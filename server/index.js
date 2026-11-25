import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { networkInterfaces } from 'os';

import { Queue } from './queue.js';
import * as youtube from './sources/youtube.js';
import * as cache from './cache.js';
import * as gemini from './ai/gemini.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ID_RE = youtube.VIDEO_ID_RE;
const AHEAD = 2;              // how many upcoming tracks are fetched in advance
const RECONNECT_GRACE = 8000; // a device that drops can come back without losing the speaker role

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

/* ------------------------------------------------------------------- state

   Everything the app knows lives in these objects. Browsers are only windows
   onto them: they send intents, the server changes state, and every device
   is pushed the result.                                                     */

const queue = new Queue();

const devices = new Map();   // deviceId -> { id, name, kind, online, socketId, dropTimer }
let activeDeviceId = null;   // the device whose speakers are in use

const playback = {
  playing: false,
  ended: false,     // the queue ran out; the last track is parked at its start
  position: 0,
  duration: 0,
  volume: 0.8,
  seekNonce: 0,     // bumped whenever the active device must jump to seekTo
  seekTo: 0
};

const dj = {
  enabled: true,
  mood: null,
  thinking: false,
  lastNote: '',
  cooldownUntil: 0
};

const settings = {
  autoSkip: true    // skip tracks that cannot be fetched instead of stopping
};

cache.setKeep(() => new Set(queue.items.map(i => i.sourceId)));

/* -------------------------------------------------------- pushing to clients */

function snapshot() {
  return {
    queue: queue.snapshot(),
    playback,
    dj: { ...dj, available: gemini.isEnabled() },
    settings,
    devices: [...devices.values()].map(({ id, name, kind, online }) => ({ id, name, kind, online })),
    activeDeviceId
  };
}

function push() {
  io.emit('state', snapshot());
}

// One-line messages. Identical ones within a few seconds are dropped so a
// burst of failures can never turn into a wall of notifications.
const recentNotices = new Map();

function notify(text, level = 'info') {
  const now = Date.now();
  for (const [t, at] of recentNotices) if (now - at > 60_000) recentNotices.delete(t);
  if (now - (recentNotices.get(text) ?? 0) < 5000) return;
  recentNotices.set(text, now);
  io.emit('notice', { text, level });
}

const tell = (socket, text, level = 'info') => socket.emit('notice', { text, level });

/* ----------------------------------------------------- track change + prefetch */

// Every change of the current track goes through here so position, duration
// and the prefetch window can never drift out of step.
function onTrackChange({ play } = {}) {
  const cur = queue.current;
  if (cur?.status === 'failed') cur.status = 'pending'; // navigating to it again is a retry
  playback.position = 0;
  playback.duration = cur?.duration || 0;
  playback.ended = false;
  playback.seekNonce++;
  playback.seekTo = 0;
  if (play !== undefined) playback.playing = Boolean(cur) && play;
  warm();
  push();
}

// Make sure the current track and the next few are on disk.
function warm() {
  const targets = [queue.current, ...queue.upcoming(AHEAD)].filter(Boolean);
  for (const item of targets) prepare(item);
}

function prepare(item) {
  if (item.status !== 'pending') return;
  item.status = 'loading';

  cache.ensure(item.sourceId)
    .then(() => {
      item.status = 'ready';
      item.failReason = '';
    })
    .catch(err => {
      item.status = 'failed';
      item.failReason = cache.explain(err);
      console.error(`[audio] ${item.sourceId} "${item.title}": ${item.failReason} | ${cache.tail(err)}`);
    })
    .then(() => {
      if (item.status === 'failed' && queue.current?.uid === item.uid && playback.playing) {
        onCurrentFailed(item);
      } else {
        push();
      }
    });
}

const skipped = [];
let skipTimer = null;

function flushSkipNotice() {
  const list = skipped.splice(0);
  if (!list.length) return;
  const short = s => (s.length > 38 ? `${s.slice(0, 37)}…` : s);
  notify(
    list.length === 1
      ? `Skipped “${short(list[0].title)}” — ${list[0].failReason}`
      : `Skipped ${list.length} tracks that couldn't be played`,
    'warn'
  );
}

