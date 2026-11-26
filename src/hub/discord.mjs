// The Discord front end (design §8): commands, threads, progress, results, buttons, follow-ups, auto-review.
// It owns the Discord connection; all routing and worker traffic goes through HubCore.
import { ChannelType, Client, Events, GatewayIntentBits, MessageFlags, Partials, PermissionFlagsBits } from 'discord.js';
import { COMMANDS, REVIEW_MENU_NAME } from './commands.mjs';
import { defaultProject } from './store.mjs';
import { detectSource, findVideoLink } from '../pipeline/fetch.mjs';
import { DEFAULT_DEPARTMENTS } from '../pipeline/schema.mjs';
import { frameMessages, progressText, resultMessages, splitText, threadName } from '../render/discord.mjs';
import { clip, fmtTime } from '../util.mjs';

const EPHEMERAL = MessageFlags.Ephemeral;
const EDIT_INTERVAL = 3000; // progress edits: at most one every 3 s per job
const VIDEO_NAME = /\.(mp4|mov|mkv|webm|m4v|avi|wmv|mpg|mpeg)$/i;

export const isVideoAttachment = (a) => Boolean(a && ((a.contentType || '').startsWith('video/') || VIDEO_NAME.test(a.name || '')));
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const userError = (text) => Object.assign(new Error(text), { user: true });

export class DiscordFront {
  constructor({ store, cfg = {}, log }) {
    this.store = store;
    this.cfg = cfg;
    this.log = log || ((...a) => console.log('[discord]', ...a));
    this.progress = new Map(); // jobId → {p, last, timer, chain}
    this.core = null;
  }

  // ---- lifecycle ------------------------------------------------------------------------------------

