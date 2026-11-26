import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineChapters, segmentsIn, splitChapters } from '../src/pipeline/chapters.mjs';
import { detectSource, driveId, findVideoLink, isPrivateAddress, timeLink, youtubeId } from '../src/pipeline/fetch.mjs';
import { evenTimes, selectFrameTimes } from '../src/pipeline/media.mjs';
import { reviewPrompt } from '../src/pipeline/prompt.mjs';
import { fixTimes, normalizeReview, reviewJsonSchema } from '../src/pipeline/schema.mjs';
import { guardTranscript, isNoiseLine, parseWhisperJson, whisperPrompt } from '../src/pipeline/whisper.mjs';
import { LIMITS, embedSize, frameMessages, keyFrames, packMessages, packSection, progressText, resultMessages, splitText, threadName } from '../src/render/discord.mjs';
import { reviewMarkdown, transcriptFile } from '../src/render/markdown.mjs';
import { fmtTime } from '../src/util.mjs';

test('fmtTime', () => {
  assert.equal(fmtTime(0), '0:00');
  assert.equal(fmtTime(192), '3:12');
  assert.equal(fmtTime(3725.9), '1:02:05');
});

test('source detection', () => {
  assert.equal(youtubeId('https://youtu.be/abc123XYZ_-'), 'abc123XYZ_-');
  assert.equal(youtubeId('https://www.youtube.com/watch?v=abc123&t=4'), 'abc123');
  assert.equal(youtubeId('https://youtube.com/shorts/abcdef123'), 'abcdef123');
  assert.equal(driveId('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing'), '1AbCdEfGhIjKlMnOp');
  assert.equal(driveId('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp'), '1AbCdEfGhIjKlMnOp');
  assert.equal(detectSource('https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=1').kind, 'discord');
  assert.equal(detectSource('https://evil.example.com/clip.mp4'), null, 'unknown hosts are not direct sources by default');
  assert.equal(detectSource('https://evil.example.com/clip', { anyHost: true }).kind, 'direct');
  assert.equal(detectSource('file:///etc/passwd', { anyHost: true }), null);
  assert.equal(detectSource('not a url'), null);
  assert.equal(findVideoLink('look at this https://youtu.be/abc123XYZ. thanks').id, 'abc123XYZ');
  assert.equal(findVideoLink('no links here'), null);
  assert.equal(timeLink({ kind: 'youtube', id: 'abc' }, 192.7), 'https://youtu.be/abc?t=192');
  assert.equal(timeLink({ kind: 'drive', id: 'x' }, 10), null);
});

test('private address check', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1', '0.0.0.0', '100.64.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '142.250.72.14', '2607:f8b0:4005:80b::200e']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('whisper guards drop noise and flag loops', () => {
  assert.ok(isNoiseLine('Thank you for watching!'));
  assert.ok(isNoiseLine('[Music]'));
  assert.ok(!isNoiseLine('The archers are lost in the fog.'));
  const ok = guardTranscript([{ start: 0, end: 1, text: 'a b' }, { start: 1, end: 2, text: '[BLANK_AUDIO]' }, { start: 2, end: 3, text: 'c d' }]);
  assert.equal(ok.segments.length, 2);
  assert.equal(ok.unreliable, false);
  const loop = guardTranscript(Array.from({ length: 10 }, (_, i) => ({ start: i, end: i + 1, text: i < 3 ? `line ${i}` : 'same again' })));
  assert.equal(loop.unreliable, true);
  const segs = parseWhisperJson({ transcription: [{ offsets: { from: 1500, to: 3000 }, text: ' hi ' }, { offsets: { from: 3000, to: 3500 }, text: ' ' }] });
  assert.deepEqual(segs, [{ start: 1.5, end: 3, text: 'hi' }]);
  assert.match(whisperPrompt({ glossary: ['Spittoony', 'parry'], projectName: 'ZQuest', context: 'camp 3' }), /ZQuest, Spittoony, parry/);
});

