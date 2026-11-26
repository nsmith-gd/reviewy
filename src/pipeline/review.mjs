// The review pipeline (design §5): fetch → probe → audio → transcribe → frames → Claude → fix times → files.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { combineChapters, segmentsIn, splitChapters } from './chapters.mjs';
import { runClaude } from './claude.mjs';
import { fetchSource } from './fetch.mjs';
import { extractAudio, grabFrames, probe, selectFrameTimes } from './media.mjs';
import { MERGE_SCHEMA, mergePrompt, reviewPrompt } from './prompt.mjs';
import { DEFAULT_DEPARTMENTS, fixTimes, normalizeReview, reviewJsonSchema } from './schema.mjs';
import { locateWhisper, transcribe, whisperPrompt } from './whisper.mjs';
import { reviewMarkdown, transcriptFile } from '../render/markdown.mjs';
import { debriefHome } from '../util.mjs';

export function cacheRoot(cfg = {}) {
  return cfg.cacheDir || join(debriefHome(), 'cache');
}
export function jobDir(cfg, jobId) {
  if (!/^[\w-]+$/.test(jobId)) throw new Error('Bad job id');
  return join(cacheRoot(cfg), jobId);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));

/** Load a finished job from the cache (follow-ups, transcript button, tracker). */
export function loadCachedJob(cfg, jobId) {
  const dir = jobDir(cfg, jobId);
  if (!existsSync(join(dir, 'review.json'))) return null;
  return {
    dir,
    framesDir: join(dir, 'frames'),
    review: readJson(join(dir, 'review.json')),
    meta: existsSync(join(dir, 'meta.json')) ? readJson(join(dir, 'meta.json')) : {},
    segments: existsSync(join(dir, 'transcript.json')) ? readJson(join(dir, 'transcript.json')).segments : [],
    frames: existsSync(join(dir, 'frames.json')) ? readJson(join(dir, 'frames.json')) : [],
  };
}

/**
 * Run one review.
 * job: {id, source, context, project: {name, glossary, departments, guidance, language}, frames: bool,
 *       reviewer, reuseFrom?}
 * progress(stage, {pct, text, title}) is called as stages advance.
 * Returns {review, meta, dir, files: {transcript, markdown}}.
 */
