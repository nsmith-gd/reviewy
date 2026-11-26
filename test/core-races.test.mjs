// Hub core regressions with raw WebSocket workers: reconnects during dispatch, results delivered after the
// grace period, and `debrief unlink` not hijacking a live worker.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { HubCore } from '../src/hub/core.mjs';
import { Store } from '../src/hub/store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(front = {}) {
  const store = new Store(null);
  const events = [];
  const core = new HubCore({
    store,
    front: { log: () => {}, onStarted: () => events.push('started'), onFailed: (j, m) => events.push(`failed ${m}`), onProgress: () => {}, onWaiting: () => {}, onResult: async () => events.push('result'), ...front },
  });
  const port = await core.listen({ port: 0, host: '127.0.0.1' });
  const open = (hello, onmsg) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`);
    const msgs = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      msgs.push(m);
      onmsg?.(m, ws);
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', ...hello })));
    ws.on('error', () => {});
    return { ws, msgs };
  };
  const a = open({ name: 'w' });
  await sleep(150);
  core.link(a.msgs.find((m) => m.type === 'code').code, { id: 'u1', tag: 'U' });
  await sleep(100);
  const token = a.msgs.find((m) => m.type === 'paired').token;
  return { store, core, events, open, a, token };
}

test('a worker that reconnects while a job is being prepared still gets the job', async () => {
  let delay = 0;
  const { store, core, open, a, token } = await setup({
    prepareJob: async (job) => {
      await sleep(delay);
      return { id: job.id, source: job.source };
    },
  });
  delay = 300;
  const job = core.createJob({ userId: 'u1', userTag: 'U', source: { kind: 'direct', url: 'https://x/y.mp4' } });
  await sleep(50);
  const b = open({ token, name: 'w', running: [] });
  await sleep(900);
  assert.ok(!a.msgs.some((m) => m.type === 'job'), 'not sent to the replaced connection');
  assert.ok(b.msgs.some((m) => m.type === 'job' && m.job.id === job.id), 'sent to the new connection');
  assert.equal(store.job(job.id).status, 'running');
  await core.close();
});

test('a result finished offline after the grace period is reclaimed, not re-run', async () => {
  const { store, core, events, open, a, token } = await setup();
  const job = core.createJob({ userId: 'u1', userTag: 'U', source: { kind: 'direct', url: 'https://x/y.mp4' } });
  await sleep(100);
  assert.ok(a.msgs.some((m) => m.type === 'job'));
  a.ws.terminate();
  await sleep(200);
  core.sweep(Date.now() + 100_000);
  assert.equal(store.job(job.id).status, 'queued');
  const b = open({ token, name: 'w', running: [job.id] }, (m, ws) => {
    if (m.type === 'welcome') ws.send(JSON.stringify({ type: 'result', jobId: job.id, review: {}, meta: {} }));
  });
  await sleep(400);
  assert.deepEqual(b.msgs.filter((m) => m.type === 'job'), [], 'the job is not sent again');
  assert.equal(store.job(job.id).status, 'done');
  assert.ok(events.includes('result'));
  assert.equal([...core.conns.values()][0].busy.size, 0);
  await core.close();
});

test('requests to a replaced connection fail fast instead of hanging', async () => {
  const { core, open, token } = await setup();
  const wid = Object.keys(core.workers)[0];
  const pending = core.request(wid, 'ask', { jobId: 'x', question: 'q' }, { timeoutMs: 60_000 });
  open({ token, name: 'w', running: [] });
  await assert.rejects(pending, /reconnected/);
  await core.close();
});

test('debrief unlink removes the pairing without requeuing the live worker\'s reviews', async () => {
  const { store, core, open, a, token } = await setup();
  const job = core.createJob({ userId: 'u1', userTag: 'U', source: { kind: 'direct', url: 'https://x/y.mp4' } });
  await sleep(100);
  const u = open({ token, unlink: true });
  await sleep(300);
  assert.ok(u.msgs.some((m) => m.type === 'revoked'));
  assert.ok(a.msgs.some((m) => m.type === 'revoked'), 'the live worker is told it was unpaired');
  assert.equal(Object.keys(core.workers).length, 0);
  assert.notEqual(store.job(job.id).error, 'The worker restarted during the review.');
  await core.close();
});

test('transient prepare errors retry later instead of failing the review', async () => {
  let fail = true;
  const { store, core, events } = await setup({
    prepareJob: async (job) => {
      if (fail) throw Object.assign(new Error('Discord 503'), { transient: true });
      return { id: job.id, source: job.source };
    },
  });
  const job = core.createJob({ userId: 'u1', userTag: 'U', source: { kind: 'direct', url: 'https://x/y.mp4' } });
  await sleep(100);
  assert.equal(store.job(job.id).status, 'queued');
  assert.ok(!events.some((e) => e.startsWith('failed')));
  fail = false;
  store.job(job.id).notBefore = 0;
  core.sweep();
  await sleep(100);
  assert.equal(store.job(job.id).status, 'running');
  await core.close();
});
