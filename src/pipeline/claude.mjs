// Headless Claude Code runner (design §11): `claude -p` with stream-json output, no session persistence,
// structured output via --json-schema, and a locked-down toolset.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debriefHome, run } from '../util.mjs';

/**
 * Account profiles. Each is {name, configDir?, env?, apiKeyEnv?}. configDir maps to CLAUDE_CONFIG_DIR, which is
 * how Claude Code keeps separate logins. apiKeyEnv names an environment variable holding an API key, for
 * reviewers who prefer API billing; the key itself never goes in the config file.
 */
export function profilesFrom(cfg = {}) {
  const list = Array.isArray(cfg.claudeProfiles) && cfg.claudeProfiles.length ? cfg.claudeProfiles : [{ name: 'default' }];
  return list.map((p, i) => ({ name: p.name || `profile${i + 1}`, ...p }));
}

function profileEnv(p) {
  const env = { ...(p.env || {}) };
  if (p.configDir) env.CLAUDE_CONFIG_DIR = p.configDir;
  if (p.apiKeyEnv && process.env[p.apiKeyEnv]) env.ANTHROPIC_API_KEY = process.env[p.apiKeyEnv];
  return env;
}

// Last known usage per profile, from Claude Code's rate_limit_event. Persisted so a restart keeps it.
const usagePath = () => join(debriefHome(), 'usage.json');
let usage = null;
function loadUsage() {
  if (usage) return usage;
  try {
    usage = JSON.parse(readFileSync(usagePath(), 'utf8'));
  } catch {
    usage = {};
  }
  return usage;
}
function saveUsage() {
  try {
    mkdirSync(debriefHome(), { recursive: true });
    writeFileSync(usagePath(), JSON.stringify(usage, null, 2));
  } catch {}
}

export function recordUsage(profileName, info) {
  const u = loadUsage();
  const windows = info?.unifiedWindows || {};
  const util = Math.max(0, ...Object.values(windows).map((w) => Number(w?.utilization) || 0));
  const blocked = info?.status && info.status !== 'allowed';
  const resetsAt = Math.max(0, ...Object.values(windows).map((w) => Number(w?.resetsAt) || 0), Number(info?.resetsAt) || 0);
  u[profileName] = { utilization: util, blockedUntil: blocked ? resetsAt * 1000 : 0, at: Date.now() };
  saveUsage();
}

/** Ballast's pickAccount: the profile with the most room left, skipping any that are rate-limited right now. */
export function pickProfile(profiles, now = Date.now(), usageTable = loadUsage()) {
  const scored = profiles.map((p, i) => {
    const u = usageTable[p.name] || {};
    const blocked = u.blockedUntil && u.blockedUntil > now;
    return { p, i, blocked, util: u.utilization ?? 0 };
  });
  const open = scored.filter((s) => !s.blocked);
  const pool = open.length ? open : scored;
  pool.sort((a, b) => a.util - b.util || a.i - b.i);
  return pool[0].p;
}

export function isRateLimitError(text) {
  return /rate.?limit|usage limit|limit reached|429|overloaded|quota/i.test(String(text || ''));
}

/**
 * Run one headless Claude Code call.
 * opts: {prompt, schema?, tools: [] (default none), allowedTools?, addDirs: [], cwd, model, cfg, signal,
 *        onEvent?, mcpConfig?, userMcp? (keep the user's own MCP servers), systemPrompt?, timeoutMs?}
 * Returns {structured, text, profile, model, costUsd, turns}.
 * Tries the next profile when one is rate-limited.
 */
export async function runClaude(opts) {
  const profiles = profilesFrom(opts.cfg);
  const tried = new Set();
  let lastErr;
  while (tried.size < profiles.length) {
    const remaining = profiles.filter((p) => !tried.has(p.name));
    const profile = pickProfile(remaining);
    tried.add(profile.name);
    try {
      return await runOnce(opts, profile);
    } catch (err) {
      lastErr = err;
      if (err.cancelled || !err.rateLimited) throw err;
    }
  }
  throw lastErr;
}

function buildArgs(opts) {
  const tools = opts.tools ?? [];
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', opts.model || 'sonnet'];
  args.push('--tools', tools.length ? tools.join(',') : '');
  if (opts.allowedTools?.length || tools.length) args.push('--allowedTools', (opts.allowedTools || tools).join(','));
  args.push('--permission-mode', 'dontAsk');
  for (const d of opts.addDirs || []) args.push('--add-dir', d);
  if (opts.schema) args.push('--json-schema', JSON.stringify(opts.schema));
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig);
  else if (!opts.userMcp) args.push('--strict-mcp-config'); // Review runs get no MCP servers at all.
  return args;
}

async function runOnce(opts, profile) {
  const args = buildArgs(opts);
  let result = null;
  let model = opts.model || 'sonnet';
  let lastText = '';
  let rateInfo = null;
  const bin = opts.cfg?.claudeBin || 'claude';
  let proc;
  try {
    proc = await run(bin, args, {
      cwd: opts.cwd,
      env: profileEnv(profile),
      input: opts.prompt, // Prompt on stdin: no command-line length limits (Windows caps at ~32k).
      signal: opts.signal,
      timeoutMs: opts.timeoutMs || 30 * 60_000,
      allowFail: true,
      onLine: (line, stream) => {
        if (stream !== 'stdout' || line[0] !== '{') return;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === 'system' && ev.subtype === 'init' && ev.model) model = ev.model;
        if (ev.type === 'rate_limit_event') rateInfo = ev.rate_limit_info;
        if (ev.type === 'assistant') {
          for (const c of ev.message?.content || []) if (c.type === 'text' && c.text) lastText = c.text;
        }
        if (ev.type === 'result') result = ev;
        opts.onEvent?.(ev);
      },
    });
  } finally {
    if (rateInfo) recordUsage(profile.name, rateInfo);
  }
  if (!result || result.is_error || proc.code !== 0) {
    const detail = result?.result || result?.api_error_status || proc.stderr.trim().split('\n').slice(-5).join('\n') || `exit code ${proc.code}`;
    const err = new Error(`Claude Code failed (${profile.name}): ${detail}`);
    err.rateLimited = isRateLimitError(detail) || (rateInfo && rateInfo.status !== 'allowed');
    if (err.rateLimited) recordUsage(profile.name, { ...(rateInfo || {}), status: 'rejected', resetsAt: rateInfo?.resetsAt || Date.now() / 1000 + 3600 });
    throw err;
  }
  let structured = result.structured_output ?? null;
  if (opts.schema && structured == null) {
    try {
      structured = JSON.parse(result.result);
    } catch {
      throw new Error('Claude Code did not return the structured review.');
    }
  }
  return {
    structured,
    text: typeof result.result === 'string' ? result.result : lastText,
    profile: profile.name,
    model,
    costUsd: result.total_cost_usd || 0,
    turns: result.num_turns || 0,
  };
}

/** Quick health check used by `debrief doctor --deep`. */
export async function claudeVersion(cfg = {}) {
  try {
    const { stdout } = await run(cfg.claudeBin || 'claude', ['--version'], { timeoutMs: 20_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}