function onCurrentFailed(item) {
  if (!settings.autoSkip) {
    playback.playing = false;
    notify(`Can't play “${item.title}” — ${item.failReason}`, 'warn');
    push();
    return;
  }

  let ok = true;
  let steps = 0;
  while (queue.current?.status === 'failed') {
    skipped.push(queue.current);
    if (++steps > queue.items.length || !queue.next({ manual: true })) {
      ok = false;
      break;
    }
  }

  clearTimeout(skipTimer);
  skipTimer = setTimeout(flushSkipNotice, 700); // one message for a whole run of skips

  if (ok) onTrackChange({ play: true });
  else finishQueue();
}

function finishQueue() {
  playback.playing = false;
  playback.ended = queue.items.length > 0;
  playback.position = 0;
  playback.duration = queue.current?.duration || 0;
  playback.seekNonce++;
  playback.seekTo = 0;
  push();
  if (playback.ended) maybeAutoFill({ force: true });
}

/* --------------------------------------------------------------------- audio */

app.get('/api/audio/:id', (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).end();

  const file = cache.pathFor(id);
  if (!file) return res.status(404).json({ error: 'Not ready' });

  cache.touch(file);
  res.type(cache.mimeFor(file));
  res.set('Cache-Control', 'no-store');
  // sendFile answers Range requests itself, so seeking just works.
  res.sendFile(file, err => {
    if (err && err.code !== 'ECONNABORTED' && !res.headersSent) res.status(500).end();
  });
});

/* -------------------------------------------------------------------- search */

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (!q) return res.status(400).json({ error: 'Type something to search for' });

  try {
    res.json({ results: await youtube.search(q, 20) });
  } catch (err) {
    console.error('[search]', err.message);
    res.status(502).json({ error: 'Search failed. Is yt-dlp installed and up to date?' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ytdlp: youtube.ytdlpVersion(),
    gemini: gemini.isEnabled(),
    cacheDir: cache.DIR
  });
});

app.use(express.static(resolve(__dirname, '../public')));

/* -------------------------------------------------------------------- the DJ */

