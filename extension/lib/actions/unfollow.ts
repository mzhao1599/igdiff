/**
 * Unfollows a user-chosen list of accounts, one at a time, slowly.
 *
 * This changes the user's account, so it is deliberately conservative:
 *   - only the accounts passed in, never more than `maxUnfollows`;
 *   - ~15-35 s between unfollows and a 5-minute pause after every 10;
 *   - the first sign that Instagram objects (action block, 429, "please wait",
 *     a sign-in or challenge page) stops the whole run;
 *   - an account that no longer exists is skipped, not retried.
 *
 * Success requires a JSON `ok` from Instagram, `following: false` when it
 * reports the friendship state, and then a read-only friendship check showing
 * the follow is really gone. An HTML page with status 200 is never a success.
 *
 * Until one endpoint has worked, any refusal from the current one means "try
 * the other": Instagram has answered the newer endpoint with a bare 404 on a
 * real account. If neither works on the first account, the run stops with both
 * answers and the queue intact rather than skipping through the selection.
 */
import { abortableSleep, classifyFailure, describeStatus } from '../collector/collect';
import {
  fetchFriendshipStatus,
  isOkStatus,
  STATUS_SOFT_BLOCK,
  unfollowUser,
  type ApiResult,
  type InstagramClient,
  type UnfollowAnswer,
  type UnfollowEndpoint,
} from '../instagram/api';

export interface UnfollowSettings {
  readonly delayMs: number;
  readonly jitterMs: number;
  readonly pauseEvery: number;
  readonly pauseMs: number;
  /** Wait before the single retry after a network error or 5xx. */
  readonly retryAfterMs: number;
  /** Confirm each unfollow with a read-only friendship check. */
  readonly verify: boolean;
}

export const DEFAULT_UNFOLLOW_SETTINGS: UnfollowSettings = {
  delayMs: 15_000,
  jitterMs: 20_000,
  pauseEvery: 10,
  pauseMs: 5 * 60_000,
  retryAfterMs: 10_000,
  verify: true,
};

export type UnfollowItemOutcome = 'unfollowed' | 'not_found' | 'failed';

export interface UnfollowItemResult {
  readonly pk: string;
  readonly outcome: UnfollowItemOutcome;
  readonly detail: string | null;
  readonly at: number;
}

export type UnfollowRunOutcome = 'completed' | 'stopped' | 'blocked' | 'limit' | 'error' | 'no_session';

export interface UnfollowProgress {
  readonly total: number;
  readonly done: number;
  readonly unfollowed: number;
  readonly current: string | null;
  readonly waiting: { readonly reason: 'pacing' | 'pause' | 'retry'; readonly ms: number; readonly endsAt: number } | null;
}

export interface UnfollowRunResult {
  readonly outcome: UnfollowRunOutcome;
  readonly message: string | null;
  readonly results: readonly UnfollowItemResult[];
  /** Accounts not attempted (stopped, blocked or over the limit), in order. */
  readonly remaining: readonly string[];
  readonly endpoint: UnfollowEndpoint | null;
}

