import test from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../server/queue.js';

const t = n => ({ source: 'youtube', sourceId: `id_${n}____`, title: `T${n}`, artist: 'A', duration: 100 });
const mk = (n = 5) => { const q = new Queue(); for (let i = 1; i <= n; i++) q.add(t(i)); return q; };
const titles = q => q.items.map(i => i.title).join(',');

test('shuffle reorders only what is still to come', () => {
  const q = mk(8);
  q.jumpTo(2);
  const before = titles(q).split(',');
  let changed = false;
  for (let i = 0; i < 20 && !changed; i++) { q.shuffleUpcoming(); changed = titles(q) !== before.join(','); }
  assert.ok(changed, 'order should change');
  const after = titles(q).split(',');
  assert.deepEqual(after.slice(0, 3), before.slice(0, 3), 'history + current untouched');
  assert.deepEqual([...after.slice(3)].sort(), [...before.slice(3)].sort(), 'same tracks');
  assert.equal(q.index, 2);
});

test('playing after shuffle follows the visible order, never jumps', () => {
  const q = mk(6);
  q.shuffleUpcoming();
  const visible = titles(q).split(',');
  const played = [q.current.title];
  while (q.next()) played.push(q.current.title);
  assert.deepEqual(played, visible);
});

test('shuffle with nothing to shuffle reports false', () => {
  assert.equal(mk(1).shuffleUpcoming(), false);
  assert.equal(new Queue().shuffleUpcoming(), false);
});

test('repeat modes', () => {
  const q = mk(3);
  q.jumpTo(2);
  assert.equal(q.next(), null, 'off: ends');
  q.setRepeat('all'); assert.equal(q.next().title, 'T1', 'all: wraps');
  q.setRepeat('one'); assert.equal(q.next().title, 'T1', 'one: stays');
  assert.equal(q.next({ manual: true }).title, 'T2', 'one: skip still advances');
});

test('manual next at the very end stops instead of wrapping', () => {
  const q = mk(2); q.jumpTo(1);
  assert.equal(q.next({ manual: true }), null);
  assert.equal(q.index, 1);
});

test('previous at the first track stays put', () => {
  const q = mk(3);
  assert.equal(q.previous().title, 'T1');
  assert.equal(q.index, 0);
});

test('removing the playing last track reports there is no next', () => {
  const q = mk(2); q.jumpTo(1);
  const r = q.remove(q.current.uid);
  assert.deepEqual(r, { wasCurrent: true, landedOnNext: false });
  const q2 = mk(3); q2.jumpTo(1);
  assert.deepEqual(q2.remove(q2.current.uid), { wasCurrent: true, landedOnNext: true });
  assert.equal(q2.current.title, 'T3');
});

test('removing history keeps the pointer on the same track', () => {
  const q = mk(4); q.jumpTo(2);
  q.remove(q.items[0].uid);
  assert.equal(q.current.title, 'T3');
});

test('shift and moveToNext never touch history or the current track', () => {
  const q = mk(5); q.jumpTo(1);
  assert.equal(q.shift(q.items[0].uid, 1), false, 'history');
  assert.equal(q.shift(q.items[1].uid, 1), false, 'current');
  assert.equal(q.shift(q.items[2].uid, -1), false, 'cannot rise above up-next');
  assert.equal(q.shift(q.items[2].uid, 1), true);
  assert.equal(titles(q), 'T1,T2,T4,T3,T5');
  assert.equal(q.moveToNext(q.items[4].uid), true);
  assert.equal(titles(q), 'T1,T2,T5,T4,T3');
});

test('insert-at is clamped so it can never land before the current track', () => {
  const q = mk(3); q.jumpTo(1);
  q.add(t(9), 'x', { at: 0 });
  assert.equal(titles(q), 'T1,T2,T9,T3');
});

test('clearUpcoming keeps history and the current track', () => {
  const q = mk(5); q.jumpTo(2); q.clearUpcoming();
  assert.equal(titles(q), 'T1,T2,T3');
  assert.equal(q.current.title, 'T3');
});

test('queue is capped', () => {
  const q = mk(200);
  assert.equal(q.add(t(201)), null);
});
