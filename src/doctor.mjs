// `debrief doctor` (design §14): check every dependency and print the install command for what's missing.
// `debrief whisper install` downloads the default model and the Silero VAD model (and, on Windows, whisper.cpp).
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { configPath, loadConfig } from './config.mjs';
import { runClaude } from './pipeline/claude.mjs';
import { locateWhisper } from './pipeline/whisper.mjs';
import { IS_WIN, debriefHome, run, which } from './util.mjs';

const P = process.platform;
const pick = (h) => (P === 'win32' ? h.win : P === 'darwin' ? h.mac : h.linux);

const HINTS = {
  ffmpeg: { win: 'winget install Gyan.FFmpeg', mac: 'brew install ffmpeg', linux: 'sudo apt install ffmpeg   (or your distro\'s package manager)' },
  ytdlp: { win: 'winget install yt-dlp.yt-dlp', mac: 'brew install yt-dlp', linux: 'python3 -m pip install -U yt-dlp   (or pipx install yt-dlp)' },
  whisper: {
    win: 'debrief whisper install   (downloads whisper.cpp, the model and the VAD model into ~/.debrief/whisper)',
    mac: 'brew install whisper-cpp && debrief whisper install',
    linux: 'build whisper.cpp (see README "Linux: building whisper.cpp"), then: debrief whisper install',
  },
  claude: { win: 'npm i -g @anthropic-ai/claude-code   then run `claude` once to log in', mac: 'npm i -g @anthropic-ai/claude-code   then run `claude` once to log in', linux: 'npm i -g @anthropic-ai/claude-code   then run `claude` once to log in' },
};

async function version(cmd, args = ['-version']) {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeoutMs: 20_000 });
    return (stdout || stderr).split('\n')[0].trim();
  } catch {
    return null;
  }
}

export async function doctor({ deep = false } = {}) {
  const cfg = loadConfig();
  const rows = [];
  const add = (ok, name, detail, hint) => rows.push({ ok, name, detail, hint });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20 ? true : false, 'Node.js', `v${process.versions.node}`, major >= 20 ? null : 'Install Node 20 or newer from https://nodejs.org');

  const ff = await version('ffmpeg');
  add(Boolean(ff), 'ffmpeg', ff || 'not found', ff ? null : pick(HINTS.ffmpeg));
  const fp = await version('ffprobe');
  add(Boolean(fp), 'ffprobe', fp || 'not found', fp ? null : pick(HINTS.ffmpeg));

  const yt = await version(cfg.ytDlp || 'yt-dlp', ['--version']);
  let ytOk = Boolean(yt);
  let ytHint = yt ? null : pick(HINTS.ytdlp);
  if (yt && /^\d{4}\.\d{2}\.\d{2}/.test(yt)) {
    const age = (Date.now() - new Date(yt.slice(0, 10).replace(/\./g, '-')).getTime()) / 86400_000;
    if (age > 60) {
      ytOk = 'warn';
      ytHint = `yt-dlp is ${Math.round(age)} days old; YouTube changes often break old versions. Update: ${P === 'win32' ? 'yt-dlp -U' : P === 'darwin' ? 'brew upgrade yt-dlp' : 'python3 -m pip install -U yt-dlp'}`;
    }
  }
  add(ytOk, 'yt-dlp', yt || 'not found', ytHint);

  const w = await locateWhisper(cfg);
  add(Boolean(w.cli), 'whisper-cli', w.cli || 'not found', w.cli ? null : pick(HINTS.whisper));
  add(Boolean(w.model), 'Whisper model', w.model || 'no ggml-*.bin found', w.model ? null : 'debrief whisper install');
  add(w.vad ? true : 'warn', 'Silero VAD (optional)', w.vad || 'not found (transcripts will have more filler in silences)', w.vad ? null : 'debrief whisper install');

  const cv = await version(cfg.claudeBin || 'claude', ['--version']);
  add(Boolean(cv), 'Claude Code', cv || 'not found', cv ? null : pick(HINTS.claude));
  if (cv && deep) {
    try {
      const r = await runClaude({ prompt: 'Reply with the single word: ok', tools: [], model: 'haiku', cfg, timeoutMs: 120_000 });
      add(true, 'Claude Code login', `works (${r.profile}, ${r.model})`);
    } catch (err) {
      add(false, 'Claude Code login', err.message.split('\n')[0], 'Run `claude` once and log in, or set up claudeProfiles in the config.');
    }
  }

  const paired = Boolean(cfg.hubUrl && (cfg.tokens?.[cfg.hubUrl] || cfg.token));
  add(cfg.hubUrl ? (paired ? true : 'warn') : 'warn', 'Hub', cfg.hubUrl ? `${cfg.hubUrl}${paired ? ' (paired)' : ' (not paired yet)'}` : 'not set (fine for solo mode)', cfg.hubUrl ? (paired ? null : 'debrief worker, then /debrief link code:<code> in Discord') : 'debrief worker --hub wss://<your hub>');

  for (const r of rows) {
    const icon = r.ok === true ? '✅' : r.ok === 'warn' ? '⚠️ ' : '❌';
    console.log(`${icon} ${r.name.padEnd(22)} ${r.detail}`);
    if (r.hint) console.log(`   ${' '.repeat(22)} → ${r.hint}`);
  }
  console.log(`\nConfig: ${configPath()}`);
  const required = rows.filter((r) => r.ok === false);
  if (!required.length) console.log('Everything needed is installed.' + (deep ? '' : ' Run `debrief doctor --deep` to also test your Claude Code login.'));
  return required.length === 0;
}

