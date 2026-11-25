'use strict';

/* ===================================================================
   LANDMINE client.

   The server owns the truth. This file renders whatever it is told and
   sends back intents ("pause", "add this", "move that up"). The only thing
   a browser decides for itself is whether to make sound, and it only does
   that while it holds the speaker role.
   =================================================================== */

const $ = id => document.getElementById(id);
const emit = (...args) => socket.emit(...args);

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const clock = s => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

const store = {
  get(key, fallback = null) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }
};

/* ------------------------------------------------------------------- icons */

const ICONS = {
  play: ['fill', 'M8 5v14l11-7z'],
  pause: ['fill', 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z'],
  next: ['fill', 'M6 5l9 7-9 7zM17 5h2v14h-2z'],
  prev: ['fill', 'M18 5l-9 7 9 7zM7 5H5v14h2z'],
  shuffle: ['', 'M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5'],
  repeat: ['', 'M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3'],
  repeat1: ['', 'M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3M11.5 10.5L13 9.5v5'],
  up: ['', 'M6 15l6-6 6 6'],
  down: ['', 'M6 9l6 6 6-6'],
  chevdown: ['', 'M6 9l6 6 6-6'],
  x: ['', 'M6 6l12 12M18 6L6 18'],
  plus: ['', 'M12 5v14M5 12h14'],
  check: ['', 'M5 12.5l4.5 4.5L19 7.5'],
  search: ['', 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4'],
  queue: ['', 'M4 6h16M4 12h16M4 18h9'],
  dj: ['', 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z'],
  settings: ['', 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4'],
  device: ['', 'M3 5h18v11H3zM8 20h8M12 16v4'],
  phone: ['', 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2'],
  volume: ['', 'M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12'],
  mute: ['', 'M4 9v6h4l5 4V5L8 9zM17 9.5l5 5M22 9.5l-5 5'],
  alert: ['', 'M12 4l9 16H3zM12 10v4M12 17.2v.01'],
  mine: ['', 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1']
};

const ic = name => {
  const [kind, d] = ICONS[name];
  return `<svg class="ic ${kind}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
};

document.querySelectorAll('[data-ic]').forEach(el => { el.innerHTML = ic(el.dataset.ic); });

/* ------------------------------------------------------------- connection */

const clientId = (() => {
  let id = null;
  try { id = sessionStorage.getItem('landmine-client'); } catch { /* ignore */ }
  if (!id) {
    // crypto.randomUUID needs https, which a LAN address usually is not.
    id = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
    try { sessionStorage.setItem('landmine-client', id); } catch { /* ignore */ }
  }
  return id;
})();

const socket = io({ auth: { clientId, name: store.get('landmine-name', '') }, transports: ['websocket', 'polling'] });

let state = null;
let myId = null;
let scrubbing = false;
let wasOffline = false;

const cur = () => state?.queue.items[state.queue.index] ?? null;
const isActive = () => Boolean(state) && state.activeDeviceId === myId;
const deviceById = id => state?.devices.find(d => d.id === id);

/* ----------------------------------------------------------- notifications

   One toast element, ever. A new message replaces the old one, so a burst
   of problems can never stack into a wall of banners.                      */

let toastTimer = null;

function toast(text, kind = 'info', ms = 3600) {
  const el = $('toast');
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = false;
  // restart the entrance animation for a replaced message
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

$('toast').onclick = () => { $('toast').hidden = true; };

/* ----------------------------------------------------------------- theming

   Personal to this browser. Two colours in, everything else derived.       */

const THEMES = [
  { id: 'hazard', name: 'Hazard', bg: '#0c0e10', accent: '#c8ff2e' },
  { id: 'sonar', name: 'Sonar', bg: '#071014', accent: '#35d4ff' },
  { id: 'violet', name: 'Violet', bg: '#0c0a14', accent: '#a78bff' },
  { id: 'flare', name: 'Flare', bg: '#0f0b0d', accent: '#ff4d6a' },
  { id: 'mono', name: 'Mono', bg: '#000000', accent: '#f4f4f5' },
  { id: 'paper', name: 'Paper', bg: '#eceef1', accent: '#2f3cff' }
];
const HEX = /^#[0-9a-f]{6}$/i;

function luminance(hex) {
  const [r, g, b] = [1, 3, 5]
    .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function loadTheme() {
  try {
    const t = JSON.parse(store.get('landmine-theme', 'null'));
    if (t && HEX.test(t.bg) && HEX.test(t.accent)) return t;
  } catch { /* fall through */ }
  return { bg: THEMES[0].bg, accent: THEMES[0].accent };
}

function applyTheme(t) {
  const root = document.documentElement;
  const light = luminance(t.bg) > 0.4;
  root.style.setProperty('--bg', t.bg);
  root.style.setProperty('--accent', t.accent);
  root.style.setProperty('--ink', light ? '#13161a' : '#e9edf0');
  root.style.setProperty('--on-accent', luminance(t.accent) > 0.45 ? '#0b0d0f' : '#ffffff');
  root.style.colorScheme = light ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]').content = t.bg;
}

function saveTheme(t) {
  store.set('landmine-theme', JSON.stringify(t));
  applyTheme(t);
  renderThemes();
}

function renderThemes() {
  const t = loadTheme();
  $('themes').innerHTML = THEMES.map(p => `
    <button class="theme ${p.bg === t.bg && p.accent === t.accent ? 'is-on' : ''}" data-theme="${p.id}">
      <span class="theme-preview" style="background:${p.bg}"><i style="background:${p.accent}"></i><i style="background:${p.accent};opacity:.4"></i></span>
      ${esc(p.name)}
    </button>`).join('');
  $('pick-accent').value = t.accent;
  $('pick-bg').value = t.bg;
}

$('themes').addEventListener('click', e => {
  const p = THEMES.find(x => x.id === e.target.closest('[data-theme]')?.dataset.theme);
  if (p) saveTheme({ bg: p.bg, accent: p.accent });
});
$('pick-accent').addEventListener('input', e => saveTheme({ ...loadTheme(), accent: e.target.value }));
$('pick-bg').addEventListener('input', e => saveTheme({ ...loadTheme(), bg: e.target.value }));
$('theme-reset').onclick = () => saveTheme({ bg: THEMES[0].bg, accent: THEMES[0].accent });

applyTheme(loadTheme());
renderThemes();

/* -------------------------------------------------------------- navigation */

function showView(name) {
  document.querySelectorAll('.nav-btn').forEach(b => {
    const on = b.dataset.view === name;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('is-on', v.dataset.view === name));
  store.set('landmine-view', name);
  if (name === 'search') $('search-input').focus({ preventScroll: true });
}

$('nav').addEventListener('click', e => {
  const btn = e.target.closest('[data-view]');
  if (btn) showView(btn.dataset.view);
});

const openDeck = on => $('deck').classList.toggle('is-open', on);
$('mini-open').onclick = () => openDeck(true);
$('deck-close').onclick = () => openDeck(false);

showView(['queue', 'search', 'dj', 'settings'].includes(store.get('landmine-view')) ? store.get('landmine-view') : 'queue');

/* ---------------------------------------------------------- audio (speaker)

   Every device runs this, and only the one holding the speaker role gets
   past the first check. Transferring playback is nothing more than the
   server naming a different device, so each browser simply reacts.       */

const audio = new Audio();
audio.preload = 'auto';

let loadedUid = null;
let seenNonce = 0;
let errorTries = 0;
let needsGesture = false;
let lastReport = 0;

function setGate(on) {
  if (needsGesture === on) return;
  needsGesture = on;
  $('gate').hidden = !on;
}

function unload() {
  loadedUid = null;
  if (audio.getAttribute('src') !== null) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
}

function tryPlay() {
  const p = audio.play();
  if (!p) return;
  p.then(() => setGate(false)).catch(err => {
    // Only a refusal for lack of a tap is the user's business. A track that
    // is still loading or was swapped mid-flight is not.
    if (err.name === 'NotAllowedError') setGate(true);
  });
}

function syncAudio() {
  if (!state) return;
  const t = cur();
  const pb = state.playback;

  if (!isActive() || !t) {
    unload();
    setGate(false);
    return;
  }

  // The track is not on disk yet: make sure nothing stale keeps playing.
  if (t.status !== 'ready') {
    if (loadedUid !== t.uid) unload(); else audio.pause();
    setGate(false);
    return;
  }

  if (loadedUid !== t.uid) {
    loadedUid = t.uid;
    errorTries = 0;
    const resumeAt = pb.position;
    audio.src = `/api/audio/${encodeURIComponent(t.sourceId)}`;
    audio.load();
    if (resumeAt > 1) {
      audio.addEventListener('loadedmetadata', () => {
        audio.currentTime = Math.min(resumeAt, audio.duration || resumeAt);
      }, { once: true });
    }
    seenNonce = pb.seekNonce;
  } else if (pb.seekNonce !== seenNonce) {
    seenNonce = pb.seekNonce;
    if (audio.readyState > 0) audio.currentTime = pb.seekTo;
  }

  audio.volume = pb.volume;

  if (pb.playing) {
    // `ended` guards against replaying a finished track before the server
    // has had time to move on.
    if (audio.paused && !audio.ended) tryPlay();
  } else {
    if (!audio.paused) audio.pause();
    setGate(false);
  }
}

audio.addEventListener('ended', () => { if (loadedUid) emit('device:ended', { uid: loadedUid }); });

audio.addEventListener('error', () => {
  if (!loadedUid || audio.getAttribute('src') === null) return;
  if (errorTries++ < 1) {
    // One quiet retry before bothering anyone.
    setTimeout(() => {
      if (!loadedUid) return;
      const at = audio.currentTime;
      audio.load();
      audio.addEventListener('loadedmetadata', () => { if (at > 1) audio.currentTime = at; }, { once: true });
      if (state?.playback.playing) tryPlay();
    }, 500);
    return;
  }
  emit('device:error', { uid: loadedUid });
});

audio.addEventListener('timeupdate', () => {
  if (!isActive() || !loadedUid) return;
  const now = Date.now();
  if (now - lastReport < 900) return;
  lastReport = now;
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  emit('device:progress', { uid: loadedUid, position: audio.currentTime, duration });
  if (!scrubbing) paintProgress(audio.currentTime, duration || state?.playback.duration || 0);
});

// A tap anywhere counts as the gesture the browser was waiting for.
const retryAfterGesture = () => {
  if (!needsGesture) return;
  setGate(false);
  syncAudio();
};
addEventListener('pointerdown', retryAfterGesture, true);
addEventListener('keydown', retryAfterGesture, true);
$('gate-btn').onclick = retryAfterGesture;

/* ----------------------------------------------------------- media session */

function initMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported */ } };
  set('play', () => emit('playback:play'));
  set('pause', () => emit('playback:pause'));
  set('previoustrack', () => emit('playback:previous'));
  set('nexttrack', () => emit('playback:next'));
  set('seekto', d => { if (Number.isFinite(d.seekTime)) emit('playback:seek', d.seekTime); });
  set('seekbackward', () => seekBy(-10));
  set('seekforward', () => seekBy(10));
}

let metaUid = null;

function syncMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = cur();
  if (!isActive() || !t) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
    metaUid = null;
    return;
  }
  if (metaUid !== t.uid) {
    metaUid = t.uid;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      artwork: t.artwork ? [{ src: t.artwork, sizes: '320x180', type: 'image/jpeg' }] : []
    });
  }
  navigator.mediaSession.playbackState = state.playback.playing ? 'playing' : 'paused';
}

initMediaSession();

/* ------------------------------------------------------------------ player */

function setArt(img, t, big) {
  if (!t) { img.removeAttribute('src'); delete img.dataset.src; return; }
  const want = big ? `https://i.ytimg.com/vi/${t.sourceId}/hq720.jpg` : t.artwork;
  if (img.dataset.src === want) return;
  img.dataset.src = want;
  img.onerror = () => { img.onerror = null; img.src = t.artwork; };
  img.src = want;
}

function paintProgress(position, duration) {
  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  $('t-now').textContent = clock(position);
  $('t-end').textContent = clock(duration);
  $('seek').value = Math.round(pct * 10);
  $('seek').style.setProperty('--p', `${pct}%`);
  $('mini').style.setProperty('--mp', `${pct}%`);
}

function paintVolume(v) {
  const pct = Math.round(v * 100);
  $('volume').value = pct;
  $('volume').style.setProperty('--p', `${pct}%`);
  $('b-mute').innerHTML = ic(v === 0 ? 'mute' : 'volume');
}

function statusLine() {
  const t = cur();
  const pb = state.playback;
  if (!t) return ['', ''];
  if (t.status === 'failed') return [`Unavailable · ${t.failReason || 'could not be fetched'}`, 'warn'];
  if (pb.ended) return ['End of queue', ''];
  if (pb.playing && t.status !== 'ready') return ['Preparing track…', 'busy'];
  if (!pb.playing) return ['Paused', ''];
  return ['', ''];
}

function renderDeck() {
  const { playback: pb, queue: q } = state;
  const t = cur();
  const live = Boolean(t) && pb.playing && t.status === 'ready';
  const loading = Boolean(t) && pb.playing && t.status !== 'ready' && t.status !== 'failed';

  $('deck').classList.toggle('is-playing', live);
  $('np-title').textContent = t ? t.title : 'Nothing queued';
  $('np-artist').textContent = t ? t.artist : 'Search for a track or ask the DJ';
  $('art').classList.toggle('is-empty', !t);
  $('art').classList.toggle('is-live', live);
  setArt($('np-art'), t, true);

  const [line, kind] = statusLine();
  $('np-state').textContent = line;
  $('np-state').dataset.kind = kind;

  const playIcon = ic(pb.playing ? 'pause' : 'play');
  for (const id of ['b-play', 'mini-play']) {
    $(id).innerHTML = playIcon;
    $(id).setAttribute('aria-label', pb.playing ? 'Pause' : 'Play');
  }
  $('b-play').classList.toggle('is-loading', loading);
  $('b-shuffle').innerHTML = ic('shuffle');
  $('b-prev').innerHTML = ic('prev');
  $('b-next').innerHTML = ic('next');
  $('b-repeat').innerHTML = ic(q.repeat === 'one' ? 'repeat1' : 'repeat');
  $('b-repeat').classList.toggle('is-on', q.repeat !== 'off');
  $('b-repeat').setAttribute('aria-label', `Repeat: ${q.repeat}`);

  $('mini-title').textContent = t ? t.title : 'Nothing queued';
  $('mini-artist').textContent = t ? t.artist : 'Tap to open the player';
  setArt($('mini-art'), t, false);

  if (!scrubbing) paintProgress(pb.position, pb.duration);
  paintVolume(pb.volume);

  const active = deviceById(state.activeDeviceId);
  const here = isActive();
  $('device-btn').classList.toggle('is-remote', !here && Boolean(active));
  $('device-label').textContent = here ? 'This device' : (active?.name ?? 'No device');
  $('device-ic').innerHTML = ic(active?.kind === 'phone' ? 'phone' : 'device');
}

/* ------------------------------------------------------------------- queue */

let historyOpen = false;
let queueSig = '';

function emptyHtml(icon, title, text, buttons = '') {
  return `<div class="empty">${ic(icon)}<b>${esc(title)}</b><p>${esc(text)}</p>${buttons ? `<div class="btn-row">${buttons}</div>` : ''}</div>`;
}

function rowHtml(it, kind, i = 0, n = 1) {
  const isCur = kind === 'current';
  const playing = isCur && state.playback.playing && it.status === 'ready';

  const tags = [
    it.auto ? `<span class="tag accent" title="${esc(it.note || 'Picked by the DJ')}">DJ</span>` : '',
    it.status === 'failed' ? `<span class="tag warn" title="${esc(it.failReason)}">Unavailable</span>` : '',
    it.status === 'loading' ? '<span class="tag"><i class="dot-spin"></i>Fetching</span>' : ''
  ].join('');

  const sub = it.status === 'failed'
    ? it.failReason || 'Could not be fetched'
    : `${it.artist}${isCur ? '' : ` · ${it.addedBy}`}`;

  const controls = kind === 'up'
    ? `<button class="icon-btn sm reveal" data-act="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${ic('up')}</button>
       <button class="icon-btn sm reveal" data-act="down" aria-label="Move down" ${i === n - 1 ? 'disabled' : ''}>${ic('down')}</button>`
    : '';

  return `
    <li class="row ${isCur ? 'is-current' : ''} ${playing ? 'is-live' : ''} ${it.status === 'failed' ? 'is-failed' : ''}" data-uid="${esc(it.uid)}">
      <button class="row-art" data-act="${isCur ? 'toggle' : 'play'}" aria-label="${isCur ? 'Play or pause' : 'Play'} ${esc(it.title)}">
        <img src="${esc(it.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">
        <span class="row-glyph">${ic(isCur && state.playback.playing ? 'pause' : 'play')}</span>
        ${isCur ? '<span class="row-eq"><i></i><i></i><i></i></span>' : ''}
      </button>
      <div class="row-body">
        <span class="row-title">${esc(it.title)}</span>
        <span class="row-sub">${esc(sub)}</span>
      </div>
      ${tags}
      <span class="row-time">${clock(it.duration)}</span>
      <div class="row-actions">
        ${controls}
        <button class="icon-btn sm ${kind === 'up' ? 'reveal' : ''}" data-act="remove" aria-label="Remove ${esc(it.title)}">${ic('x')}</button>
      </div>
    </li>`;
}

function renderQueue() {
  const { items, index } = state.queue;
  const up = index >= 0 ? items.slice(index + 1) : [];
  const history = index > 0 ? items.slice(0, index).reverse() : [];

  $('q-shuffle').disabled = up.length < 2;
  $('q-clear').disabled = up.length === 0;
  $('queue-meta').textContent = items.length
    ? `${up.length} up next · ${clock(up.reduce((s, i) => s + (i.duration || 0), 0))}`
    : 'Empty';

  const sig = JSON.stringify([
    items.map(i => [i.uid, i.status, i.failReason, i.title]),
    index, state.playback.playing, state.dj.enabled, state.dj.available
  ]);
  if (sig === queueSig) return;
  queueSig = sig;

  const body = $('queue-body');
  if (!items.length) {
    body.innerHTML = emptyHtml(
      'queue', 'Nothing queued yet',
      'Search for a song, or let the DJ pick something for the mood you are in.',
      '<button class="btn solid" data-go="search">Search for a song</button><button class="btn" data-go="dj">Ask the DJ</button>'
    );
    return;
  }

  const djNote = state.dj.available && state.dj.enabled
    ? 'The DJ will add more as this track plays out.'
    : 'Search to add more.';

  body.innerHTML = `
    <div class="section-label">Now playing</div>
    <ul class="list">${rowHtml(items[index], 'current')}</ul>
    <div class="section-label">Up next${up.length ? ` · ${up.length}` : ''}</div>
    ${up.length
      ? `<ul class="list">${up.map((it, i) => rowHtml(it, 'up', i, up.length)).join('')}</ul>`
      : `<p class="quiet">Nothing queued after this. ${djNote}</p>`}
    ${history.length
      ? `<details class="history" ${historyOpen ? 'open' : ''}><summary>History · ${history.length}</summary><ul class="list">${history.map(it => rowHtml(it, 'history')).join('')}</ul></details>`
      : ''}`;
}

$('queue-body').addEventListener('toggle', e => {
  if (e.target.matches('details.history')) historyOpen = e.target.open;
}, true);

$('queue-body').addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) return showView(go.dataset.go);

  const btn = e.target.closest('[data-act]');
  const uid = btn?.closest('[data-uid]')?.dataset.uid;
  if (!btn || !uid) return;

  switch (btn.dataset.act) {
    case 'toggle': emit('playback:toggle'); break;
    case 'play': emit('queue:play', uid); break;
    case 'up': emit('queue:shift', { uid, delta: -1 }); break;
    case 'down': emit('queue:shift', { uid, delta: 1 }); break;
    case 'remove': emit('queue:remove', uid); break;
  }
});

$('q-shuffle').onclick = () => emit('queue:shuffle');
$('q-clear').onclick = () => emit('queue:clear');

/* ------------------------------------------------------------------ search */

let results = [];
let searchState = 'idle';   // idle | loading | done | error
let searchError = '';
let searchSeq = 0;
let searchAbort = null;
let searchTimer = null;
let resultsSig = '';

// Only the general shape is checked here. The server does the real parsing and
// decides whether the link is one video or a whole playlist.
function looksLikeYouTubeLink(q) {
  try {
    const url = new URL(/^https?:\/\//i.test(q) ? q : `https://${q}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    const known = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
      'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'];
    return known.includes(host) && (url.pathname.length > 1 || url.search.length > 1);
  } catch { return false; }
}

function renderResults() {
  const box = $('results');
  const inQueue = new Set();
  if (state) {
    const { items, index } = state.queue;
    if (index >= 0) items.slice(index).forEach(i => inQueue.add(i.sourceId));
  }

  const sig = JSON.stringify([searchState, searchError, results.map(r => r.sourceId), [...inQueue]]);
  if (sig === resultsSig) return;
  resultsSig = sig;

  if (searchState === 'idle') {
    box.innerHTML = emptyHtml('search', 'Search for a song', 'Type a title or an artist. Paste a YouTube link to add it straight to the queue.');
  } else if (searchState === 'loading') {
    box.innerHTML = '<div class="skel"></div>'.repeat(6);
  } else if (searchState === 'error') {
    box.innerHTML = emptyHtml('alert', 'Search did not work', searchError, '<button class="btn" data-retry>Try again</button>');
  } else if (!results.length) {
    box.innerHTML = emptyHtml('search', 'Nothing found', 'Try different words, or fewer of them.');
  } else {
    box.innerHTML = `<ul class="list">${results.map((r, i) => `
      <li class="row" data-i="${i}">
        <span class="row-art"><img src="${esc(r.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>
        <div class="row-body"><span class="row-title">${esc(r.title)}</span><span class="row-sub">${esc(r.artist)}</span></div>
        <span class="row-time">${clock(r.duration)}</span>
        <div class="row-actions">
          <button class="icon-btn sm" data-act="next" aria-label="Play next" title="Play next">${ic('next')}</button>
          ${inQueue.has(r.sourceId)
            ? `<span class="tag accent">${ic('check')}Queued</span>`
            : `<button class="btn sm solid" data-act="add">${ic('plus')}Add</button>`}
        </div>
      </li>`).join('')}</ul>`;
  }
}

async function runSearch(q) {
  q = q.trim();
  searchAbort?.abort();
  const seq = ++searchSeq;

  if (!q) { searchState = 'idle'; results = []; searchError = ''; renderResults(); return; }

  if (looksLikeYouTubeLink(q)) {
    emit('queue:add-url', { url: q });
    $('search-input').value = '';
    searchState = 'idle';
    results = [];
    searchError = '';
    renderResults();
    return;
  }

  searchAbort = new AbortController();
  searchState = 'loading';
  renderResults();

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: searchAbort.signal });
    const data = await res.json();
    if (seq !== searchSeq) return;
    if (!res.ok) throw new Error(data.error || 'Search failed');
    results = data.results;
    searchState = 'done';
  } catch (err) {
    if (err.name === 'AbortError' || seq !== searchSeq) return;
    results = [];
    searchState = 'error';
    searchError = err.message || 'Search failed';
  }
  renderResults();
}

