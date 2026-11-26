// ffprobe / ffmpeg steps: probe, audio extraction, frame grabs, frame selection.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../util.mjs';

export async function probe(file, { signal } = {}) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { signal });
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(info.format?.duration) || Number(video?.duration) || Number(audio?.duration) || 0;
  return {
    duration,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width || 0,
    height: video?.height || 0,
    title: info.format?.tags?.title || '',
  };
}

/** 16 kHz mono 16-bit WAV, what whisper.cpp wants. */
export async function extractAudio(file, out, { signal } = {}) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], { signal });
  return out;
}

/** Grab one frame at time t, scaled to 960px wide, JPEG quality 4 (Ballast's settings). */
export async function grabFrame(file, t, out, { signal, width = 960 } = {}) {
  await run(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', '4', out],
    { signal },
  );
  return out;
}

/** Ballast's even spread: n frames at the centres of n equal slices. */
export function evenTimes(duration, n) {
  if (!(duration > 0) || n <= 0) return [];
  const step = duration / n;
  return Array.from({ length: n }, (_, i) => +(step * (i + 0.5)).toFixed(3));
}

/**
 * Speech-anchored sampling (design §5): a third of the budget goes to an even spread for coverage, two thirds
 * to the midpoints of transcript segments, so there is a frame wherever the reviewer was talking.
 * When there are more segments than anchor slots, the longest segments win. Frames closer than minGap
 * seconds are merged. Without a transcript it falls back to the even spread.
 */
export function selectFrameTimes(duration, budget, segments = [], { minGap = null } = {}) {
  if (!(duration > 0) || budget <= 0) return [];
  const speech = segments.filter((s) => s.end > s.start || s.text);
  if (!speech.length) return evenTimes(duration, budget);

  const evenCount = Math.max(1, Math.round(budget / 3));
  const anchorCount = budget - evenCount;
  let anchors = speech.map((s) => ({ t: (s.start + Math.max(s.end, s.start)) / 2, len: Math.max(0, s.end - s.start) }));
  if (anchors.length > anchorCount) anchors = [...anchors].sort((a, b) => b.len - a.len).slice(0, anchorCount);

  const gap = minGap ?? Math.min(2, duration / (budget * 4));
  const clamp = (t) => +Math.min(Math.max(0, t), Math.max(0, duration - 0.05)).toFixed(3);
  // Anchors win over even-spread frames when two land within `gap` of each other.
  const out = [];
  const far = (t) => out.every((k) => Math.abs(k - t) >= gap);
  for (const a of [...anchors].sort((x, y) => y.len - x.len)) if (far(clamp(a.t))) out.push(clamp(a.t));
  for (const t of evenTimes(duration, evenCount)) if (far(clamp(t))) out.push(clamp(t));
  out.sort((a, b) => a - b);

  // Merging can leave spare budget; top it up from the largest gaps.
  while (out.length < budget && out.length < duration / Math.max(gap, 0.5)) {
    let best = -1;
    let bestGap = 0;
    const pts = [0, ...out, duration];
    for (let i = 0; i < pts.length - 1; i++) {
      const g = pts[i + 1] - pts[i];
      if (g > bestGap) {
        bestGap = g;
        best = i;
      }
    }
    if (bestGap < gap * 2) break;
    const t = +((pts[best] + pts[best + 1]) / 2).toFixed(3);
    out.splice(best, 0, t);
    out.sort((a, b) => a - b);
  }
  return out;
}

export const frameName = (i) => `f${String(i + 1).padStart(3, '0')}.jpg`;

/** Grab all frames into dir; returns [{name, t}]. Failed grabs (e.g. past the last keyframe) are skipped. */
export async function grabFrames(file, times, dir, { signal, onProgress, concurrency = 4 } = {}) {
  const results = new Array(times.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < times.length) {
      const i = next++;
      const name = frameName(i);
      try {
        const out = join(dir, name);
        await grabFrame(file, times[i], out, { signal });
        if (existsSync(out) && statSync(out).size > 0) results[i] = { name, t: times[i] };
      } catch (err) {
        if (err.cancelled) throw err;
      }
      onProgress?.(++done / times.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, times.length) }, worker));
  return results.filter(Boolean);
}
