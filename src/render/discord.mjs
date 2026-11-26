// Turns a review into Discord message payloads (plain objects, so this is testable without discord.js).
// Limits (design §8): 2,000 chars of content, 4,096 per embed description, 6,000 across a message's embeds,
// 10 embeds and 10 attachments per message. Items are never cut in half.
import { timeLink } from '../pipeline/fetch.mjs';
import { clip, fmtTime } from '../util.mjs';

export const LIMITS = { content: 2000, description: 4096, title: 256, messageEmbedsTotal: 6000, embedsPerMessage: 10, filesPerMessage: 10 };
const COLORS = { summary: 0x5865f2, feedback: 0xed4245, intentions: 0x57f287, notes: 0xfee75c, error: 0xed4245 };
const PRI_ICON = { high: '🔴', normal: '🟡', low: '⚪' };

function stamp(source, t) {
  const link = timeLink(source, t);
  return link ? `[${fmtTime(t)}](${link})` : `\`${fmtTime(t)}\``;
}

export function feedbackLine(f, source) {
  const seen = f.source === 'seen' ? ' 👁' : '';
  const change = f.change ? `: ${f.change}` : '';
  const supports = f.intention ? ` → *supports ${f.intention}*` : '';
  return `${PRI_ICON[f.priority] || '🟡'} ${stamp(source, f.t)} **[${f.area}]** ${f.title}${change}${supports}${seen}`;
}
export function intentionLine(i) {
  return `**${i.id}** ${i.statement} *(${i.source === 'said' ? 'said' : 'seen'} at ${fmtTime(i.t)})*`;
}
export function noteLine(n, source) {
  return `${stamp(source, n.t)} **[${n.area}]** ${n.text}${n.source === 'seen' ? ' 👁' : ''}`;
}

/** Pack lines into embeds whose descriptions stay under the limit. A single over-long line is clipped. */
export function packSection(title, lines, color, { max = LIMITS.description } = {}) {
  const embeds = [];
  let cur = [];
  let len = 0;
  const flush = () => {
    if (!cur.length) return;
    embeds.push({ title: embeds.length ? `${title} (cont.)` : title, description: cur.join('\n'), color });
    cur = [];
    len = 0;
  };
  for (const raw of lines) {
    const line = clip(raw, max);
    if (len + line.length + (cur.length ? 1 : 0) > max) flush();
    cur.push(line);
    len += line.length + (cur.length > 1 ? 1 : 0);
  }
  flush();
  if (!embeds.length) embeds.push({ title, description: '*None.*', color });
  return embeds;
}