$('search-input').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value), 420);
});
$('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(e.target.value); }
});

$('results').addEventListener('click', e => {
  if (e.target.closest('[data-retry]')) return runSearch($('search-input').value);
  const btn = e.target.closest('[data-act]');
  const track = results[Number(btn?.closest('[data-i]')?.dataset.i)];
  if (!btn || !track) return;
  emit('queue:add', { track, next: btn.dataset.act === 'next' });
  if (btn.dataset.act === 'next') toast(`Playing “${track.title}” next`);
});

/* ---------------------------------------------------------------------- DJ */

const MOODS = ['Chill', 'Hyped up', 'Late night', 'Focus', 'Nostalgic', 'Sad but nice', 'Dance floor', 'Sunny morning'];

$('moods').innerHTML = MOODS.map(m => `<button class="chip" data-mood="${esc(m)}">${esc(m)}</button>`).join('');

function renderDJ() {
  const dj = state.dj;
  const text = !dj.available
    ? 'The DJ is off. Add GEMINI_API_KEY to your .env file and restart the server.'
    : dj.thinking ? dj.lastNote
    : dj.mood ? `Mood is “${dj.mood}”. New tracks follow it.`
    : dj.lastNote || 'Ready. It steps in when the queue runs low.';

  $('dj-status-text').textContent = text;
  $('dj-status').classList.toggle('is-busy', dj.thinking);
  $('dj-status').classList.toggle('is-on', dj.available && !dj.thinking);

  document.querySelectorAll('.chip').forEach(c => {
    c.classList.toggle('is-on', c.dataset.mood.toLowerCase() === (dj.mood || '').toLowerCase());
    c.disabled = !dj.available;
  });
  $('mood-clear').hidden = !dj.mood;
  $('mood-go').disabled = !dj.available;
  $('dj-fill').disabled = !dj.available || dj.thinking;
  $('dj-enabled').checked = dj.enabled;
  $('dj-enabled').disabled = !dj.available;
}