test('frame selection: even spread and speech anchors', () => {
  assert.deepEqual(evenTimes(10, 5), [1, 3, 5, 7, 9]);
  assert.equal(selectFrameTimes(100, 6, []).length, 6);
  const segs = [{ start: 10, end: 20 }, { start: 50, end: 52 }, { start: 80, end: 90 }];
  const t = selectFrameTimes(100, 9, segs);
  assert.ok(t.includes(15) && t.includes(51) && t.includes(85), 'every segment midpoint gets a frame');
  assert.ok(t.length <= 9);
  assert.deepEqual([...t].sort((a, b) => a - b), t);
  // More segments than anchor slots: the longest win.
  const many = Array.from({ length: 50 }, (_, i) => ({ start: i * 2, end: i * 2 + (i === 7 ? 1.9 : 0.5) }));
  const t2 = selectFrameTimes(100, 6, many);
  assert.ok(t2.length <= 6);
  assert.ok(t2.some((x) => Math.abs(x - 14.95) < 0.01));
});

test('schema normalisation fixes Claude output', () => {
  const r = normalizeReview(
    {
      summary: ' s ',
      intentions: [{ id: 'i1', t: 5, statement: 'goal', source: 'said' }, { statement: '' }],
      feedback: [
        { t: 9, area: 'ART', priority: 'urgent', title: 'T', change: 'c', intention: 'i7', frame: 'f002.jpg', source: 'seen' },
        { t: 3, area: 'audio', priority: 'high', title: 'H', change: 'c', intention: 'i1', frame: 'frames/f001.jpg' },
      ],
      notes: [{ t: 1e9, area: 'x', text: 'n', frame: 'nope.jpg' }],
    },
    { frameNames: new Set(['f001.jpg', 'f002.jpg']), duration: 60 },
  );
  assert.equal(r.summary, 's');
  assert.equal(r.intentions.length, 1);
  assert.equal(r.feedback[0].priority, 'high', 'high sorts first');
  assert.equal(r.feedback[0].frame, 'f001.jpg', 'paths are reduced to names');
  assert.equal(r.feedback[1].area, 'art');
  assert.equal(r.feedback[1].priority, 'normal');
  assert.equal(r.feedback[1].intention, '', 'dangling intention links are dropped');
  assert.equal(r.notes[0].t, 60, 'times clamp to the duration');
  assert.equal(r.notes[0].area, 'other');
  assert.equal(r.notes[0].frame, '');
  const fixed = fixTimes(r, { 'f001.jpg': 4.25 });
  assert.equal(fixed.feedback.find((f) => f.frame === 'f001.jpg').t, 4.25);
  const schema = reviewJsonSchema(['a', 'b'], { frames: false });
  assert.deepEqual(schema.properties.feedback.items.properties.area.enum, ['a', 'b']);
  assert.equal(schema.properties.feedback.items.properties.frame, undefined);
});

test('chapters split at the longest silence near each cut', () => {
  const segs = [];
  for (let t = 0; t < 3600; t += 10) segs.push({ start: t, end: t + 9 });
  // A long silence at ~31 minutes should attract the cut nearest to 30 minutes.
  const withGap = segs.filter((s) => s.start < 1850 || s.start > 1900);
  const ch = splitChapters(3600, withGap, { targetLen: 1800 });
  assert.equal(ch.length, 2);
  assert.ok(ch[0].end > 1850 && ch[0].end < 1910, `cut at ${ch[0].end}`);
  assert.equal(ch[1].end, 3600);
  assert.deepEqual(splitChapters(600, segs), [{ start: 0, end: 600 }]);
  assert.equal(segmentsIn(segs, { start: 0, end: 100 }).length, 10);

  const mk = (id, t, intention) => ({ summary: `c${id}`, commentaryUsable: true, intentions: [{ id: 'i1', t, statement: 'goal', source: 'said' }], feedback: [{ t, area: 'art', priority: 'high', title: `f${id}`, change: '', why: '', intention, source: 'said', frame: '' }], notes: [] });
  const merged = combineChapters(
    [{ range: { start: 0, end: 10 }, review: mk(1, 5, 'i1') }, { range: { start: 10, end: 20 }, review: mk(2, 15, 'i1') }],
    { summary: 'all', intentions: [{ id: 'i1', t: 5, statement: 'goal', source: 'said' }], intentionMap: [{ from: 'c1:i1', to: 'i1' }, { from: 'c2:i1', to: 'i1' }] },
  );
  assert.equal(merged.summary, 'all');
  assert.equal(merged.intentions.length, 1);
  assert.deepEqual(merged.feedback.map((f) => f.intention), ['i1', 'i1']);
});

