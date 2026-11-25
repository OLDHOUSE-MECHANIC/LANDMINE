import { execFile } from 'child_process';
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'fs';
import { join, resolve, extname } from 'path';
import { tmpdir } from 'os';
import { BIN, baseArgs } from './sources/youtube.js';

/**
 * Why files instead of piping a URL through?
 *
 * Handing the browser a googlevideo URL (or proxying one) is fragile: the
 * URLs are signed, IP-bound, throttled, and sometimes HLS manifests. Letting
 * yt-dlp do the whole download itself is the path it is built and patched
 * for. Once the file is on disk, serving it is trivial: seeking works, a
 * replay is instant, and the next tracks can be fetched ahead of time.
 */

export const DIR = resolve(process.env.CACHE_DIR || join(tmpdir(), 'landmine-cache'));

const AUDIO_EXT = new Set(['.m4a', '.mp4', '.webm', '.opus', '.ogg', '.mp3', '.aac']);
const MIME = {
  '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm',
  '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.aac': 'audio/aac'
};

// Prefer AAC in an m4a container: every browser plays it. Fall back to
// whatever the best audio is (usually opus/webm) rather than failing.
const FORMAT = 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio';

const MAX_TRACKS = Number(process.env.CACHE_MAX_TRACKS) || 80;
const CONCURRENCY = 2;
const TIMEOUT_MS = 180_000;

let keepFn = () => new Set();

export function init() {
  mkdirSync(DIR, { recursive: true });
  // Start clean so a crash mid-download can never leave a half file behind.
  for (const f of readdirSync(DIR)) rmSync(join(DIR, f), { force: true });
}

// Ids currently in the queue, so pruning never deletes a track about to play.
export function setKeep(fn) {
  keepFn = fn;
}

/* ------------------------------------------------------------------ lookup */

// Only an exact "<id>.<ext>" counts. That excludes .part files and the
// intermediate "<id>.f140.m4a" files yt-dlp writes while merging.
function audioFiles() {
  return readdirSync(DIR).filter(f => {
    const dot = f.indexOf('.');
    return dot > 0 && !f.slice(dot + 1).includes('.') && AUDIO_EXT.has(extname(f));
  });
}

export function pathFor(id) {
  const hit = audioFiles().find(f => f.slice(0, f.indexOf('.')) === id);
  return hit ? join(DIR, hit) : null;
}

export function mimeFor(file) {
  return MIME[extname(file)] || 'application/octet-stream';
}

export function touch(file) {
  try {
    const now = new Date();
    utimesSync(file, now, now);
  } catch { /* file may have just been pruned */ }
}

export function forget(id) {
  for (const f of readdirSync(DIR)) {
    if (f.startsWith(`${id}.`)) rmSync(join(DIR, f), { force: true });
  }
}

/* ---------------------------------------------------------------- download */

let active = 0;
const waiting = [];

function limited(fn) {
  return new Promise((resolveFn, rejectFn) => {
    const go = () => {
      active++;
      fn().then(resolveFn, rejectFn).finally(() => {
        active--;
        waiting.shift()?.();
      });
    };
    if (active < CONCURRENCY) go();
    else waiting.push(go);
  });
}

function runYtdlp(id) {
  const args = [
    `https://www.youtube.com/watch?v=${id}`,
    ...baseArgs(),
    '-f', FORMAT,
    '-q',
    '--no-simulate',
    '--print', 'after_move:filepath',
    '-o', join(DIR, '%(id)s.%(ext)s')
  ];

  return new Promise((resolveFn, rejectFn) => {
    execFile(BIN, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        return rejectFn(err);
      }
      resolveFn(stdout.trim().split('\n').pop());
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Failures that will not get better by trying again.
const PERMANENT = /private video|unavailable|removed|not available in your|blocked|age|sign in|members-only|premium|copyright|no such file|ENOENT/i;

async function download(id) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await runYtdlp(id);
      const file = pathFor(id);
      if (!file) throw new Error('yt-dlp finished but wrote no audio file');
      return file;
    } catch (err) {
      lastErr = err;
      forget(id); // never leave partials behind
      const text = `${err.stderr || ''} ${err.message || ''}`;
      if (PERMANENT.test(text)) break;
      await sleep(1200);
    }
  }
  throw lastErr;
}

const inflight = new Map();

// Resolves to the file path once the track is on disk. Concurrent callers
// for the same track share one download.
export function ensure(id) {
  const existing = pathFor(id);
  if (existing) return Promise.resolve(existing);

  let job = inflight.get(id);
  if (job) return job;

  job = limited(() => download(id)).finally(() => {
    inflight.delete(id);
    prune();
  });
  inflight.set(id, job);
  return job;
}

/* ------------------------------------------------------------- housekeeping */

export function prune() {
  try {
    const files = audioFiles();
    const excess = files.length - MAX_TRACKS;
    if (excess <= 0) return;

    const keep = keepFn();
    const victims = files
      .map(f => ({ f, id: f.slice(0, f.indexOf('.')), mtime: statSync(join(DIR, f)).mtimeMs }))
      .filter(x => !keep.has(x.id))
      .sort((a, b) => a.mtime - b.mtime)
      .slice(0, excess);

    for (const v of victims) rmSync(join(DIR, v.f), { force: true });
  } catch { /* best effort */ }
}

/* ------------------------------------------------------------------ errors */

// Turn yt-dlp's noise into one short, human reason.
export function explain(err) {
  const text = `${err?.stderr || ''}\n${err?.message || ''}`;
  const rules = [
    [/ENOENT/, 'yt-dlp is not installed'],
    [/javascript runtime|js runtime|challenge solving|ejs/i, "yt-dlp can't solve YouTube's JS challenge"],
    [/private video/i, 'Private video'],
    // Age checks also say "sign in to confirm", so they must be matched first.
    [/age[- ]restrict|confirm your age|inappropriate for some/i, 'Age-restricted'],
    [/sign in to confirm|not a bot|login required/i, 'YouTube wants a signed-in session'],
    [/not available in your country|blocked it in your country/i, 'Blocked in your region'],
    [/members-only|join this channel/i, 'Members-only'],
    [/premium/i, 'Premium-only'],
    [/video unavailable|not available|has been removed|no longer available/i, 'Video unavailable'],
    [/requested format is not available|no formats/i, 'No audio format available'],
    [/timed out|ETIMEDOUT|killed|SIGTERM/i, 'Timed out']
  ];
  for (const [re, reason] of rules) if (re.test(text)) return reason;
  return 'yt-dlp could not fetch it';
}

// The last few lines of yt-dlp's stderr, for the server log.
export function tail(err, lines = 3) {
  return String(err?.stderr || err?.message || '')
    .trim()
    .split('\n')
    .slice(-lines)
    .join(' | ')
    .slice(0, 400);
}
