/**
 * Client for the private endpoints Instagram's own web app uses for follow lists.
 *
 *   GET  /api/v1/users/{id}/info/                      profile counts
 *   GET  /api/v1/friendships/{id}/following/?count=N   following list page
 *   GET  /api/v1/friendships/{id}/followers/?count=N   followers list page
 *   POST /api/v1/friendships/show_many/                bulk friendship status
 *
 *   POST /api/v1/friendships/destroy/{id}/             unfollow (falls back to /web/friendships/{id}/unfollow/)
 *
 * These are unofficial and change without notice, so every call returns its raw
 * status and a failure hint instead of throwing, and callers decide what a
 * failure means. Nothing here retries, sleeps, or stores anything.
 *
 * Parsing ported from the legacy src/utils/igListsApi.ts.
 */

export const INSTAGRAM_ORIGIN = 'https://www.instagram.com';
/** Public app id the Instagram web client sends with every API call. */
const IG_APP_ID = '936619743392459';

export const MIN_PAGE_SIZE = 10;
/** Upper bound we ever ask for. Instagram may still return fewer per page. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/** A 2xx response whose body was not usable data (HTML challenge page, `{status: "fail"}`). */
export const STATUS_SOFT_BLOCK = 0;
/** `fetch` itself rejected: offline, DNS, aborted connection. */
export const STATUS_NETWORK_ERROR = -1;

export interface InstagramClient {
  readonly fetch: typeof fetch;
  readonly csrfToken: () => string | null;
  /**
   * Extra headers Instagram's own web client sends (claim, AJAX revision, ASBD id).
   * Only added to write requests; reads are proven to work without them.
   */
  readonly webClientHeaders?: () => Record<string, string>;
}

export interface IgUser {
  readonly pk: string;
  /** Every id variant Instagram sent (pk, pk_id, id). Used to match the same account across lists. */
  readonly ids: readonly string[];
  readonly username: string;
  readonly fullName: string;
  readonly profilePicUrl: string;
  readonly isPrivate: boolean;
  readonly isVerified: boolean;
  /** `friendship_status.followed_by` when Instagram sent it. Trust `true` only; `false` has been seen stale. */
  readonly followedBy: boolean | null;
}

export interface FailureInfo {
  readonly message: string | null;
  readonly requireLogin: boolean;
  readonly challenge: boolean;
  readonly spam: boolean;
  /** Instagram's "Try Again Later" / feedback_required answer to an action it won't allow right now. */
  readonly actionBlocked: boolean;
}

/** What came back, for diagnostics. Never contains the body itself. */
export interface ResponseInfo {
  readonly contentType: string | null;
  readonly bodyKind: 'json' | 'json-prefixed' | 'html' | 'empty' | 'text';
  readonly bytes: number;
}

export interface ApiResult<T> {
  readonly status: number;
  readonly data: T | null;
  readonly failure: FailureInfo | null;
  /** Absent when the request never got a response (network error). */
  readonly response?: ResponseInfo;
}

/** Response shape facts for diagnostics. Never contains user data. */
export interface ListPageShape {
  readonly topLevelKeys: readonly string[];
  readonly userKeys: readonly string[];
  readonly rawUserCount: number;
  readonly hasNextMaxId: boolean;
  readonly hasMore: boolean | null;
  readonly bigList: boolean | null;
  readonly hasRankToken: boolean;
  readonly usersWithFriendshipStatus: number;
  /** Kind of `next_max_id`: a plain number can be used as an offset to fetch pages in parallel. */
  readonly cursorKind: 'numeric' | 'json' | 'opaque' | null;
  /** True when the numeric cursor equals the number of users on this (first) page. */
  readonly cursorLooksLikeOffset: boolean;
  /** `hidden_following_account_count`: followed accounts Instagram leaves out of the list. */
  readonly hiddenCount: number | null;
  /** `page_size` as Instagram reports it. */
  readonly pageSizeField: number | null;
  readonly shouldLimitFollowers: boolean | null;
  readonly shouldLimitFollowings: boolean | null;
}

export interface ListPage {
  readonly users: readonly IgUser[];
  readonly nextMaxId: string | null;
  /** Ranking token Instagram echoes back; pass it into the next page of the same list. */
  readonly rankToken: string | null;
  readonly shape: ListPageShape;
}

export interface ProfileInfo {
  readonly pk: string;
  readonly username: string | null;
  readonly followerCount: number | null;
  readonly followingCount: number | null;
}

export interface FriendshipFlags {
  readonly following: boolean | null;
  readonly followedBy: boolean | null;
}

export type ListKind = 'following' | 'followers';

interface RawFriendship {
  followed_by?: boolean;
  following?: boolean;
}

