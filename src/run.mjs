// Entry points for `debrief hub`, `debrief worker`, `debrief solo` and `debrief unlink`.
import { join } from 'node:path';
import WebSocket from 'ws';
import { loadConfig, loadHubConfig, saveConfig, saveHubConfig } from './config.mjs';
import { HubCore } from './hub/core.mjs';
import { DiscordFront } from './hub/discord.mjs';
import { Store } from './hub/store.mjs';
import { Worker } from './worker/worker.mjs';
import { debriefHome } from './util.mjs';

function buildHub({ dataFile, hubCfg }) {
  const store = new Store(dataFile);
  const front = new DiscordFront({ store, cfg: hubCfg });
  const core = new HubCore({ store, front, jobExpiryHours: hubCfg.jobExpiryHours, jobRetentionDays: hubCfg.jobRetentionDays });
  front.core = core;
  return { store, front, core };
}

function onShutdown(fn) {
  let closing = false;
  const handler = async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log('\nShutting down…');
    try {
      await fn();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

export async function startHub(opts = {}) {
  if (opts.token) saveHubConfig({ discordToken: opts.token });
  const hubCfg = loadHubConfig();
  if (opts.port) hubCfg.port = Number(opts.port);
  if (!hubCfg.discordToken) throw new Error('No Discord bot token. Pass --token <token> once (it is saved to ~/.debrief/hub.config.json) or set DISCORD_TOKEN.');
  const { core, front } = buildHub({ dataFile: hubCfg.dataFile, hubCfg });
  const port = await core.listen({ port: hubCfg.port, host: hubCfg.host });
  console.log(`[hub] workers connect to ws://<this machine>:${port}  (put it behind TLS for wss://, see README)`);
  await front.start(hubCfg.discordToken);
  onShutdown(async () => {
    await front.destroy();
    await core.close();
  });
}

export async function startWorker(opts = {}) {
  const patch = {};
  if (opts.hub) patch.hubUrl = opts.hub;
  if (opts.name) patch.workerName = opts.name;
  const cfg = Object.keys(patch).length ? saveConfig(patch) : loadConfig();
  if (!cfg.hubUrl) throw new Error('No hub URL. Run: debrief worker --hub wss://<your team\'s hub>   (ask whoever runs your hub), or use `debrief solo`.');
  const worker = new Worker({ hubUrl: cfg.hubUrl, cfg });
  await worker.start();
  console.log(`[worker] ${cfg.workerName} → ${cfg.hubUrl}`);
  onShutdown(() => worker.stop());
}

/** Solo mode (design §4): the hub and a worker in one process, with the user's own bot token. */
export async function startSolo(opts = {}) {
  if (opts.token) saveHubConfig({ discordToken: opts.token });
  const hubCfg = loadHubConfig();
  if (!hubCfg.discordToken) throw new Error('No Discord bot token. Run `debrief solo --token <token>` once (see README: "Create your Discord bot").');
  const { core, front } = buildHub({ dataFile: join(debriefHome(), 'solo-hub.json'), hubCfg });
  const port = await core.listen({ port: 0, host: '127.0.0.1' });

  let code = null;
  let discordReady = false;
  const autoPair = async () => {
    if (!code || !discordReady) return;
    const owner = await front.owner().catch(() => null);
    if (!owner) {
      console.log(`[solo] In Discord, run  /debrief link code:${code}  to pair yourself.`);
      return;
    }
    const r = core.link(code, { id: owner.id, tag: owner.globalName || owner.username });
    if (r.ok) console.log(`[solo] Paired to the bot owner, ${owner.globalName || owner.username}. Use /review in any server the bot is in.`);
    code = null;
  };
  front.onReady = () => {
    discordReady = true;
    autoPair();
  };
  const cfg = loadConfig();
  const worker = new Worker({
    hubUrl: `ws://127.0.0.1:${port}`,
    tokenKey: 'solo',
    cfg,
    onCode: (c) => {
      code = c;
      autoPair();
    },
  });
  await worker.start();
  await front.start(hubCfg.discordToken);
  onShutdown(async () => {
    worker.stop();
    await front.destroy();
    await core.close();
  });
}

/** `debrief unlink`: ask the hub to drop this worker's pairing, then forget the token locally. */
export async function unlink() {
  const cfg = loadConfig();
  const token = cfg.tokens?.[cfg.hubUrl] || cfg.token;
  if (!cfg.hubUrl || !token) {
    console.log('This worker is not paired with a hub.');
    return;
  }
  await new Promise((resolve) => {
    const ws = new WebSocket(`${cfg.hubUrl.replace(/\/+$/, '')}/worker`);
    const done = () => {
      ws.terminate();
      resolve();
    };
    const timer = setTimeout(() => {
      console.log('Could not reach the hub; removing the local pairing only. Use /debrief forget in Discord to remove it on the hub.');
      done();
    }, 10_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, name: cfg.workerName })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'welcome') {
        ws.send(JSON.stringify({ type: 'unlink' }));
        console.log('Unpaired on the hub.');
        clearTimeout(timer);
        setTimeout(done, 300);
      } else if (m.type === 'revoked') {
        clearTimeout(timer);
        done();
      }
    });
    ws.on('error', () => {});
  });
  const tokens = { ...(cfg.tokens || {}) };
  delete tokens[cfg.hubUrl];
  saveConfig({ tokens, token: undefined });
  console.log('Local pairing removed.');
}
