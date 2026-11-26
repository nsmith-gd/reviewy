# Debrief

Post a video link in Discord and get structured review notes back in a thread: a summary, **Feedback** (what should change, with priority), **Intentions** (the design goals behind it) and **Notes**. Every item has a clickable timestamp, a department tag and the frame that shows it best.

Each review runs on the reviewer's own machine with their own Claude Code account and a local whisper.cpp. Discord only sees the result. The design is in the Debrief design doc (v0.1).

```
/review url:https://youtu.be/abc123 context:Combat pass on camp 3, focus on readability
```

**Contents**

- [For reviewers: set up your worker](#for-reviewers-set-up-your-worker-about-10-minutes)
- [Using it in Discord](#using-it-in-discord)
- [For whoever runs the hub](#for-whoever-runs-the-hub)
- [Solo mode](#solo-mode)
- [Worker settings](#worker-settings)
- [Send to tracker](#send-to-tracker)
- [Privacy and security](#privacy-and-security)
- [How it works](#how-it-works)
- [Development](#development)

---

## For reviewers: set up your worker (about 10 minutes)

You need Node 20+, ffmpeg, yt-dlp, whisper.cpp with a model, and Claude Code logged in. `debrief doctor` checks all of them and tells you how to install what's missing.

**1. Install Debrief**

```bash
npm i -g github:nsmith-gd/reviewy
```

**2. Install the tools**

Windows (PowerShell):

```bash
winget install Gyan.FFmpeg yt-dlp.yt-dlp
```

macOS:

```bash
brew install ffmpeg yt-dlp whisper-cpp
```

Linux: install `ffmpeg` with your package manager, `python3 -m pip install -U yt-dlp`, and build whisper.cpp (see [below](#linux-building-whispercpp)).

If you don't have Claude Code yet:

```bash
npm i -g @anthropic-ai/claude-code
```

Run `claude` once to log in.

**3. Get the Whisper model.** This downloads `ggml-large-v3-turbo-q8_0.bin` (about 870 MB) and the Silero VAD model into `~/.debrief/whisper`. On Windows it also downloads whisper.cpp itself, using the CUDA build if you have an NVIDIA GPU. If you already use Ballast, `~/.ballast/whisper` is picked up automatically and you can skip this step.

```bash
debrief whisper install
```

On a CPU-only machine, a smaller model is much faster:

```bash
debrief whisper install --model small
```

**4. Check everything**

```bash
debrief doctor --deep
```

**5. Start your worker and pair it.** Ask in `#reviews` for the hub address.

```bash
debrief worker --hub wss://debrief.example.com
```

The first time, it prints a six-character code. In any Discord server the bot is in, run `/debrief link code:K4P9QX`. That's it: run `/review` with a link.

Keep the worker running while you want reviews. It reconnects on its own, and reviews queue for up to 24 hours while it's offline. To start it at login:

- **Windows:** `schtasks /create /tn "Debrief worker" /tr "cmd /c debrief worker" /sc onlogon`
- **macOS/Linux:** run it under `pm2`, or on Linux use `deploy/debrief-worker.service` (instructions are in the file).

### Linux: building whisper.cpp

```bash
git clone --depth 1 https://github.com/ggml-org/whisper.cpp ~/.debrief/whisper/src
```

```bash
cd ~/.debrief/whisper/src && cmake -B build -DGGML_CUDA=ON && cmake --build build -j --config Release
```

Leave out `-DGGML_CUDA=ON` without an NVIDIA GPU, or use `-DGGML_VULKAN=ON` for other GPUs. Debrief finds `whisper-cli` anywhere under `~/.debrief/whisper`. Then run `debrief whisper install` for the models.

---

## Using it in Discord

| What | How |
|---|---|
| Review a link | `/review url:<link> [context:…] [project:…] [frames:off] [private:true]` |
| Review an upload | `/review file:<attachment>`, or right-click a message → **Apps → Review with Debrief** |
| Auto-review | In channels set up for it, just post a video. Your message text becomes the context line. |
| Ask about a review | @mention the bot in the review thread: *"what did I say about the archers?"*, *"turn the high-priority feedback into a checklist"* |
| Buttons | 🔁 **Re-run** (with a new context line; reuses the download and transcript) · 📄 **Transcript** · 📌 **Send to tracker** · ✅ **Done** (archives the thread) |
| Your status | `/debrief status`: your workers, Whisper/GPU, queue |
| Share your GPU | `/debrief pool join [daily_cap] [this_server_only]` lets your worker review for people who have none online. `/debrief pool leave` to stop. |
| Leave | `/debrief forget` unpairs you and deletes everything the hub holds about you. On the worker, `debrief unlink` does the same for that machine. |

**Sources:** YouTube (public and unlisted), Google Drive files shared as "anyone with the link", Discord attachments, and direct `https` links to video files on hosts you add to your worker's allowlist. YouTube timestamps link straight to the moment; Drive and Discord timestamps are plain text.

**Uploads:** posting the video as a message and using **Apps → Review with Debrief** (or auto-review) is better than `/review file:`. Discord's attachment links expire, and only a message lets the hub refresh the link if the review waits in the queue or is re-run later.

**`frames:off`** skips the picture and reviews the transcript only. It's much cheaper and fine for call recordings or talks over slides.

**`private:true`** sends the review to your DMs. In DMs you can ask follow-ups without @mentioning.

Items marked 👁 came only from the picture, not from what the reviewer said.

---

## For whoever runs the hub

The hub is the Discord bot. It's small, holds no Claude credentials and does no heavy work. One hub serves the whole studio.

### 1. Create the Discord application

1. In the [Discord developer portal](https://discord.com/developers/applications), click **New Application** and name it "Debrief".
2. Under **Bot**, click **Reset Token** and copy the token. Under **Privileged Gateway Intents**, turn on **Message Content Intent**. This is needed only for auto-review; without it, everything else still works.
3. Invite the bot. Use this URL with your application ID (from **General Information**):

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot%20applications.commands&permissions=311385246784
```

That grants View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Embed Links, Attach Files, Read Message History, Add Reactions and Use Application Commands. It requests no admin permissions.

### 2. Run the hub

Workers connect to the hub over a WebSocket, so it needs an address they can reach. Use `wss://` (TLS) for anything outside one office network.

**With Docker on a small VPS (recommended).** Caddy gets the TLS certificate automatically. Point a DNS name at the server, then:

```bash
DISCORD_TOKEN=<bot token> DEBRIEF_DOMAIN=debrief.example.com docker compose up -d --build
```

Reviewers use `debrief worker --hub wss://debrief.example.com`. Data lives in the `hub-data` volume.

**Without Docker** (an always-on PC, for example):

```bash
debrief hub --token <bot token>
```

The token is saved to `~/.debrief/hub.config.json`. The hub listens on port 8787. Put it behind a TLS reverse proxy (Caddy, nginx, Cloudflare Tunnel) so workers can use `wss://`. Health check: `GET /health`.

Environment variables: `DISCORD_TOKEN`, `DEBRIEF_PORT`, `DEBRIEF_HOST`, `DEBRIEF_DATA` (state file), `DEBRIEF_MESSAGE_CONTENT=false`.

### 3. Configure the server

All of these need the Manage Server permission. Run `/debrief setup show` to see the current settings.

```
/debrief setup project name:ZQuest glossary:Spittoony, parry window, camp 3 departments:gameplay, art, audio, ui, other guidance:Readability first; we target Quest 3.
/debrief setup channel channel:#zquest-reviews project:ZQuest auto_review:true
/debrief setup transcripts visibility:thread
/debrief setup tracker project:ZQuest enabled:true kind:Jira project_key:ZQ issue_type:Task
```

- **Projects** hold a glossary (fed to Whisper and Claude, so names come out right), departments (the `area` tags), house-style guidance, the Whisper language, and a default channel for threads.
- **Channels** can be bound to a project, so reviews there use it without anyone choosing it. They can also turn on auto-review.
- **Transcripts** are visible to the reviewer only by default, because reviews can be candid. `button` lets anyone open them with the Transcript button; `thread` attaches `transcript.txt` to the thread.

---

## Solo mode

For one person with their own bot: the hub and a worker run in one process, with no server to host.

```bash
debrief solo --token <your bot token>
```

The worker pairs itself to the bot's owner automatically. Anyone else in your server can't run reviews unless you add them to a real hub.

---

## Worker settings

These live in `~/.debrief/config.json`. Use `debrief config` to show them, or `debrief config <key> <value>` to change one.

| Key | Default | Meaning |
|---|---|---|
| `model` | `sonnet` | Claude model for reviews and follow-ups |
| `frameBudget` | `60` | Frames per review (per chapter for long videos). A third are spread evenly and two thirds anchored on speech. |
| `speechAnchoredFrames` | `true` | Set to `false` to use only Ballast's even spread |
| `longVideoMinutes` | `30` | Longer videos are split into chapters at silences and merged |
| `chapterLength` | `900` | Target chapter length, in seconds |
| `language` | `en` | Whisper language when the project doesn't set one |
| `whisperDir` / `whisperCli` / `whisperModel` | auto | Override where whisper.cpp and the model are found |
| `cacheRetentionDays` | `14` | How long frames and transcripts are kept for follow-ups and re-runs. Videos are deleted as soon as the review posts. |
| `maxConcurrentJobs` | `1` | Reviews this machine runs at once |
| `allowedHosts` | `[]` | Extra hosts for direct video links (YouTube, Drive and Discord are always allowed) |
| `youtubeCookiesFromBrowser` | `""` | For private YouTube videos, e.g. `chrome`. The cookies stay local. |
| `claudeProfiles` | one default | Several Claude Code logins, e.g. `[{"name":"work","configDir":"C:/Users/me/.claude-work"},{"name":"api","apiKeyEnv":"MY_ANTHROPIC_KEY"}]`. The worker picks the one with the most room left and fails over when one hits its limit. |
| `claudeBin`, `ytDlp` | on PATH | Full paths, if needed |
| `postFrames` | `20` | Most key frames posted per review |

---

## Send to tracker

When it's enabled for a project, the reviewer's 📌 button makes their worker run Claude Code with **their own** MCP connectors. It creates one ticket per high-priority feedback item (or per the project's `priorities` setting), with the timestamp link, the intention and a link back to the thread. Tickets are created as the reviewer.

It only works for reviews that ran on your own worker, not on a pool worker, because it acts with the worker owner's accounts.

Each reviewer opts in on their own worker by listing exactly which tools that run may use. Run `claude mcp list` to see your servers. For example, with the Atlassian connector:

```bash
debrief config tracker '{"allowedTools":["mcp__atlassian__createJiraIssue","mcp__atlassian__getVisibleJiraProjects","mcp__atlassian__getJiraProjectIssueTypesMetadata"]}'
```

Add `"mcpConfig": "<path to an MCP config JSON>"` if the server isn't already configured in Claude Code.

---

## Privacy and security

- **Where things live.** Videos, audio, frames and transcripts stay on the reviewer's machine. They are shared only with the reviewer's own Claude account and posted only as far as the server's settings say. The hub stores pairings, settings and the job queue in one JSON file. It never stores video or review text, and it never holds Claude, Google or YouTube credentials.
- **Pairing tokens.** These are stored hashed on the hub. `/debrief forget` and `debrief unlink` revoke them.
- **Prompt injection.** Review and follow-up runs get only the `Read` tool, limited to that job's frames folder, and no MCP servers. Text in the video that looks like instructions has nothing to act on. Tracker export is the only run that can write. It needs the reviewer's click, only uses the tools they listed, and only sees the structured feedback.
- **URL fetching.** Pool workers never use their owner's YouTube cookies or extra allowed hosts for other people's reviews. Workers download only from the allowlist, over https. They refuse private, loopback and link-local addresses, and check every redirect.
- **Authorization.** Workers only get jobs from the user they're paired to, or pool jobs if they opted in. Re-run, Send to tracker and Done are reviewer-only.

---

## How it works

```
Discord ⇄ Hub (bot · queue · settings) ⇄ WebSocket, outbound from each worker ⇄ Worker (Claude Code · whisper.cpp · ffmpeg · yt-dlp)
```

The worker pipeline is Ballast's video review with Debrief's changes:

1. Fetch the video.
2. Probe it with ffprobe.
3. Extract 16 kHz audio.
4. Transcribe with whisper.cpp (VAD if installed; the prompt is primed with the project glossary and the context line).
5. Apply the guards: drop stock noise lines; flag the transcript unreliable when more than 30% of lines repeat.
6. Pull speech-anchored frames at 960px, JPEG q4.
7. Run `claude -p` with `--json-schema`, the Read tool only and `--add-dir <frames>`.
8. Snap each item's time to its frame.
9. Post the result.

Videos longer than 30 minutes are reviewed in chapters and merged in a final pass.

Code map: `src/pipeline/` (fetch, media, whisper, claude, prompt, schema, chapters, review), `src/hub/` (core: pairing, routing, queue and pool; discord: the bot; store), `src/worker/`, `src/render/` (Discord embeds and Markdown).

---

## Development

```bash
npm install
```

```bash
npm test
```

The tests cover the pipeline pieces, the Discord rendering limits, the Discord front end against mock objects, and an end-to-end run. That run starts a real hub core and worker over WebSocket, uses real ffmpeg, and swaps in stand-ins for yt-dlp, whisper-cli and claude from `testdata/`. They need ffmpeg on PATH.
