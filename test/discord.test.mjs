// The Discord front end against mock Discord objects (no network): command definitions, the /review path,
// result posting, buttons, follow-ups and auto-review.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMANDS } from '../src/hub/commands.mjs';
import { HubCore } from '../src/hub/core.mjs';
import { DiscordFront } from '../src/hub/discord.mjs';
import { Store } from '../src/hub/store.mjs';
import { embedSize } from '../src/render/discord.mjs';

test('command definitions fit Discord\'s rules', () => {
  const check = (opts, path) => {
    assert.ok(opts.length <= 25, `${path}: ≤25 options`);
    let optional = false;
    for (const o of opts) {
      assert.match(o.name, /^[-_a-z0-9]{1,32}$/, `${path}.${o.name}: name`);
      assert.ok(o.description.length >= 1 && o.description.length <= 100, `${path}.${o.name}: description length ${o.description.length}`);
      if (o.type === 1 || o.type === 2) check(o.options || [], `${path}.${o.name}`);
      else {
        if (o.required) assert.ok(!optional, `${path}.${o.name}: required after optional`);
        else optional = true;
      }
      for (const c of o.choices || []) assert.ok(c.name.length <= 100 && String(c.value).length <= 100);
    }
  };
  for (const c of COMMANDS) {
    if (c.type === 3) {
      assert.ok(c.name.length <= 32);
      continue;
    }
    assert.ok(c.description.length <= 100);
    check(c.options || [], c.name);
  }
  assert.ok(JSON.stringify(COMMANDS).length < 8000, 'total command size limit');
});

// ---- mocks -------------------------------------------------------------------------------------------

let nextId = 1;
const id = () => String(1000 + nextId++);

function mockChannel({ thread = false, type = 0 } = {}) {
  const ch = {
    id: id(),
    type: thread ? 11 : type,
    parentId: thread ? 'parent' : null,
    sent: [],
    edits: [],
    reactions: [],
    name: '',
    archived: false,
    isThread: () => thread,
    async send(payload) {
      const m = mockMessage(ch, typeof payload === 'string' ? { content: payload } : payload);
      ch.sent.push(m);
      return m;
    },
    messages: {
      async edit(mid, payload) {
        ch.edits.push({ mid, ...payload });
      },
      async fetch(mid) {
        return ch.sent.find((m) => m.id === mid);
      },
    },
    async setName(n) {
      ch.name = n;
    },
    async setArchived(v) {
      ch.archived = v;
    },
    async sendTyping() {},
  };
  return ch;
}

function mockMessage(channel, payload) {
  const m = {
    id: id(),
    channel,
    channelId: channel.id,
    url: `https://discord.com/channels/g/${channel.id}/x`,
    ...payload,
    async startThread({ name }) {
      const t = mockChannel({ thread: true });
      t.name = name;
      m.thread = t;
      threads.set(t.id, t);
      return t;
    },
    async react(e) {
      channel.reactions.push(e);
    },
    async reply(p) {
      return channel.send(p);
    },
  };
  return m;
}

const threads = new Map();
const user = (uid, name) => ({ id: uid, username: name, globalName: name, async createDM() {
  const dm = mockChannel({ type: 1 });
  threads.set(dm.id, dm);
  return dm;
} });

function mockInteraction({ command, sub, group, options = {}, channel, u = user('u1', 'Nathaniel'), perms = true }) {
  const i = {
    commandName: command,
    user: u,
    member: { displayName: u.globalName },
    guildId: 'g1',
    channel,
    channelId: channel?.id,
    deferred: false,
    replied: false,
    replies: [],
    memberPermissions: { has: () => perms },
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isMessageContextMenuCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    async deferReply(o) {
      i.deferred = true;
      i.ephemeral = Boolean(o?.flags);
    },
    async editReply(p) {
      i.replies.push(typeof p === 'string' ? { content: p } : p);
      i.replyMessage ||= mockMessage(channel, typeof p === 'string' ? { content: p } : p);
      return i.replyMessage;
    },
    async fetchReply() {
      return i.replyMessage;
    },
    async reply(p) {
      i.replied = true;
      i.replies.push(p);
    },
    options: {
      getString: (k) => options[k] ?? null,
      getBoolean: (k) => options[k] ?? null,
      getInteger: (k) => options[k] ?? null,
      getAttachment: (k) => options[k] ?? null,
      getChannel: (k) => options[k] ?? null,
      getSubcommand: () => sub,
      getSubcommandGroup: () => group ?? null,
    },
  };
  return i;
}