async function pool(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fillQueue({ count = 4, mood = dj.mood, reason = 'auto' } = {}) {
  if (dj.thinking || !gemini.isEnabled()) return;

  dj.thinking = true;
  dj.lastNote = mood ? `Finding “${mood}” tracks…` : 'Looking for something that fits…';
  push();

  const wasEmpty = queue.items.length === 0;
  const front = reason === 'mood'; // a mood is a request: put it next, not at the back

  try {
    const suggestions = await gemini.suggestTracks({
      recent: queue.recent(6),
      banned: queue.items,
      mood,
      count
    });

    // The model only proposes titles. Each one is then matched to a real,
    // playable result. Misses and duplicates are quietly dropped.
    const matches = await pool(suggestions, 3, s => youtube.findOne(`${s.artist} ${s.title}`));

    let insertAt = queue.index + 1;
    let first = null;
    let added = 0;

    matches.forEach((match, i) => {
      if (!match) return;
      if (queue.items.some(it => it.sourceId === match.sourceId)) return;
      const item = queue.add(
        { ...match, auto: true, note: suggestions[i].why },
        mood ? `DJ · ${mood}` : 'DJ',
        front ? { at: insertAt } : undefined
      );
      if (!item) return;
      if (front) insertAt++;
      first ??= item;
      added++;
    });

    if (added) {
      dj.cooldownUntil = 0;
      dj.lastNote = `Added ${added} track${added === 1 ? '' : 's'}${mood ? ` for “${mood}”` : ''}`;
      notify(dj.lastNote);

      const start = wasEmpty || playback.ended || (reason === 'mood' && !playback.playing);
      if (start && first) {
        queue.jumpTo(queue.indexOf(first.uid));
        onTrackChange({ play: true });
      }
    } else {
      dj.lastNote = 'Could not find anything new to add';
    }
  } catch (err) {
    console.error('[dj]', err.message);
    dj.lastNote = "Couldn't reach the DJ. It will try again in a minute.";
    // Auto-fill is checked on every progress tick; without a cooldown a real
    // outage would be retried every second.
    dj.cooldownUntil = Date.now() + 60_000;
    notify("The DJ isn't responding right now", 'warn');
  } finally {
    dj.thinking = false;
    warm();
    push();
  }
}

// Called as the active device reports progress. Tops the queue up while the
// last track is still playing, so there is never a gap.
function maybeAutoFill({ force = false } = {}) {
  if (!dj.enabled || dj.thinking || !gemini.isEnabled()) return;
  if (Date.now() < dj.cooldownUntil) return;
  if (queue.items.length === 0 || !queue.isLastTrack) return;

  if (!force) {
    const halfway = playback.duration > 0 && playback.position / playback.duration > 0.5;
    if (!halfway) return;
  }
  fillQueue({ count: 4, reason: 'auto' });
}

/* ------------------------------------------------------------------ devices */

function guessDevice(ua = '') {
  if (/iPhone/i.test(ua)) return { base: 'iPhone', kind: 'phone' };
  if (/iPad/i.test(ua)) return { base: 'iPad', kind: 'phone' };
  if (/Android/i.test(ua)) return { base: 'Android phone', kind: 'phone' };
  if (/Macintosh/i.test(ua)) return { base: 'Mac', kind: 'computer' };
  if (/Windows/i.test(ua)) return { base: 'Windows PC', kind: 'computer' };
  if (/Linux/i.test(ua)) return { base: 'Linux PC', kind: 'computer' };
  return { base: 'Device', kind: 'computer' };
}

function uniqueName(base) {
  const taken = new Set([...devices.values()].map(d => d.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

function dropDevice(id) {
  const gone = devices.get(id);
  devices.delete(id);
  if (activeDeviceId === id) {
    // Hand the speaker role to whoever is left, preferring a computer.
    const left = [...devices.values()].filter(d => d.online);
    const next = left.find(d => d.kind === 'computer') ?? left[0];
    activeDeviceId = next?.id ?? null;
    if (playback.playing) {
      playback.playing = false;
      if (next) notify(`${gone?.name ?? 'The speaker'} went offline. Paused.`, 'warn');
    }
    playback.seekNonce++;
    playback.seekTo = playback.position;
  }
  push();
}

/* ------------------------------------------------------------------ sockets */

function cleanTrack(t) {
  if (!t || t.source !== 'youtube' || !ID_RE.test(String(t.sourceId))) return null;
  const id = String(t.sourceId);
  return {
    source: 'youtube',
    sourceId: id,
    title: String(t.title || 'Unknown track').slice(0, 200),
    artist: String(t.artist || 'Unknown artist').slice(0, 120),
    duration: Math.max(0, Math.min(Number(t.duration) || 0, 3600)),
    artwork: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` // built here, never taken from the client
  };
}

// One path for every add, whether it came from a search result or a pasted
// link. Returns counts so the caller can explain what happened to the user.
function enqueue(tracks, by, { next = false, promoteDuplicate = false } = {}) {
  const wasEmpty = queue.items.length === 0;
  let at = next ? queue.index + 1 : undefined;
  let first = null;
  let added = 0;
  let duplicates = 0;
  let moved = 0;
  let full = false;

  for (const raw of tracks) {
    const track = cleanTrack(raw);
    if (!track) continue;

    const dupe = queue.findUpcoming(track.sourceId);
    if (dupe) {
      duplicates++;
      if (next && promoteDuplicate && queue.moveToNext(dupe.uid)) moved++;
      continue;
    }

    const item = queue.add(track, by, at === undefined ? undefined : { at });
    if (!item) { full = true; break; }
    if (at !== undefined) at++;
    first ??= item;
    added++;
  }

  if (added && (wasEmpty || playback.ended)) {
    // Adding to an empty or finished queue starts playing, like before.
    queue.jumpTo(queue.indexOf(first.uid));
    onTrackChange({ play: true }); // warms and pushes
  } else if (added || moved) {
    warm();
    push();
  }

  return { added, duplicates, moved, full, first };
}

io.on('connection', socket => {
  const auth = socket.handshake.auth || {};
  const deviceId = String(auth.clientId || socket.id).slice(0, 64);
  const guess = guessDevice(socket.handshake.headers['user-agent']);

  let device = devices.get(deviceId);
  if (device) {
    clearTimeout(device.dropTimer);
    device.dropTimer = null;
    device.socketId = socket.id;
    device.online = true;
  } else {
    const chosen = typeof auth.name === 'string' ? auth.name.trim().slice(0, 32) : '';
    device = {
      id: deviceId,
      name: chosen || uniqueName(guess.base),
      kind: guess.kind,
      online: true,
      socketId: socket.id,
      dropTimer: null
    };
    devices.set(deviceId, device);
  }

  if (!activeDeviceId || !devices.get(activeDeviceId)?.online) activeDeviceId = deviceId;

  socket.emit('welcome', { deviceId });
  push();

  const isActive = () => deviceId === activeDeviceId;

  /* devices */

  socket.on('device:rename', label => {
    if (typeof label !== 'string' || !label.trim()) return;
    device.name = label.trim().slice(0, 32);
    push();
  });

  socket.on('device:transfer', id => {
    const target = devices.get(id);
    if (!target?.online || id === activeDeviceId) return;
    activeDeviceId = id;
    // The new speaker picks up from the position the old one last reported.
    playback.seekNonce++;
    playback.seekTo = playback.position;
    push();
  });

  /* transport: any device may send these */

  const play = () => {
    if (!queue.current) return;
    if (playback.ended) return onTrackChange({ play: true });
    playback.playing = true;
    if (queue.current.status === 'failed') return onCurrentFailed(queue.current);
    warm();
    push();
  };

  socket.on('playback:toggle', () => (playback.playing ? (playback.playing = false, push()) : play()));
  socket.on('playback:play', play);
  socket.on('playback:pause', () => { playback.playing = false; push(); });

  socket.on('playback:next', () => {
    if (!queue.current) return;
    const track = queue.next({ manual: true });
    if (track) onTrackChange({ play: true });
    else finishQueue();
  });

  socket.on('playback:previous', () => {
    if (!queue.current) return;
    const atStart = queue.index <= 0 && queue.repeat !== 'all';
    if (playback.position > 4 || atStart) {
      // Like every other player: restart this track unless we just started it.
      playback.position = 0;
      playback.seekNonce++;
      playback.seekTo = 0;
      if (playback.ended) { playback.ended = false; playback.playing = true; }
      push();
    } else {
      queue.previous();
      onTrackChange({ play: true });
    }
  });

  socket.on('playback:seek', seconds => {
    const t = Number(seconds);
    if (!queue.current || !Number.isFinite(t) || t < 0) return;
    playback.position = t;
    playback.seekTo = t;
    playback.seekNonce++;
    push();
  });

  socket.on('playback:volume', v => {
    const vol = Number(v);
    if (!Number.isFinite(vol)) return;
    playback.volume = Math.max(0, Math.min(1, vol));
    io.emit('volume', playback.volume); // lightweight: no need to resend the queue
  });

  socket.on('mode:repeat', mode => { queue.setRepeat(mode); push(); });

  /* queue */

  socket.on('queue:add', ({ track, next } = {}) => {
    const result = enqueue([track], device.name, { next, promoteDuplicate: true });
    if (result.full) tell(socket, 'The queue is full', 'warn');
    else if (!result.added && result.duplicates && !result.moved) tell(socket, 'Already in Up next');
  });

  // A pasted YouTube link goes straight into the queue. The browser only
  // recognises the shape of a link; the server decides what it really is.
  socket.on('queue:add-url', async ({ url } = {}) => {
    const raw = String(url ?? '').trim().slice(0, 500);
    const parsed = youtube.parseYouTubeUrl(raw);
    if (!parsed) return tell(socket, 'Paste a YouTube video or playlist link', 'warn');

    tell(socket, parsed.kind === 'playlist' ? 'Reading playlist…' : 'Fetching video…');

    let found;
    try {
      found = await youtube.resolveUrl(raw, parsed);
    } catch (err) {
      console.error('[link]', err.message);
      return tell(socket, "Couldn't read that link. Check the URL or update yt-dlp.", 'warn');
    }

    if (!found?.tracks?.length) {
      return tell(socket, parsed.kind === 'playlist'
        ? 'No playable songs found in that playlist'
        : 'No playable video found at that link', 'warn');
    }

    const result = enqueue(found.tracks, device.name);
    if (!result.added) {
      return tell(socket, result.full ? 'The queue is full' : 'Already in Up next', 'warn');
    }

    const title = found.tracks[0].title;
    const label = found.kind === 'playlist'
      ? `${result.added} song${result.added === 1 ? '' : 's'} from the playlist`
      : `“${title.length > 60 ? `${title.slice(0, 59)}…` : title}”`;
    const extra = [];
    if (result.duplicates) extra.push(`${result.duplicates} already queued`);
    if (result.full) extra.push('queue is full');
    tell(socket, `Added ${label}${extra.length ? ` (${extra.join(', ')})` : ''}`);
  });

  socket.on('queue:remove', uid => {
    const res = queue.remove(uid);
    if (!res) return;
    if (!res.wasCurrent) { warm(); return push(); }
    if (res.landedOnNext) onTrackChange({ play: playback.playing });
    else finishQueue();
  });

  socket.on('queue:play', uid => {
    const at = queue.indexOf(uid);
    if (at < 0) return;
    queue.jumpTo(at);
    onTrackChange({ play: true });
  });

  socket.on('queue:shift', ({ uid, delta } = {}) => {
    if (queue.shift(uid, Number(delta))) { warm(); push(); }
  });

  socket.on('queue:top', uid => {
    if (queue.moveToNext(uid)) { warm(); push(); }
  });

  socket.on('queue:shuffle', () => {
    if (queue.shuffleUpcoming()) { warm(); push(); }
    else tell(socket, 'Nothing to shuffle yet');
  });

  socket.on('queue:clear', () => {
    queue.clearUpcoming();
    push();
  });

  /* the DJ and settings */

  socket.on('dj:toggle', on => { dj.enabled = Boolean(on); push(); });

  socket.on('dj:mood', async mood => {
    dj.mood = typeof mood === 'string' && mood.trim() ? mood.trim().slice(0, 80) : null;
    push();
    if (dj.mood) await fillQueue({ count: 6, mood: dj.mood, reason: 'mood' });
  });

  socket.on('dj:fill', () => {
    if (!gemini.isEnabled()) return tell(socket, 'Set GEMINI_API_KEY to use the DJ', 'warn');
    fillQueue({ count: 5, reason: 'manual' });
  });

  socket.on('settings:set', (s = {}) => {
    if (typeof s.autoSkip === 'boolean') settings.autoSkip = s.autoSkip;
    push();
  });

  /* reports from the speaking device */

  socket.on('device:progress', ({ uid, position, duration } = {}) => {
    if (!isActive() || queue.current?.uid !== uid) return; // ignore stale reports from a previous track
    if (Number.isFinite(position)) playback.position = position;
    if (Number.isFinite(duration) && duration > 0) playback.duration = duration;
    io.emit('tick', { uid, position: playback.position, duration: playback.duration });
    maybeAutoFill();
  });

  socket.on('device:ended', ({ uid } = {}) => {
    if (!isActive() || queue.current?.uid !== uid) return;
    const next = queue.next();
    if (next) onTrackChange({ play: true });
    else finishQueue();
  });

  socket.on('device:error', ({ uid } = {}) => {
    if (!isActive() || queue.current?.uid !== uid) return;
    const cur = queue.current;
    cur.status = 'failed';
    cur.failReason = "This device couldn't decode it";
    cache.forget(cur.sourceId);
    onCurrentFailed(cur);
  });

  socket.on('disconnect', () => {
    if (device.socketId !== socket.id) return; // a newer connection already replaced this one
    device.online = false;
    // A brief drop (Wi-Fi blip, page reload) keeps the speaker role.
    device.dropTimer = setTimeout(() => dropDevice(deviceId), RECONNECT_GRACE);
    push();
  });
});

/* -------------------------------------------------------------------- start */

function lanAddress() {
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

cache.init();
const ytdlp = await youtube.init();

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  LANDMINE live at  http://${lanAddress()}:${PORT}\n`);
  console.log(`  yt-dlp   ${ytdlp.version ? `ready (${ytdlp.version})` : 'MISSING. Search and playback will fail'}`);
  if (ytdlp.version) {
    console.log(`  JS       ${ytdlp.jsRuntime ? `YouTube challenges solved with ${ytdlp.jsRuntime.split(':')[0]}` : 'no runtime set (some tracks may fail)'}`);
  }
  console.log(`  Gemini   ${gemini.isEnabled() ? 'ready' : 'no key, DJ is off'}`);
  console.log(`  Cache    ${cache.DIR}\n`);
});
