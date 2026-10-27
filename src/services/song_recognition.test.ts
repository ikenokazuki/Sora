import { beforeEach, describe, expect, test } from 'bun:test';
import { clearCache } from '../cache.js';
import { toneBursts } from '../test_fixtures/audio.js';
import { AudioDecodeError } from './audio_decode.js';
import { MAX_URL_BYTES, SongRecognitionInputError, downloadAudio, parseShazamResponse, pickWindows, recognizeSong } from './song_recognition.js';

// 合成の音と、作り物の Shazam・iTunes の応答だけを使う
const TRACK = {
  key: '900001', title: 'テスト曲', subtitle: 'テスト歌手', isrc: 'JPZZ02600001',
  genres: { primary: 'J-Pop' }, images: { coverart: 'https://img.example/c.jpg', coverarthq: 'https://img.example/hq.jpg' },
  url: 'https://www.shazam.com/track/900001/test', trackadamid: '1700000001',
  sections: [{ type: 'SONG', metadata: [{ title: 'Album', text: 'テストアルバム' }, { title: 'Label', text: 'テストレーベル' }, { title: 'Released', text: '2026' }] }],
};
const HIT = { matches: [{ id: '900001', offset: 61.25, timeskew: 0.0001, frequencyskew: 0 }], track: TRACK, tagid: 'X' };
const ITUNES_TRACK = {
  wrapperType: 'track', kind: 'song', trackId: 1700000001, trackName: 'テスト曲', artistName: 'テスト歌手', collectionName: 'テストアルバム',
  artworkUrl100: 'https://img.example/a/100x100bb.jpg', previewUrl: 'https://audio.example/p.m4a', releaseDate: '2026-01-01T00:00:00Z',
  primaryGenreName: 'J-Pop', trackTimeMillis: 200000, trackViewUrl: 'https://music.apple.com/jp/album/x/1?i=1700000001',
};

function fakeFetch(handlers: { shazam?: (n: number) => Response; lookup?: () => Response; search?: () => Response }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let shazamCalls = 0;
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url.startsWith('https://amp.shazam.com/')) return (handlers.shazam ?? (() => Response.json({ matches: [] })))(++shazamCalls);
    if (url.startsWith('https://itunes.apple.com/lookup')) return (handlers.lookup ?? (() => Response.json({ resultCount: 1, results: [ITUNES_TRACK] })))();
    if (url.startsWith('https://itunes.apple.com/search')) return (handlers.search ?? (() => Response.json({ resultCount: 0, results: [] })))();
    throw new Error('unexpected fetch ' + url);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const decodeOk = (durationSec = 30) => async (_bytes: Uint8Array, pick: (d: number) => number[]) =>
  ({ durationSec, windows: pick(durationSec).map((offsetSec) => ({ offsetSec, pcm: toneBursts(1000) })) });
const audio = (n: number) => ({ bytes: new Uint8Array([1, 2, 3, n]), contentType: 'audio/mp4' });
const shazamCallsOf = (calls: Array<{ url: string }>) => calls.filter((c) => c.url.startsWith('https://amp.shazam.com/')).length;

beforeEach(() => {
  clearCache();
});

describe('pickWindows', () => {
  test('follows the reference client', () => {
    expect(pickWindows(30)).toEqual([0, 12, 24]);
    expect(pickWindows(100)).toEqual([44, 0, 12]);
    expect(pickWindows(10)).toEqual([0]);
    expect(pickWindows(2)).toEqual([0]);
    expect(pickWindows(100, 7)).toEqual([7]);
  });
});

describe('parseShazamResponse', () => {
  test('reads the track, the Apple id and where in the song the clip is', () => {
    expect(parseShazamResponse(HIT)).toEqual({
      track: {
        key: '900001', title: 'テスト曲', artist: 'テスト歌手', isrc: 'JPZZ02600001', appleMusicId: '1700000001',
        album: 'テストアルバム', label: 'テストレーベル', released: '2026', genre: 'J-Pop',
        url: 'https://www.shazam.com/track/900001/test', artwork: 'https://img.example/hq.jpg',
      },
      songOffsetSec: 61.25,
    });
  });

  test('finds the Apple id in the hub when trackadamid is missing', () => {
    const { trackadamid: _, ...rest } = TRACK;
    const viaAction = { ...HIT, track: { ...rest, hub: { actions: [{ type: 'applemusicplay', id: '1700000002' }] } } };
    expect(parseShazamResponse(viaAction)?.track.appleMusicId).toBe('1700000002');
    const viaOption = { ...HIT, track: { ...rest, hub: { options: [{ actions: [{ type: 'uri', uri: 'https://music.apple.com/jp/album/x/1700000000?i=1700000003&mttnagencyid=s2n' }] }] } } };
    expect(parseShazamResponse(viaOption)?.track.appleMusicId).toBe('1700000003');
  });

  test('no track is no match', () => {
    expect(parseShazamResponse({ matches: [] })).toBeNull();
    expect(parseShazamResponse(null)).toBeNull();
  });
});