export function embedSize(e) {
  return (e.title?.length || 0) + (e.description?.length || 0) + (e.footer?.text?.length || 0) + (e.author?.name?.length || 0) +
    (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}

/** Group embeds into messages: ≤10 embeds and ≤6,000 characters each. */
export function packMessages(embeds) {
  const messages = [];
  let cur = [];
  let size = 0;
  for (const e of embeds) {
    const s = embedSize(e);
    if (cur.length && (cur.length >= LIMITS.embedsPerMessage || size + s > LIMITS.messageEmbedsTotal)) {
      messages.push({ embeds: cur });
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += s;
  }
  if (cur.length) messages.push({ embeds: cur });
  return messages;
}

export function summaryEmbed(review, meta) {
  const fields = [];
  if (meta.duration) fields.push({ name: 'Duration', value: fmtTime(meta.duration), inline: true });
  const counts = `${review.feedback.length} feedback · ${review.intentions.length} intentions · ${review.notes.length} notes`;
  fields.push({ name: 'Items', value: counts, inline: true });
  const high = review.feedback.filter((f) => f.priority === 'high').length;
  if (high) fields.push({ name: 'High priority', value: String(high), inline: true });
  if (meta.source?.url) fields.push({ name: 'Source', value: clip(meta.source.kind === 'discord' ? 'Discord attachment' : meta.source.url, 1024), inline: false });
  const by = [meta.reviewer && `${meta.reviewer}'s worker`, meta.model && `Claude ${meta.model}`, meta.profile && meta.profile !== 'default' && `account ${meta.profile}`]
    .filter(Boolean)
    .join(' · ');
  const notes = [];
  if (!review.commentaryUsable) notes.push('⚠️ Commentary missing or unusable; notes lean on the picture.');
  if (meta.transcriptUnreliable) notes.push('⚠️ The transcript repeated itself a lot and may be unreliable.');
  if (meta.noWhisper) notes.push('⚠️ No transcript: whisper.cpp is not installed on the worker.');
  if (meta.pool) notes.push(`Reviewed by pool worker ${meta.workerName || ''}`.trim());
  return {
    title: clip(`Review · ${meta.title || 'video'}`, LIMITS.title),
    url: meta.source?.kind !== 'discord' ? meta.source?.url : undefined,
    description: clip([`**Summary:** ${review.summary || '—'}`, ...notes].join('\n\n'), LIMITS.description),
    color: COLORS.summary,
    fields,
    footer: by ? { text: clip(by, 2048) } : undefined,
  };
}

/**
 * Everything the result posts, in order: [{embeds}, …]. The first message is the summary (buttons attach to it).
 */
export function resultMessages(review, meta = {}) {
  const src = meta.source;
  const first = { embeds: [summaryEmbed(review, meta)] };
  const sections = [
    ...packSection('Feedback', review.feedback.map((f) => feedbackLine(f, src)), COLORS.feedback),
    ...packSection('Intentions', review.intentions.map(intentionLine), COLORS.intentions),
    ...packSection('Notes', review.notes.map((n) => noteLine(n, src)), COLORS.notes),
  ];
  return [first, ...packMessages(sections)];
}

/**
 * Key frames: those referenced by feedback (priority order) then notes, deduped, at most maxFrames,
 * shown in time order. Returns [{name, t, caption}].
 */
export function keyFrames(review, frames, { maxFrames = 20 } = {}) {
  const byName = new Map(frames.map((f) => [f.name, f]));
  const picked = new Map();
  for (const item of [...review.feedback, ...review.notes]) {
    if (picked.size >= maxFrames) break;
    if (!item.frame || picked.has(item.frame) || !byName.has(item.frame)) continue;
    const label = item.title || item.text || '';
    picked.set(item.frame, { name: item.frame, t: byName.get(item.frame).t, caption: clip(`${fmtTime(byName.get(item.frame).t)} · ${item.area} · ${label}`, 180) });
  }
  return [...picked.values()].sort((a, b) => a.t - b.t);
}

/** Group frames into messages of ≤10 attachments with a caption line per frame. */
export function frameMessages(frames) {
  const out = [];
  for (let i = 0; i < frames.length; i += LIMITS.filesPerMessage) {
    const group = frames.slice(i, i + LIMITS.filesPerMessage);
    out.push({ content: clip(group.map((f) => `\`${f.name}\` ${f.caption}`).join('\n'), LIMITS.content), files: group });
  }
  return out;
}

/** Split long plain text into ≤2,000-char messages, preferring line breaks. */
export function splitText(text, max = LIMITS.content) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

const PIPELINE = ['downloading', 'transcribing', 'frames', 'reviewing', 'posting'];
const STAGE_LABEL = {
  queued: 'Queued',
  waiting: 'Waiting',
  downloading: 'Downloading',
  transcribing: 'Transcribing commentary',
  frames: 'Pulling frames',
  reviewing: 'Claude is reviewing',
  posting: 'Posting',
  done: 'Done',
  failed: 'Failed',
};
const STAGE_ICON = { failed: '❌', done: '✅', waiting: '⏳', queued: '🎬' };

/** The single progress message that is edited in place: current stage, percentage, and the stage trail. */
export function progressText(p) {
  const label = p.text || STAGE_LABEL[p.stage] || p.stage;
  const pct = p.pct != null && p.pct > 0 && p.pct < 1 ? ` (${Math.round(p.pct * 100)}%)` : '';
  let out = `${STAGE_ICON[p.stage] || '⏱️'} ${label}${pct}`;
  if (PIPELINE.includes(p.stage)) out += `\n-# ${PIPELINE.map((s) => (s === p.stage ? `**${STAGE_LABEL[s]}**` : STAGE_LABEL[s])).join(' → ')}`;
  return clip(out, LIMITS.content);
}

export function threadName(title, reviewer) {
  return clip(`Review · ${title || 'video'} · ${reviewer || 'reviewer'}`, 100);
}
