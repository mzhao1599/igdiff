import { describe, expect, it } from 'vitest';
import { AVATAR_MAX_BYTES, avatarKey, avatarsToFetch, fetchAvatar, fetchAvatars } from './avatars';

const PIC = 'https://scontent-sjc3-1.cdninstagram.com/v/t51.2885-19/123_n.jpg?stp=dst-jpg_s150x150&oe=6A1B2C3D&oh=sig';

describe('avatarKey', () => {
  it('keeps the host and path, dropping the signature that expires', () => {
    expect(avatarKey(PIC)).toBe('scontent-sjc3-1.cdninstagram.com/v/t51.2885-19/123_n.jpg');
    expect(avatarKey(PIC.replace('oe=6A1B2C3D', 'oe=7F000000'))).toBe(avatarKey(PIC));
  });

  it('rejects anything that is not an https URL', () => {
    expect(avatarKey('')).toBeNull();
    expect(avatarKey('http://example.com/a.jpg')).toBeNull();
    expect(avatarKey('not a url')).toBeNull();
  });
});

describe('avatarsToFetch', () => {
  const urls: Record<string, string> = { '1': PIC, '2': PIC.replace('123_n', '456_n'), '3': '' };

  it('asks only for pictures that are new or changed, once each', () => {
    const cached = new Map([['1', { key: avatarKey(PIC)! }], ['2', { key: 'old/picture.jpg' }]]);
    expect(avatarsToFetch(['1', '2', '2', '3', '4'], pk => urls[pk], cached)).toEqual([{ pk: '2', url: urls['2'] }]);
  });

  it('skips pictures that failed recently', () => {
    const failed = new Set([avatarKey(urls['2']!)!]);
    expect(avatarsToFetch(['2'], pk => urls[pk], new Map(), failed)).toEqual([]);
  });
});

describe('fetchAvatar', () => {
  const respond = (body: BodyInit | null, init: ResponseInit) => (async () => new Response(body, init)) as unknown as typeof fetch;

  it('returns the picture as a data URL', async () => {
    const fetchImpl = respond(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    expect(await fetchAvatar(fetchImpl, PIC)).toBe('data:image/jpeg;base64,AQID');
  });

  it('refuses errors, non-images, empty and oversized bodies', async () => {
    expect(await fetchAvatar(respond('x', { status: 403, headers: { 'content-type': 'image/jpeg' } }), PIC)).toBeNull();
    expect(await fetchAvatar(respond('<html>', { headers: { 'content-type': 'text/html' } }), PIC)).toBeNull();
    expect(await fetchAvatar(respond(new Uint8Array(0), { headers: { 'content-type': 'image/jpeg' } }), PIC)).toBeNull();
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
    expect(await fetchAvatar(respond(big, { headers: { 'content-type': 'image/jpeg' } }), PIC)).toBeNull();
  });

  it('survives a network error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    expect(await fetchAvatar(fetchImpl, PIC)).toBeNull();
  });
});

describe('fetchAvatars', () => {
  it('keeps the order and never runs more than the allowed number at once', async () => {
    let running = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 1));
      running--;
      return new Response(new Uint8Array([7]), { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    const requests = Array.from({ length: 7 }, (_, i) => ({ pk: String(i), url: PIC }));
    const results = await fetchAvatars(fetchImpl, requests, 3);
    expect(results.map(result => result.pk)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(results.every(result => result.dataUrl === 'data:image/png;base64,Bw==')).toBe(true);
    expect(peak).toBe(3);
  });
});
