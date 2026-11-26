// `debrief transcribe <link|file>`: run just the audio half of the pipeline and explain what Whisper heard.
// For when a transcript comes back empty or nonsensical.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { detectSource, fetchSource } from './pipeline/fetch.mjs';
import { audioStats, extractAudio, probe } from './pipeline/media.mjs';
import { SPARSE_WPM, locateWhisper, transcribe, whisperPrompt } from './pipeline/whisper.mjs';
import { debriefHome, fmtTime, newId } from './util.mjs';

function show(label, tx) {
  console.log(`\n── ${label}: ${tx.segments.length} lines, ${tx.words} words${tx.wpm != null ? `, ${Math.round(tx.wpm)} words/min` : ''}${tx.issue ? `  ⚠️ ${tx.issue}` : ''}`);
  for (const s of tx.segments.slice(0, 40)) console.log(`  [${fmtTime(s.start)}] ${s.text}`);
  if (tx.segments.length > 40) console.log(`  … ${tx.segments.length - 40} more lines`);
}

export async function diagnoseTranscript(input, { language, glossary = [], keep = false } = {}) {
  const cfg = loadConfig();
  const dir = join(debriefHome(), 'diagnose', newId(4));
  mkdirSync(dir, { recursive: true });
  try {
    let file;
    if (existsSync(input)) {
      file = resolve(input);
    } else {
      const source = detectSource(input, { anyHost: true });
      if (!source) throw new Error('Give a video file path or a YouTube / Drive / direct https link.');
      process.stdout.write('Downloading… ');
      ({ file } = await fetchSource(source, dir, { cfg, onProgress: () => {} }));
      console.log('done');
    }

    const info = await probe(file);
    console.log(`Video: ${fmtTime(info.duration)} long, ${info.width}x${info.height}, ${info.audioStreams} audio track(s)`);
    if (!info.hasAudio) {
      console.log('❌ This file has no audio track at all, so there is nothing to transcribe. Record with your microphone on.');
      return;
    }
    const wav = await extractAudio(file, join(dir, 'audio.wav'), { audioStreams: info.audioStreams });
    const st = await audioStats(wav);
    const soundPct = info.duration ? Math.max(0, Math.round(100 * (1 - st.silentSeconds / info.duration))) : 0;
    console.log(`Audio: mean ${st.meanDb} dB, peak ${st.maxDb} dB, sound (above -40 dB) for ~${soundPct}% of the video`);
    if (st.maxDb < -30) console.log('⚠️ The audio is very quiet. The microphone may not have been recorded.');

    const w = await locateWhisper(cfg);
    console.log(`Whisper: ${w.cli || 'whisper-cli NOT FOUND'}\nModel:   ${w.model || 'NOT FOUND'}\nVAD:     ${w.vad || 'not installed'}`);
    if (!w.cli || !w.model) return;

    const opts = { cfg, language: language || cfg.language || 'en', prompt: whisperPrompt({ glossary }), duration: info.duration };
    const runs = [];
    if (w.vad) runs.push(['With voice detection (what reviews use)', await transcribe(wav, join(dir, 'vad'), { ...opts, vad: true })]);
    runs.push([w.vad ? 'Without voice detection' : 'Whisper', await transcribe(wav, join(dir, 'novad'), { ...opts, vad: false })]);
    for (const [label, tx] of runs) show(label, tx);

    console.log('\n── What this suggests');
    const best = Math.max(...runs.map(([, t]) => t.words));
    const vadWords = w.vad ? runs[0][1].words : null;
    const novad = runs[runs.length - 1][1];
    if (best === 0 || (novad.wpm ?? 0) < SPARSE_WPM) {
      console.log(`Whisper hears almost no speech even without voice detection.${soundPct > 50 ? ' There is plenty of sound, so it is probably game audio or music without your voice.' : ''}`);
      console.log('Most likely the recording does not include your microphone. On Quest, turn on the microphone option when you start recording; in OBS, check the mic is an audio source on the recording track.');
    } else if (vadWords != null && vadWords < novad.words * 0.5) {
      console.log('Voice detection is throwing away most of the speech (probably because game audio is loud under your voice).');
      console.log('Turn it off for your worker:  debrief config whisperVad false');
    } else {
      console.log('Whisper hears speech normally. If the words are wrong, add names and jargon to the project glossary (/debrief setup project) or try a larger model (debrief whisper install).');
    }
    if (keep) console.log(`\nFiles kept in ${dir}`);
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}