function setup() {
  const store = new Store(null);
  const front = new DiscordFront({ store, log: () => {} });
  const core = new HubCore({ store, front });
  front.core = core;
  front.hasMessageContent = true;
  front.client = {
    user: { id: 'bot' },
    channels: { cache: new Map(), fetch: async (cid) => threads.get(cid) },
    users: { fetch: async () => null },
  };
  // A paired worker for u1 (no socket; jobs wait in the queue).
  store.data.workers.w1 = { id: 'w1', userId: 'u1', userTag: 'Nathaniel', name: 'desk', tokenHash: 'x', pool: { enabled: false } };
  return { store, front, core };
}

test('/review opens a thread from the reply, posts progress and queues the job', async () => {
  const { front, store } = setup();
  const channel = mockChannel();
  const i = mockInteraction({ command: 'review', channel, options: { url: 'https://youtu.be/abc123', context: 'Camp 3 combat pass' } });
  await front.onInteraction(i);
  const job = store.jobs()[0];
  assert.ok(job, i.replies.map((r) => r.content).join('\n'));
  assert.equal(job.source.kind, 'youtube');
  assert.equal(job.userTag, 'Nathaniel');
  assert.match(i.replies[0].content, /Queued on Nathaniel's worker/);
  const thread = threads.get(job.threadId);
  assert.equal(thread.name, 'Review · Camp 3 combat pass · Nathaniel');
  assert.equal(thread.sent[0].id, job.progressMessageId);
  // No worker online: the waiting notice is edited into the progress message.
  await new Promise((r) => setTimeout(r, 50));
  await front.progress.get(job.id)?.chain;
  assert.match(thread.edits.at(-1).content, /Waiting for Nathaniel's worker to come online/);
});

test('/review refuses unpaired users when there is no pool, and bad links', async () => {
  const { front } = setup();
  const channel = mockChannel();
  const i = mockInteraction({ command: 'review', channel, u: user('u2', 'Sam'), options: { url: 'https://youtu.be/abc123' } });
  await front.onInteraction(i);
  assert.match(i.replies.at(-1).content, /pair a worker first/);
  const j = mockInteraction({ command: 'review', channel, options: { url: 'ftp://nope' } });
  await front.onInteraction(j);
  assert.match(j.replies.at(-1).content, /doesn't look like a link/);
});

test('results post summary with buttons, sections, frames and files', async () => {
  const { front, store } = setup();
  store.updateGuild('g1', (g) => (g.projects.ZQuest = { name: 'ZQuest', tracker: { enabled: true, kind: 'Jira' } }));
  const thread = mockChannel({ thread: true });
  threads.set(thread.id, thread);
  const progress = await thread.send('progress');
  const job = store.putJob({ id: 'j1', userId: 'u1', userTag: 'Nathaniel', guildId: 'g1', threadId: thread.id, progressMessageId: progress.id, projectName: 'ZQuest', source: { kind: 'youtube', id: 'abc', url: 'https://youtu.be/abc' }, startedAt: Date.now() - 65_000, status: 'done', workerId: 'w1' });
  const review = {
    summary: 'S',
    commentaryUsable: true,
    intentions: [{ id: 'i1', t: 5, statement: 'goal', source: 'said' }],
    feedback: [{ t: 192, area: 'art', priority: 'high', title: 'Archers invisible against fog', change: 'raise rim light', why: '', intention: 'i1', source: 'said', frame: 'f001.jpg' }],
    notes: [{ t: 64, area: 'gameplay', text: 'Wave 1 spawn timing feels right.', source: 'said', frame: '' }],
  };
  const jpg = Buffer.from([0xff, 0xd8, 0xff]).toString('base64');
  await front.onResult(job, { review, meta: { title: 'Camp 3', duration: 720, model: 'sonnet' }, frames: [{ name: 'f001.jpg', t: 192, caption: '3:12 · art · Archers', data: jpg }], files: { markdown: '# md', transcript: 'tx' } });
  const [prog, summary, sections, frames, files] = thread.sent;
  assert.equal(prog.id, progress.id);
  assert.equal(summary.embeds[0].title, 'Review · Camp 3');
  assert.deepEqual(summary.components[0].components.map((c) => c.custom_id), ['dbf:rerun:j1', 'dbf:tx:j1', 'dbf:track:j1', 'dbf:done:j1']);
  assert.deepEqual(sections.embeds.map((e) => e.title), ['Feedback', 'Intentions', 'Notes']);
  assert.match(sections.embeds[0].description, /🔴 \[3:12\]\(https:\/\/youtu\.be\/abc\?t=192\) \*\*\[art\]\*\* Archers invisible against fog: raise rim light → \*supports i1\*/);
  assert.ok(sections.embeds.reduce((n, e) => n + embedSize(e), 0) <= 6000);
  assert.equal(frames.files[0].name, 'f001.jpg');
  assert.deepEqual(files.files.map((f) => f.name), ['review.md'], 'transcript is reviewer-only by default');
  assert.match(thread.edits.at(-1).content, /✅ Done in 1:0\d/);
  assert.equal(store.job('j1').summaryMessageId, summary.id);
});

test('reviewer-only buttons and the transcript visibility rule', async () => {
  const { front, store } = setup();
  const thread = mockChannel({ thread: true });
  threads.set(thread.id, thread);
  store.putJob({ id: 'j2', userId: 'u1', userTag: 'Nathaniel', guildId: 'g1', threadId: thread.id, status: 'done', workerId: 'w1', source: {} });
  const btn = (customId, u) => {
    const i = mockInteraction({ channel: thread, u });
    i.isChatInputCommand = () => false;
    i.isButton = () => true;
    i.customId = customId;
    i.message = { components: [] };
    i.update = async (p) => (i.updated = p);
    i.showModal = async (m) => (i.modal = m);
    return i;
  };
  const other = user('u3', 'Sam');
  for (const action of ['rerun', 'done', 'track', 'tx']) {
    const i = btn(`dbf:${action}:j2`, other);
    await front.onInteraction(i);
    assert.match(i.replies.at(-1).content, /Only Nathaniel|reviewer only/, action);
  }
  const r = btn('dbf:rerun:j2', user('u1', 'Nathaniel'));
  await front.onInteraction(r);
  assert.equal(r.modal.custom_id, 'dbf:rerun:j2');
  const tx = btn('dbf:tx:j2', user('u1', 'Nathaniel'));
  front.core.request = async () => ({ text: '[0:01] hello' });
  front.core.conns.set('w1', {});
  await front.onInteraction(tx);
  assert.equal(tx.replies.at(-1).content ?? tx.replies.at(-1), '[0:01] hello');
  const done = btn('dbf:done:j2', user('u1', 'Nathaniel'));
  await front.onInteraction(done);
  assert.ok(thread.archived);
});

test('@mention follow-ups go to the worker; offline workers are reported, not guessed', async () => {
  const { front, store, core } = setup();
  const thread = mockChannel({ thread: true });
  store.putJob({ id: 'j3', userId: 'u1', userTag: 'Nathaniel', guildId: 'g1', threadId: thread.id, status: 'done', finishedAt: 1, workerId: 'w1', source: {} });
  const msg = (content) => ({ ...mockMessage(thread, { content }), author: { id: 'u3', bot: false, username: 'Sam' }, member: { displayName: 'Sam' }, guildId: 'g1', mentions: { users: new Map([['bot', {}]]) } });
  await front.onMessage(msg('<@bot> what did I say about the archers?'));
  assert.match(thread.sent.at(-1).content, /worker is offline/);
  core.conns.set('w1', {});
  let asked;
  core.request = async (wid, kind, body) => {
    asked = { wid, kind, body };
    return { text: 'You said they vanish in fog [3:12].' };
  };
  await front.onMessage(msg('<@bot> what did I say about the archers?'));
  assert.deepEqual(asked, { wid: 'w1', kind: 'ask', body: { jobId: 'j3', question: 'what did I say about the archers?', asker: 'Sam' } });
  assert.match(thread.sent.at(-1).content, /vanish in fog/);
});

test('auto-review queues paired reviewers\' videos and nudges unpaired ones with one reaction', async () => {
  const { front, store } = setup();
  const channel = mockChannel();
  store.updateGuild('g1', (g) => (g.channels[channel.id] = { autoReview: true }));
  const post = (uid, content, attachments = []) => {
    const m = mockMessage(channel, { content });
    Object.assign(m, { author: { id: uid, bot: false, username: uid }, member: null, guildId: 'g1', mentions: { users: new Map() } });
    m.attachments = Object.assign(attachments, { find: attachments.find.bind(attachments) });
    return m;
  };
  await front.onMessage(post('u9', 'my clip https://youtu.be/zzz111'));
  assert.deepEqual(channel.reactions, ['🔗']);
  await front.onMessage(post('u1', 'just chatting, no video'));
  assert.equal(store.jobs().length, 0);
  await front.onMessage(post('u1', 'camp 3 pass', [{ id: 'a1', name: 'clip.mp4', contentType: 'video/mp4', url: 'https://cdn.discordapp.com/x/clip.mp4' }]));
  const job = store.jobs()[0];
  assert.equal(job.source.kind, 'discord');
  assert.equal(job.context, 'camp 3 pass');
  assert.equal(job.sourceMessage.attachmentId, 'a1');
  assert.deepEqual(channel.reactions, ['🔗', '🎬']);
});

test('setup requires Manage Server and saves projects and channels', async () => {
  const { front, store } = setup();
  const channel = mockChannel();
  const denied = mockInteraction({ command: 'debrief', group: 'setup', sub: 'show', channel, perms: false });
  await front.onInteraction(denied);
  assert.match(denied.replies.at(-1).content, /Manage Server/);
  const i = mockInteraction({ command: 'debrief', group: 'setup', sub: 'project', channel, options: { name: 'ZQuest', glossary: 'Spittoony, parry, camp 3', departments: 'Gameplay, Art, UI' } });
  await front.onInteraction(i);
  const p = store.guild('g1').projects.ZQuest;
  assert.deepEqual(p.glossary, ['Spittoony', 'parry', 'camp 3']);
  assert.deepEqual(p.departments, ['gameplay', 'art', 'ui']);
  const c = mockInteraction({ command: 'debrief', group: 'setup', sub: 'channel', channel, options: { channel: { id: 'c9' }, project: 'zquest', auto_review: true } });
  await front.onInteraction(c);
  assert.deepEqual(store.guild('g1').channels.c9, { project: 'ZQuest', autoReview: true });
  assert.equal(front.resolveProject('g1', { id: 'c9', isThread: () => false }, null), 'ZQuest');
  const prep = await front.prepareJob({ id: 'x', guildId: 'g1', projectName: 'ZQuest', source: { kind: 'youtube' }, userTag: 'N' });
  assert.deepEqual(prep.project.departments, ['gameplay', 'art', 'ui']);
});
