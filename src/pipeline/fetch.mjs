// Video sources (design §7): YouTube via yt-dlp, Google Drive by file id, Discord CDN, and direct https links
// on the worker's allowlist. Every plain HTTP fetch refuses private and loopback addresses, redirects included.
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { run } from '../util.mjs';

export const DEFAULT_ALLOWED_HOSTS = [
  'youtube.com',
  'youtu.be',
  'drive.google.com',
  'drive.usercontent.google.com',
  'docs.google.com',
  'cdn.discordapp.com',
  'media.discordapp.net',
];

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|m4v|avi|wmv|flv|mpg|mpeg|ts)(\?|#|$)/i;

function hostMatches(host, allowed) {
  host = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((a) => {
    a = a.toLowerCase();
    return host === a || host.endsWith(`.${a}`);
  });
}

export function youtubeId(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
    if (h === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(shorts|live|embed|v)\/([\w-]{6,})/);
      if (m) return m[2];
    }
  } catch {}
  return null;
}

export function driveId(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)(drive|docs)\.google\.com$/.test(u.hostname) && u.hostname !== 'drive.usercontent.google.com') return null;
    const m = u.pathname.match(/\/file\/(?:u\/\d+\/)?d\/([\w-]{10,})/);
    if (m) return m[1];
    return u.searchParams.get('id');
  } catch {
    return null;
  }
}

/**
 * Classify a link. Returns {kind, url, id?} or null when it isn't something we can review.
 * anyHost: accept any https link as a direct download (the hub does this for explicit /review links and lets
 * each worker apply its own allowlist).
 */
export function detectSource(url, { allowedHosts = DEFAULT_ALLOWED_HOSTS, anyHost = false } = {}) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const yt = youtubeId(u.href);
  if (yt) return { kind: 'youtube', url: u.href, id: yt };
  const dr = driveId(u.href);
  if (dr) return { kind: 'drive', url: u.href, id: dr };
  if (/(^|\.)(cdn\.discordapp\.com|media\.discordapp\.net)$/i.test(u.hostname)) return { kind: 'discord', url: u.href };
  if (u.protocol === 'https:' && anyHost) return { kind: 'direct', url: u.href };
  if (u.protocol === 'https:' && hostMatches(u.hostname, allowedHosts) && VIDEO_EXT.test(u.pathname)) return { kind: 'direct', url: u.href };
  return null;
}

/** Pull the first reviewable link out of free text (auto-review, context menu). */
export function findVideoLink(text, opts) {
  const urls = String(text || '').match(/https?:\/\/[^\s<>()]+/gi) || [];
  for (const raw of urls) {
    const src = detectSource(raw.replace(/[.,!?;:'"\]]+$/, ''), opts);
    if (src) return src;
  }
  return null;
}

/** Start-time link for a timestamp, where the player supports one (YouTube only, design §8). */
export function timeLink(source, t) {
  if (source?.kind !== 'youtube' || !source.id) return null;
  return `https://youtu.be/${source.id}?t=${Math.floor(t)}`;
}

// ---- address safety -------------------------------------------------------------------------------

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224
  );
}

/** Expand an IPv6 address into 8 numeric groups (handles :: and a trailing dotted IPv4). */
function ipv6Groups(ip) {
  let v = ip.toLowerCase().split('%')[0];
  const dotted = v.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    v = v.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16));
}

const v4From = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) return ipv4Private(ip);
  if (isIP(ip) !== 6) return true;
  const g = ipv6Groups(ip);
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return true;
  const zeros5 = g.slice(0, 5).every((x) => x === 0);
  if (zeros5 && g[5] === 0 && g[6] === 0 && g[7] <= 1) return true; // :: and ::1
  if (zeros5 && (g[5] === 0xffff || g[5] === 0)) return ipv4Private(v4From(g[6], g[7])); // v4-mapped / v4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return ipv4Private(v4From(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return true; // 6to4 can tunnel to anything
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/**
 * DNS lookup used for the actual connection: the address that is checked is the address that is used,
 * so a host can't pass the check with a public address and then connect to a private one (DNS rebinding).
 */
export function safeLookup(hostname, options, cb) {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
      return cb(new Error(`Refusing to download from ${hostname}: it resolves to a private or local address.`));
    }
    if (options?.all) cb(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  });
}

