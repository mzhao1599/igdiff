/**
 * One full, read-only sync of the signed-in account's follow lists.
 *
 * Order matters and is inherited from the legacy scanner, which learned it the
 * hard way: fetch the whole following list, then the whole followers list, and
 * only then classify. Per-account `followed_by` flags are only trusted when
 * they say `true` (Instagram has returned stale `false`), so anything the lists
 * cannot settle goes through one batched `show_many` check at the end.
 *
 * New here: when a baseline (the previous saved snapshot) is supplied, every
 * account that seems to have unfollowed you, or that you seem to have
 * unfollowed, is re-checked with `show_many` before it is reported. A list that
 * silently skipped someone therefore restores them instead of producing a
 * false "unfollowed you" event.
 *
 * Fail-closed: only `outcome === 'completed'` results may be saved. Any
 * throttling, refusal, page cap or stop yields a different outcome.
 */
import {
  fetchFriendshipStatuses,
  fetchListPage,
  fetchProfile,
  isOkStatus,
  STATUS_NETWORK_ERROR,
  STATUS_SOFT_BLOCK,
  type ApiResult,
  type FailureInfo,
  type IgUser,
  type InstagramClient,
  type ListKind,
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
  readonly pageDelayMs: number;
  readonly pageJitterMs: number;
  readonly cooldownEveryPages: number;
  readonly cooldownMs: number;
  readonly cooldownJitterMs: number;
  readonly maxRetries: number;
  /** Base wait after a 429 / "please wait" response. Doubles per retry. */
  readonly throttleBackoffMs: number;
  /** Base wait after a network error or 5xx. Doubles per retry. */
  readonly transientBackoffMs: number;
  readonly backoffMaxMs: number;
  readonly sweepChunkSize: number;
  readonly sweepDelayMs: number;
  readonly followingPageCap: number;
  readonly followersPageCap: number;
}

export const DEFAULT_COLLECTOR_SETTINGS: CollectorSettings = {
  pageSize: 50,
  pageDelayMs: 2000,
  pageJitterMs: 1500,
  cooldownEveryPages: 5,
  cooldownMs: 12000,
  cooldownJitterMs: 4000,
  maxRetries: 3,
  throttleBackoffMs: 120_000,
  transientBackoffMs: 5_000,
  backoffMaxMs: 600_000,
  sweepChunkSize: 20,
  sweepDelayMs: 800,
  followingPageCap: 1000,
  followersPageCap: 2000,
};

export interface Baseline {
  readonly followerIds: readonly string[];
  readonly followingIds: readonly string[];
}

export type CollectionPhase = 'profile' | 'following' | 'followers' | 'verifying' | 'done';

export interface CollectionProgress {
  readonly phase: CollectionPhase;
  readonly following: number;
  readonly followers: number;
  readonly reportedFollowing: number | null;
  readonly reportedFollowers: number | null;
  readonly requests: number;
  readonly lastStatus: number | null;
  readonly waiting: { readonly reason: 'pacing' | 'cooldown' | 'backoff'; readonly ms: number; readonly attempt: number } | null;
}

export interface CollectionStats {
  requests: number;
  followingPages: number;
  followersPages: number;
  retries: number;
  /** Size of the followers list exactly as Instagram paginated it. */
  listedFollowers: number;
  /** Following accounts missing from the followers list but flagged `followed_by: true`. */
  confirmedByListFlag: number;
  /** Following accounts missing from the followers list that show_many confirmed follow you. */
  confirmedBySweep: number;
  /** Baseline followers missing from this list that show_many says still follow you. */
  restoredFollowers: number;
  /** Baseline following missing from this list that show_many says you still follow. */
  restoredFollowing: number;
  sweepChecked: number;
  cursorRepeated: boolean;
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

export async function collect(options: CollectorOptions): Promise<CollectionResult> {
  const settings: CollectorSettings = { ...DEFAULT_COLLECTOR_SETTINGS, ...options.settings };
  const { client, signal } = options;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const viewerId = options.viewerId;

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
    confirmedByListFlag: 0,
    confirmedBySweep: 0,
    restoredFollowers: 0,
    restoredFollowing: 0,
    sweepChecked: 0,
    cursorRepeated: false,
  };

  let phase: CollectionPhase = 'profile';
  let reportedFollowers: number | null = null;
  let reportedFollowing: number | null = null;
  let viewerUsername: string | null = null;
  let lastStatus: number | null = null;
  let totalPages = 0;

