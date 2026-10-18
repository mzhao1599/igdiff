/**
 * In-memory stand-in for the Instagram endpoints the extension uses.
 * Test-only: nothing in `entrypoints/` imports it.
 */
import type { InstagramClient } from '../instagram/api';
import { sprinkleValue } from '../instagram/session';

const CSRF = 'csrf-test';
const CURRENT_TOKEN = 'dtsg-current';
const EXPIRED_TOKEN = 'dtsg-expired';
const JAZOEST = sprinkleValue(CSRF, { paramName: 'jazoest', version: 2, randomize: false });

export interface FakeAccount {
  readonly pk: string;
  readonly username?: string;
  /** Extra id variants sent alongside pk (e.g. a graph id). */
  readonly id?: string;
  /** `friendship_status.followed_by` sent on the following list. Omitted when undefined. */
  readonly followedBy?: boolean;
}

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly params: URLSearchParams;
  readonly body: string | null;
  /** 1-based count of requests to this path so far, including this one. */
  readonly nth: number;
}

export interface FakeInstagramOptions {
  readonly viewerId?: string;
  readonly following?: readonly FakeAccount[];
  readonly followers?: readonly FakeAccount[];
  /** Instagram serves followers in small chunks regardless of `count`. */
  readonly followersChunk?: number;
  readonly followingChunk?: number;
  readonly reportedFollowers?: number | null;
  readonly reportedFollowing?: number | null;
  /** Sent as `hidden_following_account_count` on following pages. */
  readonly hiddenFollowing?: number;
  /**
   * How `order=…` is treated on both lists: ignored (default), answered with the
   * whole list in one page (what Instagram did for following on a real account),
   * or refused with a 400.
   */
  readonly orderBehavior?: 'ignored' | 'all-in-one' | 'rejected';
  /**
   * The page token the client's `webClient` hands out: current (default), expired
   * until a fresh page is loaded, or none (no `webClient`). Like Instagram, every
   * POST without the current token and checksum gets the HTML app page.
   */
  readonly pageToken?: 'current' | 'expired' | 'none';
  /** The unfollow endpoint always answers with the HTML app page. */
  readonly destroyGone?: boolean;
  /** The unfollow endpoint answers with a bare JSON 404, as seen on a real account for a request without the page token. */
  readonly destroy404?: boolean;
  /** Accounts whose follows become requests, like private accounts. */
  readonly privateAccounts?: readonly string[];
  /** Overrides for show_many. `null` leaves an account out of the response (deactivated/unavailable). */
  readonly friendships?: Readonly<Record<string, { following?: boolean; followed_by?: boolean } | null>>;
  /** Return a Response to replace the default answer for a request. */
  readonly intercept?: (request: FakeRequest) => Response | undefined;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function html(body: string, status = 200, url?: string): Response {
  const response = new Response(body, { status, headers: { 'content-type': 'text/html' } });
  if (url) {
    Object.defineProperty(response, 'url', { value: url });
  }
  return response;
}

function rawUser(account: FakeAccount) {
  return {
    pk: account.pk,
    ...(account.id ? { id: account.id } : {}),
    username: account.username ?? `user${account.pk}`,
    full_name: `User ${account.pk}`,
    profile_pic_url: `https://cdn.example/${account.pk}.jpg`,
    is_private: false,
    is_verified: false,
    ...(account.followedBy !== undefined ? { friendship_status: { followed_by: account.followedBy } } : {}),
  };
}

export function createFakeInstagram(options: FakeInstagramOptions = {}) {
  const viewerId = options.viewerId ?? '1000';
  const following = options.following ?? [];
  const followers = options.followers ?? [];
  const requests: FakeRequest[] = [];
  const counts = new Map<string, number>();
  const unfollowed: string[] = [];
  const removedFollowers: string[] = [];
  const followed: string[] = [];
  const requested: string[] = [];
  let freshPageLoads = 0;

  const page = (
    list: readonly FakeAccount[],
    params: URLSearchParams,
    chunk: number | undefined,
    extra: Record<string, unknown> = {},
  ) => {
    const offset = Number(params.get('max_id') ?? '0');
    const allInOne = options.orderBehavior === 'all-in-one' && params.has('order');
    const size = allInOne ? list.length : Math.min(Number(params.get('count') ?? '50'), chunk ?? Infinity);
    const slice = list.slice(offset, offset + size);
    const next = offset + size < list.length ? String(offset + size) : null;
    return json({
      users: slice.map(rawUser),
      big_list: next !== null,
      ...(next !== null ? { next_max_id: next } : {}),
      follow_ranking_token: 'rank-token',
      ...extra,
      status: 'ok',
    });
  };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const nth = (counts.get(url.pathname) ?? 0) + 1;
    counts.set(url.pathname, nth);
    const body = typeof init?.body === 'string' ? init.body : null;
    const request: FakeRequest = { method, path: url.pathname, params: url.searchParams, body, nth };
    requests.push(request);

    const intercepted = options.intercept?.(request);
    if (intercepted) {
      return intercepted;
    }
    if (options.orderBehavior === 'rejected' && url.searchParams.has('order')) {
      return json({ message: 'Invalid parameter', status: 'fail' }, 400);
    }
    const form = new URLSearchParams(body ?? '');
    if (method === 'POST' && (form.get('fb_dtsg') !== CURRENT_TOKEN || form.get('jazoest') !== JAZOEST)) {
      return html('<!doctype html><html>app</html>');
    }

    if (url.pathname === `/api/v1/users/${viewerId}/info/`) {
      return json({
        user: {
          pk: viewerId,
          username: 'me',
          follower_count: options.reportedFollowers === undefined ? followers.length : options.reportedFollowers,
          following_count: options.reportedFollowing === undefined ? following.length : options.reportedFollowing,
        },
        status: 'ok',
      });
    }
    if (url.pathname === `/api/v1/friendships/${viewerId}/following/`) {
      return page(
        following,
        url.searchParams,
        options.followingChunk,
        options.hiddenFollowing === undefined ? {} : { hidden_following_account_count: options.hiddenFollowing },
      );
    }
    if (url.pathname === `/api/v1/friendships/${viewerId}/followers/`) {
      return page(followers, url.searchParams, options.followersChunk);
    }
    const unfollow = /^\/api\/v1\/friendships\/destroy\/([^/]+)\/$/.exec(url.pathname);
    if (unfollow && method === 'POST') {
      const id = decodeURIComponent(unfollow[1]!);
      if (options.destroyGone) {
        return html('<!doctype html><html>app</html>');
      }
      if (options.destroy404) {
        return json({ status: 'fail' }, 404);
      }
      if (!following.some(account => account.pk === id)) {
        return json({ message: 'User not found', status: 'fail' }, 404);
      }
      unfollowed.push(id);
      return json({ friendship_status: { following: false }, status: 'ok' });
    }
    const create = /^\/api\/v1\/friendships\/create\/([^/]+)\/$/.exec(url.pathname);
    if (create && method === 'POST') {
      const id = decodeURIComponent(create[1]!);
      if (![...followers, ...following].some(account => account.pk === id)) {
        return json({ message: 'User not found', status: 'fail' }, 404);
      }
      const isPrivate = options.privateAccounts?.includes(id) ?? false;
      (isPrivate ? requested : followed).push(id);
      return json({ friendship_status: { following: !isPrivate, outgoing_request: isPrivate }, status: 'ok' });
    }
    const remove = /^\/api\/v1\/friendships\/remove_follower\/([^/]+)\/$/.exec(url.pathname);
    if (remove && method === 'POST') {
      const id = decodeURIComponent(remove[1]!);
      if (!followers.some(account => account.pk === id)) {
        return json({ message: 'User not found', status: 'fail' }, 404);
      }
      removedFollowers.push(id);
      return json({ friendship_status: { followed_by: false }, status: 'ok' });
    }
    const single = /^\/api\/v1\/friendships\/show\/([^/]+)\/$/.exec(url.pathname);
    if (single && method === 'GET') {
      const id = decodeURIComponent(single[1]!);
      const override = options.friendships?.[id];
      if (override === null) {
        return json({ message: 'User not found', status: 'fail' }, 404);
      }
      return json({
        ...(override ?? {
          following: (following.some(account => account.pk === id) && !unfollowed.includes(id)) || followed.includes(id),
          followed_by: followers.some(account => account.pk === id) && !removedFollowers.includes(id),
          outgoing_request: requested.includes(id),
        }),
        status: 'ok',
      });
    }
    if (url.pathname === '/api/v1/friendships/show_many/' && method === 'POST') {
      const ids = form.get('user_ids')?.split(',') ?? [];
      const statuses: Record<string, unknown> = {};
      for (const id of ids) {
        const override = options.friendships?.[id];
        if (override === null) {
          continue;
        }
        statuses[id] = override ?? {
          following: following.some(account => account.pk === id),
          followed_by: followers.some(account => account.pk === id),
        };
      }
      return json({ friendship_statuses: statuses, status: 'ok' });
    }
    return json({ message: 'not found', status: 'fail' }, 404);
  };

  const pageToken = options.pageToken ?? 'current';
  const client: InstagramClient = {
    fetch: fetchImpl as typeof fetch,
    csrfToken: () => CSRF,
    ...(pageToken === 'none'
      ? {}
      : {
          webClient: async ({ fresh = false } = {}) => {
            if (fresh) {
              freshPageLoads++;
            }
            const token = pageToken === 'expired' && freshPageLoads === 0 ? EXPIRED_TOKEN : CURRENT_TOKEN;
            return { headers: { 'x-ig-www-claim': '0' }, fields: { fb_dtsg: token, jazoest: JAZOEST } };
          },
        }),
  };
  return { client, requests, viewerId, unfollowed, removedFollowers, followed, requested, freshPageLoads: () => freshPageLoads };
}

export function accounts(...pks: string[]): FakeAccount[] {
  return pks.map(pk => ({ pk }));
}