export async function reviewOne(job, { cfg = {}, progress = () => {}, signal } = {}) {
  const dir = jobDir(cfg, job.id);
  const framesDir = join(dir, 'frames');
  mkdirSync(framesDir, { recursive: true });
  const project = job.project || {};
  const departments = project.departments?.length ? project.departments : DEFAULT_DEPARTMENTS;
  const wantFrames = job.frames !== false;

  let info;
  let title = '';
  let segments = [];
  let tx = { unreliable: false, language: project.language, model: null, vad: false };
  let noWhisper = false;
  let frames = [];
  let videoFile = null;

  // Re-runs reuse the earlier job's transcript and frames when the worker still has them.
  const prev = job.reuseFrom ? safeJobDir(cfg, job.reuseFrom) : null;
  const canReuse = prev && existsSync(join(prev, 'transcript.json')) && existsSync(join(prev, 'meta.json')) &&
    (!wantFrames || existsSync(join(prev, 'frames.json')));

  if (canReuse) {
    progress('transcribing', { text: 'Reusing the earlier download and transcript' });
    const pm = readJson(join(prev, 'meta.json'));
    const pt = readJson(join(prev, 'transcript.json'));
    info = { duration: pm.duration, hasVideo: true, hasAudio: true };
    title = pm.title || '';
    segments = pt.segments;
    tx = { ...tx, ...pt.info };
    noWhisper = Boolean(pm.noWhisper);
    copyFileSync(join(prev, 'transcript.json'), join(dir, 'transcript.json'));
    if (wantFrames) {
      frames = readJson(join(prev, 'frames.json'));
      cpSync(join(prev, 'frames'), framesDir, { recursive: true });
    }
  } else {
    // 1. Fetch
    progress('downloading', { pct: 0 });
    const got = await fetchSource(job.source, dir, { cfg, signal, pool: Boolean(job.pool), onProgress: (pct) => progress('downloading', { pct }) });
    videoFile = got.file;
    // 2. Probe
    info = await probe(videoFile, { signal });
    title = got.title || info.title || '';
    progress('downloading', { pct: 1, title });
    if (!info.duration) throw new Error('Could not read the video\'s duration; the file may be damaged.');

    // 4–6. Audio, transcript and guards come before frames so frames can anchor on speech.
    if (info.hasAudio) {
      const w = await locateWhisper(cfg);
      if (w.cli && w.model) {
        progress('transcribing', { pct: 0 });
        const wav = await extractAudio(videoFile, join(dir, 'audio.wav'), { signal });
        tx = await transcribe(wav, join(dir, 'whisper'), {
          cfg,
          language: project.language || cfg.language || 'en',
          prompt: whisperPrompt({ glossary: project.glossary, context: job.context, projectName: project.name }),
          signal,
          onProgress: (pct) => progress('transcribing', { pct }),
        });
        segments = tx.segments;
        rmSync(wav, { force: true });
      } else {
        noWhisper = true;
      }
    }
    writeJson(join(dir, 'transcript.json'), { segments, info: { unreliable: tx.unreliable, language: tx.language, model: tx.model, vad: tx.vad } });

    // 3. Frames
    if (wantFrames && info.hasVideo) {
      progress('frames', { pct: 0 });
      const budget = cfg.frameBudget || 60;
      const chapters = longVideo(info.duration, cfg) ? splitChapters(info.duration, segments, { targetLen: cfg.chapterLength || 15 * 60 }) : [{ start: 0, end: info.duration }];
      const times = chapters.flatMap((c) =>
        selectFrameTimes(c.end - c.start, budget, cfg.speechAnchoredFrames === false ? [] : shift(segmentsIn(segments, c), -c.start)).map((t) => +(t + c.start).toFixed(3)),
      );
      frames = await grabFrames(videoFile, times, framesDir, { signal, onProgress: (pct) => progress('frames', { pct }) });
      writeJson(join(dir, 'frames.json'), frames);
    }
  }
  if (!segments.length && !frames.length) throw new Error('Nothing to review: no speech was transcribed and there are no frames.');

  // 7. Review with Claude Code
  const duration = info.duration;
  const chapters = longVideo(duration, cfg) ? splitChapters(duration, segments, { targetLen: cfg.chapterLength || 15 * 60 }) : [{ start: 0, end: duration }];
  const frameNames = new Set(frames.map((f) => f.name));
  const model = job.model || cfg.model || 'sonnet';
  const base = { context: job.context, project, departments, framesDir, duration, title, unreliable: tx.unreliable, reviewer: job.reviewer };
  let review;
  let runInfo;
  const reviewRange = async (range, label) => {
    const fr = frames.filter((f) => f.t >= range.start && f.t < range.end + 0.01);
    const segs = segmentsIn(segments, range);
    const res = await runClaude({
      prompt: reviewPrompt({ ...base, segments: chapters.length > 1 ? segs : segments, frames: fr, range: chapters.length > 1 ? range : null }),
      schema: reviewJsonSchema(departments, { frames: fr.length > 0 }),
      tools: fr.length ? ['Read'] : [],
      addDirs: fr.length ? [framesDir] : [],
      cwd: dir,
      model,
      cfg,
      signal,
      onEvent: (ev) => {
        if (ev.type === 'assistant') {
          const reads = (ev.message?.content || []).filter((c) => c.type === 'tool_use' && c.name === 'Read').length;
          if (reads) progress('reviewing', { text: `${label}Claude is watching ${fr.length} frames against your commentary` });
        }
      },
    });
    runInfo = res;
    return normalizeReview(res.structured, { departments, frameNames, duration });
  };

  if (chapters.length === 1) {
    progress('reviewing', { text: frames.length ? `Claude is watching ${frames.length} frames against your commentary` : 'Claude is reading your commentary' });
    review = await reviewRange(chapters[0], '');
  } else {
    const parts = [];
    for (const [k, range] of chapters.entries()) {
      const label = `Chapter ${k + 1}/${chapters.length}: `;
      progress('reviewing', { text: `${label}Claude is reviewing`, pct: k / (chapters.length + 1) });
      parts.push({ range, review: await reviewRange(range, label) });
    }
    progress('reviewing', { text: 'Merging chapters', pct: chapters.length / (chapters.length + 1) });
    const merged = await runClaude({ prompt: mergePrompt({ chapters: parts, context: job.context, title }), schema: MERGE_SCHEMA, tools: [], cwd: dir, model, cfg, signal });
    review = normalizeReview(combineChapters(parts, merged.structured), { departments, frameNames, duration });
  }

  // 8. Snap item times to their frames.
  review = fixTimes(review, Object.fromEntries(frames.map((f) => [f.name, f.t])));

  const meta = {
    jobId: job.id,
    title,
    duration,
    source: job.source,
    context: job.context || '',
    reviewer: job.reviewer || '',
    project: project.name || '',
    pool: Boolean(job.pool),
    model: runInfo?.model || model,
    profile: runInfo?.profile,
    costUsd: runInfo?.costUsd,
    transcriptUnreliable: tx.unreliable,
    whisperModel: tx.model,
    noWhisper,
    chapters: chapters.length,
    frameCount: frames.length,
  };
  writeJson(join(dir, 'review.json'), review);
  writeJson(join(dir, 'meta.json'), meta);
  const transcript = transcriptFile(segments, { title, unreliable: tx.unreliable });
  const markdown = reviewMarkdown(review, meta);
  writeFileSync(join(dir, 'transcript.txt'), transcript);
  writeFileSync(join(dir, 'review.md'), markdown);

  // The video goes as soon as the review exists (design §13); frames and transcript stay for follow-ups.
  deleteVideo(dir);
  return { review, meta, dir, frames, files: { transcript, markdown } };
}

function longVideo(duration, cfg) {
  return duration > (cfg.longVideoMinutes || 30) * 60;
}
const shift = (segs, by) => segs.map((s) => ({ ...s, start: s.start + by, end: s.end + by }));

function safeJobDir(cfg, id) {
  try {
    return jobDir(cfg, id);
  } catch {
    return null;
  }
}

export function deleteVideo(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (f.startsWith('source.') || f === 'audio.wav') rmSync(join(dir, f), { force: true });
}