function httpsGet(u, { signal, headers }) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) {
    return Promise.reject(new Error(`Refusing to download from ${u.hostname}: it is a private or local address.`));
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest(u, { method: 'GET', headers: { 'user-agent': 'debrief', ...headers }, lookup: safeLookup, signal }, (res) => {
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: { get: (k) => [res.headers[k.toLowerCase()]].flat()[0] ?? null },
        stream: res,
        cancel: () => res.destroy(),
        text: async () => {
          let out = '';
          for await (const c of res) {
            out += c;
            if (out.length > 2e6) break;
          }
          res.destroy();
          return out;
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** GET that follows redirects by hand so every hop is checked against the allowlist and address rules. */
export async function safeFetch(url, { allowedHosts = DEFAULT_ALLOWED_HOSTS, signal, headers, maxRedirects = 8 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:') throw new Error(`Refusing non-https URL: ${u.origin}`);
    if (!hostMatches(u.hostname, [...allowedHosts, ...GOOGLE_STORAGE])) throw new Error(`${u.hostname} is not on this worker's source allowlist.`);
    const res = await httpsGet(u, { signal, headers });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      res.cancel();
      current = new URL(res.headers.get('location'), u).href;
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects.');
}
// Drive serves the bytes from these hosts after a redirect.
const GOOGLE_STORAGE = ['googleusercontent.com', 'drive.usercontent.google.com'];

async function saveResponse(res, out, { signal, onProgress, maxBytes, kind }) {
  if (!res.ok) {
    res.cancel();
    if (kind === 'discord' && (res.status === 403 || res.status === 404)) {
      throw new Error('The Discord attachment link has expired. Post the video as a message and use Apps → Review with Debrief on it, so the link can be refreshed.');
    }
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (maxBytes && total > maxBytes) {
    res.cancel();
    throw new Error(`Video is ${(total / 1e9).toFixed(1)} GB, over this worker's limit.`);
  }
  let got = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length;
      if (maxBytes && got > maxBytes) return cb(new Error('Video is over this worker\'s size limit.'));
      if (total) onProgress?.(got / total);
      cb(null, chunk);
    },
  });
  await pipeline(res.stream, counter, createWriteStream(out), { signal });
  return out;
}

async function downloadDirect(url, dir, opts) {
  const res = await safeFetch(url, opts);
  const type = res.headers.get('content-type') || '';
  if (res.ok && /text\/html/i.test(type)) {
    res.cancel();
    throw new Error('That link points to a web page, not a video file.');
  }
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'video');
  const out = join(dir, `source${(name.match(/\.\w{2,4}$/) || ['.mp4'])[0]}`);
  await saveResponse(res, out, opts);
  return { file: out, title: name.replace(/\.\w{2,4}$/, '') };
}

const DRIVE_HELP = 'Google Drive did not return the file. Make sure it is shared as "Anyone with the link".';

/** Link-shared Drive files, including the "can't scan for viruses" confirmation page for large files. */
async function downloadDrive(id, dir, opts) {
  let res = await safeFetch(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`, opts);
  if (/text\/html/i.test(res.headers.get('content-type') || '')) {
    const html = await res.text();
    const form = html.match(/<form[^>]+action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
    if (!form) throw new Error(DRIVE_HELP);
    const action = new URL(form[1].replace(/&amp;/g, '&'), 'https://drive.usercontent.google.com/');
    for (const m of form[2].matchAll(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi)) action.searchParams.set(m[1], m[2]);
    res = await safeFetch(action.href, opts);
    if (/text\/html/i.test(res.headers.get('content-type') || '')) {
      res.cancel();
      throw new Error(DRIVE_HELP);
    }
  }
  const cd = res.headers.get('content-disposition') || '';
  const fname = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="([^"]+)"/i) || [])[1] || 'video.mp4');
  const out = join(dir, `source${(fname.match(/\.\w{2,4}$/) || ['.mp4'])[0]}`);
  await saveResponse(res, out, opts);
  return { file: out, title: fname.replace(/\.\w{2,4}$/, '') };
}

async function downloadYoutube(url, dir, { signal, onProgress, cfg = {}, pool = false }) {
  const args = [
    '--no-playlist', '--no-warnings', '--newline', '--progress', '--no-simulate',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', join(dir, 'source.%(ext)s'),
    '--print', 'before_dl:TITLE:%(title)s',
  ];
  // Never use the worker owner's browser cookies for someone else's (pool) review.
  if (cfg.youtubeCookiesFromBrowser && !pool) args.push('--cookies-from-browser', cfg.youtubeCookiesFromBrowser);
  args.push('--', url);
  let title = '';
  // yt-dlp downloads video and audio separately; track both as halves of the bar.
  let part = 0;
  let last = 0;
  await run(cfg.ytDlp || 'yt-dlp', args, {
    signal,
    onLine: (line) => {
      if (line.startsWith('TITLE:')) title = line.slice(6).trim();
      const m = line.match(/^\[download\]\s+([\d.]+)%/);
      if (m) {
        const p = Number(m[1]) / 100;
        if (p < last - 0.5) part = Math.min(part + 1, 1);
        last = p;
        onProgress?.(Math.min(1, (part + p) / 2));
      }
    },
  });
  const file = readdirSync(dir).filter((f) => f.startsWith('source.') && !/\.(part|ytdl)$/.test(f)).map((f) => join(dir, f))
    .sort((a, b) => statSync(b).size - statSync(a).size)[0];
  if (!file || !existsSync(file)) throw new Error('yt-dlp finished without producing a video file.');
  return { file, title };
}

/**
 * Download a source into dir. Returns {file, title}.
 * opts: {cfg, signal, onProgress, allowedHosts, maxBytes}
 */
export async function fetchSource(source, dir, opts = {}) {
  // Pool reviews come from other people, so they only get the built-in hosts, not the owner's additions.
  const allowedHosts = opts.pool ? DEFAULT_ALLOWED_HOSTS : [...DEFAULT_ALLOWED_HOSTS, ...(opts.cfg?.allowedHosts || [])];
  const o = { ...opts, allowedHosts, kind: source.kind, maxBytes: opts.cfg?.maxDownloadBytes || 8e9 };
  switch (source.kind) {
    case 'youtube':
      return downloadYoutube(source.url, dir, o);
    case 'drive':
      return downloadDrive(source.id, dir, o);
    case 'discord':
    case 'direct':
      return downloadDirect(source.url, dir, o);
    default:
      throw new Error(`Unsupported source: ${source.kind}`);
  }
}