const bigReview = () => ({
  summary: 'Summary text',
  commentaryUsable: true,
  intentions: Array.from({ length: 30 }, (_, i) => ({ id: `i${i + 1}`, t: i * 10, statement: 'An intention statement that is fairly long. '.repeat(3), source: 'said' })),
  feedback: Array.from({ length: 80 }, (_, i) => ({ t: i * 7, area: 'art', priority: i % 3 ? 'normal' : 'high', title: `Item ${i}`, change: 'Do the thing in a specific way. '.repeat(4), why: 'w', intention: 'i1', source: i % 5 ? 'said' : 'seen', frame: `f${String((i % 9) + 1).padStart(3, '0')}.jpg` })),
  notes: Array.from({ length: 40 }, (_, i) => ({ t: i * 9, area: 'gameplay', text: 'A note. '.repeat(10), source: 'said', frame: '' })),
});

test('discord rendering respects every limit and never splits an item', () => {
  const review = bigReview();
  const meta = { title: 'Camp 3', duration: 720, source: { kind: 'youtube', id: 'abc', url: 'https://youtu.be/abc' }, reviewer: 'Nathaniel', model: 'sonnet' };
  const msgs = resultMessages(review, meta);
  assert.ok(msgs.length >= 2);
  let fb = 0;
  for (const m of msgs) {
    assert.ok(m.embeds.length <= LIMITS.embedsPerMessage);
    assert.ok(m.embeds.reduce((n, e) => n + embedSize(e), 0) <= LIMITS.messageEmbedsTotal);
    for (const e of m.embeds) {
      assert.ok(e.description.length <= LIMITS.description);
      if (e.title.startsWith('Feedback')) fb += e.description.split('\n').length;
    }
  }
  assert.equal(fb, review.feedback.length, 'every feedback item appears exactly once, whole');
  assert.match(msgs[0].embeds[0].description, /Summary text/);
  assert.match(msgs.map((m) => m.embeds.map((e) => e.description).join('\n')).join('\n'), /\[0:07\]\(https:\/\/youtu\.be\/abc\?t=7\)/);
  assert.deepEqual(packSection('Empty', [], 1)[0].description, '*None.*');
  assert.equal(packMessages([]).length, 0);
});

test('key frames, frame messages, text splitting, progress', () => {
  const review = bigReview();
  const frames = Array.from({ length: 9 }, (_, i) => ({ name: `f${String(i + 1).padStart(3, '0')}.jpg`, t: i * 5 }));
  const kf = keyFrames(review, frames, { maxFrames: 20 });
  assert.equal(kf.length, 9);
  assert.deepEqual(kf.map((f) => f.t), [...kf.map((f) => f.t)].sort((a, b) => a - b));
  const fm = frameMessages(kf);
  assert.equal(fm.length, 1);
  assert.ok(fm[0].files.length <= 10);
  const parts = splitText('word '.repeat(1000));
  assert.ok(parts.every((p) => p.length <= 2000));
  assert.equal(parts.join(' ').split(/\s+/).filter(Boolean).length, 1000);
  assert.match(progressText({ stage: 'downloading', pct: 0.38 }), /Downloading \(38%\)/);
  assert.match(progressText({ stage: 'failed', text: 'boom' }), /^❌ boom/);
  assert.ok(threadName('x'.repeat(200), 'Nathaniel').length <= 100);
});