$('moods').addEventListener('click', e => {
  const chip = e.target.closest('[data-mood]');
  if (!chip) return;
  const same = (state?.dj.mood || '').toLowerCase() === chip.dataset.mood.toLowerCase();
  emit('dj:mood', same ? '' : chip.dataset.mood);
});

const setMood = () => {
  const v = $('mood-input').value.trim();
  if (!v) return;
  emit('dj:mood', v);
  $('mood-input').value = '';
};
$('mood-go').onclick = setMood;
$('mood-input').addEventListener('keydown', e => { if (e.key === 'Enter') setMood(); });
$('mood-clear').onclick = () => emit('dj:mood', '');
$('dj-enabled').onchange = e => emit('dj:toggle', e.target.checked);
$('dj-fill').onclick = () => emit('dj:fill');

/* ---------------------------------------------------------------- settings */

function renderSettings() {
  $('set-autoskip').checked = state.settings.autoSkip;
  const me = deviceById(myId);
  if (me && document.activeElement !== $('device-name')) $('device-name').value = me.name;
}

$('set-autoskip').onchange = e => emit('settings:set', { autoSkip: e.target.checked });

const saveName = () => {
  const v = $('device-name').value.trim();
  if (!v) return;
  store.set('landmine-name', v);
  emit('device:rename', v);
  toast('Device renamed');
};
$('device-name-save').onclick = saveName;
$('device-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveName(); });

/* ------------------------------------------------------------- device picker */

const dialog = $('device-dialog');

function renderDevices() {
  $('device-list').innerHTML = state.devices.map(d => {
    const on = d.id === state.activeDeviceId;
    return `
      <li>
        <button class="device-row ${on ? 'is-on' : ''}" data-device="${esc(d.id)}" ${d.online ? '' : 'disabled'}>
          ${ic(d.kind === 'phone' ? 'phone' : 'device')}
          <span class="meta-col"><b>${esc(d.name)}${d.id === myId ? ' (this device)' : ''}</b><small>${on ? 'Playing here' : d.online ? 'Available' : 'Reconnecting…'}</small></span>
          ${on ? ic('check') : ''}
        </button>
      </li>`;
  }).join('');
}

$('device-btn').onclick = () => { if (state) { renderDevices(); dialog.showModal(); } };
$('device-close').onclick = () => dialog.close();
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
$('device-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-device]');
  if (!btn) return;
  emit('device:transfer', btn.dataset.device);
  dialog.close();
});

