/**
 * When to sync automatically. Pure functions, no I/O: the background gathers the
 * inputs, asks `decideAutoSync`, and acts on the answer.
 *
 * Rules, in order:
 *   1. Automatic syncing must be on, and no other sync may be running.
 *   2. An interrupted sync whose checkpoint is recent is resumed first.
 *   3. After a failure, wait out that failure's back-off.
 *   4. Otherwise sync once the last saved sync is a day old.
 *   5. Only start if today's remaining request budget covers a typical sync.
 */
import type { CollectionOutcome } from '../collector/collect';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const AUTO_SYNC_INTERVAL_MS = 24 * HOUR;
/** A running sync re-sends progress every 5 s; this long without any means it is gone. */
export const LEASE_TIMEOUT_MS = 60_000;
/** Older checkpoints are dropped: their cursors may be stale and their data too old to mix in. */
export const CHECKPOINT_MAX_AGE_MS = 6 * HOUR;
export const DEFAULT_DAILY_BUDGET = 600;
/** Assumed cost of a sync before one has completed. */
export const DEFAULT_SYNC_ESTIMATE = 150;

export type AttemptOutcome = CollectionOutcome | 'interrupted';

/** How long to wait before trying again automatically after each outcome. */
export const RETRY_AFTER_MS: Readonly<Record<AttemptOutcome, number>> = {
  completed: 0,
  interrupted: 0,
  no_session: 0,
  rate_limited: 6 * HOUR,
  blocked: 6 * HOUR,
  error: 2 * HOUR,
  partial: 2 * HOUR,
  stopped: 12 * HOUR,
  budget: 0, // the budget rule already waits for the next day
};

export interface Attempt {
  readonly at: number;
  readonly outcome: AttemptOutcome;
}

export interface Lease {
  readonly runId: string;
  readonly tabId: number;
  readonly viewerId: string;
  readonly mode: 'auto' | 'manual';
  readonly startedAt: number;
  readonly heartbeatAt: number;
  /** Requests of this run already added to the daily budget. */
  readonly accountedRequests: number;
}

export interface BudgetDay {
  /** Local calendar day, YYYY-MM-DD. */
  readonly day: string;
  readonly used: number;
}

export function dayKey(now: number): string {
  const date = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function startOfNextDay(now: number): number {
  const date = new Date(now);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

export function budgetUsedToday(budget: BudgetDay | null | undefined, now: number): number {
  return budget && budget.day === dayKey(now) ? budget.used : 0;
}

export function addToBudget(budget: BudgetDay | null | undefined, requests: number, now: number): BudgetDay {
  return { day: dayKey(now), used: budgetUsedToday(budget, now) + Math.max(0, requests) };
}

export function isLeaseAlive(lease: Lease | null | undefined, now: number): lease is Lease {
  return !!lease && now - lease.heartbeatAt < LEASE_TIMEOUT_MS;
}

export function isCheckpointFresh(updatedAt: number | null | undefined, now: number): boolean {
  return typeof updatedAt === 'number' && now - updatedAt < CHECKPOINT_MAX_AGE_MS;
}

export interface AutoSyncInput {
  readonly now: number;
  readonly enabled: boolean;
  readonly leaseAlive: boolean;
  readonly lastSyncAt: number | null;
  readonly lastAttempt: Attempt | null;
  readonly checkpointUpdatedAt: number | null;
  readonly budgetUsed: number;
  readonly dailyBudget: number;
  /** Requests the last completed sync took (or the default estimate). */
  readonly estimate: number;
  /** Testing aid: skip the 24-hour wait and the failure back-off. */
  readonly ignoreSchedule?: boolean;
}

export type WaitReason = 'disabled' | 'running' | 'backoff' | 'fresh' | 'budget';

export type AutoSyncDecision =
  | { readonly action: 'start' | 'resume'; readonly maxRequests: number }
  | { readonly action: 'wait'; readonly reason: WaitReason; readonly until: number | null };

export function decideAutoSync(input: AutoSyncInput): AutoSyncDecision {
  const { now } = input;
  if (!input.enabled) {
    return { action: 'wait', reason: 'disabled', until: null };
  }
  if (input.leaseAlive) {
    return { action: 'wait', reason: 'running', until: null };
  }
  const remaining = Math.max(0, input.dailyBudget - input.budgetUsed);

  if (isCheckpointFresh(input.checkpointUpdatedAt, now)) {
    return remaining > 0
      ? { action: 'resume', maxRequests: remaining }
      : { action: 'wait', reason: 'budget', until: startOfNextDay(now) };
  }

  if (!input.ignoreSchedule) {
    const attempt = input.lastAttempt;
    if (attempt) {
      const retryAt = attempt.at + RETRY_AFTER_MS[attempt.outcome];
      if (attempt.outcome !== 'completed' && now < retryAt) {
        return { action: 'wait', reason: 'backoff', until: retryAt };
      }
    }
    if (input.lastSyncAt !== null && now - input.lastSyncAt < AUTO_SYNC_INTERVAL_MS) {
      return { action: 'wait', reason: 'fresh', until: input.lastSyncAt + AUTO_SYNC_INTERVAL_MS };
    }
  }

  if (remaining < input.estimate) {
    return { action: 'wait', reason: 'budget', until: startOfNextDay(now) };
  }
  return { action: 'start', maxRequests: remaining };
}

/** A sync the user asked for: no schedule, but still one at a time and within the budget. */
export function decideManualSync(input: Omit<AutoSyncInput, 'enabled' | 'lastSyncAt' | 'lastAttempt' | 'estimate'>): AutoSyncDecision {
  const { now } = input;
  if (input.leaseAlive) {
    return { action: 'wait', reason: 'running', until: null };
  }
  const remaining = Math.max(0, input.dailyBudget - input.budgetUsed);
  if (remaining <= 0) {
    return { action: 'wait', reason: 'budget', until: startOfNextDay(now) };
  }
  return isCheckpointFresh(input.checkpointUpdatedAt, now)
    ? { action: 'resume', maxRequests: remaining }
    : { action: 'start', maxRequests: remaining };
}

/** What to do with an interrupted run's checkpoint after a run ends this way. */
export function keepCheckpointAfter(outcome: CollectionOutcome): boolean {
  return outcome === 'rate_limited' || outcome === 'budget';
}
