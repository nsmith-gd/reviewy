// `debrief service …`: run the worker (or solo mode) in the background, start it at login, and keep a log.
// Windows: a hidden launcher in the Startup folder. macOS: a LaunchAgent. Linux: a systemd user service.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadHubConfig } from './config.mjs';
import { debriefHome, sleep } from './util.mjs';

const P = process.platform;
const LABEL = 'com.debrief.worker';
const CLI = fileURLToPath(new URL('../bin/debrief.mjs', import.meta.url));

export const logPath = () => join(debriefHome(), 'worker.log');
export const pidPath = () => join(debriefHome(), 'worker.pid');

export function servicePaths() {
  return {
    win32: join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Debrief worker.vbs'),
    darwin: join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`),
    linux: join(homedir(), '.config', 'systemd', 'user', 'debrief-worker.service'),
  };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The autostart file for this platform. args: e.g. ['worker'] or ['solo']. */
export function serviceFile(platform, { node = process.execPath, cli = CLI, args = ['worker'], log = logPath(), path = process.env.PATH || '', home = debriefHome() } = {}) {
  const argv = [node, cli, ...args, '--log', log];
  if (platform === 'win32') {
    // A .vbs launcher runs node with no console window (style 0). Quotes are doubled inside VBScript strings.
    const cmd = argv.map((a) => `""${a}""`).join(' ');
    return `' Starts the Debrief worker at login with no window. Remove with: debrief service uninstall\r\nSet sh = CreateObject("WScript.Shell")\r\nsh.Environment("Process")("DEBRIEF_HOME") = "${home}"\r\nsh.Run "${cmd}", 0, False\r\n`;
  }
  if (platform === 'darwin') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${argv.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path)}</string><key>DEBRIEF_HOME</key><string>${xml(home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
</dict>
</plist>
`;
  }
  const q = (a) => (/[\s"\\]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a);
  return `[Unit]
Description=Debrief review worker
After=network-online.target

[Service]
ExecStart=${argv.map(q).join(' ')}
Environment=${q(`PATH=${path}`)}
Environment=${q(`DEBRIEF_HOME=${home}`)}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

// ---- single instance ---------------------------------------------------------------------------------

/** True if pid is alive and is a Debrief process (pids get reused, so check the command line). */
export function isDebriefProcess(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  let cmd = '';
  try {
    if (P === 'win32') {
      cmd = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true }).stdout || '';
    } else if (existsSync(`/proc/${pid}/cmdline`)) {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } else {
      cmd = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout || '';
    }
  } catch {
    return false;
  }
  return /debrief/i.test(cmd) && /\b(worker|solo)\b/.test(cmd);
}

