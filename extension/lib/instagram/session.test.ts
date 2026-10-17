import { describe, expect, it } from 'vitest';
import {
  buildWebClient,
  parsePageConfig,
  randomPageId,
  readCookie,
  readSession,
  sprinkleValue,
  webSessionId,
  type PageConfig,
} from './session';

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

const PAGE = [
  '<script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"define":[',
  '["SprinkleConfig",[],{"param_name":"jazoest","version":2,"should_randomize":false},2111],',
  '["DTSGInitialData",[],{"token":"NAfQ-dtsg:1"},258],',
  '["InstagramWebPushInfo",[],{"rollout_hash":"1029384756"},1]',
  ']}]]]}</script>',
].join('');

const storage = (items: Record<string, string>) => ({ getItem: (key: string) => items[key] ?? null });

describe('parsePageConfig', () => {
  it('reads the page token, checksum config and revision from Instagram\'s page', () => {
    expect(parsePageConfig(PAGE)).toEqual({
      dtsg: 'NAfQ-dtsg:1',
      sprinkle: { paramName: 'jazoest', version: 2, randomize: false },
      rolloutHash: '1029384756',
    });
  });

  it('reports what is missing as null', () => {
    expect(parsePageConfig('<html></html>')).toEqual({ dtsg: null, sprinkle: null, rolloutHash: null });
    expect(parsePageConfig('["SprinkleConfig",[],{"param_name":1}]').sprinkle).toBeNull();
  });
});

describe('sprinkleValue', () => {
  it('is the version followed by the sum of the token\'s character codes', () => {
    expect(sprinkleValue('abc', { paramName: 'jazoest', version: 2, randomize: false })).toBe('2294');
    expect(sprinkleValue('abc', { paramName: 'jazoest', version: 2, randomize: true })).toBe('294');
  });
});

describe('webSessionId', () => {
  it('joins the unexpired session, the tab and the page id', () => {
    const local = storage({ Session: 'abc123:2000' });
    expect(webSessionId(local, storage({ TabId: 'tab456' }), 'page78', 1000)).toBe('abc123:tab456:page78');
  });

  it('leaves out an expired session or malformed parts', () => {
    expect(webSessionId(storage({ Session: 'abc123:500' }), storage({}), 'page78', 1000)).toBe('::page78');
    expect(webSessionId(storage({ Session: 'BAD!:2000' }), storage({ TabId: 'x' }), 'page78', 1000)).toBe('::page78');
  });

  it('page ids are 6 base-36 characters', () => {
    expect(randomPageId(() => 0)).toBe('000000');
    expect(randomPageId(() => 0.999999)).toMatch(/^[a-z0-9]{6}$/);
  });
});

describe('buildWebClient', () => {
  const inputs = (page: PageConfig, csrfToken: string | null, claim?: string) => ({
    page,
    csrfToken,
    sessionStore: storage(claim ? { 'www-claim-v2': claim } : {}),
    localStore: storage({}),
    asbdId: '359341',
    pageId: 'page78',
    now: 0,
  });

  it('mirrors what the web app adds to a POST', () => {
    expect(buildWebClient(inputs(parsePageConfig(PAGE), 'abc', 'hmac.claim'))).toEqual({
      headers: {
        'x-ig-www-claim': 'hmac.claim',
        'x-asbd-id': '359341',
        'x-web-session-id': '::page78',
        'x-instagram-ajax': '1029384756',
      },
      fields: { fb_dtsg: 'NAfQ-dtsg:1', jazoest: '2294' },
    });
  });

  it('sends a claim of 0 before the web app has one, and leaves out what it cannot find', () => {
    expect(buildWebClient(inputs(parsePageConfig('<html></html>'), 'abc'))).toEqual({
      headers: { 'x-ig-www-claim': '0', 'x-asbd-id': '359341', 'x-web-session-id': '::page78' },
      fields: {},
    });
    expect(buildWebClient(inputs(parsePageConfig(PAGE), null)).fields).toEqual({ fb_dtsg: 'NAfQ-dtsg:1' });
  });
});