// ---- whisper install ---------------------------------------------------------------------------------

const MODEL_URL = (m) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${m}.bin`;
const VAD_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin';

async function download(url, out, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} from ${new URL(url).host}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let lastPct = -1;
  const counter = new TransformStream({
    transform(chunk, ctrl) {
      got += chunk.byteLength;
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct;
        process.stdout.write(`\r  ${label}: ${pct}% of ${(total / 1e6).toFixed(0)} MB   `);
      }
      ctrl.enqueue(chunk);
    },
  });
  const tmp = `${out}.part`;
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(tmp));
  renameSync(tmp, out);
  process.stdout.write('\n');
}

/** Windows: fetch the latest whisper.cpp release (CUDA build when an NVIDIA GPU is present) and unzip it. */
async function installWhisperWindows(dir) {
  const hasNvidia = Boolean(await which('nvidia-smi'));
  const rel = await (await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest', { headers: { 'user-agent': 'debrief' } })).json();
  const assets = rel.assets || [];
  const asset = (hasNvidia && assets.find((a) => /cublas-12.*x64\.zip$/i.test(a.name))) || assets.find((a) => /^whisper-bin-x64\.zip$/i.test(a.name));
  if (!asset) throw new Error('Could not find a Windows build in the latest whisper.cpp release. Download one by hand from https://github.com/ggml-org/whisper.cpp/releases into ~/.debrief/whisper.');
  const zip = join(dir, asset.name);
  await download(asset.browser_download_url, zip, asset.name);
  const bin = join(dir, 'bin');
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true });
  await run('tar', ['-xf', zip, '-C', bin]); // Windows 10+ ships bsdtar, which reads zip files.
  rmSync(zip, { force: true });
  console.log(`  whisper.cpp ${rel.tag_name} (${hasNvidia ? 'CUDA' : 'CPU'}) installed in ${bin}`);
}

export async function installWhisper({ model = 'large-v3-turbo-q8_0', vad = true } = {}) {
  const cfg = loadConfig();
  const dir = cfg.whisperDir || join(debriefHome(), 'whisper');
  mkdirSync(dir, { recursive: true });
  const found = await locateWhisper(cfg);
  if (!found.cli) {
    if (IS_WIN) await installWhisperWindows(dir);
    else if (P === 'darwin') console.log('whisper-cli not found. Install it with: brew install whisper-cpp');
    else console.log('whisper-cli not found. See README "Linux: building whisper.cpp".');
  } else {
    console.log(`  whisper-cli: ${found.cli}`);
  }
  const modelPath = join(dir, `ggml-${model}.bin`);
  if (existsSync(modelPath)) console.log(`  model already present: ${modelPath}`);
  else await download(MODEL_URL(model), modelPath, `ggml-${model}.bin`);
  if (vad) {
    const has = readdirSync(dir).some((f) => /silero.*\.bin$/i.test(f));
    if (has) console.log('  Silero VAD already present');
    else await download(VAD_URL, join(dir, 'ggml-silero-v5.1.2.bin'), 'Silero VAD');
  }
  console.log(`Done. Whisper files are in ${dir}`);
}
