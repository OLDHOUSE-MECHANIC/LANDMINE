import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'lm-test-'));
process.env.YTDLP_PATH = join(here, 'fixtures/fake-ytdlp.sh');
process.env.CACHE_DIR = join(dir, 'cache');
process.env.FAKE_LOG = join(dir, 'calls.log');
process.env.CACHE_MAX_TRACKS = '3';
writeFileSync(process.env.FAKE_LOG, '');

const cache = await import('../server/cache.js');
cache.init();
const calls = id => readFileSync(process.env.FAKE_LOG, 'utf8').split('\n').filter(l => l === id).length;

test('downloads once, then serves from disk', async () => {
  const f1 = await cache.ensure('abc12345678');
  assert.ok(existsSync(f1));
  assert.equal(cache.mimeFor(f1), 'audio/mp4');
  await cache.ensure('abc12345678');
  assert.equal(calls('abc12345678'), 1);
});

test('concurrent requests for one track share a single download', async () => {
  const [a, b, c] = await Promise.all([cache.ensure('SLOW1234567'), cache.ensure('SLOW1234567'), cache.ensure('SLOW1234567')]);
  assert.equal(a, b); assert.equal(b, c);
  assert.equal(calls('SLOW1234567'), 1);
});

test('a transient failure is retried once and then succeeds', async () => {
  const f = await cache.ensure('FLAKY123456');
  assert.ok(existsSync(f));
  assert.equal(calls('FLAKY123456'), 2);
});

test('a permanent failure is not retried, and is explained plainly', async () => {
  await assert.rejects(cache.ensure('FAIL1234567'), err => {
    assert.equal(cache.explain(err), 'Video unavailable');
    return true;
  });
  assert.equal(calls('FAIL1234567'), 1);
  assert.equal(cache.pathFor('FAIL1234567'), null, 'no leftovers');
});

test('failure reasons are readable', async () => {
  await assert.rejects(cache.ensure('AGE12345678'), e => { assert.equal(cache.explain(e), 'Age-restricted'); return true; });
  await assert.rejects(cache.ensure('NOJS1234567'), e => { assert.match(cache.explain(e), /JS challenge/); return true; });
});

test('half-written .part files are never treated as ready', () => {
  writeFileSync(join(process.env.CACHE_DIR, 'PART1234567.m4a.part'), 'x');
  writeFileSync(join(process.env.CACHE_DIR, 'MERG1234567.f140.m4a'), 'x');
  assert.equal(cache.pathFor('PART1234567'), null);
  assert.equal(cache.pathFor('MERG1234567'), null);
});

test('pruning drops the oldest tracks but never one that is queued', async () => {
  cache.init();
  cache.setKeep(() => new Set(['old11111111'])); // as the server does: set once at startup
  const ids = ['old11111111', 'mid22222222', 'new33333333', 'new44444444', 'new55555555'];
  for (const id of ids) { await cache.ensure(id); await new Promise(r => setTimeout(r, 15)); }
  cache.prune();
  assert.ok(cache.pathFor('old11111111'), 'queued track survives');
  assert.equal(cache.pathFor('mid22222222'), null, 'oldest unqueued is evicted');
  assert.ok(cache.pathFor('new55555555'));
});
