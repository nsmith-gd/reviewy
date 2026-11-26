// Local transcription with whisper.cpp, plus the hallucination guards Ballast uses.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IS_WIN, debriefHome, run, which } from '../util.mjs';

const EXE = IS_WIN ? 'whisper-cli.exe' : 'whisper-cli';

/** Directories searched for whisper.cpp, in order. Ballast's install is reused when present (design §14). */
export function whisperDirs(configured) {
  return [configured, join(debriefHome(), 'whisper'), join(homedir(), '.ballast', 'whisper')].filter(Boolean);
}

function findFile(dir, test, depth = 3) {
  if (!dir || !existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.isFile() && test(e.name)) return join(dir, e.name);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const hit = findFile(join(dir, e.name), test, depth - 1);
    if (hit) return hit;
  }
  return null;
}

const MODEL_PREFERENCE = ['large-v3-turbo-q8_0', 'large-v3-turbo', 'large-v3', 'medium', 'small', 'base', 'tiny'];

/** Locate whisper-cli, a ggml model and (optionally) the Silero VAD model. Returns null fields when missing. */
export async function locateWhisper(cfg = {}) {
  const dirs = whisperDirs(cfg.whisperDir);
  let cli = cfg.whisperCli && existsSync(cfg.whisperCli) ? cfg.whisperCli : null;
  for (const d of dirs) cli ||= findFile(d, (n) => n === EXE);
  cli ||= await which('whisper-cli');

  let model = cfg.whisperModel && existsSync(cfg.whisperModel) ? cfg.whisperModel : null;
  if (!model) {
    const models = [];
    for (const d of dirs) {
      const found = [];
      const walk = (dir, depth) => {
        if (!existsSync(dir) || depth < 0) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isFile() && /^ggml-.*\.bin$/.test(e.name) && !/silero/i.test(e.name)) found.push(join(dir, e.name));
          else if (e.isDirectory() && !e.name.startsWith('.')) walk(join(dir, e.name), depth - 1);
        }
      };
      try {
        walk(d, 2);
      } catch {}
      models.push(...found);
    }
    const rank = (p) => {
      const i = MODEL_PREFERENCE.findIndex((m) => p.includes(`ggml-${m}`));
      return i === -1 ? 99 : i;
    };
    model = models.sort((a, b) => rank(a) - rank(b))[0] || null;
  }

  let vad = null;
  for (const d of dirs) vad ||= findFile(d, (n) => /silero.*\.bin$/i.test(n));
  return { cli, model, vad };
}

// Lines whisper produces from silence or music. Matched against the whole line, case-insensitive.
const NOISE = [
  /^\[?\(?(music|applause|laughter|silence|blank_audio|no speech|inaudible|noise|background noise)\)?\]?\.?$/i,
  /^thank(s| you)( so much)? for watching[.!]?$/i,
  /^(please )?(like and )?subscribe[.!]?$/i,
  /^subtitles? (by|from) .*$/i,
  /^transcri(bed|ption) by .*$/i,
  /^amara\.org.*$/i,
  /^\.+$/,
  /^you$/i,
  /^♪+.*♪*$/,
];

export function isNoiseLine(text) {
  const t = String(text).trim();
  return !t || NOISE.some((re) => re.test(t));
}

/**
 * Apply the guards: drop stock noise lines, then flag the transcript unreliable when more than 30% of the
 * remaining lines are repeats (whisper's classic loop failure).
 */
export function guardTranscript(segments) {
  const kept = segments.filter((s) => !isNoiseLine(s.text)).map((s) => ({ ...s, text: s.text.trim() }));
  const seen = new Map();
  let repeats = 0;
  for (const s of kept) {
    const key = s.text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
    if (!key) continue;
    if (seen.has(key)) repeats++;
    seen.set(key, true);
  }
  const ratio = kept.length ? repeats / kept.length : 0;
  return { segments: kept, unreliable: kept.length >= 5 && ratio > 0.3, repeatRatio: ratio };
}

/** Build whisper's initial prompt from the project glossary and the reviewer's context line. */
export function whisperPrompt({ glossary = [], context = '', projectName = '' } = {}) {
  const terms = [projectName, ...glossary].filter(Boolean);
  const parts = [];
  if (terms.length) parts.push(`Terms: ${terms.join(', ')}.`);
  if (context) parts.push(context.trim());
  // whisper.cpp only uses the last ~224 tokens of the prompt, so keep it short.
  return parts.join(' ').slice(0, 600);
}

/** Parse whisper-cli -oj output into [{start, end, text}] in seconds. */
export function parseWhisperJson(json) {
  const list = json?.transcription || [];
  return list
    .map((s) => ({
      start: (s.offsets?.from ?? 0) / 1000,
      end: (s.offsets?.to ?? 0) / 1000,
      text: String(s.text || '').trim(),
    }))
    .filter((s) => s.text);
}

/**
 * Transcribe a 16 kHz mono WAV. Returns {segments, unreliable, language}.
 * Uses Silero VAD when the model is installed, which removes most hallucinated filler in silences.
 */
export async function transcribe(wavPath, outBase, { cfg = {}, language = 'en', prompt = '', signal, onProgress } = {}) {
  const w = await locateWhisper(cfg);
  if (!w.cli || !w.model) throw new Error('whisper.cpp is not installed (whisper-cli or a ggml model is missing). Run `debrief doctor`.');
  const args = ['-m', w.model, '-f', wavPath, '-l', language || 'auto', '-oj', '-of', outBase, '-pp', '-np'];
  if (cfg.whisperThreads) args.push('-t', String(cfg.whisperThreads));
  if (prompt) args.push('--prompt', prompt);
  if (w.vad) args.push('--vad', '--vad-model', w.vad);
  await run(w.cli, args, {
    signal,
    onLine: (line) => {
      const m = line.match(/progress\s*=\s*(\d+)%/);
      if (m) onProgress?.(Number(m[1]) / 100);
    },
  });
  const json = JSON.parse(readFileSync(`${outBase}.json`, 'utf8'));
  const guarded = guardTranscript(parseWhisperJson(json));
  return { ...guarded, language: json?.result?.language || language, model: w.model.replace(/^.*[\\/]/, ''), vad: Boolean(w.vad) };
}
