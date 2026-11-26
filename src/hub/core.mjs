// Hub core (design §4, §10): worker connections, pairing, routing, the offline queue and the pool.
// It knows nothing about Discord; the Discord front end plugs in through `front` callbacks.
import { createServer } from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { newId, sha256 } from '../util.mjs';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_TTL = 15 * 60_000;
const MAX_ATTEMPTS = 3;
const ORPHAN_GRACE = 90_000; // a worker that drops mid-review gets this long to reconnect and claim it
export const PROTOCOL_VERSION = 1;

export function makeCode() {
  return Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * front: {
 *   prepareJob(job) → payload for the worker (resolves project settings, refreshes Discord CDN links)
 *   onStarted(job, worker), onProgress(job, p), onResult(job, result), onFailed(job, message),
 *   onWaiting(job, text), onExpired(job), onPaired(userId, worker), log(...)
 * }
 */
export class HubCore {
  constructor({ store, front = {}, jobExpiryHours = 24, jobRetentionDays = 30 } = {}) {
    this.store = store;
    this.front = front;
    this.jobExpiryMs = jobExpiryHours * 3600_000;
    this.jobRetentionMs = jobRetentionDays * 86400_000;
    this.conns = new Map(); // workerId → {ws, workerId, busy:Set, caps, capacity}
    this.pending = new Map(); // code → {conn, expiresAt}
    this.requests = new Map(); // reqId → {resolve, reject, timer}
    this.log = front.log || ((...a) => console.log('[hub]', ...a));
    // Jobs that were running when the hub stopped: their workers get a grace period to reconnect and claim them.
    for (const j of store.jobs((j) => j.status === 'running')) j.orphanedAt = Date.now();
    store.save();
  }

  get workers() {
    return this.store.data.workers;
  }

  // ---- server ---------------------------------------------------------------------------------------

  listen({ port = 8787, host = '0.0.0.0' } = {}) {
    this.http = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, workersOnline: this.conns.size, queued: this.store.jobs((j) => j.status === 'queued').length }));
        return;
      }
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ server: this.http, path: '/worker', maxPayload: 64 * 1024 * 1024 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30_000);
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    return new Promise((resolve) => this.http.listen(port, host, () => resolve(this.http.address().port)));
  }

  async close() {
    clearInterval(this.heartbeat);
    clearInterval(this.sweeper);
    for (const ws of this.wss?.clients || []) ws.terminate();
    await new Promise((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise((r) => (this.http ? this.http.close(() => r()) : r()));
    this.store.flush();
  }

  onConnection(ws) {
    const conn = { ws, workerId: null, busy: new Set(), caps: {}, capacity: 1, authed: false };
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    const helloTimer = setTimeout(() => !conn.authed && !conn.code && ws.close(4001, 'hello timeout'), 15_000);
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onMessage(conn, msg).catch((err) => this.log('message error', err));
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.onDisconnect(conn);
    });
    ws.on('error', () => {});
  }

  send(conn, type, body = {}) {
    if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify({ type, ...body }));
  }

  // ---- worker messages --------------------------------------------------------------------------------

  async onMessage(conn, msg) {
    if (msg.type === 'hello') return this.onHello(conn, msg);
    if (!conn.authed) return;
    const w = this.workers[conn.workerId];
    switch (msg.type) {
      case 'progress': {
        const job = this.store.job(msg.jobId);
        if (job && job.workerId === conn.workerId && job.status === 'running') {
          if (msg.title && !job.title) {
            job.title = msg.title;
            this.store.save();
          }
          this.front.onProgress?.(job, { stage: msg.stage, pct: msg.pct, text: msg.text, title: msg.title });
        }
        break;
      }
      case 'result': {
        const job = this.store.job(msg.jobId);
        conn.busy.delete(msg.jobId);
        if (!job || job.workerId !== conn.workerId || job.status !== 'running') break;
        job.status = 'done';
        job.finishedAt = Date.now();
        job.title = msg.meta?.title || job.title;
        this.store.putJob(job);
        try {
          await this.front.onResult?.(job, { review: msg.review, meta: msg.meta, frames: msg.frames || [], files: msg.files || {} });
        } catch (err) {
          this.log('posting result failed', err);
          this.front.onFailed?.(job, `Posting the result failed: ${err.message}`);
        }
        this.send(conn, 'posted', { jobId: job.id });
        this.dispatch();
        break;
      }
      case 'failed': {
        const job = this.store.job(msg.jobId);
        conn.busy.delete(msg.jobId);
        if (!job || job.workerId !== conn.workerId || job.status !== 'running') break;
        job.status = msg.cancelled ? 'cancelled' : 'failed';
        job.error = String(msg.error || 'Unknown error').slice(0, 1500);
        job.finishedAt = Date.now();
        this.store.putJob(job);
        this.front.onFailed?.(job, job.error);
        this.dispatch();
        break;
      }
      case 'reply': {
        const r = this.requests.get(msg.reqId);
        if (!r || r.workerId !== conn.workerId) break;
        this.requests.delete(msg.reqId);
        clearTimeout(r.timer);
        if (msg.ok) r.resolve(msg.data ?? {});
        else r.reject(new Error(msg.error || 'The worker could not do that.'));
        break;
      }
      case 'unlink':
        this.log(`worker ${w?.name} unlinked itself`);
        this.unpair(conn.workerId, 'Unlinked.');
        break;
      case 'caps':
        conn.caps = msg.caps || {};
        if (w) w.caps = conn.caps;
        this.store.save();
        break;
    }
  }

  onHello(conn, msg) {
    conn.capacity = Math.max(1, Math.min(4, Number(msg.capacity) || 1));
    conn.caps = msg.caps || {};
    conn.name = String(msg.name || 'worker').slice(0, 60);
    conn.version = msg.version;
    if (msg.token) {
      const [id, secret] = String(msg.token).split('.');
      const w = this.workers[id];
      const ok = w && secret && safeEqual(w.tokenHash, sha256(secret));
      if (!ok) {
        this.send(conn, 'revoked', { reason: 'This worker is not paired with this hub (the pairing was removed or the token is wrong).' });
        conn.ws.close(4003, 'bad token');
        return;
      }
      const old = this.conns.get(id);
      conn.authed = true;
      conn.workerId = id;
      this.conns.set(id, conn);
      if (old && old !== conn) old.ws.close(4000, 'replaced by a new connection');
      // Reclaim reviews this worker is still running; requeue the ones it lost (e.g. it restarted).
      const running = new Set(Array.isArray(msg.running) ? msg.running : []);
      for (const job of this.store.jobs((j) => j.workerId === id && j.status === 'running')) {
        if (running.has(job.id)) {
          delete job.orphanedAt;
          conn.busy.add(job.id);
          this.store.putJob(job);
        } else {
          this.requeue(job, 'The worker restarted during the review.');
        }
      }
      w.name = conn.name;
      w.caps = conn.caps;
      w.lastSeen = Date.now();
      this.store.save();
      this.send(conn, 'welcome', { workerId: id, userId: w.userId, userTag: w.userTag, pool: w.pool, protocol: PROTOCOL_VERSION });
      this.log(`worker ${w.name} (${w.userTag}) online`);
      this.dispatch();
      return;
    }
    // Unpaired: hand out a code for /debrief link.
    let code;
    do code = makeCode();
    while (this.pending.has(code));
    const expiresAt = Date.now() + CODE_TTL;
    this.pending.set(code, { conn, expiresAt });
    conn.code = code;
    this.send(conn, 'code', { code, expiresAt });
  }

  onDisconnect(conn) {
    if (conn.code) this.pending.delete(conn.code);
    if (!conn.workerId || this.conns.get(conn.workerId) !== conn) return;
    this.conns.delete(conn.workerId);
    const w = this.workers[conn.workerId];
    if (w) w.lastSeen = Date.now();
    for (const [id, r] of this.requests) {
      if (r.workerId === conn.workerId) {
        clearTimeout(r.timer);
        this.requests.delete(id);
        r.reject(new Error('The worker went offline.'));
      }
    }
    // Jobs it was running wait a short grace period for it to reconnect, then go back in the queue (sweep()).
    for (const job of this.store.jobs((j) => j.workerId === conn.workerId && j.status === 'running')) {
      job.orphanedAt = Date.now();
      this.store.putJob(job);
    }
    this.log(`worker ${w?.name || conn.workerId} offline`);
    this.dispatch();
  }

  requeue(job, why) {
    job.attempts = (job.attempts || 0) + 1;
    job.workerId = null;
    job.waitingNotified = false;
    delete job.orphanedAt;
    if (job.attempts >= MAX_ATTEMPTS) {
      job.status = 'failed';
      job.error = `${why} Gave up after ${MAX_ATTEMPTS} tries.`;
      job.finishedAt = Date.now();
      this.store.putJob(job);
      this.front.onFailed?.(job, job.error);
    } else {
      job.status = 'queued';
      this.store.putJob(job);
      this.front.onProgress?.(job, { stage: 'queued', text: `${why} Queued again.` });
    }
    this.dispatch();
  }

  // ---- pairing -------------------------------------------------------------------------------------

  /** /debrief link code:XXXXXX. user: {id, tag}. */
  link(code, user) {
    const c = String(code || '').trim().toUpperCase();
    const p = this.pending.get(c);
    if (!p || p.expiresAt < Date.now() || p.conn.ws.readyState !== 1) {
      this.pending.delete(c);
      return { ok: false, error: 'That code is not valid or has expired. Restart `debrief worker` for a new one.' };
    }
    this.pending.delete(c);
    const id = newId(8);
    const secret = randomBytes(24).toString('base64url');
    const w = {
      id,
      userId: user.id,
      userTag: user.tag,
      name: p.conn.name,
      tokenHash: sha256(secret),
      createdAt: Date.now(),
      lastSeen: Date.now(),
      caps: p.conn.caps,
      pool: { enabled: false, guilds: [], dailyCap: 10, day: '', used: 0 },
    };
    this.workers[id] = w;
    this.store.save();
    const conn = p.conn;
    conn.code = null;
    conn.authed = true;
    conn.workerId = id;
    this.conns.set(id, conn);
    this.send(conn, 'paired', { token: `${id}.${secret}`, workerId: id, userId: user.id, userTag: user.tag });
    this.front.onPaired?.(user.id, w);
    this.log(`paired worker ${w.name} to ${user.tag}`);
    this.dispatch();
    return { ok: true, worker: w };
  }

  workersOf(userId) {
    return Object.values(this.workers).filter((w) => w.userId === userId);
  }
  isOnline(workerId) {
    return this.conns.has(workerId);
  }
  isPaired(userId) {
    return this.workersOf(userId).length > 0;
  }

  /** Remove one worker's pairing (debrief unlink, or /debrief forget). */
  unpair(workerId, reason = 'This worker was unpaired.') {
    const conn = this.conns.get(workerId);
    delete this.workers[workerId];
    if (conn) {
      this.send(conn, 'revoked', { reason });
      conn.ws.close(4003, 'unpaired');
    }
    this.store.save();
  }

  /** /debrief forget: unpair everything and delete all job records for the user. */
  forget(userId) {
    const ws = this.workersOf(userId);
    for (const w of ws) this.unpair(w.id, 'Unpaired with /debrief forget.');
    let jobs = 0;
    for (const j of this.store.jobs((j) => j.userId === userId)) {
      delete this.store.data.jobs[j.id];
      jobs++;
    }
    this.store.save();
    return { workers: ws.length, jobs };
  }

  setPool(userId, { enabled, guildId = null, dailyCap = null }) {
    const ws = this.workersOf(userId);
    for (const w of ws) {
      w.pool ||= { enabled: false, guilds: [], dailyCap: 10, day: '', used: 0 };
      w.pool.enabled = enabled;
      if (enabled) {
        w.pool.guilds = guildId ? [guildId] : [];
        if (dailyCap) w.pool.dailyCap = dailyCap;
      }
      const conn = this.conns.get(w.id);
      if (conn) this.send(conn, 'pool', { pool: w.pool });
    }
    this.store.save();
    if (enabled) this.dispatch();
    return ws.length;
  }

  /** Whether anyone could serve this user's review in this guild, now or later. */
  canServe(userId, guildId) {
    return this.isPaired(userId) || this.poolWorkers(guildId, userId, { onlineOnly: false }).length > 0;
  }

  poolWorkers(guildId, userId, { onlineOnly = true } = {}) {
    const day = today();
    return Object.values(this.workers).filter((w) => {
      if (!w.pool?.enabled || w.userId === userId) return false;
      if (w.pool.guilds?.length && !w.pool.guilds.includes(guildId)) return false;
      const used = w.pool.day === day ? w.pool.used : 0;
      if (used >= (w.pool.dailyCap || 10)) return false;
      return !onlineOnly || this.conns.has(w.id);
    });
  }

  // ---- jobs ----------------------------------------------------------------------------------------

  /**
   * Queue a review. fields: {userId, userTag, guildId, channelId, threadId, progressMessageId, source, context,
   * projectName, frames, private, sourceMessage, reuseFrom}
   */
  createJob(fields) {
    const job = {
      id: newId(8),
      status: 'queued',
      createdAt: Date.now(),
      attempts: 0,
      workerId: null,
      pool: false,
      ...fields,
    };
    this.store.putJob(job);
    this.dispatch();
    return job;
  }

  pickWorker(job) {
    const free = (w) => {
      const c = this.conns.get(w.id);
      return c && c.busy.size < c.capacity ? c : null;
    };
    const load = (w) => this.conns.get(w.id).busy.size;
    const own = this.workersOf(job.userId);
    const ownFree = own.filter(free).sort((a, b) => load(a) - load(b));
    if (ownFree.length) return { worker: ownFree[0], pool: false };
    if (own.some((w) => this.conns.has(w.id))) return null; // own worker online but busy: wait for it
    const pool = this.poolWorkers(job.guildId, job.userId).filter(free).sort((a, b) => load(a) - load(b));
    if (pool.length) return { worker: pool[0], pool: true };
    return null;
  }

  dispatch() {
    if (this.dispatching) {
      this.redispatch = true;
      return;
    }
    this.dispatching = true;
    this.dispatchLoop()
      .catch((err) => this.log('dispatch error', err))
      .finally(() => {
        this.dispatching = false;
        if (this.redispatch) {
          this.redispatch = false;
          this.dispatch();
        }
      });
  }

  async dispatchLoop() {
    const queued = this.store.jobs((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    for (const job of queued) {
      const pick = this.pickWorker(job);
      if (!pick) {
        if (!job.waitingNotified) {
          job.waitingNotified = true;
          this.store.putJob(job);
          const own = this.workersOf(job.userId);
          const text = own.some((w) => this.conns.has(w.id))
            ? `Waiting for ${job.userTag}'s worker to finish its current review`
            : own.length
              ? `Waiting for ${job.userTag}'s worker to come online`
              : 'Waiting for a pool worker to come online';
          this.front.onWaiting?.(job, text);
        }
        continue;
      }
      const conn = this.conns.get(pick.worker.id);
      conn.busy.add(job.id); // reserve before any await
      let payload;
      try {
        payload = (await this.front.prepareJob?.(job)) || { id: job.id, source: job.source, context: job.context, frames: job.frames };
      } catch (err) {
        conn.busy.delete(job.id);
        job.status = 'failed';
        job.error = err.message;
        this.store.putJob(job);
        this.front.onFailed?.(job, err.message);
        continue;
      }
      if (!this.conns.has(pick.worker.id) || this.store.job(job.id)?.status !== 'queued') {
        conn.busy.delete(job.id);
        continue;
      }
      job.status = 'running';
      job.workerId = pick.worker.id;
      job.pool = pick.pool;
      job.startedAt = Date.now();
      if (pick.pool) {
        const p = pick.worker.pool;
        if (p.day !== today()) {
          p.day = today();
          p.used = 0;
        }
        p.used++;
      }
      this.store.putJob(job);
      this.send(conn, 'job', { job: { ...payload, id: job.id, pool: pick.pool, requester: job.userTag } });
      this.front.onStarted?.(job, pick.worker);
    }
  }

  cancel(jobId) {
    const job = this.store.job(jobId);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      this.store.putJob(job);
      return true;
    }
    if (job.status === 'running') {
      const conn = this.conns.get(job.workerId);
      if (conn) this.send(conn, 'cancel', { jobId });
      return true;
    }
    return false;
  }

  /** Ask a worker something (follow-up, transcript, tracker export). Resolves with the reply data. */
  request(workerId, kind, body, { timeoutMs = 5 * 60_000 } = {}) {
    const conn = this.conns.get(workerId);
    if (!conn) return Promise.reject(Object.assign(new Error('offline'), { offline: true }));
    const reqId = newId(6);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(reqId);
        reject(new Error('The worker took too long to answer.'));
      }, timeoutMs);
      this.requests.set(reqId, { resolve, reject, timer, workerId });
      this.send(conn, 'request', { reqId, kind, ...body });
    });
  }

  /** Expire old queued jobs (24 h) and trim finished ones to their ids after the retention window. */
  sweep(now = Date.now()) {
    for (const [code, p] of this.pending) if (p.expiresAt < now) this.pending.delete(code);
    for (const job of this.store.jobs()) {
      if (job.status === 'running' && job.orphanedAt && now - job.orphanedAt > ORPHAN_GRACE) {
        this.requeue(job, 'The worker went offline during the review.');
      } else if (job.status === 'queued' && now - job.createdAt > this.jobExpiryMs) {
        job.status = 'expired';
        job.finishedAt = now;
        this.store.putJob(job);
        this.front.onExpired?.(job);
      } else if (['done', 'failed', 'expired', 'cancelled'].includes(job.status) && !job.trimmed && now - (job.finishedAt || job.createdAt) > this.jobRetentionMs) {
        this.store.data.jobs[job.id] = { id: job.id, status: job.status, userId: job.userId, threadId: job.threadId, finishedAt: job.finishedAt, trimmed: true };
        this.store.save();
      }
    }
  }

  status(userId) {
    const workers = this.workersOf(userId).map((w) => {
      const c = this.conns.get(w.id);
      return { ...w, online: Boolean(c), busy: c ? c.busy.size : 0, capacity: c?.capacity || 1, caps: c?.caps || w.caps || {} };
    });
    const jobs = this.store.jobs((j) => j.userId === userId && (j.status === 'queued' || j.status === 'running')).sort((a, b) => a.createdAt - b.createdAt);
    return { workers, jobs };
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
