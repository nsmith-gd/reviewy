// The review schema (design §6) and normalisation of what Claude returns.

export const DEFAULT_DEPARTMENTS = ['gameplay', 'art', 'audio', 'backend', 'other'];
export const PRIORITIES = ['high', 'normal', 'low'];

/** JSON Schema handed to `claude --json-schema`. Departments come from the project settings. */
export function reviewJsonSchema(departments = DEFAULT_DEPARTMENTS, { frames = true } = {}) {
  const area = { type: 'string', enum: departments };
  const source = { type: 'string', enum: ['said', 'seen'] };
  const t = { type: 'number', minimum: 0, description: 'Seconds from the start of the video.' };
  const frame = { type: 'string', description: 'File name of the frame that shows this best, e.g. f031.jpg. Empty if none.' };
  const feedbackProps = {
    t,
    area,
    priority: { type: 'string', enum: PRIORITIES },
    title: { type: 'string', description: 'Short headline, under 80 characters.' },
    change: { type: 'string', description: 'What should change, in the reviewer\'s direction.' },
    why: { type: 'string', description: 'Why it matters.' },
    intention: { type: 'string', description: 'Id of the intention this serves (e.g. i1), or empty.' },
    source,
  };
  const noteProps = { t, area, text: { type: 'string' }, source };
  if (frames) {
    feedbackProps.frame = frame;
    noteProps.frame = frame;
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'commentaryUsable', 'intentions', 'feedback', 'notes'],
    properties: {
      summary: { type: 'string', description: '2–3 sentences: what this review covers and the main takeaways.' },
      commentaryUsable: { type: 'boolean', description: 'False when the spoken commentary is missing, garbled or unrelated to the picture.' },
      intentions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 't', 'statement', 'source'],
          properties: { id: { type: 'string' }, t, statement: { type: 'string' }, source },
        },
      },
      feedback: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['t', 'area', 'priority', 'title', 'change', 'source'], properties: feedbackProps },
      },
      notes: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: ['t', 'area', 'text', 'source'], properties: noteProps },
      },
    },
  };
}

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Coerce Claude's output into a well-formed review: unknown areas become "other", bad priorities "normal",
 * dangling intention links are dropped, and frames that don't exist are cleared.
 */
export function normalizeReview(raw, { departments = DEFAULT_DEPARTMENTS, frameNames = null, duration = null } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const fallbackArea = departments.includes('other') ? 'other' : departments[departments.length - 1];
  const area = (a) => {
    const v = str(a).toLowerCase();
    return departments.includes(v) ? v : fallbackArea;
  };
  const source = (s) => (str(s) === 'seen' ? 'seen' : 'said');
  const clampT = (t) => (duration ? Math.min(num(t), duration) : num(t));
  const frame = (f) => {
    const v = str(f).replace(/^.*[\\/]/, '');
    if (!v) return '';
    return !frameNames || frameNames.has(v) ? v : '';
  };

  const intentions = (Array.isArray(r.intentions) ? r.intentions : [])
    .filter((i) => i && str(i.statement))
    .map((i, idx) => ({ id: str(i.id) || `i${idx + 1}`, t: clampT(i.t), statement: str(i.statement), source: source(i.source) }));
  const ids = new Set(intentions.map((i) => i.id));

  const feedback = (Array.isArray(r.feedback) ? r.feedback : [])
    .filter((f) => f && (str(f.title) || str(f.change)))
    .map((f) => ({
      t: clampT(f.t),
      area: area(f.area),
      priority: PRIORITIES.includes(str(f.priority)) ? str(f.priority) : 'normal',
      title: str(f.title) || str(f.change).slice(0, 80),
      change: str(f.change),
      why: str(f.why),
      intention: ids.has(str(f.intention)) ? str(f.intention) : '',
      source: source(f.source),
      frame: frame(f.frame),
    }));

  const notes = (Array.isArray(r.notes) ? r.notes : [])
    .filter((n) => n && str(n.text))
    .map((n) => ({ t: clampT(n.t), area: area(n.area), text: str(n.text), source: source(n.source), frame: frame(n.frame) }));

  return {
    summary: str(r.summary),
    commentaryUsable: r.commentaryUsable !== false,
    intentions: intentions.sort((a, b) => a.t - b.t),
    feedback: sortFeedback(feedback),
    notes: notes.sort((a, b) => a.t - b.t),
  };
}

const PRI_RANK = { high: 0, normal: 1, low: 2 };
export function sortFeedback(items) {
  return [...items].sort((a, b) => PRI_RANK[a.priority] - PRI_RANK[b.priority] || a.t - b.t);
}

/**
 * Design §5 step 8: replace each item's time with its frame's exact time, so a timestamp always
 * lands on the moment the frame shows. frameTimes maps "f031.jpg" → seconds.
 */
export function fixTimes(review, frameTimes) {
  const fix = (item) => (item.frame && frameTimes[item.frame] != null ? { ...item, t: frameTimes[item.frame] } : item);
  return { ...review, feedback: sortFeedback(review.feedback.map(fix)), notes: review.notes.map(fix).sort((a, b) => a.t - b.t) };
}
