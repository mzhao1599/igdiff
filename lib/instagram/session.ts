/**
 * Reads the signed-in Instagram session from the page's cookies.
 *
 * Only two non-HttpOnly cookies are used: `ds_user_id` (who is signed in) and
 * `csrftoken` (required header on Instagram's POST endpoints). The HttpOnly
 * `sessionid` cookie is never read; the browser attaches it to same-origin
 * requests on its own. POSTs also carry the request token Instagram renders
 * into its page, as the web app's do. Nothing here is stored or sent anywhere
 * but Instagram.
 */
import type { WebClientContext } from './api';

export interface InstagramSession {
  readonly viewerId: string | null;
  readonly csrfToken: string | null;
}

export function readCookie(cookieString: string, name: string): string | null {
  for (const part of cookieString.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value === '' ? null : decodeURIComponent(value);
    }
  }
  return null;
}

export function readSession(cookieString: string): InstagramSession {
  return {
    viewerId: readCookie(cookieString, 'ds_user_id'),
    csrfToken: readCookie(cookieString, 'csrftoken'),
  };
}

/** How the web app names and builds the CSRF checksum it adds to POST bodies (`jazoest`). */
export interface SprinkleConfig {
  readonly paramName: string;
  readonly version: number;
  readonly randomize: boolean;
}

/** Values Instagram renders into its page for the web app's own requests. */
export interface PageConfig {
  /** `DTSGInitialData.token`, sent as `fb_dtsg` on every POST. Without it Instagram answers with its HTML app page. */
  readonly dtsg: string | null;
  readonly sprinkle: SprinkleConfig | null;
  /** The web app's revision, sent as `X-Instagram-AJAX` on writes. */
  readonly rolloutHash: string | null;
}

export function parsePageConfig(html: string): PageConfig {
  const dtsg = /"DTSGInitialData",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] ?? null;
  let sprinkle: SprinkleConfig | null = null;
  const rawSprinkle = /"SprinkleConfig",\[\],(\{[^{}]*\})/.exec(html)?.[1];
  if (rawSprinkle) {
    try {
      const parsed = JSON.parse(rawSprinkle) as { param_name?: unknown; version?: unknown; should_randomize?: unknown };
      if (typeof parsed.param_name === 'string' && typeof parsed.version === 'number') {
        sprinkle = { paramName: parsed.param_name, version: parsed.version, randomize: parsed.should_randomize === true };
      }
    } catch {
      sprinkle = null;
    }
  }
  return { dtsg, sprinkle, rolloutHash: /"rollout_hash":"([^"]+)"/.exec(html)?.[1] ?? null };
}

/** The web app's `jazoest`: the config version followed by the sum of the CSRF token's character codes. */
export function sprinkleValue(csrfToken: string, sprinkle: SprinkleConfig): string {
  let sum = 0;
  for (let i = 0; i < csrfToken.length; i++) {
    sum += csrfToken.charCodeAt(i);
  }
  return sprinkle.randomize ? String(sum) : `${sprinkle.version}${sum}`;
}

const WEB_SESSION_PART = /^[a-z0-9]{6}$/;

/**
 * `X-Web-Session-ID` the way the web app builds it: `<session>:<tab>:<page>`,
 * from the session in localStorage (while unexpired), the tab id in
 * sessionStorage, and a per-page random id. Missing parts are left empty.
 */
export function webSessionId(
  localStore: Pick<Storage, 'getItem'>,
  sessionStore: Pick<Storage, 'getItem'>,
  pageId: string,
  now: number,
): string {
  const [session, expiry] = (localStore.getItem('Session') ?? '').split(':');
  const sessionId = session && WEB_SESSION_PART.test(session) && Number(expiry) > now ? session : '';
  const tab = sessionStore.getItem('TabId') ?? '';
  return `${sessionId}:${WEB_SESSION_PART.test(tab) ? tab : ''}:${pageId}`;
}

/** A random 6-character base-36 id, like the web app's page id. */
export function randomPageId(random: () => number = Math.random): string {
  return Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
}

export interface WebClientInputs {
  readonly page: PageConfig;
  readonly csrfToken: string | null;
  readonly sessionStore: Pick<Storage, 'getItem'>;
  readonly localStore: Pick<Storage, 'getItem'>;
  readonly asbdId: string;
  readonly pageId: string;
  readonly now: number;
}

/**
 * What Instagram's web app adds to its own POSTs, built the same way it builds
 * them. The claim is sent as "0" until the web app has one; other values that
 * can't be found are left out.
 */
export function buildWebClient(inputs: WebClientInputs): WebClientContext {
  const { page, csrfToken } = inputs;
  const headers: Record<string, string> = {
    'x-ig-www-claim': inputs.sessionStore.getItem('www-claim-v2') ?? '0',
    'x-asbd-id': inputs.asbdId,
    'x-web-session-id': webSessionId(inputs.localStore, inputs.sessionStore, inputs.pageId, inputs.now),
  };
  if (page.rolloutHash) {
    headers['x-instagram-ajax'] = page.rolloutHash;
  }
  const fields: Record<string, string> = {};
  if (page.dtsg) {
    fields.fb_dtsg = page.dtsg;
  }
  if (page.sprinkle && page.sprinkle.paramName !== '' && csrfToken) {
    fields[page.sprinkle.paramName] = sprinkleValue(csrfToken, page.sprinkle);
  }
  return { headers, fields };
}