describe('recognizeSong', () => {
  test('sends one signature per window until Shazam matches, then links iTunes by the Apple id', async () => {
    const { fn, calls } = fakeFetch({ shazam: (n) => Response.json(n === 2 ? HIT : { matches: [] }) });
    const out = await recognizeSong({ audio: audio(1) }, { fetchFn: fn, decode: decodeOk(30) });
    expect(out).toMatchObject({
      found: true, itunesMatch: 'apple-id', itunes: { id: '1700000001', title: 'テスト曲', artist: 'テスト歌手' },
      shazam: { key: '900001' }, match: { songOffsetSec: 61.25, clipOffsetSec: 12 },
    });
    expect(out.attempts).toEqual([{ offsetSec: 0, durationSec: 12, matched: false }, { offsetSec: 12, durationSec: 12, matched: true }]);
    expect(out.audio).toEqual({ bytes: 4, durationSec: 30, contentType: 'audio/mp4' });
    const tag = calls.filter((c) => c.url.startsWith('https://amp.shazam.com/'));
    expect(tag).toHaveLength(2);
    expect(tag[0].url).toMatch(/^https:\/\/amp\.shazam\.com\/discovery\/v5\/en\/JP\/iphone\/-\/tag\/[0-9A-F-]{36}\/[0-9A-F-]{36}\?sync=true/);
    const headers = tag[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.['X-Shazam-Platform']).toBe('IPHONE');
    const body = JSON.parse(String(tag[0].init?.body));
    expect(body.signature.uri.startsWith('data:audio/vnd.shazam.sig;base64,')).toBe(true);
    expect(body.signature.samplems).toBe(12000);
    expect(calls.find((c) => c.url.startsWith('https://itunes.apple.com/lookup'))?.url).toBe('https://itunes.apple.com/lookup?id=1700000001&country=jp&entity=song');
  });

  test('falls back to an exact title and artist match in the iTunes search, else null', async () => {
    const lookupEmpty = () => Response.json({ resultCount: 0, results: [] });
    const near = { ...ITUNES_TRACK, trackId: 1700000009, trackName: 'テスト曲 (Live)' };
    const exact = { ...ITUNES_TRACK, trackId: 1700000010, trackName: 'ﾃｽﾄ曲', artistName: 'テスト 歌手' };
    const both = fakeFetch({ shazam: () => Response.json(HIT), lookup: lookupEmpty, search: () => Response.json({ resultCount: 2, results: [near, exact] }) });
    expect(await recognizeSong({ audio: audio(2) }, { fetchFn: both.fn, decode: decodeOk() })).toMatchObject({ itunesMatch: 'title-artist', itunes: { id: '1700000010' } });
    const onlyNear = fakeFetch({ shazam: () => Response.json(HIT), lookup: lookupEmpty, search: () => Response.json({ resultCount: 1, results: [near] }) });
    expect(await recognizeSong({ audio: audio(3) }, { fetchFn: onlyNear.fn, decode: decodeOk() })).toMatchObject({ found: true, itunesMatch: null, itunes: null });
  });

  test('an iTunes failure keeps the match', async () => {
    const { fn } = fakeFetch({ shazam: () => Response.json(HIT), lookup: () => new Response('down', { status: 503 }) });
    expect(await recognizeSong({ audio: audio(4) }, { fetchFn: fn, decode: decodeOk() })).toMatchObject({ found: true, itunes: null, itunesMatch: null });
  });

  test('caches by the audio bytes, offset and country; noCache skips it', async () => {
    const { fn, calls } = fakeFetch({ shazam: () => Response.json(HIT) });
    const first = await recognizeSong({ audio: audio(5), offsetSec: 5 }, { fetchFn: fn, decode: decodeOk() });
    expect(first.attempts).toEqual([{ offsetSec: 5, durationSec: 12, matched: true }]);
    expect((await recognizeSong({ audio: audio(5), offsetSec: 5 }, { fetchFn: fn, decode: decodeOk() })).cached).toBe(true);
    expect(shazamCallsOf(calls)).toBe(1);
    await recognizeSong({ audio: audio(5), offsetSec: 6 }, { fetchFn: fn, decode: decodeOk() });
    await recognizeSong({ audio: audio(5), offsetSec: 5, country: 'us' }, { fetchFn: fn, decode: decodeOk() });
    await recognizeSong({ audio: audio(5), offsetSec: 5, noCache: true }, { fetchFn: fn, decode: decodeOk() });
    expect(shazamCallsOf(calls)).toBe(4);
  });

  test('no match, not audio and too short are found:false with a reason', async () => {
    const { fn } = fakeFetch({});
    expect(await recognizeSong({ audio: audio(6) }, { fetchFn: fn, decode: decodeOk(30) })).toMatchObject({ found: false, reason: 'no-match', itunes: null, itunesMatch: null });
    const broken = async () => { throw new AudioDecodeError('EncodingError: Unable to decode audio data'); };
    expect(await recognizeSong({ audio: audio(7) }, { fetchFn: fn, decode: broken })).toMatchObject({ found: false, reason: 'not-audio' });
    expect(await recognizeSong({ audio: audio(8) }, { fetchFn: fn, decode: decodeOk(2) })).toMatchObject({ found: false, reason: 'too-short' });
    const html = { bytes: new Uint8Array([60]), contentType: 'text/html; charset=utf-8' };
    expect(await recognizeSong({ audio: html }, { fetchFn: fn, decode: decodeOk() })).toMatchObject({ found: false, reason: 'not-audio' });
  });

  test('a silent window is skipped, and only silence is too short', async () => {
    const { fn, calls } = fakeFetch({ shazam: () => Response.json(HIT) });
    const silentFirst = async (_b: Uint8Array, pick: (d: number) => number[]) => ({
      durationSec: 30, windows: pick(30).map((offsetSec, i) => ({ offsetSec, pcm: i === 0 ? new Int16Array(12 * 16000) : toneBursts(1000) })),
    });
    expect(await recognizeSong({ audio: audio(9) }, { fetchFn: fn, decode: silentFirst })).toMatchObject({ found: true, match: { clipOffsetSec: 12 } });
    const silence = async (_b: Uint8Array, pick: (d: number) => number[]) => ({ durationSec: 30, windows: pick(30).map((offsetSec) => ({ offsetSec, pcm: new Int16Array(12 * 16000) })) });
    expect(await recognizeSong({ audio: audio(10) }, { fetchFn: fn, decode: silence })).toMatchObject({ found: false, reason: 'too-short' });
    expect(shazamCallsOf(calls)).toBe(1);
  });

  test('Shazam refusals and outages are errors that name the status', async () => {
    let n = 20;
    for (const status of [403, 429, 503]) {
      const { fn } = fakeFetch({ shazam: () => new Response('no', { status }) });
      await expect(recognizeSong({ audio: audio(n++) }, { fetchFn: fn, decode: decodeOk() })).rejects.toThrow(`Shazam HTTP ${status}`);
    }
    const slow = (async () => { throw new DOMException('timed out', 'TimeoutError'); }) as unknown as typeof fetch;
    await expect(recognizeSong({ audio: audio(n++) }, { fetchFn: slow, decode: decodeOk() })).rejects.toThrow('timed out');
  });

  test('needs a url or an upload, only http(s) urls, and a two-letter country', async () => {
    await expect(recognizeSong({})).rejects.toBeInstanceOf(SongRecognitionInputError);
    await expect(recognizeSong({ url: 'file:///etc/passwd' })).rejects.toBeInstanceOf(SongRecognitionInputError);
    await expect(recognizeSong({ audio: audio(30), country: 'japan' })).rejects.toBeInstanceOf(SongRecognitionInputError);
  });
});

describe('downloadAudio', () => {
  const via = (res: Response) => async () => ({ finalUrl: 'https://cdn.example/a.m4a', response: res });

  test('returns the bytes and the content type', async () => {
    const res = new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mp4' } });
    expect(await downloadAudio('https://cdn.example/a.m4a', via(res))).toEqual({ bytes: new Uint8Array([1, 2]), contentType: 'audio/mp4' });
  });

  test('an error page, an HTML page, a big file and a failed fetch are reasons, not errors', async () => {
    expect(await downloadAudio('https://x.example/a', via(new Response('gone', { status: 404 })))).toMatchObject({ reason: 'download-failed' });
    expect(await downloadAudio('https://x.example/a', via(new Response('<html>', { headers: { 'content-type': 'text/html' } })))).toMatchObject({ reason: 'not-audio' });
    expect(await downloadAudio('https://x.example/a', via(new Response(new Uint8Array(MAX_URL_BYTES + 1))))).toMatchObject({ reason: 'too-large' });
    expect(await downloadAudio('https://x.example/a', async () => { throw new Error('getaddrinfo ENOTFOUND x.example'); })).toMatchObject({ reason: 'download-failed' });
  });
});
