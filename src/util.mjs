// Small shared helpers: process spawning, time formatting, ids.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const IS_WIN = process.platform === 'win32';

/** Root for all Debrief state on this machine. DEBRIEF_HOME overrides it (tests, multiple installs). */
export function debriefHome() {
  return process.env.DEBRIEF_HOME || join(homedir(), '.debrief');
}

export function newId(bytes = 6) {
  return randomBytes(bytes).toString('hex');
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Seconds → "m:ss" or "h:mm:ss". */
export function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const winCache = new Map();

/** The script or binary an npm .cmd shim launches, relative to the shim's folder (the shim's own node.exe is skipped). */
export function parseCmdShim(text) {
  const hits = [...String(text).matchAll(/"%~?dp0%?\\?([^"]+?\.(?:exe|js|cjs|mjs))"/gi)].map((m) => m[1]).filter((p) => !/(^|\\)node\.exe$/i.test(p));
  return hits.length ? hits[hits.length - 1].replace(/\\/g, '/') : null;
}

/**
 * On Windows, Node can't spawn .cmd/.bat files without a shell (and a shell would mangle our JSON arguments).
 * npm installs CLIs such as `claude` as .cmd shims, so follow the shim to the real .exe or .js it launches.
 * Returns [command, prefixArgs].
 */
export function resolveWindowsCommand(cmd) {
  if (!IS_WIN) return [cmd, []];
  if (winCache.has(cmd)) return winCache.get(cmd);
  let path = cmd;
  if (!/[\\/]/.test(cmd)) {
    const r = spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true });
    const hits = (r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    path = hits.find((h) => /\.(exe|com)$/i.test(h)) || hits.find((h) => /\.(cmd|bat)$/i.test(h)) || cmd;
  }
  let out = [path, []];
  if (/\.(cmd|bat)$/i.test(path) && existsSync(path)) {
    const rel = parseCmdShim(readFileSync(path, 'utf8'));
    const target = rel && resolve(dirname(path), rel);
    if (target && existsSync(target)) out = /\.exe$/i.test(target) ? [target, []] : [process.execPath, [target]];
    else throw new Error(`${path} is a .cmd launcher Debrief can't follow. Set the full path to the real executable in ~/.debrief/config.json (e.g. "claudeBin").`);
  }
  winCache.set(cmd, out);
  return out;
}

/**
 * Run a command and collect its output. Never goes through a shell, so arguments are passed verbatim.
 * opts.onLine(line, stream) gets every stdout/stderr line as it arrives (progress parsing).
 * opts.signal aborts the process. Rejects on non-zero exit unless opts.allowFail.
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const [bin, pre] = IS_WIN && cmd !== 'where' ? resolveWindowsCommand(cmd) : [cmd, []];
      child = spawn(bin, [...pre, ...args], {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: [opts.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    const bufs = { stdout: '', stderr: '' };
    const feed = (name, chunk) => {
      const text = chunk.toString();
      if (name === 'stdout') stdout += text;
      else stderr += text;
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
      if (!opts.onLine) return;
      bufs[name] += text;
      const parts = bufs[name].split(/\r?\n|\r/);
      bufs[name] = parts.pop();
      for (const line of parts) if (line) opts.onLine(line, name);
    };
    child.stdout.on('data', (c) => feed('stdout', c));
    child.stderr.on('data', (c) => feed('stderr', c));
    if (opts.input != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input);
    }
    const onAbort = () => child.kill(IS_WIN ? undefined : 'SIGTERM');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let timer;
    if (opts.timeoutMs) timer = setTimeout(onAbort, opts.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (err.code === 'ENOENT') err.message = `${cmd} not found. Run \`debrief doctor\` to see how to install it.`;
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      for (const name of ['stdout', 'stderr']) if (opts.onLine && bufs[name]) opts.onLine(bufs[name], name);
      if (opts.signal?.aborted) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (code !== 0 && !opts.allowFail) {
        const tail = stderr.trim().split('\n').slice(-8).join('\n');
        return reject(Object.assign(new Error(`${cmd} exited with code ${code}${tail ? `:\n${tail}` : ''}`), { code, stdout, stderr }));
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** Find an executable on PATH; returns its path or null. */
export async function which(name) {
  const finder = IS_WIN ? 'where' : 'which';
  try {
    const { stdout } = await run(finder, [name]);
    return stdout.split(/\r?\n/).find(Boolean)?.trim() || null;
  } catch {
    return null;
  }
}

/** Truncate to n characters, adding an ellipsis when cut. */
export function clip(text, n) {
  const s = String(text ?? '');
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…`;
}
