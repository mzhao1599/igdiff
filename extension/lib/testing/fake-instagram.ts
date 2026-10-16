/**
 * In-memory stand-in for the four Instagram endpoints the collector uses.
 * Test-only: nothing in `entrypoints/` imports it.
 */
import type { InstagramClient } from '../instagram/api';

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
    const single = /^\/api\/v1\/friendships\/show\/([^/]+)\/$/.exec(url.pathname);
    if (single && method === 'GET') {
      const id = decodeURIComponent(single[1]!);
      const override = options.friendships?.[id];
      if (override === null) {
        return json({ message: 'User not found', status: 'fail' }, 404);
      }
      return json({
        ...(override ?? {
          following: following.some(account => account.pk === id),
          followed_by: followers.some(account => account.pk === id),
        }),
        status: 'ok',
      });
    }
    if (url.pathname === '/api/v1/friendships/show_many/' && method === 'POST') {
      const ids = new URLSearchParams(body ?? '').get('user_ids')?.split(',') ?? [];
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

  const client: InstagramClient = { fetch: fetchImpl as typeof fetch, csrfToken: () => 'csrf-test' };
  return { client, requests, viewerId };
}

export function accounts(...pks: string[]): FakeAccount[] {
  return pks.map(pk => ({ pk }));
}
