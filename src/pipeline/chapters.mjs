// Long videos (design §5): split at the longest silences into chapters, review each, merge.
import { sortFeedback } from './schema.mjs';

/**
 * Pick chapter boundaries. Aims for chapters of ~targetLen seconds; each cut goes at the longest gap between
 * transcript segments within ±30% of the ideal point (falls back to the ideal point when there is no speech).
 * Returns [{start, end}].
 */
export function splitChapters(duration, segments = [], { targetLen = 15 * 60 } = {}) {
  const count = Math.max(1, Math.round(duration / targetLen));
  if (count <= 1) return [{ start: 0, end: duration }];
  const len = duration / count;
  const gaps = [];
  for (let i = 1; i < segments.length; i++) {
    const a = segments[i - 1].end;
    const b = segments[i].start;
    if (b > a) gaps.push({ at: (a + b) / 2, size: b - a });
  }
  const cuts = [];
  for (let k = 1; k < count; k++) {
    const ideal = len * k;
    const lo = ideal - len * 0.3;
    const hi = ideal + len * 0.3;
    const best = gaps.filter((g) => g.at > lo && g.at < hi).sort((x, y) => y.size - x.size || Math.abs(x.at - ideal) - Math.abs(y.at - ideal))[0];
    cuts.push(best ? best.at : ideal);
  }
  const edges = [0, ...cuts.sort((a, b) => a - b), duration];
  return edges.slice(0, -1).map((s, i) => ({ start: +s.toFixed(3), end: +edges[i + 1].toFixed(3) }));
}

export function segmentsIn(segments, { start, end }) {
  return segments.filter((s) => {
    const mid = (s.start + Math.max(s.end, s.start)) / 2;
    return mid >= start && mid < end;
  });
}

/**
 * Combine chapter reviews using the merge pass's output: renumbered intentions, an id map and a summary.
 * Chapter intention ids are referenced as "c<k>:<id>" (1-based k).
 */
export function combineChapters(chapters, merge) {
  const map = new Map((merge?.intentionMap || []).map((m) => [m.from, m.to]));
  const intentions = merge?.intentions?.length
    ? merge.intentions
    : chapters.flatMap((c, k) => c.review.intentions.map((i) => ({ ...i, id: `c${k + 1}:${i.id}` })));
  const validIds = new Set(intentions.map((i) => i.id));
  const remap = (k, id) => {
    if (!id) return '';
    const to = map.get(`c${k + 1}:${id}`) ?? `c${k + 1}:${id}`;
    return validIds.has(to) ? to : '';
  };
  const feedback = chapters.flatMap((c, k) => c.review.feedback.map((f) => ({ ...f, intention: remap(k, f.intention) })));
  const notes = chapters.flatMap((c) => c.review.notes);
  return {
    summary: merge?.summary || chapters.map((c) => c.review.summary).join(' '),
    commentaryUsable: chapters.some((c) => c.review.commentaryUsable),
    intentions: [...intentions].sort((a, b) => a.t - b.t),
    feedback: sortFeedback(feedback),
    notes: notes.sort((a, b) => a.t - b.t),
  };
}
