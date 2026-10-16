import { describe, expect, it } from 'vitest';
import { readCookie, readSession } from './session';

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