  async start(token) {
    const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages];
    const withContent = this.cfg.messageContent !== false;
    try {
      await this.login(token, withContent ? [...intents, GatewayIntentBits.MessageContent] : intents);
      this.hasMessageContent = withContent;
    } catch (err) {
      if (!withContent || !/disallowed intents/i.test(err.message)) throw err;
      this.log('The Message Content intent is not enabled for this bot in the Discord developer portal. Auto-review is off; slash commands, the context menu and @mention follow-ups still work.');
      await this.login(token, intents);
      this.hasMessageContent = false;
    }
  }

  async login(token, intents) {
    this.client?.destroy();
    const client = new Client({ intents, partials: [Partials.Channel, Partials.Message] });
    this.client = client;
    client.once(Events.ClientReady, async () => {
      this.log(`logged in as ${client.user.tag} in ${client.guilds.cache.size} server(s)`);
      await Promise.all(client.guilds.cache.map((g) => this.register(g)));
      this.onReady?.(client);
    });
    client.on(Events.GuildCreate, (g) => this.register(g));
    client.on(Events.InteractionCreate, (i) => this.onInteraction(i));
    client.on(Events.MessageCreate, (m) => this.onMessage(m).catch((err) => this.log('message handler error', err)));
    client.on(Events.Error, (err) => this.log('client error', err.message));
    await client.login(token);
  }

  async register(guild) {
    try {
      await guild.commands.set(COMMANDS);
    } catch (err) {
      this.log(`could not register commands in ${guild.name}: ${err.message}`);
    }
  }

  async destroy() {
    for (const st of this.progress.values()) clearTimeout(st.timer);
    await this.client?.destroy();
  }

  /** Bot owner (solo mode auto-pairs them). */
  async owner() {
    const app = await this.client.application.fetch();
    const o = app.owner;
    if (!o) return null;
    if (o.ownerId) return this.client.users.fetch(o.ownerId); // Team
    return o;
  }

  // ---- helpers --------------------------------------------------------------------------------------

  displayName(user, member) {
    return member?.displayName || user.globalName || user.username;
  }

  async channel(id) {
    return this.client.channels.cache.get(id) || this.client.channels.fetch(id);
  }

  resolveProject(guildId, channel, explicit) {
    if (!guildId) return '';
    const g = this.store.guild(guildId);
    const names = Object.keys(g.projects);
    if (explicit) {
      const hit = names.find((n) => n.toLowerCase() === explicit.trim().toLowerCase());
      if (!hit) throw userError(`No project called "${explicit}". ${names.length ? `Projects here: ${names.join(', ')}.` : 'This server has no projects yet (`/debrief setup project`).'}`);
      return hit;
    }
    const bound = g.channels[channel?.id]?.project || (channel?.isThread?.() && g.channels[channel.parentId]?.project);
    if (bound && g.projects[bound]) return bound;
    return names.length === 1 ? names[0] : '';
  }

  /** Called by the core just before a job goes to a worker. */
  async prepareJob(job) {
    const g = job.guildId ? this.store.guild(job.guildId) : null;
    const p = g?.projects[job.projectName];
    let source = job.source;
    // Discord CDN links are signed and expire, so refresh them from the message (design §7).
    if (job.sourceMessage) {
      try {
        const ch = await this.channel(job.sourceMessage.channelId);
        const msg = await ch.messages.fetch(job.sourceMessage.messageId);
        const att = msg.attachments.get(job.sourceMessage.attachmentId) || msg.attachments.find(isVideoAttachment);
        if (att) source = { ...source, kind: 'discord', url: att.url };
      } catch (err) {
        throw new Error(`Could not reach the original message to refresh the video link (${err.message}). Was it deleted?`);
      }
    }
    return {
      id: job.id,
      source,
      context: job.context || '',
      frames: job.frames !== false,
      reviewer: job.userTag,
      reuseFrom: job.reuseFrom || null,
      project: p
        ? { name: p.name, glossary: p.glossary, departments: p.departments.length ? p.departments : DEFAULT_DEPARTMENTS, guidance: p.guidance, language: p.language }
        : {},
    };
  }

  /**
   * Common path for /review, the context menu, auto-review and re-runs. Creates (or reuses) the thread, posts
   * the progress message and queues the job.
   * opts: {user, member, guildId, channel, source, context, projectName, frames, private, sourceMessage,
   *        starter: async (text) => Message to start the thread from, thread: existing thread/DM, reuseFrom}
   */
  async startReview(o) {
    if (!this.core.canServe(o.user.id, o.guildId)) {
      throw userError('You need to pair a worker first. Install Debrief, run `debrief worker`, then use `/debrief link` with the code it prints. (See the README.)');
    }
    const reviewer = this.displayName(o.user, o.member);
    const ownOnline = this.core.workersOf(o.user.id).some((w) => this.core.isOnline(w.id));
    const queuedText = ownOnline || this.core.isPaired(o.user.id) ? `Queued on ${reviewer}'s worker` : 'Queued for a pool worker';
    let target = o.thread || null;
    let ownThread = false;
    if (!target && o.private) target = await o.user.createDM();
    if (!target && o.channel?.isThread?.()) target = o.channel;
    if (!target) {
      const name = threadName(o.context || sourceLabel(o.source), reviewer);
      let host = o.channel;
      if (!host || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(host.type)) {
        const p = o.guildId && this.store.guild(o.guildId).projects[o.projectName];
        host = p?.defaultChannelId ? await this.channel(p.defaultChannelId).catch(() => null) : null;
        if (!host) throw userError('I can\'t open a review thread here. Use a text channel, or set a default channel for the project with `/debrief setup project`.');
        o.starter = null;
      }
      const starter = o.starter ? await o.starter(`🎬 ${queuedText}`) : await host.send(`🎬 ${queuedText} · <@${o.user.id}>`);
      target = await starter.startThread({ name, autoArchiveDuration: 1440 });
      ownThread = true;
    }
    const progressMsg = await target.send(progressText({ stage: 'queued', text: queuedText }));
    return this.core.createJob({
      userId: o.user.id,
      userTag: reviewer,
      guildId: o.guildId || null,
      channelId: o.channel?.id || null,
      threadId: target.id,
      ownThread,
      progressMessageId: progressMsg.id,
      source: o.source,
      context: o.context || '',
      projectName: o.projectName || '',
      frames: o.frames !== false,
      private: Boolean(o.private),
      sourceMessage: o.sourceMessage || null,
      reuseFrom: o.reuseFrom || null,
    });
  }

  // ---- progress (core callbacks) -----------------------------------------------------------------------

  editProgress(job, p, { force = false } = {}) {
    let st = this.progress.get(job.id);
    if (!st) {
      st = { p: null, last: 0, timer: null, chain: Promise.resolve(), final: false };
      this.progress.set(job.id, st);
    }
    if (st.final && !force) return st.chain;
    st.p = p;
    if (force) st.final = ['done', 'failed'].includes(p.stage) || st.final;
    const run = () => {
      st.timer = null;
      st.last = Date.now();
      const text = progressText(st.p);
      st.chain = st.chain
        .then(async () => {
          const ch = await this.channel(job.threadId);
          await ch.messages.edit(job.progressMessageId, { content: text });
        })
        .catch((err) => this.log(`progress edit failed for ${job.id}: ${err.message}`));
      return st.chain;
    };
    const due = st.last + EDIT_INTERVAL - Date.now();
    if (force || due <= 0) {
      clearTimeout(st.timer);
      return run();
    }
    st.timer ||= setTimeout(run, due);
    return st.chain;
  }

  onStarted(job, worker) {
    const where = job.pool ? `pool worker ${worker.name} (${worker.userTag})` : `${worker.userTag}'s worker`;
    this.editProgress(job, { stage: 'queued', text: `Starting on ${where}` });
  }

  onWaiting(job, text) {
    this.editProgress(job, { stage: 'waiting', text });
  }

  onProgress(job, p) {
    if (p.title && job.ownThread && !job.renamed && !job.private) {
      job.renamed = true;
      this.store.putJob(job);
      this.channel(job.threadId)
        .then((ch) => ch.setName(threadName(p.title, job.userTag)))
        .catch(() => {});
    }
    this.editProgress(job, p);
  }

  onFailed(job, message) {
    this.editProgress(job, { stage: 'failed', text: clip(`Review failed: ${message}`, 1800) }, { force: true });
  }

  onExpired(job) {
    this.editProgress(job, { stage: 'failed', text: 'Expired: no worker came online within 24 hours. Run `/review` again when your worker is up.' }, { force: true });
  }

  async onResult(job, result) {
    const ch = await this.channel(job.threadId);
    const g = job.guildId ? this.store.guild(job.guildId) : null;
    const meta = { ...result.meta, reviewer: job.userTag, source: result.meta?.source || job.source };
    const msgs = resultMessages(result.review, meta);
    const first = await ch.send({ ...msgs[0], components: [this.buttons(job, g)] });
    job.summaryMessageId = first.id;
    job.summaryUrl = first.url;
    this.store.putJob(job);
    for (const m of msgs.slice(1)) await ch.send(m);
    for (const fm of frameMessages(result.frames || [])) {
      await ch.send({ content: fm.content, files: fm.files.map((f) => ({ attachment: Buffer.from(f.data, 'base64'), name: f.name, description: clip(f.caption, 1000) })) });
    }
    const files = [{ attachment: Buffer.from(result.files.markdown || ''), name: 'review.md' }];
    const visibility = g?.transcriptVisibility || 'reviewer';
    if (result.files.transcript && (visibility === 'thread' || job.private)) files.push({ attachment: Buffer.from(result.files.transcript), name: 'transcript.txt' });
    await ch.send({ content: '📎 Full review' + (files.length > 1 ? ' and transcript' : '') + (job.private ? '' : ' · @mention me here to ask about it'), files });
    const took = job.startedAt ? ` in ${fmtTime((Date.now() - job.startedAt) / 1000)}` : '';
    await this.editProgress(job, { stage: 'done', text: `Done${took}` }, { force: true });
    this.progress.delete(job.id);
  }

  buttons(job, g) {
    const p = g?.projects[job.projectName];
    const b = (id, label, emoji, style = 2) => ({ type: 2, style, custom_id: `dbf:${id}:${job.id}`, label, emoji: { name: emoji } });
    const row = [b('rerun', 'Re-run', '🔁'), b('tx', 'Transcript', '📄')];
    if (p?.tracker?.enabled) row.push(b('track', 'Send to tracker', '📌'));
    if (!job.private) row.push(b('done', 'Done', '✅', 3));
    return { type: 1, components: row };
  }

  // ---- interactions -----------------------------------------------------------------------------------

  async onInteraction(i) {
    try {
      if (i.isAutocomplete()) return await this.onAutocomplete(i);
      if (i.isChatInputCommand() && i.commandName === 'review') return await this.onReview(i);
      if (i.isChatInputCommand() && i.commandName === 'debrief') return await this.onDebrief(i);
      if (i.isMessageContextMenuCommand() && i.commandName === REVIEW_MENU_NAME) return await this.onReviewMessage(i);
      if (i.isButton() && i.customId.startsWith('dbf:')) return await this.onButton(i);
      if (i.isModalSubmit() && i.customId.startsWith('dbf:')) return await this.onModal(i);
    } catch (err) {
      if (!err.user) this.log('interaction error', err);
      const content = err.user ? `⚠️ ${err.message}` : `❌ Something went wrong: ${clip(err.message, 1500)}`;
      try {
        if (i.deferred || i.replied) await i.editReply({ content, embeds: [], components: [] });
        else if (i.isRepliable()) await i.reply({ content, flags: EPHEMERAL });
      } catch {}
    }
  }

  async onAutocomplete(i) {
    const focused = i.options.getFocused(true);
    const g = i.guildId ? this.store.guild(i.guildId) : null;
    const names = Object.keys(g?.projects || {});
    const q = String(focused.value || '').toLowerCase();
    let choices = names.filter((n) => n.toLowerCase().includes(q));
    if (i.commandName === 'debrief' && i.options.getSubcommand(false) === 'channel') choices = ['none', ...choices];
    await i.respond(choices.slice(0, 25).map((n) => ({ name: n, value: n })));
  }

  async onReview(i) {
    const priv = i.options.getBoolean('private') ?? false;
    await i.deferReply(priv ? { flags: EPHEMERAL } : {});
    const url = i.options.getString('url');
    const file = i.options.getAttachment('file');
    let source;
    if (file) {
      if (!isVideoAttachment(file)) throw userError(`${file.name} doesn't look like a video.`);
      source = { kind: 'discord', url: file.url, name: file.name };
    } else if (url) {
      source = detectSource(url, { anyHost: true });
      if (!source) throw userError('That doesn\'t look like a link I can fetch. Use a YouTube, Google Drive or direct https video link, or attach the file.');
    } else {
      throw userError('Give me a `url`, or attach the video with `file`.');
    }
    const channel = i.channel || (i.channelId ? await this.channel(i.channelId).catch(() => null) : null);
    const projectName = this.resolveProject(i.guildId, channel, i.options.getString('project'));
    const inThread = channel?.isThread?.();
    let replyUsed = false;
    const job = await this.startReview({
      user: i.user,
      member: i.member,
      guildId: i.guildId,
      channel,
      source,
      context: i.options.getString('context') || '',
      projectName,
      frames: i.options.getString('frames') !== 'off',
      private: priv,
      starter: priv || inThread ? null : async (text) => {
        replyUsed = true;
        await i.editReply(text);
        return i.fetchReply();
      },
    });
    if (priv) await i.editReply('🎬 Queued. The review will arrive in your DMs.');
    else if (inThread) await i.editReply(`🎬 Queued on ${job.userTag}'s worker. Progress below.`);
    else if (!replyUsed) await i.editReply(`🎬 Queued. Follow along in <#${job.threadId}>`);
  }

  async onReviewMessage(i) {
    await i.deferReply({ flags: EPHEMERAL });
    const msg = i.targetMessage;
    const att = msg.attachments.find(isVideoAttachment);
    let source;
    let sourceMessage = null;
    if (att) {
      source = { kind: 'discord', url: att.url, name: att.name };
      sourceMessage = { channelId: msg.channelId, messageId: msg.id, attachmentId: att.id };
    } else {
      source = findVideoLink(msg.content);
      if (!source) throw userError('That message has no video attachment or video link I can fetch.');
    }
    const channel = msg.channel;
    const reviewer = this.displayName(i.user, i.member);
    const context = clip(stripLinks(msg.content), 300);
    let thread = channel.isThread() ? channel : msg.thread;
    if (!thread) thread = await msg.startThread({ name: threadName(context || sourceLabel(source), reviewer), autoArchiveDuration: 1440 });
    await this.startReview({
      user: i.user,
      member: i.member,
      guildId: i.guildId,
      channel,
      thread,
      source,
      sourceMessage,
      context,
      projectName: this.resolveProject(i.guildId, channel, null),
    });
    await i.editReply(`🎬 Queued. Follow along in ${thread.url}`);
  }

  async onDebrief(i) {
    const group = i.options.getSubcommandGroup(false);
    const sub = i.options.getSubcommand();
    if (group === 'setup') return this.onSetup(i, sub);
    await i.deferReply({ flags: EPHEMERAL });
    const reviewer = this.displayName(i.user, i.member);

    if (!group && sub === 'link') {
      const r = this.core.link(i.options.getString('code'), { id: i.user.id, tag: reviewer });
      if (!r.ok) throw userError(r.error);
      return i.editReply(`✅ Paired **${r.worker.name}** with your account. Run \`/review\` to send it a video.`);
    }
    if (!group && sub === 'status') return i.editReply(this.statusText(i.user.id, i.guildId));
    if (!group && sub === 'forget') {
      const r = this.core.forget(i.user.id);
      return i.editReply(`🗑️ Unpaired ${r.workers} worker(s) and deleted ${r.jobs} job record(s). Review threads already posted in Discord stay where they are.`);
    }
    if (group === 'pool') {
      if (!this.core.isPaired(i.user.id)) throw userError('Pair a worker first with `/debrief link`.');
      if (sub === 'join') {
        const cap = i.options.getInteger('daily_cap') || 10;
        const only = i.options.getBoolean('this_server_only') ? i.guildId : null;
        this.core.setPool(i.user.id, { enabled: true, guildId: only, dailyCap: cap });
        return i.editReply(`🤝 Your worker is in the pool${only ? ' for this server' : ''}, up to ${cap} reviews a day. Pool reviews run on your Claude account and say so in the result. \`/debrief pool leave\` to stop.`);
      }
      this.core.setPool(i.user.id, { enabled: false });
      return i.editReply('Your worker has left the pool.');
    }
    throw userError('Unknown command.');
  }

  statusText(userId, guildId) {
    const s = this.core.status(userId);
    const lines = [];
    lines.push('**Your workers**');
    if (!s.workers.length) lines.push('None paired. Run `debrief worker` on your machine, then `/debrief link code:<code>`.');
    for (const w of s.workers) {
      const c = w.caps || {};
      const bits = [
        c.whisper ? `whisper ${c.whisperModel || ''}${c.vad ? ' + VAD' : ''}` : '⚠️ no whisper',
        c.gpu ? `GPU: ${c.gpu}` : null,
        c.model ? `model: ${c.model}` : null,
        w.online ? `busy ${w.busy}/${w.capacity}` : `last seen ${ago(w.lastSeen)}`,
        w.pool?.enabled ? `pool: on (${w.pool.day === new Date().toISOString().slice(0, 10) ? w.pool.used : 0}/${w.pool.dailyCap} today)` : 'pool: off',
      ].filter(Boolean);
      lines.push(`${w.online ? '🟢' : '⚫'} **${w.name}** · ${bits.join(' · ')}`);
    }
    lines.push('', '**Your queue**');
    if (!s.jobs.length) lines.push('Empty.');
    for (const j of s.jobs) lines.push(`• ${j.status === 'running' ? '⏱️ Running' : '⏳ Queued'}: ${clip(j.title || j.context || sourceLabel(j.source), 80)} · ${ago(j.createdAt)} · <#${j.threadId}>`);
    if (guildId) {
      const pool = this.core.poolWorkers(guildId, userId);
      lines.push('', `**Pool:** ${pool.length} worker(s) online for this server.`);
    }
    if (!this.hasMessageContent) lines.push('', '-# Auto-review is off on this hub (Message Content intent not enabled).');
    return clip(lines.join('\n'), 2000);
  }

  async onSetup(i, sub) {
    if (!i.guildId) throw userError('Setup only works in a server.');
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw userError('You need the Manage Server permission to change Debrief settings.');
    await i.deferReply({ flags: EPHEMERAL });
    const o = i.options;
    if (sub === 'show') return i.editReply(this.settingsText(i.guildId));

    if (sub === 'project') {
      const name = o.getString('name').trim();
      this.store.updateGuild(i.guildId, (g) => {
        const key = Object.keys(g.projects).find((k) => k.toLowerCase() === name.toLowerCase()) || name;
        const p = g.projects[key] || defaultProject(key);
        if (o.getString('glossary') != null) p.glossary = list(o.getString('glossary'));
        if (o.getString('departments') != null) p.departments = list(o.getString('departments')).map((d) => d.toLowerCase());
        if (o.getString('guidance') != null) p.guidance = o.getString('guidance');
        if (o.getString('language') != null) p.language = o.getString('language').trim().toLowerCase();
        if (o.getChannel('default_channel')) p.defaultChannelId = o.getChannel('default_channel').id;
        g.projects[key] = p;
      });
      return i.editReply(`✅ Saved project **${name}**.\n\n${this.settingsText(i.guildId)}`);
    }
    if (sub === 'remove-project') {
      const name = o.getString('name');
      let removed = false;
      this.store.updateGuild(i.guildId, (g) => {
        const key = Object.keys(g.projects).find((k) => k.toLowerCase() === name.toLowerCase());
        if (!key) return;
        delete g.projects[key];
        for (const c of Object.values(g.channels)) if (c.project === key) delete c.project;
        removed = true;
      });
      return i.editReply(removed ? `🗑️ Removed **${name}**.` : `No project called ${name}.`);
    }
    if (sub === 'channel') {
      const ch = o.getChannel('channel');
      const project = o.getString('project');
      const auto = o.getBoolean('auto_review');
      let error = null;
      this.store.updateGuild(i.guildId, (g) => {
        const c = g.channels[ch.id] || {};
        if (project != null) {
          if (project === 'none') delete c.project;
          else {
            const key = Object.keys(g.projects).find((k) => k.toLowerCase() === project.toLowerCase());
            if (!key) error = `No project called ${project}.`;
            else c.project = key;
          }
        }
        if (auto != null) c.autoReview = auto;
        g.channels[ch.id] = c;
      });
      if (error) throw userError(error);
      const warn = auto && !this.hasMessageContent ? '\n⚠️ Auto-review needs the Message Content intent, which this bot doesn\'t have. Enable it in the Discord developer portal and restart the hub.' : '';
      return i.editReply(`✅ Updated <#${ch.id}>.${warn}\n\n${this.settingsText(i.guildId)}`);
    }
    if (sub === 'transcripts') {
      this.store.updateGuild(i.guildId, (g) => (g.transcriptVisibility = o.getString('visibility')));
      return i.editReply(`✅ Transcript visibility: **${o.getString('visibility')}**.`);
    }
    if (sub === 'tracker') {
      const name = o.getString('project');
      let found = false;
      this.store.updateGuild(i.guildId, (g) => {
        const key = Object.keys(g.projects).find((k) => k.toLowerCase() === name.toLowerCase());
        if (!key) return;
        found = true;
        const t = g.projects[key].tracker;
        t.enabled = o.getBoolean('enabled');
        if (o.getString('kind') != null) t.kind = o.getString('kind');
        if (o.getString('project_key') != null) t.projectKey = o.getString('project_key');
        if (o.getString('issue_type') != null) t.issueType = o.getString('issue_type');
        if (o.getString('priorities') != null) t.priorities = o.getString('priorities').split(',');
        if (o.getString('instructions') != null) t.instructions = o.getString('instructions');
      });
      if (!found) throw userError(`No project called ${name}.`);
      return i.editReply(`✅ Tracker settings saved for **${name}**. Each reviewer also needs tracker export set up on their own worker (see the README).`);
    }
    throw userError('Unknown setup command.');
  }

  settingsText(guildId) {
    const g = this.store.guild(guildId);
    const lines = ['**Debrief settings**', `Transcripts: **${g.transcriptVisibility}**`, '', '**Projects**'];
    const ps = Object.values(g.projects);
    if (!ps.length) lines.push('None. Add one with `/debrief setup project`.');
    for (const p of ps) {
      lines.push(`• **${p.name}** · ${p.departments.length ? p.departments.join('/') : 'default departments'} · glossary: ${p.glossary.length} terms · language: ${p.language || 'en'}` +
        `${p.defaultChannelId ? ` · default <#${p.defaultChannelId}>` : ''}${p.tracker.enabled ? ` · tracker: ${p.tracker.kind}${p.tracker.projectKey ? ` ${p.tracker.projectKey}` : ''}` : ''}`);
      if (p.guidance) lines.push(`  -# ${clip(p.guidance, 150)}`);
    }
    lines.push('', '**Channels**');
    const chans = Object.entries(g.channels).filter(([, c]) => c.project || c.autoReview);
    if (!chans.length) lines.push('None configured.');
    for (const [id, c] of chans) lines.push(`• <#${id}>${c.project ? ` → ${c.project}` : ''}${c.autoReview ? ' · auto-review' : ''}`);
    return clip(lines.join('\n'), 2000);
  }

  async onButton(i) {
    const [, action, jobId] = i.customId.split(':');
    const job = this.store.job(jobId);
    if (!job || job.trimmed) throw userError('This review is no longer on record.');
    const isReviewer = i.user.id === job.userId;
    const g = job.guildId ? this.store.guild(job.guildId) : null;

    if (action === 'rerun') {
      if (!isReviewer) throw userError(`Only ${job.userTag} can re-run this review.`);
      return i.showModal({
        title: 'Re-run review',
        custom_id: `dbf:rerun:${job.id}`,
        components: [{ type: 1, components: [{ type: 4, custom_id: 'context', label: 'Context line (optional)', style: 1, required: false, max_length: 300, value: job.context || undefined }] }],
      });
    }
    if (action === 'tx') {
      if ((g?.transcriptVisibility || 'reviewer') === 'reviewer' && !isReviewer) throw userError(`Transcripts in this server are visible to the reviewer only.`);
      await i.deferReply({ flags: EPHEMERAL });
      const data = await this.askWorker(job, 'transcript', { jobId: job.id }, { timeoutMs: 60_000 });
      const text = data.text || '';
      if (text.length <= 1900) return i.editReply(text);
      return i.editReply({ content: `${clip(text, 1800)}\n-# Full transcript attached.`, files: [{ attachment: Buffer.from(text), name: 'transcript.txt' }] });
    }
    if (action === 'track') {
      if (!isReviewer) throw userError(`Only ${job.userTag} can send this review to the tracker (it runs with their account).`);
      const p = g?.projects[job.projectName];
      if (!p?.tracker?.enabled) throw userError('Tracker export is not enabled for this project.');
      await i.deferReply({ flags: EPHEMERAL });
      await i.editReply(`📌 Creating ${p.tracker.kind} tickets on your worker…`);
      const ch = await this.channel(job.threadId);
      try {
        const tracker = { kind: p.tracker.kind, projectKey: p.tracker.projectKey, issueType: p.tracker.issueType, instructions: p.tracker.instructions, priorities: p.tracker.priorities || ['high'] };
        const data = await this.askWorker(job, 'tracker', { jobId: job.id, tracker, reviewLink: job.summaryUrl || '' }, { timeoutMs: 16 * 60_000 });
        const tickets = data.tickets || [];
        const body = tickets.length
          ? tickets.map((t) => (t.error ? `⚠️ ${t.title}: ${t.error}` : `📌 ${t.key ? `**${t.key}** ` : ''}[${clip(t.title, 120)}](${t.url})`)).join('\n')
          : data.note || 'No tickets were created.';
        for (const part of splitText(`**Sent to ${p.tracker.kind}** by ${job.userTag}\n${body}`)) await ch.send(part);
      } catch (err) {
        await ch.send(`❌ Tracker export failed: ${clip(err.message, 1500)}`);
      }
      return i.editReply('Done. Results are in the thread.').catch(() => {});
    }
    if (action === 'done') {
      if (!isReviewer) throw userError(`Only ${job.userTag} can mark this review done.`);
      const row = i.message.components?.[0]?.toJSON?.() || { type: 1, components: [] };
      row.components = row.components.map((c) => ({ ...c, disabled: true }));
      await i.update({ components: [row] });
      job.resolved = true;
      this.store.putJob(job);
      const ch = i.channel;
      if (ch?.isThread?.()) {
        await ch.send(`✅ Marked done by ${job.userTag}.`);
        await ch.setArchived(true).catch(() => {});
      }
      return;
    }
    throw userError('Unknown button.');
  }

  async onModal(i) {
    const [, action, jobId] = i.customId.split(':');
    if (action !== 'rerun') return;
    const job = this.store.job(jobId);
    if (!job || job.trimmed) throw userError('This review is no longer on record.');
    if (i.user.id !== job.userId) throw userError('Only the reviewer can re-run this review.');
    await i.deferReply({ flags: EPHEMERAL });
    const thread = await this.channel(job.threadId);
    const context = i.fields.getTextInputValue('context')?.trim() || job.context;
    await this.startReview({
      user: i.user,
      member: i.member,
      guildId: job.guildId,
      channel: thread,
      thread,
      source: job.source,
      sourceMessage: job.sourceMessage,
      context,
      projectName: job.projectName,
      frames: job.frames,
      private: job.private,
      reuseFrom: job.id,
    });
    await i.editReply('🔁 Re-running. Progress is in the thread.');
  }

  async askWorker(job, kind, body, opts) {
    if (!job.workerId || !this.core.workers[job.workerId]) throw userError('The worker that made this review is no longer paired.');
    try {
      return await this.core.request(job.workerId, kind, body, opts);
    } catch (err) {
      if (err.offline) throw userError(`${this.core.workers[job.workerId]?.userTag || 'The reviewer'}'s worker is offline right now, so I can't reach that review. Try again when it's back.`);
      throw userError(err.message);
    }
  }

  // ---- messages: follow-ups and auto-review -------------------------------------------------------------

  async onMessage(msg) {
    if (msg.author.bot || !this.client.user) return;
    const isDM = !msg.guildId;
    const mentioned = msg.mentions.users.has(this.client.user.id);
    if (isDM || (mentioned && msg.channel.isThread())) {
      const job = this.store.jobForThread(msg.channelId);
      if (job) return this.onFollowup(msg, job);
      if (isDM) return;
    }
    if (msg.guildId) return this.onAutoReview(msg);
  }

  async onFollowup(msg, job) {
    const question = msg.content.replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '').trim();
    if (!question) return msg.reply('Ask me something about this review, e.g. "what did I say about the archers?"');
    if (!this.core.isOnline(job.workerId)) {
      return msg.reply(`${this.core.workers[job.workerId]?.userTag || 'The reviewer'}'s worker is offline right now, so I can't answer from this review. Try again when it's back.`);
    }
    await msg.channel.sendTyping().catch(() => {});
    const typing = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);
    try {
      const asker = this.displayName(msg.author, msg.member);
      const data = await this.core.request(job.workerId, 'ask', { jobId: job.id, question, asker }, { timeoutMs: 10 * 60_000 });
      const parts = splitText(data.text || 'I have no answer for that.');
      await msg.reply(parts[0]);
      for (const p of parts.slice(1)) await msg.channel.send(p);
    } catch (err) {
      await msg.reply(`❌ ${clip(err.message, 1500)}`);
    } finally {
      clearInterval(typing);
    }
  }

  async onAutoReview(msg) {
    const g = this.store.guild(msg.guildId);
    const ch = msg.channel;
    const binding = g.channels[msg.channelId] || (ch.isThread() ? g.channels[ch.parentId] : null);
    if (!binding?.autoReview) return;
    const att = msg.attachments.find(isVideoAttachment);
    const source = att ? { kind: 'discord', url: att.url, name: att.name } : findVideoLink(msg.content);
    if (!source) return;
    if (!this.core.canServe(msg.author.id, msg.guildId)) {
      await msg.react('🔗').catch(() => {});
      return;
    }
    const reviewer = this.displayName(msg.author, msg.member);
    const context = clip(stripLinks(msg.content), 300);
    try {
      let thread = ch.isThread() ? ch : msg.thread;
      if (!thread) thread = await msg.startThread({ name: threadName(context || sourceLabel(source), reviewer), autoArchiveDuration: 1440 });
      await this.startReview({
        user: msg.author,
        member: msg.member,
        guildId: msg.guildId,
        channel: ch,
        thread,
        source,
        sourceMessage: att ? { channelId: msg.channelId, messageId: msg.id, attachmentId: att.id } : null,
        context,
        projectName: this.resolveProject(msg.guildId, ch, null),
      });
      await msg.react('🎬').catch(() => {});
    } catch (err) {
      this.log('auto-review failed', err.message);
      await msg.react('⚠️').catch(() => {});
    }
  }
}

function stripLinks(text) {
  return String(text || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
}

export function sourceLabel(source) {
  if (!source) return 'video';
  if (source.name) return source.name;
  if (source.kind === 'youtube') return 'YouTube video';
  if (source.kind === 'drive') return 'Drive video';
  return 'video';
}
