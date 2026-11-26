// review.md and transcript.txt (design §8, "files").
import { timeLink } from '../pipeline/fetch.mjs';
import { fmtTime } from '../util.mjs';

const PRI_ICON = { high: '🔴', normal: '🟡', low: '⚪' };

function stamp(source, t) {
  const link = timeLink(source, t);
  return link ? `[${fmtTime(t)}](${link})` : `[${fmtTime(t)}]`;
}

export function transcriptFile(segments, { title = '', unreliable = false, issue = null } = {}) {
  const note = issue === 'sparse'
    ? 'Note: almost no speech was detected; these lines are probably whisper mishearing game audio, not commentary.'
    : unreliable ? 'Note: whisper repeated itself a lot; this transcript may be unreliable.' : '';
  const head = [title ? `Transcript: ${title}` : 'Transcript', note]
    .filter(Boolean)
    .join('\n');
  const body = segments.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n');
  return `${head}\n\n${body || '(no speech detected)'}\n`;
}

export function reviewMarkdown(review, meta = {}) {
  const src = meta.source;
  const lines = [];
  lines.push(`# Review · ${meta.title || 'video'}${meta.reviewer ? ` · ${meta.reviewer}` : ''}`);
  const facts = [];
  if (src?.url) facts.push(`Source: ${src.url}`);
  if (meta.duration) facts.push(`Duration: ${fmtTime(meta.duration)}`);
  if (meta.context) facts.push(`Context: ${meta.context}`);
  if (meta.model) facts.push(`Reviewed by Claude (${meta.model}${meta.profile ? `, ${meta.profile}` : ''})`);
  if (facts.length) lines.push('', facts.map((f) => `- ${f}`).join('\n'));
  if (!review.commentaryUsable) lines.push('', '> The spoken commentary was missing or unusable; these notes lean on the picture.');
  lines.push('', '## Summary', '', review.summary || '—');

  lines.push('', '## Feedback', '');
  if (!review.feedback.length) lines.push('_None._');
  for (const f of review.feedback) {
    lines.push(`- ${PRI_ICON[f.priority]} **${f.priority}** ${stamp(src, f.t)} **[${f.area}]** **${f.title}**${f.source === 'seen' ? ' _(seen, not said)_' : ''}`);
    if (f.change) lines.push(`  - Change: ${f.change}`);
    if (f.why) lines.push(`  - Why: ${f.why}`);
    if (f.intention) lines.push(`  - Supports ${f.intention}`);
    if (f.frame) lines.push(`  - Frame: ${f.frame}`);
  }

  lines.push('', '## Intentions', '');
  if (!review.intentions.length) lines.push('_None stated._');
  for (const i of review.intentions) lines.push(`- **${i.id}** ${i.statement} _(${i.source === 'said' ? 'said' : 'seen'} at ${fmtTime(i.t)})_`);

  lines.push('', '## Notes', '');
  if (!review.notes.length) lines.push('_None._');
  for (const n of review.notes) lines.push(`- ${stamp(src, n.t)} **[${n.area}]** ${n.text}${n.source === 'seen' ? ' _(seen)_' : ''}`);

  return `${lines.join('\n')}\n`;
}
