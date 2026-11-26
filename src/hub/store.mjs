// The hub's small database: pairings, worker tokens (hashed), server settings and the job queue.
// A JSON file written atomically; a studio's volume (tens of reviews a day) doesn't need more.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = () => ({ version: 1, workers: {}, guilds: {}, jobs: {} });

export class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    if (file && existsSync(file)) {
      try {
        this.data = { ...EMPTY(), ...JSON.parse(readFileSync(file, 'utf8')) };
      } catch (err) {
        const bad = `${file}.corrupt-${Date.now()}`;
        renameSync(file, bad);
        console.error(`[hub] ${file} was unreadable (${err.message}); moved it to ${bad} and started fresh.`);
      }
    }
    this.timer = null;
  }

  /** Debounced save; call after any mutation. */
  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
    this.timer.unref?.();
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this.timer);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  // ---- guild settings ----
  guild(id) {
    return normalizeGuild(this.data.guilds[id]);
  }
  updateGuild(id, fn) {
    const g = this.guild(id);
    fn(g);
    this.data.guilds[id] = g;
    this.save();
    return g;
  }

  // ---- jobs ----
  job(id) {
    return this.data.jobs[id] || null;
  }
  putJob(job) {
    this.data.jobs[job.id] = job;
    this.save();
    return job;
  }
  jobs(filter = () => true) {
    return Object.values(this.data.jobs).filter(filter);
  }
  /** The latest job posted in a thread (follow-ups go to whoever made it). */
  jobForThread(threadId) {
    return this.jobs((j) => j.threadId === threadId && j.status === 'done').sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0] || null;
  }
}

export function defaultProject(name = '') {
  return {
    name,
    glossary: [],
    departments: [],
    guidance: '',
    language: '',
    defaultChannelId: '',
    tracker: { enabled: false, kind: 'Jira', projectKey: '', issueType: '', instructions: '' },
  };
}

export function normalizeGuild(g = {}) {
  const projects = {};
  for (const [k, p] of Object.entries(g.projects || {})) projects[k] = { ...defaultProject(k), ...p, tracker: { ...defaultProject().tracker, ...(p.tracker || {}) } };
  return {
    projects,
    channels: { ...(g.channels || {}) },
    transcriptVisibility: g.transcriptVisibility || 'reviewer',
  };
}
