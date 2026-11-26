// The worker (design §4): runs on each reviewer's machine, connects out to the hub over a WebSocket,
// runs reviews with the reviewer's own Claude Code and whisper.cpp, and answers follow-ups from its cache.
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { loadConfig, saveConfig } from '../config.mjs';
import { runClaude } from '../pipeline/claude.mjs';
import { locateWhisper } from '../pipeline/whisper.mjs';
import { followupPrompt, TRACKER_SCHEMA, trackerPrompt } from '../pipeline/prompt.mjs';
import { cacheRoot, deleteVideo, jobDir, loadCachedJob, reviewOne } from '../pipeline/review.mjs';
import { keyFrames } from '../render/discord.mjs';
import { timeLink } from '../pipeline/fetch.mjs';
import { run, sleep } from '../util.mjs';
import { VERSION } from '../version.mjs';

/** What `/debrief status` shows about this machine. */
export async function detectCaps(cfg) {
  const w = await locateWhisper(cfg);
  let gpu = 'cpu';
  if (process.platform === 'darwin' && process.arch === 'arm64') gpu = 'metal';
  else {
    try {
      const { stdout } = await run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeoutMs: 5000 });
      if (stdout.trim()) gpu = stdout.trim().split('\n')[0];
    } catch {}
  }
  return {
    whisper: Boolean(w.cli && w.model),
    whisperModel: w.model ? w.model.replace(/^.*[\\/]/, '') : null,
    vad: Boolean(w.vad),
    gpu,
    platform: `${process.platform}-${process.arch}`,
    model: cfg.model,
    profiles: (cfg.claudeProfiles || []).length || 1,
    version: VERSION,
  };
}

/** Delete cached jobs older than the retention window (design §13). */
export function sweepCache(cfg, now = Date.now()) {
  const root = cacheRoot(cfg);
  if (!existsSync(root)) return 0;
  const maxAge = (cfg.cacheRetentionDays ?? 14) * 86400_000;
  let removed = 0;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      const st = statSync(dir);
      if (st.isDirectory() && now - st.mtimeMs > maxAge) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {}
  }
  return removed;
}

export class Worker {
  /**
   * opts: {hubUrl, tokenKey ('default' or 'solo'), cfg?, log?, onCode?(code), onPaired?(info), onReady?(info)}
   */
  constructor(opts) {
    this.opts = opts;
    this.cfg = opts.cfg || loadConfig();
    this.log = opts.log || ((...a) => console.log('[worker]', ...a));
    this.running = new Map(); // jobId → AbortController
    this.finished = new Map(); // jobId → {outcome, at}: kept until the hub confirms it posted the result
    this.stopped = false;
    this.backoff = 1000;
  }

  get tokenKey() {
    return this.opts.tokenKey || this.opts.hubUrl;
  }

  /** Pairing tokens live in the config file, keyed by hub URL (solo mode uses "solo"). */
  get token() {
    const saved = loadConfig();
    return saved.tokens?.[this.tokenKey] || (this.tokenKey === saved.hubUrl ? saved.token : '') || '';
  }

  setToken(token) {
    const saved = loadConfig();
    const tokens = { ...(saved.tokens || {}) };
    if (token) tokens[this.tokenKey] = token;
    else delete tokens[this.tokenKey];
    const patch = { tokens };
    if (this.tokenKey === saved.hubUrl && saved.token) patch.token = undefined;
    saveConfig(patch);
  }

  async start() {
    this.caps = await detectCaps(this.cfg);
    sweepCache(this.cfg);
    this.sweepTimer = setInterval(() => sweepCache(this.cfg), 86400_000);
    this.sweepTimer.unref?.();
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    for (const ac of this.running.values()) ac.abort();
    this.ws?.close();
  }