/* ---------------------------------------------------------------- controls */

$('b-play').onclick = () => emit('playback:toggle');
$('mini-play').onclick = () => emit('playback:toggle');
$('mini-next').onclick = () => emit('playback:next');
$('b-next').onclick = () => emit('playback:next');
$('b-prev').onclick = () => emit('playback:previous');

$('b-shuffle').onclick = () => {
  emit('queue:shuffle');
  $('b-shuffle').classList.remove('pulse');
  void $('b-shuffle').offsetWidth;
  $('b-shuffle').classList.add('pulse');
};

$('b-repeat').onclick = () => {
  const order = ['off', 'all', 'one'];
  emit('mode:repeat', order[(order.indexOf(state.queue.repeat) + 1) % order.length]);
};

const seek = $('seek');
seek.addEventListener('input', () => {
  scrubbing = true;
  const dur = state?.playback.duration || 0;
  $('t-now').textContent = clock((Number(seek.value) / 1000) * dur);
  seek.style.setProperty('--p', `${Number(seek.value) / 10}%`);
});
seek.addEventListener('change', () => {
  const dur = state?.playback.duration || 0;
  if (dur > 0) emit('playback:seek', (Number(seek.value) / 1000) * dur);
  setTimeout(() => { scrubbing = false; }, 300);
});