export interface RawUser {
  pk?: string | number;
  pk_id?: string | number;
  id?: string | number;
  username?: string;
  full_name?: string;
  profile_pic_url?: string;
  profile_pic_url_hd?: string;
  is_private?: boolean;
  is_verified?: boolean;
  followed_by?: boolean;
  friendship_status?: RawFriendship;
}

export interface RawListResponse {
  users?: RawUser[];
  next_max_id?: string | number | Record<string, unknown> | null;
  has_more?: boolean;
  big_list?: boolean;
  status?: string;
  follow_ranking_token?: string;
  hidden_following_account_count?: number;
  page_size?: number;
  should_limit_list_of_followers?: boolean;
  should_limit_list_of_followings?: boolean;
}

/** Sort orders to try instead of Instagram's default ranking. Unverified: see the probe experiment. */
export type ListOrder = 'date_followed_latest' | 'date_followed_earliest';

export interface ListPageOptions {
  readonly maxId?: string | null;
  readonly rankToken?: string | null;
  readonly count?: number;
  readonly order?: ListOrder | null;
  /** The web app sends `search_surface=follow_list_page`. Default true. */
  readonly searchSurface?: boolean;
}

interface RawFailureBody {
  message?: unknown;
  status?: unknown;
  require_login?: unknown;
  checkpoint_url?: unknown;
  challenge?: unknown;
  spam?: unknown;
  feedback_title?: unknown;
  feedback_required?: unknown;
}

export function clampPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.round(value)));
}

export function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export function collectRawUserIds(raw: RawUser): string[] {
  const ids: string[] = [];
  for (const value of [raw.pk, raw.pk_id, raw.id]) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    const id = String(value);
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

export function parseFollowedBy(raw: RawUser): boolean | null {
  if (typeof raw.friendship_status?.followed_by === 'boolean') {
    return raw.friendship_status.followed_by;
  }
  if (typeof raw.followed_by === 'boolean') {
    return raw.followed_by;
  }
  return null;
}

export function parseRankToken(json: RawListResponse): string | null {
  return typeof json.follow_ranking_token === 'string' ? json.follow_ranking_token : null;
}

/** Cursor for the next page. Object cursors are passed back as JSON; `has_more` without a cursor falls back to the last pk. */
export function parseNextMaxId(json: RawListResponse, lastPk: string | null): string | null {
  const raw = json.next_max_id;
  if (raw !== undefined && raw !== null) {
    if (typeof raw === 'object') {
      try {
        return JSON.stringify(raw);
      } catch {
        return lastPk;
      }
    }
    return String(raw);
  }
  if (json.has_more === true) {
    return lastPk;
  }
  return null;
}

export function normalizeUser(raw: RawUser): IgUser | null {
  const ids = collectRawUserIds(raw);
  const pk = ids[0];
  if (pk === undefined || !raw.username) {
    return null;
  }
  return {
    pk,
    ids,
    username: raw.username,
    fullName: raw.full_name ?? '',
    profilePicUrl: raw.profile_pic_url_hd ?? raw.profile_pic_url ?? '',
    isPrivate: Boolean(raw.is_private),
    isVerified: Boolean(raw.is_verified),
    followedBy: parseFollowedBy(raw),
  };
}

export function describeListShape(json: RawListResponse): ListPageShape {
  const users = Array.isArray(json.users) ? json.users : [];
  const first = users[0];
  const cursor = json.next_max_id;
  const cursorKind: ListPageShape['cursorKind'] =
    cursor === undefined || cursor === null
      ? null
      : typeof cursor === 'object'
        ? 'json'
        : /^\d+$/.test(String(cursor))
          ? 'numeric'
          : 'opaque';
  const numberOrNull = (value: unknown) => (typeof value === 'number' ? value : null);
  const booleanOrNull = (value: unknown) => (typeof value === 'boolean' ? value : null);
  return {
    cursorKind,
    cursorLooksLikeOffset: cursorKind === 'numeric' && Number(cursor) === users.length,
    hiddenCount: numberOrNull(json.hidden_following_account_count),
    pageSizeField: numberOrNull(json.page_size),
    shouldLimitFollowers: booleanOrNull(json.should_limit_list_of_followers),
    shouldLimitFollowings: booleanOrNull(json.should_limit_list_of_followings),
    topLevelKeys: Object.keys(json).sort(),
    userKeys: first && typeof first === 'object' ? Object.keys(first).sort() : [],
    rawUserCount: users.length,
    hasNextMaxId: json.next_max_id !== undefined && json.next_max_id !== null,
    hasMore: typeof json.has_more === 'boolean' ? json.has_more : null,
    bigList: typeof json.big_list === 'boolean' ? json.big_list : null,
    hasRankToken: typeof json.follow_ranking_token === 'string',
    usersWithFriendshipStatus: users.filter(user => user && typeof user.friendship_status === 'object').length,
  };
}

export function parseFailureBody(body: unknown, finalUrl: string): FailureInfo {
  const record: RawFailureBody = body && typeof body === 'object' ? (body as RawFailureBody) : {};
  const message = typeof record.message === 'string' ? record.message : null;
  return {
    message,
    requireLogin: record.require_login === true || finalUrl.includes('/accounts/login'),
    challenge:
      typeof record.checkpoint_url === 'string' ||
      (record.challenge !== undefined && record.challenge !== null) ||
      finalUrl.includes('/challenge'),
    spam: record.spam === true,
    actionBlocked:
      message === 'feedback_required' || record.feedback_required === true || typeof record.feedback_title === 'string',
  };
}

function buildHeaders(client: InstagramClient, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'x-ig-app-id': IG_APP_ID,
    'x-requested-with': 'XMLHttpRequest',
    accept: '*/*',
    ...extra,
  };
  const csrf = client.csrfToken();
  if (csrf) {
    headers['x-csrftoken'] = csrf;
  }
  return headers;
}