  connect() {
    if (this.stopped) return;
    const url = this.opts.hubUrl.replace(/\/+$/, '').replace(/\/worker$/, '') + '/worker';
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 1000;
      this.send('hello', {
        token: this.token || undefined,
        name: this.cfg.workerName,
        version: VERSION,
        capacity: this.cfg.maxConcurrentJobs || 1,
        caps: this.caps,
        running: [...this.running.keys(), ...this.finished.keys()],
      });
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onMessage(msg).catch((err) => this.log('error:', err.message));
    });
    ws.on('close', (code, reason) => {
      if (this.stopped) return;
      if (code === 4003) return; // revoked; onMessage('revoked') decides what next
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 60_000);
      this.log(`disconnected from hub (${code}${reason?.length ? ` ${reason}` : ''}); retrying in ${Math.round(wait / 1000)}s`);
      setTimeout(() => this.connect(), wait);
    });
    ws.on('error', (err) => {
      if (this.backoff <= 2000) this.log(`hub connection error: ${err.message}`);
    });
  }

  send(type, body = {}) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ type, ...body }));
      return true;
    }
    return false;
  }

  async onMessage(msg) {
    switch (msg.type) {
      case 'code':
        this.opts.onCode?.(msg.code, msg.expiresAt);
        if (!this.opts.onCode) this.log(`Pair this worker: in Discord, run  /debrief link code:${msg.code}   (expires in 15 minutes)`);
        break;
      case 'paired':
        this.setToken(msg.token);
        this.log(`Paired with ${msg.userTag}. Ready for reviews.`);
        this.opts.onPaired?.(msg);
        this.flushUnsent();
        break;
      case 'welcome':
        this.log(`Connected to hub as ${msg.userTag}'s worker${msg.pool?.enabled ? ' (in the pool)' : ''}.`);
        this.opts.onReady?.(msg);
        this.flushUnsent();
        break;
      case 'revoked':
        this.log(msg.reason || 'The hub revoked this worker\'s pairing.');
        this.setToken('');
        if (!this.stopped) setTimeout(() => this.connect(), 2000);
        break;
      case 'pool':
        this.log(msg.pool?.enabled ? `Joined the review pool (cap ${msg.pool.dailyCap}/day).` : 'Left the review pool.');
        break;
      case 'job':
        this.runJob(msg.job);
        break;
      case 'cancel':
        this.running.get(msg.jobId)?.abort();
        break;
      case 'posted':
        this.finished.delete(msg.jobId);
        deleteVideo(jobDir(this.cfg, msg.jobId));
        break;
      case 'request':
        this.onRequest(msg);
        break;
    }
  }

  /** Re-send outcomes the hub may have missed while we were disconnected. The hub ignores duplicates. */
  flushUnsent() {
    const now = Date.now();
    for (const [jobId, f] of this.finished) {
      const maxAge = f.outcome.type === 'result' ? 86400_000 : 15 * 60_000;
      if (now - f.at > maxAge) this.finished.delete(jobId);
      else this.send(f.outcome.type, f.outcome.body);
    }
  }

  async runJob(job) {
    if (this.running.has(job.id)) return;
    // Already finished (e.g. while offline, and the hub requeued it meanwhile): send the outcome, don't redo it.
    const done = this.finished.get(job.id);
    if (done) {
      this.send(done.outcome.type, done.outcome.body);
      return;
    }
    const ac = new AbortController();
    this.running.set(job.id, ac);
    const who = job.pool ? `${job.requester} (pool)` : job.requester;
    this.log(`review ${job.id} for ${who}: ${job.source?.url}`);
    let last = 0;
    let lastStage = '';
    const progress = (stage, p = {}) => {
      const now = Date.now();
      if (stage === lastStage && !p.title && now - last < 1500) return;
      last = now;
      lastStage = stage;
      this.send('progress', { jobId: job.id, stage, ...p });
    };
    let outcome;
    try {
      const res = await reviewOne(job, { cfg: this.cfg, progress, signal: ac.signal });
      progress('posting', {});
      const frames = keyFrames(res.review, res.frames, { maxFrames: this.cfg.postFrames || 20 }).map((f) => ({
        ...f,
        data: readFileSync(join(res.dir, 'frames', f.name)).toString('base64'),
      }));
      outcome = { type: 'result', body: { jobId: job.id, review: res.review, meta: { ...res.meta, workerName: this.cfg.workerName, pool: job.pool }, frames, files: res.files } };
      this.log(`review ${job.id} done: ${res.review.feedback.length} feedback, ${res.review.intentions.length} intentions, ${res.review.notes.length} notes`);
    } catch (err) {
      this.log(`review ${job.id} failed: ${err.message}`);
      deleteVideo(jobDir(this.cfg, job.id));
      outcome = { type: 'failed', body: { jobId: job.id, error: err.message, cancelled: Boolean(err.cancelled) } };
    } finally {
      this.running.delete(job.id);
    }
    this.finished.set(job.id, { outcome, at: Date.now() });
    this.send(outcome.type, outcome.body);
  }

  async onRequest(msg) {
    const reply = (ok, data, error) => this.send('reply', { reqId: msg.reqId, ok, data, error });
    try {
      const cached = loadCachedJob(this.cfg, msg.jobId);
      if (!cached) throw new Error('This worker no longer has that review cached (it is kept for ' + (this.cfg.cacheRetentionDays ?? 14) + ' days).');
      if (msg.kind === 'transcript') {
        return reply(true, { text: readFileSync(join(cached.dir, 'transcript.txt'), 'utf8') });
      }
      if (msg.kind === 'ask') {
        const res = await runClaude({
          prompt: followupPrompt({ question: String(msg.question || '').slice(0, 4000), review: cached.review, segments: cached.segments, framesDir: cached.framesDir, frames: cached.frames, asker: msg.asker }),
          tools: cached.frames.length ? ['Read'] : [],
          addDirs: cached.frames.length ? [cached.framesDir] : [],
          cwd: cached.dir,
          model: this.cfg.model,
          cfg: this.cfg,
          timeoutMs: 10 * 60_000,
        });
        return reply(true, { text: res.text, model: res.model });
      }
      if (msg.kind === 'tracker') return reply(true, await this.exportToTracker(cached, msg));
      throw new Error(`Unknown request: ${msg.kind}`);
    } catch (err) {
      reply(false, null, err.message);
    }
  }

  /**
   * Send to tracker (design §11): the one run with more than Read. It uses the reviewer's own MCP connectors,
   * but only the tools listed in tracker.allowedTools, and only sees the structured feedback JSON.
   */
  async exportToTracker(cached, msg) {
    if (cached.meta.pool) {
      throw new Error('This review ran on a pool worker. Tracker export runs with the worker owner\'s own accounts, so it is only available on your own worker.');
    }
    const t = this.cfg.tracker || {};
    if (!t.allowedTools?.length) {
      throw new Error('Tracker export is not set up on this worker. Add tracker.allowedTools (and tracker.mcpConfig if needed) to ~/.debrief/config.json — see the README.');
    }
    const minPriority = msg.tracker?.priorities || ['high'];
    const items = cached.review.feedback
      .filter((f) => minPriority.includes(f.priority))
      .map((f) => ({
        title: f.title,
        change: f.change,
        why: f.why,
        area: f.area,
        priority: f.priority,
        time: f.t,
        link: timeLink(cached.meta.source, f.t) || '',
        intention: cached.review.intentions.find((i) => i.id === f.intention)?.statement || '',
        frame: f.frame,
      }));
    if (!items.length) return { tickets: [], note: 'No feedback items at that priority.' };
    const res = await runClaude({
      prompt: trackerPrompt({ items, tracker: msg.tracker, reviewLink: msg.reviewLink, title: cached.meta.title }),
      schema: TRACKER_SCHEMA,
      tools: [],
      allowedTools: t.allowedTools,
      mcpConfig: t.mcpConfig || undefined,
      userMcp: true,
      cwd: cached.dir,
      model: this.cfg.model,
      cfg: { ...this.cfg, claudeProfiles: t.profile ? this.cfg.claudeProfiles.filter((p) => p.name === t.profile) : this.cfg.claudeProfiles },
      timeoutMs: 15 * 60_000,
    });
    return res.structured;
  }
}

/** Wait until a worker is connected and paired (used by solo mode and tests). */
export async function waitFor(fn, { timeoutMs = 10_000, every = 50 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  throw new Error('Timed out');
}
