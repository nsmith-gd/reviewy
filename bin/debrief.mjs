#!/usr/bin/env node
// Debrief CLI.
import { parseArgs } from 'node:util';
import { configPath, loadConfig, saveConfig } from '../src/config.mjs';
import { diagnoseTranscript } from '../src/diagnose.mjs';
import { doctor, installWhisper } from '../src/doctor.mjs';
import { startHub, startSolo, startWorker, unlink } from '../src/run.mjs';
import { VERSION } from '../src/version.mjs';

const HELP = `debrief ${VERSION}: video review notes in Discord from your own Claude Code

Usage:
  debrief worker [--hub <url>] [--name <name>]   Run your worker (pairs on first run)
  debrief solo [--token <bot token>]             Hub + worker in one process, with your own bot
  debrief hub [--token <bot token>] [--port N]   Run the team hub (Discord bot + worker server)
  debrief doctor [--deep]                        Check dependencies (--deep also tests the Claude login)
  debrief whisper install [--model <name>]       Download whisper.cpp model + VAD (and whisper.cpp on Windows)
  debrief transcribe <link|file> [--glossary a,b] [--language en] [--keep]
                                                 Diagnose a bad transcript: audio levels, Whisper with/without VAD
  debrief config [key] [value]                   Show or change a worker setting
  debrief unlink                                 Unpair this worker from its hub

Docs: README.md`;

const [cmd, ...rest] = process.argv.slice(2);

function opts(spec) {
  return parseArgs({ args: rest, options: spec, allowPositionals: true });
}

function parseValue(v) {
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^[[{]/.test(v)) return JSON.parse(v);
  return v;
}

try {
  switch (cmd) {
    case 'worker': {
      const { values } = opts({ hub: { type: 'string' }, name: { type: 'string' } });
      await startWorker(values);
      break;
    }
    case 'solo': {
      const { values } = opts({ token: { type: 'string' } });
      await startSolo(values);
      break;
    }
    case 'hub': {
      const { values } = opts({ token: { type: 'string' }, port: { type: 'string' } });
      await startHub(values);
      break;
    }
    case 'doctor': {
      const { values } = opts({ deep: { type: 'boolean' } });
      process.exitCode = (await doctor(values)) ? 0 : 1;
      break;
    }
    case 'whisper': {
      const { values, positionals } = opts({ model: { type: 'string' }, 'no-vad': { type: 'boolean' } });
      if (positionals[0] !== 'install') throw new Error('Usage: debrief whisper install [--model large-v3-turbo-q8_0|small|base…] [--no-vad]');
      await installWhisper({ model: values.model, vad: !values['no-vad'] });
      break;
    }
    case 'transcribe': {
      const { values, positionals } = opts({ language: { type: 'string' }, glossary: { type: 'string' }, keep: { type: 'boolean' } });
      if (!positionals[0]) throw new Error('Usage: debrief transcribe <youtube link | drive link | video file>');
      await diagnoseTranscript(positionals[0], { language: values.language, glossary: (values.glossary || '').split(',').map((x) => x.trim()).filter(Boolean), keep: values.keep });
      break;
    }
    case 'config': {
      const [key, value] = rest;
      if (!key) {
        const cfg = loadConfig();
        const shown = { ...cfg, token: cfg.token ? '(set)' : '', tokens: Object.fromEntries(Object.keys(cfg.tokens || {}).map((k) => [k, '(set)'])) };
        console.log(`${configPath()}\n${JSON.stringify(shown, null, 2)}`);
      } else if (value === undefined) {
        console.log(JSON.stringify(loadConfig()[key], null, 2));
      } else {
        if (key === 'token' || key === 'tokens') throw new Error('Pair with /debrief link instead of setting tokens by hand.');
        saveConfig({ [key]: parseValue(value) });
        console.log(`Set ${key}.`);
      }
      break;
    }
    case 'unlink':
      await unlink();
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      break;
    default:
      console.log(HELP);
      if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1;
  }
} catch (err) {
  console.error(`debrief: ${err.message}`);
  process.exit(1);
}