export interface UnfollowOptions {
  readonly client: InstagramClient;
  readonly viewerId: string | null;
  readonly pks: readonly string[];
  readonly maxUnfollows: number;
  readonly settings?: Partial<UnfollowSettings>;
  readonly signal?: AbortSignal;
  readonly onItem?: (result: UnfollowItemResult) => void;
  readonly onProgress?: (progress: UnfollowProgress) => void;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

class RunStop extends Error {
  constructor(
    readonly outcome: Exclude<UnfollowRunOutcome, 'completed'>,
    message: string,
  ) {
    super(message);
  }
}

function describeAnswer(endpoint: UnfollowEndpoint, result: ApiResult<UnfollowAnswer>): string {
  const message = result.failure?.message ? ` "${result.failure.message}"` : '';
  const body = result.response ? ` (${result.response.bodyKind})` : '';
  return `${endpoint}: ${describeStatus(result.status)}${message}${body}`;
}

/** The endpoint itself seems to be gone (not this account): HTML app page, empty body, 404/405 without JSON. */
function endpointMissing(result: ApiResult<UnfollowAnswer>): boolean {
  const kind = result.response?.bodyKind;
  const notJson = kind === 'html' || kind === 'empty' || kind === 'text';
  return (
    (result.status === STATUS_SOFT_BLOCK && kind === 'html') ||
    ((result.status === 404 || result.status === 405) && notJson)
  );
}

export async function runUnfollows(options: UnfollowOptions): Promise<UnfollowRunResult> {
  const settings = { ...DEFAULT_UNFOLLOW_SETTINGS, ...options.settings };
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const { client, signal } = options;
  const queue = Array.from(new Set(options.pks));
  const results: UnfollowItemResult[] = [];
  let unfollowed = 0;
  let index = 0;
  let current: string | null = null;
  // Try the endpoint the web app uses today first; once one works, stick with it.
  let endpoint: UnfollowEndpoint = 'destroy';
  let endpointConfirmed = false;

  const emit = (waiting: UnfollowProgress['waiting'] = null) =>
    options.onProgress?.({ total: queue.length, done: results.length, unfollowed, current, waiting });

  const checkStopped = () => {
    if (signal?.aborted) {
      throw new RunStop('stopped', 'Stopped. The accounts not yet unfollowed are still in the queue.');
    }
  };

  const wait = async (reason: 'pacing' | 'pause' | 'retry', ms: number) => {
    emit({ reason, ms, endsAt: now() + ms });
    await sleep(ms, signal);
    checkStopped();
  };

  const record = (pk: string, outcome: UnfollowItemOutcome, detail: string | null) => {
    const item = { pk, outcome, detail, at: now() };
    results.push(item);
    if (outcome === 'unfollowed') {
      unfollowed++;
    }
    options.onItem?.(item);
  };

  /** One account, with endpoint discovery and a single retry on transient errors. */
  async function unfollowOne(pk: string): Promise<void> {
    const tried: string[] = [];
    for (let attempt = 0; ; attempt++) {
      checkStopped();
      const result = await unfollowUser(client, pk, endpoint);

      if (isOkStatus(result.status) && result.data) {
        endpointConfirmed = true;
        if (result.data.following === true) {
          record(pk, 'failed', 'Instagram still reports you follow this account.');
          return;
        }
        if (settings.verify) {
          const check = await fetchFriendshipStatus(client, pk);
          if (check.data?.following === true) {
            record(pk, 'failed', 'Instagram answered ok, but you still follow this account.');
            return;
          }
          record(pk, 'unfollowed', check.data ? null : 'Not double-checked: the friendship check did not answer.');
          return;
        }
        record(pk, 'unfollowed', null);
        return;
      }

      const failure = result.failure;
      const kind = classifyFailure(result.status, failure);
      const detail = describeAnswer(endpoint, result);
      // Hard stops, whichever endpoint answered.
      if (failure?.actionBlocked || failure?.spam) {
        throw new RunStop(
          'blocked',
          `Instagram blocked unfollowing for now${failure.message ? ` ("${failure.message}")` : ''}. Paused for a day.`,
        );
      }
      if (kind === 'auth') {
        throw new RunStop('blocked', 'Instagram asked to sign in again or finish a security check. Unfollowing stopped.');
      }

      // Until an endpoint has worked, a refusal is about the endpoint, not this account.
      if (!endpointConfirmed && (kind === 'fatal' || endpointMissing(result))) {
        tried.push(detail);
        if (endpoint === 'destroy') {
          endpoint = 'web';
          continue;
        }
        endpoint = 'destroy';
        throw new RunStop(
          'error',
          `Instagram didn't accept the unfollow request (${tried.join('; ')}). Nothing was unfollowed; the accounts stay queued.`,
        );
      }

      if (kind === 'throttled') {
        throw new RunStop('blocked', `Instagram asked to slow down (${describeStatus(result.status)}). Paused for a day.`);
      }
      if (kind === 'transient' && attempt === 0) {
        await wait('retry', settings.retryAfterMs);
        continue;
      }
      if (kind === 'transient') {
        throw new RunStop('error', 'Instagram could not be reached. Unfollowing stopped; try again later.');
      }
      // The endpoint works, so this refusal is about this one account (deleted, deactivated, not followed).
      record(pk, result.status === 404 || result.status === 400 ? 'not_found' : 'failed', detail);
      return;
    }
  }

  let outcome: UnfollowRunOutcome = 'completed';
  let message: string | null = null;
  try {
    if (!options.viewerId) {
      throw new RunStop('no_session', 'No signed-in Instagram account in this tab.');
    }
    for (; index < queue.length; index++) {
      checkStopped();
      if (unfollowed >= options.maxUnfollows) {
        throw new RunStop('limit', `Reached today's limit of unfollows. The rest stay queued for tomorrow.`);
      }
      current = queue[index]!;
      emit();
      const before = unfollowed;
      await unfollowOne(current);
      current = null;
      const isLast = index === queue.length - 1;
      if (!isLast && unfollowed > before) {
        if (settings.pauseEvery > 0 && unfollowed % settings.pauseEvery === 0) {
          await wait('pause', settings.pauseMs);
        } else {
          await wait('pacing', settings.delayMs + Math.floor(random() * settings.jitterMs));
        }
      }
    }
    index = queue.length;
  } catch (error) {
    if (error instanceof RunStop) {
      outcome = error.outcome;
      message = error.message;
    } else {
      outcome = 'error';
      message = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  current = null;
  emit();

  const attempted = new Set(results.map(item => item.pk));
  return {
    outcome,
    message,
    results,
    remaining: queue.filter(pk => !attempted.has(pk)),
    endpoint: endpointConfirmed ? endpoint : null,
  };
}
