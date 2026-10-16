/**
 * Reads the signed-in Instagram session from the page's cookies.
 *
 * Only two non-HttpOnly cookies are used: `ds_user_id` (who is signed in) and
 * `csrftoken` (required header on Instagram's POST endpoints). The HttpOnly
 * `sessionid` cookie is never read; the browser attaches it to same-origin
 * requests on its own. Nothing here is stored or sent anywhere else.
 */
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

/**
 * The headers Instagram's web client adds to its own requests, read from the
 * page the same way the web app does. Values that can't be found are left out,
 * except the claim, which the web app sends as "0" until it has one.
 */
export function readWebClientHeaders(
  sessionStore: Pick<Storage, 'getItem'>,
  pageHtml: () => string,
  asbdId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'x-ig-www-claim': sessionStore.getItem('www-claim-v2') ?? '0',
    'x-asbd-id': asbdId,
  };
  const rolloutHash = /"rollout_hash":"([^"]+)"/.exec(pageHtml())?.[1];
  if (rolloutHash) {
    headers['x-instagram-ajax'] = rolloutHash;
  }
  return headers;
}
