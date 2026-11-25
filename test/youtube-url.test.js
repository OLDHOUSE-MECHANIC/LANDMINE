import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
process.env.YTDLP_PATH = join(here, 'fixtures/fake-ytdlp-url.sh');

const youtube = await import('../server/sources/youtube.js');

test('parses the YouTube link shapes people paste', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=abc12345678', { kind: 'video', id: 'abc12345678' }],
    ['https://youtu.be/abc12345678?si=xyz', { kind: 'video', id: 'abc12345678' }],
    ['youtube.com/shorts/abc12345678', { kind: 'video', id: 'abc12345678' }],
    ['https://m.youtube.com/live/abc12345678', { kind: 'video', id: 'abc12345678' }],
    ['https://www.youtube.com/embed/abc12345678', { kind: 'video', id: 'abc12345678' }],
    ['https://music.youtube.com/playlist?list=PL1234567890', { kind: 'playlist', id: 'PL1234567890' }]
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(youtube.parseYouTubeUrl(input), expected, input);
  }
});

test('a video link copied from a playlist resolves to the playlist', () => {
  assert.deepEqual(
    youtube.parseYouTubeUrl('https://www.youtube.com/watch?v=abc12345678&list=PL1234567890&index=2'),
    { kind: 'playlist', id: 'PL1234567890' }
  );
});

test('rejects other sites and non-links', () => {
  const bad = [
    '', 'Daft Punk', 'https://example.com/watch?v=abc12345678',
    'https://youtube.com/', 'ftp://youtube.com/watch?v=abc12345678'
  ];
  for (const input of bad) assert.equal(youtube.parseYouTubeUrl(input), null, input);
});

test('playlist extraction is enabled only for playlist links', () => {
  assert.ok(youtube.baseArgs().includes('--no-playlist'));
  assert.ok(!youtube.baseArgs({ playlist: true }).includes('--no-playlist'));
});

test('resolves a single video to one clean track', async () => {
  const found = await youtube.resolveUrl('https://youtu.be/abc12345678');
  assert.equal(found.kind, 'video');
  assert.deepEqual(found.tracks, [{
    source: 'youtube',
    sourceId: 'abc12345678',
    title: 'Solo',
    artist: 'Artist',
    duration: 180,
    artwork: 'https://i.ytimg.com/vi/abc12345678/mqdefault.jpg'
  }]);
});

test('resolves every entry in a playlist, once', async () => {
  const found = await youtube.resolveUrl('https://www.youtube.com/playlist?list=PL1234567890');
  assert.equal(found.kind, 'playlist');
  assert.equal(found.tracks.length, 2);
  assert.deepEqual(found.tracks.map(t => t.sourceId), ['vid11111111', 'vid22222222']);
  assert.equal(found.tracks[1].duration, 0, 'flat entries can omit the duration');
});