function seekBy(delta) {
  if (!state || !cur()) return;
  const { position, duration } = state.playback;
  emit('playback:seek', Math.max(0, Math.min(position + delta, duration || position + delta)));
}

let lastVolume = 0.8;
let volumeSentAt = 0;
let volumeTimer = null;

function sendVolume(v) {
  volumeSentAt = performance.now();
  emit('playback:volume', v);
}

$('volume').addEventListener('input', e => {
  const v = Number(e.target.value) / 100;
  audio.volume = v;                          // instant feedback on this device
  if (state) state.playback.volume = v;
  paintVolume(v);
  clearTimeout(volumeTimer);
  if (performance.now() - volumeSentAt > 60) sendVolume(v);
  else volumeTimer = setTimeout(() => sendVolume(v), 70);
});

$('b-mute').onclick = () => {
  const v = state?.playback.volume ?? 0.8;
  if (v > 0) { lastVolume = v; emit('playback:volume', 0); } else emit('playback:volume', lastVolume || 0.8);
};

/* --------------------------------------------------------------- keyboard */

addEventListener('keydown', e => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target.tagName;

  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }

  switch (e.key) {
    case ' ':
      if (tag === 'BUTTON' || tag === 'SUMMARY') return; // let the focused control handle it
      e.preventDefault();
      emit('playback:toggle');
      break;
    case 'n': case 'N': emit('playback:next'); break;
    case 'p': case 'P': emit('playback:previous'); break;
    case 'ArrowRight': seekBy(10); break;
    case 'ArrowLeft': seekBy(-10); break;
    case '/': e.preventDefault(); showView('search'); break;
    case 'Escape': openDeck(false); break;
  }
});

