import { describe, expect, it } from 'vitest';
import {
  addToBudget,
  AUTO_SYNC_INTERVAL_MS,
  budgetUsedToday,
  CHECKPOINT_MAX_AGE_MS,
  dayKey,
  decideAutoSync,
  decideManualSync,
  isLeaseAlive,
  keepCheckpointAfter,
  LEASE_TIMEOUT_MS,
  RETRY_AFTER_MS,
  startOfNextDay,
  type AutoSyncInput,
} from './policy';

const NOW = new Date(2026, 9, 16, 14, 0, 0).getTime();
const HOUR = 3_600_000;

function input(patch: Partial<AutoSyncInput> = {}): AutoSyncInput {
  return {
    now: NOW,
    enabled: true,
    leaseAlive: false,
    lastSyncAt: NOW - AUTO_SYNC_INTERVAL_MS - 1,
    lastAttempt: null,
    checkpointUpdatedAt: null,
    budgetUsed: 0,
    dailyBudget: 600,
    estimate: 50,
    ...patch,
  };
}

describe('decideAutoSync', () => {
  it('starts when the last sync is a day old, with the remaining budget as the cap', () => {
    expect(decideAutoSync(input({ budgetUsed: 100 }))).toEqual({ action: 'start', maxRequests: 500 });
  });

  it('starts right away for an account that has never synced', () => {
    expect(decideAutoSync(input({ lastSyncAt: null })).action).toBe('start');
  });

  it('waits until a day has passed since the last saved sync', () => {
    const lastSyncAt = NOW - 2 * HOUR;
    expect(decideAutoSync(input({ lastSyncAt }))).toEqual({
      action: 'wait',
      reason: 'fresh',
      until: lastSyncAt + AUTO_SYNC_INTERVAL_MS,
    });
  });

  it('does nothing when switched off or while another sync runs', () => {
    expect(decideAutoSync(input({ enabled: false }))).toMatchObject({ action: 'wait', reason: 'disabled' });
    expect(decideAutoSync(input({ leaseAlive: true }))).toMatchObject({ action: 'wait', reason: 'running' });
  });

  it('resumes a recent interrupted sync before anything else, even if a sync is not due', () => {
    expect(decideAutoSync(input({ lastSyncAt: NOW - HOUR, checkpointUpdatedAt: NOW - HOUR }))).toEqual({
      action: 'resume',
      maxRequests: 600,
    });
  });

  it('starts over instead of resuming a checkpoint that is too old', () => {
    expect(decideAutoSync(input({ checkpointUpdatedAt: NOW - CHECKPOINT_MAX_AGE_MS - 1 })).action).toBe('start');
  });

  it('backs off after a failure for that failure’s wait', () => {
    const at = NOW - HOUR;
    expect(decideAutoSync(input({ lastAttempt: { at, outcome: 'rate_limited' } }))).toEqual({
      action: 'wait',
      reason: 'backoff',
      until: at + RETRY_AFTER_MS.rate_limited,
    });
    expect(decideAutoSync(input({ lastAttempt: { at: NOW - 3 * HOUR, outcome: 'error' } })).action).toBe('start');
  });

  it('does not back off after an interruption', () => {
    expect(decideAutoSync(input({ lastAttempt: { at: NOW - 60_000, outcome: 'interrupted' } })).action).toBe('start');
  });

  it('waits for tomorrow when the remaining budget does not cover a typical sync', () => {
    expect(decideAutoSync(input({ budgetUsed: 580, estimate: 50 }))).toEqual({
      action: 'wait',
      reason: 'budget',
      until: startOfNextDay(NOW),
    });
  });

  it('only resumes while some budget is left', () => {
    expect(decideAutoSync(input({ checkpointUpdatedAt: NOW, budgetUsed: 600 }))).toMatchObject({
      action: 'wait',
      reason: 'budget',
    });
  });

  it('can ignore the schedule for testing, but never the lease or budget', () => {
    expect(decideAutoSync(input({ lastSyncAt: NOW, ignoreSchedule: true })).action).toBe('start');
    expect(
      decideAutoSync(input({ lastAttempt: { at: NOW, outcome: 'blocked' }, ignoreSchedule: true })).action,
    ).toBe('start');
    expect(decideAutoSync(input({ leaseAlive: true, ignoreSchedule: true })).action).toBe('wait');
    expect(decideAutoSync(input({ budgetUsed: 600, ignoreSchedule: true })).action).toBe('wait');
  });
});

describe('decideManualSync', () => {
  const manual = (patch: Partial<AutoSyncInput> = {}) => {
    const { now, leaseAlive, checkpointUpdatedAt, budgetUsed, dailyBudget } = input(patch);
    return decideManualSync({ now, leaseAlive, checkpointUpdatedAt, budgetUsed, dailyBudget });
  };

  it('ignores the schedule but respects the lease and budget', () => {
    expect(manual()).toEqual({ action: 'start', maxRequests: 600 });
    expect(manual({ leaseAlive: true }).action).toBe('wait');
    expect(manual({ budgetUsed: 600 })).toMatchObject({ action: 'wait', reason: 'budget' });
    expect(manual({ checkpointUpdatedAt: NOW }).action).toBe('resume');
  });
});

describe('budget', () => {
  it('counts per local day and resets the next day', () => {
    const today = addToBudget(null, 40, NOW);
    expect(today).toEqual({ day: dayKey(NOW), used: 40 });
    expect(addToBudget(today, 10, NOW).used).toBe(50);
    const tomorrow = startOfNextDay(NOW) + 1;
    expect(budgetUsedToday(today, tomorrow)).toBe(0);
    expect(addToBudget(today, 5, tomorrow)).toEqual({ day: dayKey(tomorrow), used: 5 });
  });
});

describe('lease and checkpoints', () => {
  const lease = { runId: 'r', tabId: 1, viewerId: 'v', mode: 'auto' as const, startedAt: NOW, heartbeatAt: NOW, accountedRequests: 0 };

  it('treats a lease without recent heartbeats as dead', () => {
    expect(isLeaseAlive(lease, NOW + LEASE_TIMEOUT_MS - 1)).toBe(true);
    expect(isLeaseAlive(lease, NOW + LEASE_TIMEOUT_MS)).toBe(false);
    expect(isLeaseAlive(null, NOW)).toBe(false);
  });

  it('keeps a checkpoint only for outcomes worth resuming', () => {
    expect(keepCheckpointAfter('rate_limited')).toBe(true);
    expect(keepCheckpointAfter('budget')).toBe(true);
    for (const outcome of ['completed', 'stopped', 'blocked', 'error', 'partial', 'no_session'] as const) {
      expect(keepCheckpointAfter(outcome)).toBe(false);
    }
  });
});