export function runningPid() {
  try {
    const { pid } = JSON.parse(readFileSync(pidPath(), 'utf8'));
    return isDebriefProcess(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Called by `debrief worker` / `debrief solo`: refuse to start a second copy, and record our pid. */
export function claimSingleInstance(mode) {
  const other = runningPid();
  if (other && other !== process.pid) {
    throw new Error(`A Debrief worker is already running (process ${other}). Two workers for the same pairing would fight over the connection.\nStop it with: debrief service stop`);
  }
  mkdirSync(debriefHome(), { recursive: true });
  writeFileSync(pidPath(), JSON.stringify({ pid: process.pid, mode, startedAt: Date.now() }));
  process.on('exit', () => {
    try {
      if (JSON.parse(readFileSync(pidPath(), 'utf8')).pid === process.pid) unlinkSync(pidPath());
    } catch {}
  });
}

// ---- logging -----------------------------------------------------------------------------------------

/** Send console output to a log file (rotated at 5 MB) when running in the background. */
export function logToFile(file) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    if (statSync(file).size > 5e6) renameSync(file, `${file}.old`);
  } catch {}
  const fd = openSync(file, 'a');
  const write = (level, args) => {
    const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    try {
      writeFileSync(fd, `${new Date().toISOString()} ${level} ${text}\n`);
    } catch {}
  };
  console.log = (...a) => write('info', a);
  console.error = (...a) => write('error', a);
  console.warn = (...a) => write('warn', a);
  process.on('uncaughtException', (err) => {
    write('fatal', [err]);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => write('error', ['unhandled rejection:', err]));
}

export function tailLog(lines = 40) {
  const file = logPath();
  if (!existsSync(file)) return '';
  const size = statSync(file).size;
  const len = Math.min(size, 64 * 1024);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  readSync(fd, buf, 0, len, size - len);
  closeSync(fd);
  return buf.toString('utf8').split('\n').slice(-lines - 1).join('\n').trim();
}

// ---- commands ----------------------------------------------------------------------------------------

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout;
}

export async function stopService({ quiet = false } = {}) {
  if (P === 'darwin' && existsSync(servicePaths().darwin)) spawnSync('launchctl', ['unload', servicePaths().darwin]);
  if (P === 'linux' && existsSync(servicePaths().linux)) spawnSync('systemctl', ['--user', 'stop', 'debrief-worker']);
  const pid = runningPid();
  if (pid) {
    try {
      process.kill(pid);
    } catch {}
    for (let i = 0; i < 20 && isDebriefProcess(pid); i++) await sleep(250);
  }
  if (!quiet) console.log(pid ? `Stopped the worker (process ${pid}).` : 'No worker was running.');
}

export async function startService() {
  const paths = servicePaths();
  if (P === 'win32') {
    if (!existsSync(paths.win32)) throw new Error('The service is not installed. Run: debrief service install');
    spawn('wscript.exe', [paths.win32], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (P === 'darwin') {
    sh('launchctl', ['load', '-w', paths.darwin]);
  } else {
    sh('systemctl', ['--user', 'enable', '--now', 'debrief-worker']);
  }
  for (let i = 0; i < 40 && !runningPid(); i++) await sleep(250);
  const pid = runningPid();
  if (!pid) throw new Error(`The worker didn't start. Check the log: ${logPath()}`);
  return pid;
}

/**
 * Problems that would make a background worker quit at once, where nobody can see why. Returns a message or null.
 */
export function preflight({ solo = false } = {}) {
  if (solo) {
    if (!loadHubConfig().discordToken) return 'Solo mode has no bot token yet. Run `debrief solo --token <bot token>` once in this window first, then run this again.';
    return null;
  }
  const cfg = loadConfig();
  if (!cfg.hubUrl) {
    return 'No team hub is set for this worker.\n  • Using your own bot (solo mode)? Run:  debrief service install --solo\n  • Joining a team hub? Run  debrief worker --hub wss://<hub address>  once, pair it with /debrief link, then run this again.';
  }
  if (!(cfg.tokens?.[cfg.hubUrl] || cfg.token)) {
    return `This worker isn't paired with ${cfg.hubUrl} yet, and in the background you couldn't see the pairing code.\n  Run  debrief worker  once in this window, use /debrief link code:<code> in Discord, then press Ctrl+C and run this again.`;
  }
  return null;
}

function logSince(offset) {
  try {
    const size = statSync(logPath()).size;
    const fd = openSync(logPath(), 'r');
    const len = Math.min(size - offset, 16 * 1024);
    const buf = Buffer.alloc(Math.max(0, len));
    if (len > 0) readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    return buf.toString('utf8').trim();
  } catch {
    return '';
  }
}

export async function installService({ solo = false } = {}) {
  const problem = preflight({ solo });
  if (problem) throw new Error(problem);
  const file = servicePaths()[P] || servicePaths().linux;
  await stopService({ quiet: true });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serviceFile(P === 'win32' || P === 'darwin' ? P : 'linux', { args: [solo ? 'solo' : 'worker'] }));
  if (P === 'linux') sh('systemctl', ['--user', 'daemon-reload']);
  let offset = 0;
  try {
    offset = statSync(logPath()).size;
  } catch {}
  let pid;
  try {
    pid = await startService();
  } catch (err) {
    // Don't leave a launcher behind that fails silently at every login.
    await uninstallService({ quiet: true });
    const log = logSince(offset);
    throw new Error(`The background worker stopped straight after starting, so I removed it again.${log ? `\nIt said:\n${log.split('\n').slice(-12).map((l) => `  ${l}`).join('\n')}` : `\nNothing was written to ${logPath()}. Try running  debrief ${solo ? 'solo' : 'worker'}  in this window to see the error.`}`);
  }
  console.log(`✅ Debrief ${solo ? 'solo mode' : 'worker'} is running in the background (process ${pid}) and will start at login.`);
  console.log(`   You can close this window. Log: ${logPath()}`);
  console.log('   debrief service status · debrief service stop · debrief service uninstall');
  if (P === 'linux') console.log('   To keep it running while you are logged out: loginctl enable-linger $USER');
}

export async function uninstallService({ quiet = false } = {}) {
  await stopService({ quiet: true });
  const file = servicePaths()[P] || servicePaths().linux;
  if (P === 'linux' && existsSync(file)) spawnSync('systemctl', ['--user', 'disable', 'debrief-worker']);
  rmSync(file, { force: true });
  if (P === 'linux') spawnSync('systemctl', ['--user', 'daemon-reload']);
  if (!quiet) console.log('Removed the background worker. It will no longer start at login.');
}

export function serviceStatus() {
  const file = servicePaths()[P] || servicePaths().linux;
  const pid = runningPid();
  let mode = '';
  try {
    mode = JSON.parse(readFileSync(pidPath(), 'utf8')).mode;
  } catch {}
  console.log(`Running:            ${pid ? `yes, ${mode || 'worker'} (process ${pid})` : 'no'}`);
  console.log(`Starts at login:    ${existsSync(file) ? `yes (${file})` : 'no (debrief service install)'}`);
  console.log(`Log:                ${logPath()}`);
  const tail = tailLog(15);
  if (tail) console.log(`\nRecent log:\n${tail}`);
}
