// End to end without Discord: a real HubCore and Worker over WebSocket, real ffmpeg, and stand-ins for
// yt-dlp, whisper-cli and claude (testdata/). Covers pairing, a review, follow-ups, the transcript,
// tracker export, re-runs, the offline queue, the pool, and forget.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'debrief-e2e-'));
process.env.DEBRIEF_HOME = join(TMP, 'home');

const { WORKER_DEFAULTS, loadConfig } = await import('../src/config.mjs');
const { HubCore } = await import('../src/hub/core.mjs');
const { Store } = await import('../src/hub/store.mjs');
const { Worker, waitFor } = await import('../src/worker/worker.mjs');

const video = join(TMP, 'in.mp4');
const claudeLog = join(TMP, 'claude.log');
process.env.FAKE_VIDEO = video;
process.env.FAKE_CLAUDE_LOG = claudeLog;
const model = join(TMP, 'ggml-tiny.bin');

const cfg = {
  ...WORKER_DEFAULTS,
  workerName: 'test-rig',
  cacheDir: join(TMP, 'cache'),
  ytDlp: join(ROOT, 'testdata/fake-ytdlp.mjs'),
  claudeBin: join(ROOT, 'testdata/fake-claude.mjs'),
  whisperCli: join(ROOT, 'testdata/fake-whisper.mjs'),
  whisperModel: model,
  frameBudget: 6,
  tracker: { allowedTools: ['mcp__jira__createJiraIssue'] },
};

function fakeFront() {
  const f = { results: [], failed: [], waiting: [], progress: [], started: [] };
  f.prepareJob = async (job) => ({ id: job.id, source: job.source, context: job.context, frames: job.frames, reviewer: job.userTag, reuseFrom: job.reuseFrom, project: { name: 'ZQuest', glossary: ['Spittoony'] } });
  f.onResult = async (job, r) => f.results.push({ job, ...r });
  f.onFailed = (job, m) => f.failed.push({ job, m });
  f.onWaiting = (job, t) => f.waiting.push({ job, t });
  f.onProgress = (job, p) => f.progress.push({ job, ...p });
  f.onStarted = (job, w) => f.started.push({ job, w });
  f.onExpired = () => {};
  f.log = () => {};
  return f;
}

let core;
let front;
let url;
const workers = [];
const quiet = () => {};

function startWorker(opts = {}) {
  let code = null;
  let paired = false;
  const w = new Worker({ hubUrl: url, tokenKey: 'e2e', cfg, log: quiet, onCode: (c) => (code = c), onPaired: () => (paired = true), onReady: () => (paired = true), ...opts });
  workers.push(w);
  w.start();
  return { w, code: () => code, paired: () => paired };
}

const job = (fields = {}) => core.createJob({ userId: 'u1', userTag: 'Nathaniel', guildId: 'g1', threadId: 't1', source: { kind: 'youtube', url: 'https://youtu.be/abc123', id: 'abc123' }, context: 'camp 3 combat', frames: true, ...fields });
const resultFor = (id) => waitFor(() => front.results.find((r) => r.job.id === id), { timeoutMs: 60_000 });

before(async () => {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
  writeFileSync(model, 'not a real model');
  front = fakeFront();
  core = new HubCore({ store: new Store(join(TMP, 'hub.json')), front });
  url = `ws://127.0.0.1:${await core.listen({ port: 0, host: '127.0.0.1' })}`;
});

after(async () => {
  for (const w of workers) w.stop();
  await core.close();
  rmSync(TMP, { recursive: true, force: true });
});

let first;

test('pairing: worker gets a code, /debrief link binds it, token is saved', async () => {
  const s = startWorker();
  const code = await waitFor(s.code);
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(core.link('WRONG1', { id: 'u1', tag: 'Nathaniel' }).ok, false);
  const r = core.link(code, { id: 'u1', tag: 'Nathaniel' });
  assert.ok(r.ok);
  await waitFor(s.paired);
  assert.ok(loadConfig().tokens.e2e.startsWith(`${r.worker.id}.`));
  assert.notEqual(core.workers[r.worker.id].tokenHash, loadConfig().tokens.e2e.split('.')[1], 'only the hash is stored on the hub');
  assert.equal(core.link(code, { id: 'u9', tag: 'x' }).ok, false, 'codes are single-use');
});