/** Meta prefixes some JSON responses with this to block cross-site script inclusion. */
const XSSI_PREFIX = 'for (;;);';

export function parseResponseBody(
  text: string,
  contentType: string | null,
): { body: unknown; info: ResponseInfo } {
  const trimmed = text.trimStart();
  const prefixed = trimmed.startsWith(XSSI_PREFIX);
  const jsonText = prefixed ? trimmed.slice(XSSI_PREFIX.length) : trimmed;
  const bytes = text.length;
  let body: unknown = null;
  let parsed = false;
  try {
    body = JSON.parse(jsonText);
    parsed = true;
  } catch {
    body = null;
  }
  let bodyKind: ResponseInfo['bodyKind'];
  if (parsed) {
    bodyKind = prefixed ? 'json-prefixed' : 'json';
  } else if (trimmed === '') {
    bodyKind = 'empty';
  } else if (trimmed.startsWith('<') || (contentType ?? '').includes('html')) {
    bodyKind = 'html';
  } else {
    bodyKind = 'text';
  }
  return { body, info: { contentType, bodyKind, bytes } };
}

async function requestJson<T>(client: InstagramClient, url: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  let response: Response;
  let text: string;
  try {
    response = await client.fetch(url, { ...init, credentials: 'include' });
    text = await response.text();
  } catch {
    return { status: STATUS_NETWORK_ERROR, data: null, failure: null };
  }

  const { body, info } = parseResponseBody(text, response.headers.get('content-type'));
  const finalUrl = response.url || url;

  if (!isOkStatus(response.status)) {
    return { status: response.status, data: null, failure: parseFailureBody(body, finalUrl), response: info };
  }
  // A 2xx that is HTML (login/challenge page) or an explicit `status: "fail"` is not data.
  if (body === null || typeof body !== 'object' || (body as { status?: unknown }).status === 'fail') {
    return { status: STATUS_SOFT_BLOCK, data: null, failure: parseFailureBody(body, finalUrl), response: info };
  }
  return { status: response.status, data: body as T, failure: null, response: info };
}

export async function fetchListPage(
  client: InstagramClient,
  viewerId: string,
  kind: ListKind,
  options: ListPageOptions = {},
): Promise<ApiResult<ListPage>> {
  const url = new URL(`${INSTAGRAM_ORIGIN}/api/v1/friendships/${encodeURIComponent(viewerId)}/${kind}/`);
  url.searchParams.set('count', String(clampPageSize(options.count)));
  if (options.searchSurface !== false) {
    url.searchParams.set('search_surface', 'follow_list_page');
  }
  if (options.order) {
    url.searchParams.set('order', options.order);
  }
  if (options.maxId) {
    url.searchParams.set('max_id', options.maxId);
  }
  if (options.rankToken) {
    url.searchParams.set('rank_token', options.rankToken);
  }

  const result = await requestJson<RawListResponse>(client, url.toString(), { headers: buildHeaders(client) });
  if (result.data === null) {
    return { ...result, data: null };
  }

  const json = result.data;
  const users = (Array.isArray(json.users) ? json.users : [])
    .map(normalizeUser)
    .filter((user): user is IgUser => user !== null);
  const lastPk = users.at(-1)?.pk ?? null;

  return {
    ...result,
    data: {
      users,
      nextMaxId: parseNextMaxId(json, lastPk),
      rankToken: parseRankToken(json),
      shape: describeListShape(json),
    },
  };
}

interface RawProfileResponse {
  user?: {
    pk?: string | number;
    username?: string;
    follower_count?: number;
    following_count?: number;
  };
}

