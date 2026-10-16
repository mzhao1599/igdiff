/**
 * One full, read-only sync of the signed-in account's follow lists.
 *
 * Both lists are downloaded completely before anything is classified (the
 * legacy scanner learned that classifying page by page is unsafe). They are
 * fetched side by side and requested sorted by date followed: on a real account
 * that returned the whole following list in one response, while the default
 * ranking reshuffles between pages and silently skips accounts. If Instagram
 * refuses the sort, the list falls back to default paging. Pacing only kicks in
 * once Instagram pushes back with a 429.
 *
 * Per-account `followed_by` flags are only trusted when they say `true`
 * (Instagram has returned stale `false`), so accounts the lists cannot settle
 * get one batched `show_many` check. When a baseline (the previous saved
 * snapshot) is supplied, every account that seems to have unfollowed you, or
 * that you seem to have unfollowed, is re-checked the same way before it is
 * reported. Those checks are best effort: if Instagram refuses them, the sync
 * still completes and the changes are recorded as `unconfirmed`.
 *
 * Fail-closed: only `outcome === 'completed'` results may be saved. Throttling
 * on the lists themselves, a sign-in or challenge page, a page cap, a stop, or
 * an empty list where data was expected yields a different outcome.
 */
import {
  fetchFriendshipStatus,
  fetchFriendshipStatuses,
  fetchListPage,
  fetchProfile,
  isOkStatus,
  STATUS_NETWORK_ERROR,
  STATUS_SOFT_BLOCK,
  type ApiResult,
  type FailureInfo,
  type FriendshipFlags,
  type IgUser,
  type InstagramClient,
  type ListKind,
  type ListOrder,
} from '../instagram/api';

export type CollectionOutcome =
  | 'completed'
  | 'partial'
  | 'rate_limited'
  | 'blocked'
  | 'error'
  | 'no_session'
  | 'stopped';

export type Verification = 'confirmed' | 'unconfirmed';

export interface CollectorSettings {
  readonly pageSize: number;
  /** Fixed wait between pages. 0 = back to back, like Instagram's own client. */
  readonly pageDelayMs: number;
  /** Random extra wait per page so requests are not perfectly periodic. */
  readonly pageJitterMs: number;
  /** Extra pause every N pages. 0 disables it. */
  readonly cooldownEveryPages: number;
  readonly cooldownMs: number;
  readonly cooldownJitterMs: number;
  readonly maxRetries: number;
  /** Base wait after a 429 / "please wait" response. Doubles per retry. */
  readonly throttleBackoffMs: number;
  /** Base wait after a network error or 5xx. Doubles per retry. */
  readonly transientBackoffMs: number;
  readonly backoffMaxMs: number;
  /** After Instagram throttles once, every later page waits at least this long (doubling, capped). */
  readonly slowdownAfterThrottleMs: number;
  readonly slowdownMaxMs: number;
  readonly sweepChunkSize: number;
  readonly sweepDelayMs: number;
  /** One-by-one checks used for apparent changes when the bulk check is refused. */
  readonly singleCheckLimit: number;
  readonly singleCheckDelayMs: number;
  readonly followingPageCap: number;
  readonly followersPageCap: number;
  /** Sort to request. Date order is stable while paging; null uses Instagram's default ranking. */
  readonly listOrder: ListOrder | null;
}

export const DEFAULT_COLLECTOR_SETTINGS: CollectorSettings = {
  pageSize: 50,
  pageDelayMs: 0,
  pageJitterMs: 300,
  cooldownEveryPages: 0,
  cooldownMs: 0,
  cooldownJitterMs: 0,
  maxRetries: 3,
  throttleBackoffMs: 60_000,
  transientBackoffMs: 3_000,
  backoffMaxMs: 600_000,
  slowdownAfterThrottleMs: 2_000,
  slowdownMaxMs: 10_000,
  sweepChunkSize: 20,
  sweepDelayMs: 200,
  singleCheckLimit: 50,
  singleCheckDelayMs: 400,
  followingPageCap: 1000,
  followersPageCap: 2000,
  listOrder: 'date_followed_latest',
};

export interface Baseline {
  readonly followerIds: readonly string[];
  readonly followingIds: readonly string[];
}