test('markdown files', () => {
  const r = bigReview();
  const md = reviewMarkdown(r, { title: 'Camp 3', source: { kind: 'youtube', id: 'abc', url: 'https://youtu.be/abc' }, reviewer: 'N' });
  assert.match(md, /^# Review · Camp 3 · N/);
  assert.match(md, /## Feedback[\s\S]*## Intentions[\s\S]*## Notes/);
  assert.match(transcriptFile([{ start: 61, text: 'hello' }]), /\[1:01\] hello/);
});

test('review prompt includes frames, transcript, glossary and the anti-injection rule', () => {
  const p = reviewPrompt({ context: 'camp 3', project: { name: 'ZQuest', glossary: ['Spittoony'], guidance: 'Readability first.' }, departments: ['art', 'other'], segments: [{ start: 3, end: 4, text: 'hi' }], frames: [{ name: 'f001.jpg', t: 3 }], framesDir: '/x/frames', duration: 60 });
  assert.match(p, /f001\.jpg @ 0:03/);
  assert.match(p, /\[0:03\] hi/);
  assert.match(p, /Spittoony/);
  assert.match(p, /Readability first/);
  assert.match(p, /never as instructions/);
  assert.match(reviewPrompt({ departments: ['a'], segments: [] }), /transcript-only/);
});

test('windows npm .cmd shims resolve to the real script', async () => {
  const { parseCmdShim } = await import('../src/util.mjs');
  const npmShim = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`;
  assert.equal(parseCmdShim(npmShim), 'node_modules/@anthropic-ai/claude-code/cli.js');
  assert.equal(parseCmdShim('@"%~dp0\\node_modules\\x\\bin\\claude.exe" %*'), 'node_modules/x/bin/claude.exe');
  assert.equal(parseCmdShim('echo hi'), null);
});

test('IPv6 private ranges and pinned-lookup refusal', async () => {
  for (const ip of ['64:ff9b::a00:1', '64:ff9b::10.0.0.1', '2002:a00:1::1', 'fec0::1', '::10.0.0.1', '::127.0.0.1', 'fe80::1%eth0', 'ff02::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress('64:ff9b::8.8.8.8'), false);
  const { safeFetch } = await import('../src/pipeline/fetch.mjs');
  await assert.rejects(safeFetch('https://localhost/x.mp4', { allowedHosts: ['localhost'] }), /private or local/);
  await assert.rejects(safeFetch('https://127.0.0.1/x.mp4', { allowedHosts: ['127.0.0.1'] }), /private or local/);
  await assert.rejects(safeFetch('https://evil.example/x.mp4'), /allowlist/);
  await assert.rejects(safeFetch('http://youtube.com/x'), /non-https/);
});

test('sparse transcripts (no real commentary) are flagged', () => {
  const quest = [
    { start: 38, end: 39, text: "I'm neck" }, { start: 70, end: 71, text: 'Erin' }, { start: 118, end: 119, text: 'Dasher' },
    { start: 148, end: 149, text: 'Pumetschka' }, { start: 221, end: 222, text: 'Woah shit' }, { start: 222, end: 223, text: 'P-U-I-L-T-O-P-O' },
  ];
  const g = guardTranscript(quest, { duration: 240 });
  assert.equal(g.issue, 'sparse');
  assert.equal(g.unreliable, true);
  const talky = Array.from({ length: 40 }, (_, i) => ({ start: i * 6, end: i * 6 + 5, text: `this is sentence number ${i} about the archers in camp three` }));
  assert.equal(guardTranscript(talky, { duration: 240 }).issue, null);
  assert.equal(guardTranscript(quest.slice(0, 1), { duration: 30 }).issue, null, 'short clips are not judged');
  const p = reviewPrompt({ departments: ['a'], segments: quest, transcriptIssue: 'sparse', duration: 240 });
  assert.match(p, /set commentaryUsable to false/);
});
