/**
 * Daily unfollow limit and the pause after Instagram blocks the action. Pure.
 *
 * Instagram doesn't publish limits; action blocks are what it does when an
 * account unfollows too much too fast, and they get longer if ignored. These
 * numbers stay well under what is commonly reported for established accounts.
 */
import { dayKey, startOfNextDay } from '../scheduler/policy';

export const DAILY_UNFOLLOW_LIMIT = 100;
/** After an action block, no unfollows for this long. */
export const BLOCK_COOLDOWN_MS = 24 * 3_600_000;

export interface UnfollowLedger {
  /** Local calendar day the count belongs to, YYYY-MM-DD. */
  readonly day: string;
  readonly count: number;
  readonly blockedUntil: number | null;
}

export function unfollowsToday(ledger: UnfollowLedger | null | undefined, now: number): number {
  return ledger && ledger.day === dayKey(now) ? ledger.count : 0;
}

export function recordUnfollows(ledger: UnfollowLedger | null | undefined, count: number, now: number): UnfollowLedger {
  return {
    day: dayKey(now),
    count: unfollowsToday(ledger, now) + Math.max(0, count),
    blockedUntil: ledger?.blockedUntil ?? null,
  };
}

export function recordBlock(ledger: UnfollowLedger | null | undefined, now: number): UnfollowLedger {
  return { day: dayKey(now), count: unfollowsToday(ledger, now), blockedUntil: now + BLOCK_COOLDOWN_MS };
}

export type UnfollowAllowance =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly reason: 'blocked' | 'daily_limit'; readonly until: number };

export function unfollowAllowance(
  ledger: UnfollowLedger | null | undefined,
  now: number,
  limit: number = DAILY_UNFOLLOW_LIMIT,
): UnfollowAllowance {
  if (ledger?.blockedUntil && now < ledger.blockedUntil) {
    return { allowed: false, reason: 'blocked', until: ledger.blockedUntil };
  }
  const remaining = Math.max(0, limit - unfollowsToday(ledger, now));
  return remaining > 0 ? { allowed: true, remaining } : { allowed: false, reason: 'daily_limit', until: startOfNextDay(now) };
}