export type CollectionPhase = 'profile' | 'lists' | 'verifying' | 'done';

export interface CollectionProgress {
  readonly phase: CollectionPhase;
  readonly startedAt: number;
  readonly following: number;
  readonly followers: number;
  readonly reportedFollowing: number | null;
  readonly reportedFollowers: number | null;
  /** Accounts checked / to check in the verifying phase. */
  readonly checked: number;
  readonly toCheck: number;
  readonly requests: number;
  readonly lastStatus: number | null;
  readonly waiting: {
    readonly reason: 'pacing' | 'cooldown' | 'backoff';
    readonly ms: number;
    readonly attempt: number;
    readonly endsAt: number;
  } | null;
}

export interface CollectionStats {
  requests: number;
  followingPages: number;
  followersPages: number;
  retries: number;
  /** Size of the followers list exactly as Instagram paginated it. */
  listedFollowers: number;
  /** Rows received before removing repeats. More rows than unique accounts means the list shifted while paging. */
  followingRows: number;
  followerRows: number;
  /** `hidden_following_account_count` from the following list: accounts Instagram leaves out of it. */
  hiddenFollowing: number | null;
  /** Following accounts missing from the followers list but flagged `followed_by: true`. */
  confirmedByListFlag: number;
  /** Following accounts missing from the followers list that a friendship check confirmed follow you. */
  confirmedBySweep: number;
  /** Baseline followers missing from this list that a friendship check says still follow you. */
  restoredFollowers: number;
  /** Baseline following missing from this list that a friendship check says you still follow. */
  restoredFollowing: number;
  sweepChecked: number;
  singleChecks: number;
  cursorRepeated: boolean;
  /** The profile endpoint refused, so Instagram's own follower/following counts are unknown. */
  profileUnavailable: boolean;
  /** show_many refused; apparent changes fell back to one-by-one checks or stayed unconfirmed. */
  bulkCheckUnavailable: boolean;
  /** The one-by-one fallback was refused too (or hit its limit). */
  singleCheckUnavailable: boolean;
  /** Sort order the lists were requested in. */
  listOrder: ListOrder | null;
  /** Lists whose sorted request was refused and that were paged in default order instead. */
  orderFallback: ListKind[];
}

export interface CollectionResult {
  readonly outcome: CollectionOutcome;
  readonly message: string | null;
  readonly viewerId: string | null;
  readonly viewerUsername: string | null;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly reportedFollowers: number | null;
  readonly reportedFollowing: number | null;
  /** Every profile seen in either list, deduplicated by pk. */
  readonly users: readonly IgUser[];
  readonly followerIds: readonly string[];
  readonly followingIds: readonly string[];
  readonly lostFollowerChecks: Readonly<Record<string, Verification>>;
  readonly removedFollowingChecks: Readonly<Record<string, Verification>>;
  readonly stats: CollectionStats;
}

export interface CollectorOptions {
  readonly client: InstagramClient;
  readonly viewerId: string | null;
  readonly baseline?: Baseline | null;
  readonly settings?: Partial<CollectorSettings>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CollectionProgress) => void;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

export type FailureKind = 'throttled' | 'transient' | 'auth' | 'fatal';

export function classifyFailure(status: number, failure: FailureInfo | null): FailureKind {
  if (failure?.requireLogin || failure?.challenge || status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 429 || status === STATUS_SOFT_BLOCK || failure?.spam || /wait/i.test(failure?.message ?? '')) {
    return 'throttled';
  }
  if (status === STATUS_NETWORK_ERROR || status >= 500) {
    return 'transient';
  }
  return 'fatal';
}

/** Human wording for a status, including the two pseudo-statuses. */
export function describeStatus(status: number): string {
  if (status === STATUS_SOFT_BLOCK) {
    return 'a page instead of data';
  }
  if (status === STATUS_NETWORK_ERROR) {
    return 'a network error';
  }
  return `HTTP ${status}`;
}

export function backoffMs(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const capped = Math.min(maxMs, baseMs * 2 ** (Math.max(1, attempt) - 1));
  return capped + Math.floor(random() * capped * 0.2);
}

