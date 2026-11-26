// Worker settings in ~/.debrief/config.json (design §9) and hub settings in ~/.debrief/hub.config.json.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { debriefHome } from './util.mjs';

export const WORKER_DEFAULTS = {
  hubUrl: '',
  token: '',
  workerName: hostname(),
  model: 'sonnet',
  frameBudget: 60,
  speechAnchoredFrames: true,
  longVideoMinutes: 30,
  chapterLength: 900,
  whisperDir: '',
  whisperVad: true,
  language: 'en',
  cacheRetentionDays: 14,
  maxConcurrentJobs: 1,
  allowedHosts: [],
  claudeProfiles: [],
  youtubeCookiesFromBrowser: '',
  tracker: { mcpConfig: '', allowedTools: [] },
};

export const configPath = () => process.env.DEBRIEF_CONFIG || join(debriefHome(), 'config.json');

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}

function writePrivate(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {}
}

export function loadConfig(path = configPath()) {
  const raw = readJson(path);
  return { ...WORKER_DEFAULTS, ...raw, tracker: { ...WORKER_DEFAULTS.tracker, ...(raw.tracker || {}) } };
}

/** Merge a patch into the saved config (only the keys given), keeping anything the user added by hand. */
export function saveConfig(patch, path = configPath()) {
  const current = readJson(path);
  const next = { ...current, ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  writePrivate(path, next);
  return loadConfig(path);
}

export const HUB_DEFAULTS = {
  discordToken: '',
  port: 8787,
  host: '0.0.0.0',
  publicUrl: '',
  dataFile: '',
  messageContent: true,
  jobExpiryHours: 24,
  jobRetentionDays: 30,
};

export const hubConfigPath = () => process.env.DEBRIEF_HUB_CONFIG || join(debriefHome(), 'hub.config.json');

/** Hub settings: file first, then environment variables (Docker-friendly). */
export function loadHubConfig(path = hubConfigPath()) {
  const raw = readJson(path);
  const env = process.env;
  const cfg = { ...HUB_DEFAULTS, ...raw };
  if (env.DISCORD_TOKEN) cfg.discordToken = env.DISCORD_TOKEN;
  if (env.DEBRIEF_PORT) cfg.port = Number(env.DEBRIEF_PORT);
  if (env.DEBRIEF_HOST) cfg.host = env.DEBRIEF_HOST;
  if (env.DEBRIEF_PUBLIC_URL) cfg.publicUrl = env.DEBRIEF_PUBLIC_URL;
  if (env.DEBRIEF_DATA) cfg.dataFile = env.DEBRIEF_DATA;
  if (env.DEBRIEF_MESSAGE_CONTENT) cfg.messageContent = env.DEBRIEF_MESSAGE_CONTENT !== 'false';
  cfg.dataFile ||= join(debriefHome(), 'hub.json');
  return cfg;
}

export function saveHubConfig(patch, path = hubConfigPath()) {
  writePrivate(path, { ...readJson(path), ...patch });
}