export async function fetchProfile(client: InstagramClient, userId: string): Promise<ApiResult<ProfileInfo>> {
  const result = await requestJson<RawProfileResponse>(
    client,
    `${INSTAGRAM_ORIGIN}/api/v1/users/${encodeURIComponent(userId)}/info/`,
    { headers: buildHeaders(client) },
  );
  const user = result.data?.user;
  if (!user) {
    return { ...result, status: result.data ? STATUS_SOFT_BLOCK : result.status, data: null };
  }
  return {
    ...result,
    data: {
      pk: String(user.pk ?? userId),
      username: typeof user.username === 'string' ? user.username : null,
      followerCount: typeof user.follower_count === 'number' ? user.follower_count : null,
      followingCount: typeof user.following_count === 'number' ? user.following_count : null,
    },
  };
}

interface RawShowManyResponse {
  friendship_statuses?: Record<string, RawFriendship | undefined>;
}

/**
 * Friendship status for up to ~20 accounts in one request. Accounts Instagram
 * returns no entry for (deactivated, deleted, unavailable) are absent from the map.
 */
export async function fetchFriendshipStatuses(
  client: InstagramClient,
  userIds: readonly string[],
): Promise<ApiResult<ReadonlyMap<string, FriendshipFlags>>> {
  const result = await requestJson<RawShowManyResponse>(client, `${INSTAGRAM_ORIGIN}/api/v1/friendships/show_many/`, {
    method: 'POST',
    headers: buildHeaders(client, { 'content-type': 'application/x-www-form-urlencoded' }),
    body: `user_ids=${userIds.map(encodeURIComponent).join(',')}`,
  });
  if (result.data === null) {
    return { ...result, data: null };
  }

  const statuses = new Map<string, FriendshipFlags>();
  for (const [id, raw] of Object.entries(result.data.friendship_statuses ?? {})) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    statuses.set(id, {
      following: typeof raw.following === 'boolean' ? raw.following : null,
      followedBy: typeof raw.followed_by === 'boolean' ? raw.followed_by : null,
    });
  }
  return { ...result, data: statuses };
}

interface RawFriendshipShowResponse extends RawFriendship {
  friendship_status?: RawFriendship;
}

/**
 * Friendship status for one account. Slower than `fetchFriendshipStatuses` (one
 * request per account), so only used when the bulk endpoint is unavailable.
 */
export async function fetchFriendshipStatus(
  client: InstagramClient,
  userId: string,
): Promise<ApiResult<FriendshipFlags>> {
  const result = await requestJson<RawFriendshipShowResponse>(
    client,
    `${INSTAGRAM_ORIGIN}/api/v1/friendships/show/${encodeURIComponent(userId)}/`,
    { headers: buildHeaders(client) },
  );
  if (result.data === null) {
    return { ...result, data: null };
  }
  const source = result.data.friendship_status ?? result.data;
  return {
    ...result,
    data: {
      following: typeof source.following === 'boolean' ? source.following : null,
      followedBy: typeof source.followed_by === 'boolean' ? source.followed_by : null,
    },
  };
}

/** Which unfollow endpoint answered. `destroy` is what the web app uses today; `web` is the older one. */
export type UnfollowEndpoint = 'destroy' | 'web';

export interface UnfollowAnswer {
  readonly endpoint: UnfollowEndpoint;
  /** `friendship_status.following` after the call when Instagram sent it; must not be true. */
  readonly following: boolean | null;
}

interface RawUnfollowResponse {
  status?: string;
  friendship_status?: RawFriendship;
}

/**
 * Unfollows one account. Changes the user's account: only call this for an
 * account the user chose to unfollow.
 */
export async function unfollowUser(
  client: InstagramClient,
  userId: string,
  endpoint: UnfollowEndpoint,
): Promise<ApiResult<UnfollowAnswer>> {
  const id = encodeURIComponent(userId);
  const url =
    endpoint === 'destroy'
      ? `${INSTAGRAM_ORIGIN}/api/v1/friendships/destroy/${id}/`
      : `${INSTAGRAM_ORIGIN}/web/friendships/${id}/unfollow/`;
  const result = await requestJson<RawUnfollowResponse>(client, url, {
    method: 'POST',
    headers: buildHeaders(client, {
      ...client.webClientHeaders?.(),
      'content-type': 'application/x-www-form-urlencoded',
    }),
    body: endpoint === 'destroy' ? `user_id=${id}&container_module=profile` : '',
  });
  if (result.data === null) {
    return { ...result, data: null };
  }
  const following = result.data.friendship_status?.following;
  return { ...result, data: { endpoint, following: typeof following === 'boolean' ? following : null } };
}