/* ------------------------------------------------------------------ render */

function render() {
  renderDeck();
  renderQueue();
  renderResults();
  renderDJ();
  renderSettings();
  if (dialog.open) renderDevices();
}

/* ----------------------------------------------------------------- sockets */

socket.on('welcome', ({ deviceId }) => { myId = deviceId; });

socket.on('state', next => {
  state = next;
  render();
  syncAudio();
  syncMediaSession();
});

// Position updates arrive far more often than full state; they only move the bar.
socket.on('tick', ({ uid, position, duration }) => {
  if (!state || isActive() || scrubbing || cur()?.uid !== uid) return;
  state.playback.position = position;
  state.playback.duration = duration;
  paintProgress(position, duration);
});

socket.on('volume', v => {
  if (state) state.playback.volume = v;
  if (isActive()) audio.volume = v;
  if (document.activeElement !== $('volume')) paintVolume(v);
});

socket.on('notice', ({ text, level }) => toast(text, level));

socket.on('connect', () => {
  $('lamp').classList.add('on');
  if (wasOffline) { toast('Back online'); wasOffline = false; }
});

socket.on('disconnect', () => {
  $('lamp').classList.remove('on');
  wasOffline = true;
  toast('Connection lost. Reconnecting…', 'warn', 6000);
});

renderResults();
