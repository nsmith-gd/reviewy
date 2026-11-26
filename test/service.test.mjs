// Background running: autostart files, the single-instance lock, the log file, and a worker stepping aside
// (instead of reconnecting forever) when another worker with the same pairing takes over.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const TMP = mkdtempSync(join(tmpdir(), 'debrief-svc-'));
process.env.DEBRIEF_HOME = TMP;
const CLI = fileURLToPath(new URL('../bin/debrief.mjs', import.meta.url));
const { serviceFile, runningPid, stopService, claimSingleInstance, pidPath } = await import('../src/service.mjs');
const { WORKER_DEFAULTS } = await import('../src/config.mjs');
const { HubCore } = await import('../src/hub/core.mjs');
const { Store } = await import('../src/hub/store.mjs');
const { Worker, waitFor } = await import('../src/worker/worker.mjs');

after(() => rmSync(TMP, { recursive: true, force: true }));

test('autostart files for each platform', () => {
  const win = serviceFile('win32', { node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\Users\\N\\AppData\\Roaming\\npm\\node_modules\\debrief\\bin\\debrief.mjs', log: 'C:\\Users\\N\\.debrief\\worker.log', home: 'C:\\Users\\N\\.debrief' });
  // VBScript: the whole command is one string with doubled quotes around each argument, run hidden (0).
  assert.match(win, /sh\.Run """C:\\Program Files\\nodejs\\node\.exe"" ""C:\\Users\\N\\AppData\\Roaming\\npm\\node_modules\\debrief\\bin\\debrief\.mjs"" ""worker"" ""--log"" ""C:\\Users\\N\\\.debrief\\worker\.log""", 0, False/);
  const mac = serviceFile('darwin', { node: '/opt/homebrew/bin/node', cli: '/x/debrief.mjs', args: ['solo'], log: '/Users/n/.debrief/worker.log', path: '/opt/homebrew/bin:/usr/bin' });
  assert.match(mac, /<string>\/opt\/homebrew\/bin\/node<\/string><string>\/x\/debrief\.mjs<\/string><string>solo<\/string><string>--log<\/string>/);
  assert.match(mac, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  const lin = serviceFile('linux', { node: '/usr/bin/node', cli: '/home/n/my apps/debrief.mjs', log: '/home/n/.debrief/worker.log', path: '/usr/bin' });
  assert.match(lin, /ExecStart=\/usr\/bin\/node "\/home\/n\/my apps\/debrief\.mjs" worker --log \/home\/n\/\.debrief\/worker\.log/);
  assert.match(lin, /Restart=on-failure/);
});

test('only one background worker runs; stop works; output goes to the log', async () => {
  const log = join(TMP, 'worker.log');
  const env = { ...process.env, DEBRIEF_HOME: TMP };
  const first = spawn(process.execPath, [CLI, 'worker', '--hub', 'ws://127.0.0.1:9', '--log', log], { env, stdio: 'ignore' });
  await waitFor(() => runningPid() === first.pid, { timeoutMs: 10_000 });
  // A second copy refuses to start.
  const second = spawn(process.execPath, [CLI, 'worker', '--hub', 'ws://127.0.0.1:9'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  second.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => second.on('close', r));
  assert.equal(code, 1);
  assert.match(err, /already running/);
  // The first one logged to the file, not a console.
  await waitFor(() => existsSync(log) && /\[worker\]/.test(readFileSync(log, 'utf8')), { timeoutMs: 10_000 });
  await stopService({ quiet: true });
  await waitFor(() => first.exitCode !== null || first.signalCode !== null, { timeoutMs: 5_000 });
  assert.equal(runningPid(), null);
});

test('a stale pid file does not block starting', () => {
  claimSingleInstance('worker'); // writes our own pid
  assert.equal(JSON.parse(readFileSync(pidPath(), 'utf8')).pid, process.pid);
});

test('a worker steps aside when another worker with the same pairing connects', async () => {
  const store = new Store(null);
  const core = new HubCore({ store, front: { log: () => {} } });
  const url = `ws://127.0.0.1:${await core.listen({ port: 0, host: '127.0.0.1' })}`;
  const cfg = { ...WORKER_DEFAULTS, cacheDir: join(TMP, 'cache') };
  let code = null;
  let replaced = false;
  const a = new Worker({ hubUrl: url, tokenKey: 'svc', cfg, log: () => {}, onCode: (c) => (code = c), onReplaced: () => (replaced = true) });
  await a.start();
  await waitFor(() => code);
  core.link(code, { id: 'u1', tag: 'U' });
  await waitFor(() => core.conns.size === 1 && [...core.conns.values()][0].authed);
  const b = new Worker({ hubUrl: url, tokenKey: 'svc', cfg, log: () => {} });
  await b.start();
  await waitFor(() => replaced);
  assert.ok(a.stopped);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(core.conns.size, 1, 'no reconnect ping-pong');
  b.stop();
  await core.close();
});

test('install explains what is missing instead of starting a worker that quits', async () => {
  const { preflight } = await import('../src/service.mjs');
  const { saveConfig, saveHubConfig } = await import('../src/config.mjs');
  saveConfig({ hubUrl: undefined, tokens: {} });
  assert.match(preflight({ solo: false }), /debrief service install --solo/);
  assert.match(preflight({ solo: true }), /debrief solo --token/);
  saveHubConfig({ discordToken: 'x' });
  assert.equal(preflight({ solo: true }), null);
  saveConfig({ hubUrl: 'wss://hub.example' });
  assert.match(preflight({ solo: false }), /isn't paired/);
  saveConfig({ tokens: { 'wss://hub.example': 'id.secret' } });
  assert.equal(preflight({ solo: false }), null);
});