  const emit = (waiting: CollectionProgress['waiting'] = null) => {
    options.onProgress?.({
      phase,
      following: followingByPk.size,
      followers: followersByPk.size,
      reportedFollowing,
      reportedFollowers,
      requests: stats.requests,
      lastStatus,
      waiting,
    });
  };

  const checkStopped = () => {
    if (signal?.aborted) {
      throw new CollectionStop('stopped', 'Stopped before finishing. Nothing was saved.');
    }
  };

  const wait = async (reason: 'pacing' | 'cooldown' | 'backoff', ms: number, attempt = 0) => {
    emit({ reason, ms, attempt });
    await sleep(ms, signal);
    checkStopped();
  };

  async function request<T>(label: string, attemptOnce: () => Promise<ApiResult<T>>): Promise<T> {
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
          `Instagram refused ${label} (HTTP ${result.status})${detail}. Open Instagram, sign in or finish any security check, then try again.`,
        );
      }
      if (kind === 'fatal') {
        throw new CollectionStop('error', `Instagram returned HTTP ${result.status} for ${label}${detail}.`);
      }

      attempt++;
      stats.retries++;
      if (attempt > settings.maxRetries) {
        throw new CollectionStop(
          kind === 'throttled' ? 'rate_limited' : 'error',
          kind === 'throttled'
            ? `Instagram kept rate-limiting ${label}${detail}. Try again later; nothing was saved.`
            : `${label} kept failing (last status ${result.status}). Nothing was saved.`,
        );
      }
      const base = kind === 'throttled' ? settings.throttleBackoffMs : settings.transientBackoffMs;
      await wait('backoff', backoffMs(attempt, base, settings.backoffMaxMs, random), attempt);
    }
  }

  async function pace() {
    totalPages++;
    await wait('pacing', settings.pageDelayMs + Math.floor(random() * settings.pageJitterMs));
    if (settings.cooldownEveryPages > 0 && totalPages % settings.cooldownEveryPages === 0) {
      const jitter = Math.floor((random() * 2 - 1) * settings.cooldownJitterMs);
      await wait('cooldown', Math.max(0, settings.cooldownMs + jitter));
    }
  }

  async function paginate(id: string, kind: ListKind, into: Map<string, IgUser>, reportedTotal: number | null) {
    const cap = kind === 'following' ? settings.followingPageCap : settings.followersPageCap;
    let maxId: string | null = null;
    let rankToken: string | null = null;
    for (let page = 0; ; ) {
      const result = await request(`the ${kind} list`, () =>
        fetchListPage(client, id, kind, { maxId, rankToken, count: settings.pageSize }),
      );
      if (kind === 'following') {
        stats.followingPages++;
      } else {
        stats.followersPages++;
      }

      if (page === 0 && result.users.length === 0 && reportedTotal !== null && reportedTotal > 0) {
        // Issue #5 in the legacy repo: 200 OK, real count elsewhere, zero rows here.
        throw new CollectionStop(
          'blocked',
          `Instagram returned an empty ${kind} list although your profile shows ${reportedTotal}. Nothing was saved.`,
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

  async function sweep(ids: readonly string[]): Promise<Map<string, { following: boolean | null; followedBy: boolean | null }>> {
    const statuses = new Map<string, { following: boolean | null; followedBy: boolean | null }>();
    for (let i = 0; i < ids.length; i += settings.sweepChunkSize) {
      const chunk = ids.slice(i, i + settings.sweepChunkSize);
      const result = await request('the friendship check', () => fetchFriendshipStatuses(client, chunk));
      result.forEach((flags, id) => statuses.set(id, flags));
      stats.sweepChecked += chunk.length;
      emit();
      if (i + settings.sweepChunkSize < ids.length) {
        await wait('pacing', settings.sweepDelayMs + Math.floor(random() * settings.sweepDelayMs));
      }
    }
    return statuses;
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
        `Instagram refused the profile request (HTTP ${profile.status}). Sign in again or finish any security check.`,
      );
    }

    phase = 'following';
    await paginate(viewerId, 'following', followingByPk, reportedFollowing);
    await pace();

    phase = 'followers';
    await paginate(viewerId, 'followers', followersByPk, reportedFollowers);
    stats.listedFollowers = followersByPk.size;

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

    const lostCandidates = (options.baseline?.followerIds ?? []).filter(id => !followerIds.has(id));
    const removedCandidates = (options.baseline?.followingIds ?? []).filter(id => !followingIds.has(id));
    const toCheck = Array.from(new Set([...notFollowingBackCandidates, ...lostCandidates, ...removedCandidates]));
    const statuses = toCheck.length > 0 ? await sweep(toCheck) : new Map();

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
