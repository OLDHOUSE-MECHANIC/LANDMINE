import { randomUUID } from 'crypto';

const MAX_ITEMS = 200;

/**
 * The queue is one ordered list and a pointer into it.
 *
 *   items[0 .. index-1]   history  (already played)
 *   items[index]          now playing
 *   items[index+1 ..]     up next, in the exact order it will play
 *
 * There is no hidden "play order". What you see is what plays. Shuffle
 * physically reorders the up-next section, so nothing ever jumps around.
 */
export class Queue {
  constructor() {
    this.items = [];
    this.index = -1;
    this.repeat = 'off'; // 'off' | 'all' | 'one'
  }

  get current() {
    return this.index >= 0 ? this.items[this.index] ?? null : null;
  }

  get isLastTrack() {
    if (this.items.length === 0) return true;
    if (this.repeat !== 'off') return false;
    return this.index >= this.items.length - 1;
  }

  upcoming(limit = Infinity) {
    if (this.index < 0) return [];
    return this.items.slice(this.index + 1, this.index + 1 + limit);
  }

  indexOf(uid) {
    return this.items.findIndex(i => i.uid === uid);
  }

  findUpcoming(sourceId) {
    return this.upcoming().find(i => i.sourceId === sourceId) ?? null;
  }

  // Add a track. `at` inserts at a position (never before the current track).
  add(track, addedBy = 'someone', { at } = {}) {
    if (this.items.length >= MAX_ITEMS) return null;

    const item = {
      uid: randomUUID(),
      source: track.source,
      sourceId: track.sourceId,
      title: track.title ?? 'Unknown track',
      artist: track.artist ?? 'Unknown artist',
      duration: Number(track.duration) || 0,
      artwork: track.artwork ?? '',
      addedBy,
      auto: Boolean(track.auto),
      note: track.note ?? '',
      status: 'pending',   // pending | loading | ready | failed
      failReason: ''
    };

    const floor = this.index + 1;
    const pos = at === undefined
      ? this.items.length
      : Math.min(Math.max(at, floor), this.items.length);

    this.items.splice(pos, 0, item);
    if (this.index === -1) this.index = 0;
    return item;
  }

  // Returns null if the uid is unknown. Otherwise tells the caller what
  // happened so it can decide what should play next.
  remove(uid) {
    const at = this.indexOf(uid);
    if (at === -1) return null;

    const wasCurrent = at === this.index;
    this.items.splice(at, 1);

    let landedOnNext = true;
    if (at < this.index) {
      this.index--;
    } else if (wasCurrent && this.index >= this.items.length) {
      // Removed the last track while it was playing: there is no next one.
      this.index = this.items.length - 1;
      landedOnNext = false;
    }
    if (this.items.length === 0) this.index = -1;

    return { wasCurrent, landedOnNext };
  }

  // Nudge an up-next track earlier (-1) or later (+1). History and the
  // current track are never touched.
  shift(uid, delta) {
    const at = this.indexOf(uid);
    if (at <= this.index) return false;
    const to = at + (delta < 0 ? -1 : 1);
    if (to <= this.index || to >= this.items.length) return false;
    const [item] = this.items.splice(at, 1);
    this.items.splice(to, 0, item);
    return true;
  }

  moveToNext(uid) {
    const at = this.indexOf(uid);
    if (at <= this.index) return false;
    if (at === this.index + 1) return true;
    const [item] = this.items.splice(at, 1);
    this.items.splice(this.index + 1, 0, item);
    return true;
  }

  // Randomise the order of what is still to come. The current track and
  // history stay exactly where they are.
  shuffleUpcoming() {
    const start = this.index + 1;
    const n = this.items.length - start;
    if (n < 2) return false;
    for (let i = this.items.length - 1; i > start; i--) {
      const j = start + Math.floor(Math.random() * (i - start + 1));
      [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    }
    return true;
  }

  clearUpcoming() {
    if (this.index < 0) return;
    this.items.length = this.index + 1;
  }

  jumpTo(index) {
    if (index < 0 || index >= this.items.length) return null;
    this.index = index;
    return this.current;
  }

  // Natural advance. Returns the next track, or null at the end of the queue.
  next({ manual = false } = {}) {
    if (this.items.length === 0) return null;
    if (this.repeat === 'one' && !manual) return this.current;
    if (this.index < this.items.length - 1) {
      this.index++;
      return this.current;
    }
    if (this.repeat === 'all') {
      this.index = 0;
      return this.current;
    }
    return null;
  }

  // Going back never jumps to the end of the queue by accident.
  previous() {
    if (this.items.length === 0) return null;
    if (this.index > 0) {
      this.index--;
    } else if (this.repeat === 'all' && this.items.length > 1) {
      this.index = this.items.length - 1;
    }
    return this.current;
  }

  setRepeat(mode) {
    if (['off', 'all', 'one'].includes(mode)) this.repeat = mode;
    return this.repeat;
  }

  // Recent listening context, newest last. This is what the DJ reasons over.
  recent(n = 6) {
    if (this.index < 0) return [];
    return this.items.slice(Math.max(0, this.index - n + 1), this.index + 1);
  }

  snapshot() {
    return { items: this.items, index: this.index, repeat: this.repeat };
  }
}
