import { describe, expect, it } from 'vitest';
import { readCookie, readSession, readWebClientHeaders } from './session';

describe('readCookie', () => {
  it('finds a cookie by exact name, not by suffix', () => {
    const cookies = 'mid=abc; xds_user_id=999; ds_user_id=12345; csrftoken=tok%3D';
    expect(readCookie(cookies, 'ds_user_id')).toBe('12345');
    expect(readCookie(cookies, 'csrftoken')).toBe('tok=');
  });

  it('returns null for a missing or empty cookie', () => {
    expect(readCookie('a=1', 'ds_user_id')).toBeNull();
    expect(readCookie('ds_user_id=', 'ds_user_id')).toBeNull();
    expect(readCookie('', 'ds_user_id')).toBeNull();
  });
});

describe('readSession', () => {
  it('reads the viewer id and csrf token', () => {
    expect(readSession('ds_user_id=42; csrftoken=x')).toEqual({ viewerId: '42', csrfToken: 'x' });
  });

  it('reports a signed-out page as no viewer', () => {
    expect(readSession('csrftoken=x').viewerId).toBeNull();
  });
});

describe('readWebClientHeaders', () => {
  const store = (value: string | null) => ({ getItem: (key: string) => (key === 'www-claim-v2' ? value : null) });

  it('mirrors what the web app sends', () => {
    expect(readWebClientHeaders(store('hmac.abc'), () => '{"rollout_hash":"1a2b3c"}', '359341')).toEqual({
      'x-ig-www-claim': 'hmac.abc',
      'x-asbd-id': '359341',
      'x-instagram-ajax': '1a2b3c',
    });
  });

  it('sends a claim of 0 before the web app has one, and skips a missing revision', () => {
    expect(readWebClientHeaders(store(null), () => '<html></html>', '1')).toEqual({ 'x-ig-www-claim': '0', 'x-asbd-id': '1' });
  });
});
