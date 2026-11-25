import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

export const BIN = process.env.YTDLP_PATH || 'yt-dlp';

// Bare video ids are used for the cache and for tracks coming from search
// results. Playlist ids are longer and can contain the same characters.
export const VIDEO_ID_RE = /^[\w-]{6,20}$/;
const PLAYLIST_ID_RE = /^[\w-]{8,64}$/;

const HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'www.youtu.be',
  'youtube-nocookie.com', 'www.youtube-nocookie.com'
]);

const searchCache = new Map();
const SEARCH_TTL = 1000 * 60 * 30;

/* ------------------------------------------------------------- yt-dlp setup

   YouTube now makes yt-dlp solve a JavaScript challenge before it will hand
   over every audio format. yt-dlp only enables Deno by default, so on a
   machine with Node but no Deno it quietly gets a partial format list, and
   that is exactly why some tracks play and others fail. We hand it the Node
   binary that is already running this server.                              */

let version = null;
let jsRuntimeArg = null;

export async function init() {
  try {
    const { stdout } = await run(BIN, ['--version']);
    version = stdout.trim();
  } catch {
    version = null;
    return { version: null, jsRuntime: null };
  }

  const setting = process.env.YTDLP_JS_RUNTIME; // "off" disables, or e.g. "deno"
  if (setting === 'off') {
    jsRuntimeArg = null;
  } else if (setting) {
    jsRuntimeArg = setting;
  } else {
    jsRuntimeArg = `node:${process.execPath}`;
  }
  return { version, jsRuntime: jsRuntimeArg };
}

export function baseArgs({ playlist = false } = {}) {
  // Playlist extraction has to be allowed explicitly: every other yt-dlp call
  // (downloads, search, single videos) wants just one video.
  const args = playlist ? [] : ['--no-playlist'];
  if (jsRuntimeArg) args.push('--js-runtimes', jsRuntimeArg);
  if (process.env.YTDLP_REMOTE_COMPONENTS) {
    args.push('--remote-components', process.env.YTDLP_REMOTE_COMPONENTS);
  }
  if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
    args.push('--cookies-from-browser', process.env.YTDLP_COOKIES_FROM_BROWSER);
  }
  if (process.env.YTDLP_COOKIES_FILE) {
    args.push('--cookies', process.env.YTDLP_COOKIES_FILE);
  }
  if (process.env.YTDLP_EXTRA_ARGS) {
    args.push(...process.env.YTDLP_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  }
  return args;
}

export const ytdlpVersion = () => version;

/* ------------------------------------------------------------------ search */

function cacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { searchCache.delete(key); return null; }
  return hit.value;
}

export async function search(query, limit = 20) {
  const key = `${query}::${limit}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  // --flat-playlist keeps this fast: metadata only, no per-video extraction.
  const { stdout } = await run(BIN, [
    `ytsearch${limit}:${query}`,
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--ignore-errors'
  ], { maxBuffer: 1024 * 1024 * 24, timeout: 45_000 });

  const seen = new Set();
  const tracks = stdout
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .map(toTrack)
    .filter(t => t && !seen.has(t.sourceId) && seen.add(t.sourceId))
    // Drop livestreams and hour-long uploads that aren't songs.
    .filter(t => t.duration > 30 && t.duration < 1500);

  searchCache.set(key, { value: tracks, expires: Date.now() + SEARCH_TTL });
  return tracks;
}

// Used by the DJ: find the single best match for a text suggestion.
export async function findOne(query) {
  const results = await search(query, 3);
  return results[0] ?? null;
}

/* ------------------------------------------------------------- direct links */

// Accept the shapes people actually paste: watch/, youtu.be/, shorts/, live/,
// embed/, /playlist and bare host names. Canonical URLs are built from the ids
// afterwards, so nothing from the pasted string reaches yt-dlp unchecked.
export function parseYouTubeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 500) return null;

  let url;
  try { url = new URL(raw); } catch { try { url = new URL(`https://${raw}`); } catch { return null; } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  const short = url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be';
  const list = url.searchParams.get('list');

  let videoId = short ? parts[0] : url.searchParams.get('v');
  if (!short && ['shorts', 'live', 'embed', 'v'].includes(parts[0])) videoId = parts[1];

  // A watch URL copied from a playlist carries both ids. The playlist is the
  // more useful interpretation here: it is what the user meant to share.
  if (list && PLAYLIST_ID_RE.test(list)) return { kind: 'playlist', id: list };
  if (videoId && VIDEO_ID_RE.test(videoId)) return { kind: 'video', id: videoId };
  return null;
}

// Returns { kind, tracks }, where tracks use the same shape as search results.
export async function resolveUrl(input, parsed = parseYouTubeUrl(input)) {
  if (!parsed) return null;

  if (parsed.kind === 'video') {
    const url = `https://www.youtube.com/watch?v=${parsed.id}`;
    const { stdout } = await run(BIN, [
      ...baseArgs(),
      '--dump-single-json',
      '--skip-download',
      '--no-warnings',
      url
    ], { maxBuffer: 1024 * 1024 * 4, timeout: 45_000 });

    const track = toTrack(JSON.parse(stdout));
    if (!track) throw new Error('No video found in that link');
    return { kind: 'video', tracks: [track] };
  }

  const url = `https://www.youtube.com/playlist?list=${parsed.id}`;
  // --flat-playlist gives one small JSON object per entry instead of fetching
  // every video's full metadata, which would make long playlists painfully slow.
  const { stdout } = await run(BIN, [
    // Even a stray --no-playlist in YTDLP_EXTRA_ARGS must not break playlists.
    ...baseArgs({ playlist: true }).filter(a => a !== '--no-playlist'),
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--ignore-errors',
    url
  ], { maxBuffer: 1024 * 1024 * 24, timeout: 90_000 });

  const seen = new Set();
  const tracks = stdout
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .map(toTrack)
    .filter(t => t && !seen.has(t.sourceId) && seen.add(t.sourceId));

  return { kind: 'playlist', tracks };
}

// Shared by search, direct links and playlists. Flat playlist entries often
// have no duration; zero is fine, playback reports the real length later.
function toTrack(v) {
  if (!v || v._type === 'playlist') return null;
  const id = String(v.id ?? '');
  if (!VIDEO_ID_RE.test(id)) return null;
  const seconds = Number(v.duration) || (Number(v.duration_ms) ? Number(v.duration_ms) / 1000 : 0);
  return {
    source: 'youtube',
    sourceId: id,
    title: cleanTitle(String(v.title ?? '')),
    artist: String(v.uploader || v.channel || v.channel_name || 'Unknown artist').replace(/ - Topic$/, ''),
    duration: Math.round(seconds) || 0,
    artwork: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`
  };
}

// YouTube titles are full of noise that makes display and matching worse.
function cleanTitle(raw = '') {
  return raw
    .replace(/[([](official\s+)?(music\s+)?(video|audio|lyric(s)?(\s+video)?|visuali[sz]er)[)\]]/gi, '')
    .replace(/[([](hd|hq|4k|remaster(ed)?(\s+\d{4})?)[)\]]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
