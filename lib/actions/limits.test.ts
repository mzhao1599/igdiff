import { describe, expect, it } from 'vitest';
import { startOfNextDay } from '../scheduler/policy';
import { BLOCK_COOLDOWN_MS, recordBlock, recordUnfollows, unfollowAllowance, unfollowsToday } from './limits';

const NOW = new Date(2026, 9, 16, 15, 0, 0).getTime();

describe('unfollow limits', () => {
  it('allows the daily limit minus what was already done today', () => {
    expect(unfollowAllowance(null, NOW, 100)).toEqual({ allowed: true, remaining: 100 });
    const ledger = recordUnfollows(null, 30, NOW);
    expect(unfollowAllowance(ledger, NOW, 100)).toEqual({ allowed: true, remaining: 70 });
  });

  it('refuses for the rest of the day once the limit is reached', () => {
    const ledger = recordUnfollows(null, 100, NOW);
    expect(unfollowAllowance(ledger, NOW, 100)).toEqual({ allowed: false, reason: 'daily_limit', until: startOfNextDay(NOW) });
    expect(unfollowsToday(ledger, startOfNextDay(NOW) + 1)).toBe(0);
    expect(unfollowAllowance(ledger, startOfNextDay(NOW) + 1, 100).allowed).toBe(true);
  });

  it('pauses for a day after Instagram blocks the action', () => {
    const ledger = recordBlock(recordUnfollows(null, 5, NOW), NOW);
    expect(unfollowAllowance(ledger, NOW + 1)).toEqual({ allowed: false, reason: 'blocked', until: NOW + BLOCK_COOLDOWN_MS });
    expect(unfollowAllowance(ledger, NOW + BLOCK_COOLDOWN_MS).allowed).toBe(true);
    expect(unfollowsToday(ledger, NOW)).toBe(5);
  });
});