test('a review runs end to end and comes back structured', async () => {
  const j = job();
  first = await resultFor(j.id);
  const { review, meta, frames, files } = first;
  assert.equal(first.job.status, 'done');
  assert.equal(meta.title, 'Camp 3 combat pass');
  assert.equal(Math.round(meta.duration), 30);
  assert.equal(meta.model, 'claude-fake-1');
  assert.equal(review.feedback[0].title, 'Archers invisible against fog', 'high priority first');
  assert.equal(review.feedback[0].area, 'art', 'area normalised');
  const bogus = review.feedback.find((f) => f.title === 'Bogus area item');
  assert.equal(bogus.area, 'other');
  assert.equal(bogus.priority, 'normal');
  assert.equal(bogus.intention, '');
  assert.equal(bogus.frame, '');
  assert.ok(frames.length >= 1 && frames.every((f) => f.data && Buffer.from(f.data, 'base64')[0] === 0xff), 'key frames are JPEGs');
  // Times snap to the frame's time.
  for (const f of review.feedback.filter((x) => x.frame)) assert.equal(f.t, frames.find((x) => x.name === f.frame)?.t ?? f.t);
  assert.doesNotMatch(files.transcript, /Thank you for watching/, 'noise lines are dropped');
  assert.match(files.transcript, /\[0:16\] The archers are lost/);
  assert.match(files.markdown, /## Intentions/);
  const stages = new Set(front.progress.filter((p) => p.job.id === j.id).map((p) => p.stage));
  for (const s of ['downloading', 'transcribing', 'frames', 'reviewing', 'posting']) assert.ok(stages.has(s), s);
  // The worker deleted the video but kept frames and transcript.
  const dir = join(cfg.cacheDir, j.id);
  assert.ok(!readdirSync(dir).some((f) => f.startsWith('source.')));
  assert.ok(existsSync(join(dir, 'transcript.json')) && existsSync(join(dir, 'frames', 'f001.jpg')));
  // The review run was locked to Read on the frames directory with no MCP servers.
  const call = JSON.parse(readFileSync(claudeLog, 'utf8').trim().split('\n')[0]);
  assert.deepEqual(call.args.slice(call.args.indexOf('--tools'), call.args.indexOf('--tools') + 2), ['--tools', 'Read']);
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.ok(call.args.includes('--no-session-persistence'));
  assert.equal(call.args[call.args.indexOf('--add-dir') + 1], join(dir, 'frames'));
  assert.match(call.prompt, /Spittoony/);
  assert.match(call.prompt, /f001\.jpg @/);
});

test('follow-up questions, transcript and tracker export are answered from the cache', async () => {
  const wid = first.job.workerId;
  const ans = await core.request(wid, 'ask', { jobId: first.job.id, question: 'what did I say about the archers?', asker: 'Sam' });
  assert.match(ans.text, /archers/);
  const tx = await core.request(wid, 'transcript', { jobId: first.job.id });
  assert.match(tx.text, /parry window/);
  const tr = await core.request(wid, 'tracker', { jobId: first.job.id, tracker: { kind: 'Jira', projectKey: 'ZQ', priorities: ['high'] }, reviewLink: 'https://discord.com/x' });
  assert.equal(tr.tickets[0].key, 'ZQ-1');
  const calls = readFileSync(claudeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const tracker = calls.find((c) => c.prompt.includes('ticket'));
  assert.ok(!tracker.args.includes('--strict-mcp-config'), 'tracker export uses the reviewer\'s own connectors');
  assert.equal(tracker.args[tracker.args.indexOf('--allowedTools') + 1], 'mcp__jira__createJiraIssue');
  assert.match(tracker.prompt, /youtu\.be\/abc123\?t=/);
  assert.doesNotMatch(tracker.prompt, /Stagger needs/, 'only high-priority items are exported');
  await assert.rejects(core.request(wid, 'ask', { jobId: 'nope', question: 'x' }), /no longer has that review/);
});

test('re-run reuses the cached transcript and frames', async () => {
  const before = front.progress.length;
  const j = job({ reuseFrom: first.job.id, context: 'focus on audio' });
  const r = await resultFor(j.id);
  assert.equal(r.job.status, 'done');
  const texts = front.progress.slice(before).filter((p) => p.job.id === j.id).map((p) => p.text || '');
  assert.ok(texts.some((t) => /Reusing/.test(t)));
  assert.ok(!front.progress.slice(before).some((p) => p.job.id === j.id && p.stage === 'downloading'));
});

test('offline queue: jobs wait for the worker and run when it reconnects', async () => {
  workers[0].stop();
  await waitFor(() => core.conns.size === 0);
  const j = job({ context: 'while offline' });
  await waitFor(() => front.waiting.find((x) => x.job.id === j.id));
  assert.match(front.waiting.find((x) => x.job.id === j.id).t, /come online/);
  assert.equal(core.store.job(j.id).status, 'queued');
  startWorker(); // reconnects with the saved token
  const r = await resultFor(j.id);
  assert.equal(r.job.status, 'done');
});

test('a worker that drops mid-review is requeued after the grace period', async () => {
  const j = core.store.putJob({ id: 'orphan1', status: 'running', workerId: core.store.data.workers[Object.keys(core.store.data.workers)[0]].id, orphanedAt: Date.now() - 200_000, userId: 'u1', userTag: 'Nathaniel', guildId: 'g1', threadId: 't1', source: { kind: 'youtube', url: 'https://youtu.be/abc123', id: 'abc123' }, createdAt: Date.now(), attempts: 0 });
  core.sweep();
  const r = await resultFor(j.id);
  assert.equal(r.job.attempts, 1);
});

test('the pool serves reviewers without a worker, within its daily cap', async () => {
  assert.equal(core.canServe('u2', 'g1'), false);
  core.setPool('u1', { enabled: true, guildId: 'g1', dailyCap: 1 });
  assert.equal(core.canServe('u2', 'g1'), true);
  assert.equal(core.canServe('u2', 'other-guild'), false, 'pool can be limited to a server');
  const j = job({ userId: 'u2', userTag: 'Sam', context: 'pool job' });
  const r = await resultFor(j.id);
  assert.equal(r.job.pool, true);
  assert.equal(core.poolWorkers('g1', 'u2').length, 0, 'daily cap reached');
  core.setPool('u1', { enabled: false });
});

test('forget unpairs and deletes the user\'s records; the worker gets a new code', async () => {
  const s = workers[workers.length - 1];
  let newCode = null;
  s.opts.onCode = (c) => (newCode = c);
  const r = core.forget('u1');
  assert.equal(r.workers, 1);
  assert.ok(r.jobs >= 4);
  assert.equal(core.store.jobs((j) => j.userId === 'u1').length, 0);
  await waitFor(() => newCode, { timeoutMs: 10_000 });
  assert.equal(loadConfig().tokens.e2e, undefined, 'the revoked token was removed');
});

test('audio from every track is mixed (mic on a second track is not lost)', async () => {
  const { extractAudio, probe, audioStats } = await import('../src/pipeline/media.mjs');
  const two = join(TMP, 'two.mkv');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-t', '3', '-map', '0:a', '-map', '1:a', '-c:a', 'pcm_s16le', two]);
  const info = await probe(two);
  assert.equal(info.audioStreams, 2);
  const wav = await extractAudio(two, join(TMP, 'two.wav'), { audioStreams: info.audioStreams });
  const st = await audioStats(wav);
  assert.ok(st.maxDb > -20, `second track is audible (peak ${st.maxDb} dB)`);
});
