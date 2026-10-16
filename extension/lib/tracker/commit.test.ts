import { describe, expect, it } from 'vitest';
import { makeResult } from '../testing/fixtures';
import { planCommit } from './commit';

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => String(from + i));

describe('planCommit', () => {
  it('rejects anything that did not complete', () => {
    for (const outcome of ['partial', 'rate_limited', 'blocked', 'error', 'stopped', 'no_session'] as const) {
      const plan = planCommit(null, makeResult({ outcome, followerIds: ['1'] }));
      expect(plan.kind).toBe('rejected');
    }
  });

  it('rejects a result without a viewer', () => {
    expect(planCommit(null, makeResult({ viewerId: null })).kind).toBe('rejected');
  });

  it('saves the first sync as a baseline with no events', () => {
    const plan = planCommit(null, makeResult({ followerIds: ['1'], followingIds: ['2'] }));
    expect(plan).toMatchObject({ kind: 'accepted', baseline: true, diff: null, events: [] });
  });

  it('turns the diff into events, carrying the show_many verdict on losses', () => {
    const plan = planCommit(
      { followerIds: ['1', '2', '3'], followingIds: ['a', 'b'] },
      makeResult({
        followerIds: ['3', '4'],
        followingIds: ['b', 'c'],
        lostFollowerChecks: { '1': 'confirmed', '2': 'unconfirmed' },
        removedFollowingChecks: { a: 'confirmed' },
      }),
    );
    expect(plan.kind).toBe('accepted');
    if (plan.kind !== 'accepted') {
      return;
    }
    expect(plan.baseline).toBe(false);
    expect(plan.events).toEqual([
      { type: 'follower_gained', pk: '4' },
      { type: 'follower_lost', pk: '1', verification: 'confirmed' },
      { type: 'follower_lost', pk: '2', verification: 'unconfirmed' },
      { type: 'following_added', pk: 'c' },
      { type: 'following_removed', pk: 'a', verification: 'confirmed' },
    ]);
  });

  it('treats a loss the collector never checked as unconfirmed', () => {
    const plan = planCommit({ followerIds: ['1'], followingIds: [] }, makeResult({ followerIds: [] }));
    expect(plan.kind === 'accepted' && plan.events[0]).toEqual({
      type: 'follower_lost',
      pk: '1',
      verification: 'unconfirmed',
    });
  });

  it('rejects a mass disappearance of followers that show_many did not confirm', () => {
    const previous = { followerIds: range(0, 1000), followingIds: [] };
    const plan = planCommit(previous, makeResult({ followerIds: range(0, 700) }));
    expect(plan).toMatchObject({ kind: 'rejected', reason: 'suspicious_change' });
  });

  it('accepts a large drop when show_many confirmed each loss', () => {
    const previous = { followerIds: range(0, 1000), followingIds: [] };
    const lost = range(700, 1000);
    const plan = planCommit(
      previous,
      makeResult({
        followerIds: range(0, 700),
        lostFollowerChecks: Object.fromEntries(lost.map(id => [id, 'confirmed' as const])),
      }),
    );
    expect(plan.kind).toBe('accepted');
  });

  it('does not trip the guard on small accounts with a few unconfirmed losses', () => {
    const plan = planCommit({ followerIds: range(0, 30), followingIds: [] }, makeResult({ followerIds: range(0, 10) }));
    expect(plan.kind).toBe('accepted');
  });

  it('applies the same guard to follows that vanished', () => {
    const plan = planCommit(
      { followerIds: [], followingIds: range(0, 500) },
      makeResult({ followingIds: range(0, 100) }),
    );
    expect(plan).toMatchObject({ kind: 'rejected', reason: 'suspicious_change' });
  });
});