/** Resolves after `ms`, or early (without throwing) when `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

class CollectionStop extends Error {
  constructor(
    readonly outcome: Exclude<CollectionOutcome, 'completed'>,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Maps every id variant and lowercased username of `users` to that user's pk.
 * Lets the same account match across lists when Instagram sent different id
 * schemes (pk vs graph id) in each.
 */
function buildIdentityIndex(users: Iterable<IgUser>): Map<string, string> {
  const index = new Map<string, string>();
  for (const user of users) {
    for (const id of user.ids) {
      index.set(id, user.pk);
    }
    index.set(`@${user.username.toLowerCase()}`, user.pk);
  }
  return index;
}

function findIdentity(index: ReadonlyMap<string, string>, user: IgUser): string | null {
  for (const id of user.ids) {
    const match = index.get(id);
    if (match !== undefined) {
      return match;
    }
  }
  return index.get(`@${user.username.toLowerCase()}`) ?? null;
}

interface ExpectedSize {
  readonly count: number;
  readonly source: 'profile' | 'snapshot';
}

export async function collect(options: CollectorOptions): Promise<CollectionResult> {
  const settings: CollectorSettings = { ...DEFAULT_COLLECTOR_SETTINGS, ...options.settings };
  const { client } = options;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const viewerId = options.viewerId;
  const baseline = options.baseline ?? null;

  // Aborted by the caller (Stop) or internally when one list fails and the other must stop too.
  const internal = new AbortController();
  const onExternalAbort = () => internal.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (options.signal?.aborted) {
    internal.abort();
  }

  const startedAt = now();
  const followingByPk = new Map<string, IgUser>();
  const followersByPk = new Map<string, IgUser>();
  const followerIds = new Set<string>();
  const followingIds = new Set<string>();
  const lostFollowerChecks: Record<string, Verification> = {};
  const removedFollowingChecks: Record<string, Verification> = {};
  const stats: CollectionStats = {
    requests: 0,
    followingPages: 0,
    followersPages: 0,
    retries: 0,
    listedFollowers: 0,
    followingRows: 0,
    followerRows: 0,
    hiddenFollowing: null,
    confirmedByListFlag: 0,
    confirmedBySweep: 0,
    restoredFollowers: 0,
    restoredFollowing: 0,
    sweepChecked: 0,
    singleChecks: 0,
    cursorRepeated: false,
    profileUnavailable: false,
    bulkCheckUnavailable: false,
    singleCheckUnavailable: false,
    listOrder: settings.listOrder,
    orderFallback: [],
  };

  let phase: CollectionPhase = 'profile';
  let reportedFollowers: number | null = null;
  let reportedFollowing: number | null = null;
  let viewerUsername: string | null = null;
  let lastStatus: number | null = null;
  let totalPages = 0;
  let slowdownMs = 0;
  let checked = 0;
  let toCheck = 0;

  const emit = (waiting: CollectionProgress['waiting'] = null) => {
    options.onProgress?.({
      phase,
      startedAt,
      following: followingByPk.size,
      followers: followersByPk.size,
      reportedFollowing,
      reportedFollowers,
      checked,
      toCheck,
      requests: stats.requests,
      lastStatus,
      waiting,
    });
  };

  const checkStopped = () => {
    if (internal.signal.aborted) {
      throw new CollectionStop('stopped', 'Stopped before finishing. Nothing was saved.');
    }
  };

  const wait = async (reason: 'pacing' | 'cooldown' | 'backoff', ms: number, attempt = 0) => {
    if (ms <= 0) {
      checkStopped();
      return;
    }
    emit({ reason, ms, attempt, endsAt: now() + ms });
    await sleep(ms, internal.signal);
    checkStopped();
  };

  const noteThrottled = () => {
    slowdownMs = Math.min(settings.slowdownMaxMs, Math.max(settings.slowdownAfterThrottleMs, slowdownMs * 2));
  };

  /**
   * Runs one request with retries. Required requests throw a CollectionStop when
   * they give up; optional ones (friendship checks) retry once and return null.
   */
  async function request<T>(label: string, attemptOnce: () => Promise<ApiResult<T>>, optional = false): Promise<T | null> {
    for (let attempt = 0; ; ) {
      checkStopped();
      const result = await attemptOnce();
      stats.requests++;
      lastStatus = result.status;
      if (isOkStatus(result.status) && result.data !== null) {
        return result.data;
      }

      const kind = classifyFailure(result.status, result.failure);
      const detail = result.failure?.message ? ` ("${result.failure.message}")` : '';
      if (kind === 'auth') {
        throw new CollectionStop(
          'blocked',
          `Instagram refused ${label} (${describeStatus(result.status)})${detail}. Open Instagram, sign in or finish any security check, then try again.`,
        );
      }
      // An optional endpoint answering with Instagram's HTML app page is gone, not busy: don't retry.
      if (optional && result.status === STATUS_SOFT_BLOCK && result.response?.bodyKind === 'html') {
        return null;
      }
      if (kind === 'throttled') {
        noteThrottled();
      }
      const limit = optional ? 1 : settings.maxRetries;
      if (kind === 'fatal' || attempt >= limit) {
        if (optional) {
          return null;
        }
        if (kind === 'fatal') {
          throw new CollectionStop('error', `Instagram returned ${describeStatus(result.status)} for ${label}${detail}.`);
        }
        throw new CollectionStop(
          kind === 'throttled' ? 'rate_limited' : 'error',
          kind === 'throttled'
            ? `Instagram kept rate-limiting ${label}${detail}. Try again later; nothing was saved.`
            : `${label} kept failing (last: ${describeStatus(result.status)}). Nothing was saved.`,
        );
      }

      attempt++;
      stats.retries++;
      // Optional checks only get one quick retry: a long wait is not worth it for a best-effort step.
      const base = kind === 'throttled' && !optional ? settings.throttleBackoffMs : settings.transientBackoffMs;
      await wait('backoff', backoffMs(attempt, base, settings.backoffMaxMs, random), attempt);
    }
  }

  async function pace() {
    totalPages++;
    await wait('pacing', settings.pageDelayMs + slowdownMs + Math.floor(random() * settings.pageJitterMs));
    if (settings.cooldownEveryPages > 0 && totalPages % settings.cooldownEveryPages === 0) {
      const jitter = Math.floor((random() * 2 - 1) * settings.cooldownJitterMs);
      await wait('cooldown', Math.max(0, settings.cooldownMs + jitter));
    }
  }

  async function paginate(
    id: string,
    kind: ListKind,
    into: Map<string, IgUser>,
    expected: ExpectedSize | null,
    order: ListOrder | null,
  ) {
    const cap = kind === 'following' ? settings.followingPageCap : settings.followersPageCap;
    let maxId: string | null = null;
    let rankToken: string | null = null;
    for (let page = 0; ; ) {
      const result = (await request(`the ${kind} list`, () =>
        fetchListPage(client, id, kind, { maxId, rankToken, count: settings.pageSize, order }),
      ))!;
      if (kind === 'following') {
        stats.followingPages++;
        stats.followingRows += result.users.length;
        stats.hiddenFollowing = result.shape.hiddenCount ?? stats.hiddenFollowing;
      } else {
        stats.followersPages++;
        stats.followerRows += result.users.length;
      }

      if (page === 0 && result.users.length === 0 && expected !== null && expected.count > 0) {
        // Issue #5 in the legacy repo: 200 OK, real count elsewhere, zero rows here.
        throw new CollectionStop(
          'blocked',
          expected.source === 'profile'
            ? `Instagram returned an empty ${kind} list although your profile shows ${expected.count}. Nothing was saved.`
            : `Instagram returned an empty ${kind} list although your last snapshot had ${expected.count}. Nothing was saved.`,
        );
      }
      for (const user of result.users) {
        // Last page wins: Instagram can repeat an account while reordering a long list.
        into.set(user.pk, user);
      }
      rankToken = result.rankToken ?? rankToken;
      emit();

      if (!result.nextMaxId) {
        return;
      }
      if (result.nextMaxId === maxId) {
        stats.cursorRepeated = true;
        return;
      }
      maxId = result.nextMaxId;
      page++;
      if (page >= cap) {
        throw new CollectionStop('partial', `Stopped after ${cap} ${kind} pages, so the list is incomplete. Nothing was saved.`);
      }
      await pace();
    }
  }

  /** Pages one list in the configured order, falling back to default paging if the sort is refused. */
  async function collectList(id: string, kind: ListKind, into: Map<string, IgUser>, expected: ExpectedSize | null) {
    const order = settings.listOrder;
    if (!order) {
      await paginate(id, kind, into, expected, null);
      return;
    }
    try {
      await paginate(id, kind, into, expected, order);
    } catch (error) {
      // Refused outright on the first page (not throttled, not signed out): try the default order.
      if (error instanceof CollectionStop && error.outcome === 'error' && into.size === 0) {
        stats.orderFallback.push(kind);
        await paginate(id, kind, into, expected, null);
        return;
      }
      throw error;
    }
  }

  /** Bulk friendship check. Stops early (and flags it) if Instagram refuses. */
  async function bulkCheck(ids: readonly string[], into: Map<string, FriendshipFlags>) {
    for (let i = 0; i < ids.length; i += settings.sweepChunkSize) {
      const chunk = ids.slice(i, i + settings.sweepChunkSize);
      const result = await request('the bulk friendship check', () => fetchFriendshipStatuses(client, chunk), true);
      if (result === null) {
        stats.bulkCheckUnavailable = true;
        return;
      }
      result.forEach((flags, id) => into.set(id, flags));
      stats.sweepChecked += chunk.length;
      checked += chunk.length;
      emit();
      if (i + settings.sweepChunkSize < ids.length) {
        await wait('pacing', settings.sweepDelayMs + slowdownMs + Math.floor(random() * settings.sweepDelayMs));
      }
    }
  }

  /** One-by-one fallback for the few accounts whose change we must not guess. */
  async function singleChecks(ids: readonly string[], into: Map<string, FriendshipFlags>) {
    const batch = ids.slice(0, settings.singleCheckLimit);
    if (batch.length < ids.length) {
      stats.singleCheckUnavailable = true;
    }
    for (const [index, id] of batch.entries()) {
      checkStopped();
      const result = await fetchFriendshipStatus(client, id);
      stats.requests++;
      lastStatus = result.status;
      checked++;
      if (isOkStatus(result.status) && result.data !== null) {
        into.set(id, result.data);
        stats.singleChecks++;
      } else {
        const kind = classifyFailure(result.status, result.failure);
        if (kind === 'auth') {
          throw new CollectionStop(
            'blocked',
            `Instagram refused the friendship check (${describeStatus(result.status)}). Sign in again or finish any security check.`,
          );
        }
        if (kind === 'throttled' || kind === 'transient') {
          // Out of goodwill for now. Whatever is left stays unconfirmed.
          if (kind === 'throttled') {
            noteThrottled();
          }
          stats.singleCheckUnavailable = true;
          return;
        }
        // 404/400 for this one account (deleted, deactivated): no status, move on.
      }
      emit();
      if (index < batch.length - 1) {
        await wait('pacing', settings.singleCheckDelayMs + slowdownMs + Math.floor(random() * settings.singleCheckDelayMs));
      }
    }
  }

  let outcome: CollectionOutcome = 'completed';
  let message: string | null = null;

  try {
    if (!viewerId) {
      throw new CollectionStop('no_session', 'No signed-in Instagram account found in this tab.');
    }

    // Counts are best-effort: they guard against "200 OK but empty" lists and drive progress.
    emit();
    const profile = await fetchProfile(client, viewerId);
    stats.requests++;
    lastStatus = profile.status;
    if (profile.data) {
      reportedFollowers = profile.data.followerCount;
      reportedFollowing = profile.data.followingCount;
      viewerUsername = profile.data.username;
    } else if (classifyFailure(profile.status, profile.failure) === 'auth') {
      throw new CollectionStop(
        'blocked',
        `Instagram refused the profile request (${describeStatus(profile.status)}). Sign in again or finish any security check.`,
      );
    } else {
      stats.profileUnavailable = true;
    }

    const expected = (reported: number | null, previous: readonly string[] | undefined): ExpectedSize | null => {
      if (reported !== null) {
        return { count: reported, source: 'profile' };
      }
      return previous ? { count: previous.length, source: 'snapshot' } : null;
    };

    phase = 'lists';
    let firstError: unknown = null;
    const lists = [
      collectList(viewerId, 'following', followingByPk, expected(reportedFollowing, baseline?.followingIds)),
      collectList(viewerId, 'followers', followersByPk, expected(reportedFollowers, baseline?.followerIds)),
    ];
    await Promise.all(
      lists.map(run =>
        run.catch(error => {
          // The first real failure wins; the sibling list is stopped and its "stopped" ignored.
          firstError ??= error;
          internal.abort();
        }),
      ),
    );
    if (firstError !== null) {
      throw firstError;
    }
    stats.listedFollowers = followersByPk.size;

    if (
      followingByPk.size === 0 &&
      followersByPk.size === 0 &&
      reportedFollowers === null &&
      reportedFollowing === null &&
      baseline === null
    ) {
      throw new CollectionStop(
        'blocked',
        'Instagram returned two empty lists and no profile counts, so an empty account cannot be told apart from a blocked request. Nothing was saved.',
      );
    }

    phase = 'verifying';
    emit();
    followersByPk.forEach((_user, pk) => followerIds.add(pk));
    followingByPk.forEach((_user, pk) => followingIds.add(pk));

    // Same account under a different id scheme in each list: keep the following-list pk.
    const followerIndex = buildIdentityIndex(followersByPk.values());
    const notFollowingBackCandidates: string[] = [];
    for (const user of followingByPk.values()) {
      if (followerIds.has(user.pk)) {
        continue;
      }
      const match = findIdentity(followerIndex, user);
      if (match !== null) {
        followerIds.delete(match);
        followerIds.add(user.pk);
        continue;
      }
      if (user.followedBy === true) {
        followerIds.add(user.pk);
        stats.confirmedByListFlag++;
        continue;
      }
      notFollowingBackCandidates.push(user.pk);
    }

    const lostCandidates = (baseline?.followerIds ?? []).filter(id => !followerIds.has(id));
    const removedCandidates = (baseline?.followingIds ?? []).filter(id => !followingIds.has(id));
    const changeCandidates = Array.from(new Set([...lostCandidates, ...removedCandidates]));
    // Apparent changes first: they matter most and are usually few.
    const bulkOrder = Array.from(new Set([...changeCandidates, ...notFollowingBackCandidates]));
    const statuses = new Map<string, FriendshipFlags>();
    toCheck = bulkOrder.length;

    if (bulkOrder.length > 0) {
      await bulkCheck(bulkOrder, statuses);
    }
    if (stats.bulkCheckUnavailable) {
      const remaining = changeCandidates.filter(id => !statuses.has(id));
      toCheck = checked + Math.min(remaining.length, settings.singleCheckLimit);
      if (remaining.length > 0) {
        await singleChecks(remaining, statuses);
      }
    }

    for (const pk of notFollowingBackCandidates) {
      if (statuses.get(pk)?.followedBy === true) {
        followerIds.add(pk);
        stats.confirmedBySweep++;
      }
    }
    for (const pk of lostCandidates) {
      const flags = statuses.get(pk);
      if (flags?.followedBy === true) {
        followerIds.add(pk);
        stats.restoredFollowers++;
      } else {
        lostFollowerChecks[pk] = flags?.followedBy === false ? 'confirmed' : 'unconfirmed';
      }
    }
    for (const pk of removedCandidates) {
      const flags = statuses.get(pk);
      if (flags?.following === true) {
        followingIds.add(pk);
        stats.restoredFollowing++;
      } else {
        removedFollowingChecks[pk] = flags?.following === false ? 'confirmed' : 'unconfirmed';
      }
    }
  } catch (error) {
    if (error instanceof CollectionStop) {
      outcome = error.outcome;
      message = error.message;
    } else {
      outcome = 'error';
      message = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    options.signal?.removeEventListener('abort', onExternalAbort);
  }

  const users = new Map<string, IgUser>(followersByPk);
  followingByPk.forEach((user, pk) => users.set(pk, user));
  phase = 'done';
  emit();

  return {
    outcome,
    message,
    viewerId,
    viewerUsername,
    startedAt,
    finishedAt: now(),
    reportedFollowers,
    reportedFollowing,
    users: Array.from(users.values()),
    followerIds: Array.from(followerIds),
    followingIds: Array.from(followingIds),
    lostFollowerChecks,
    removedFollowingChecks,
    stats,
  };
}
