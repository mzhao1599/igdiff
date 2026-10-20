import { describe, expect, it } from 'vitest';
import { computeRelationships, difference, diffSnapshots, isEmptyDiff } from './diff';

describe('difference', () => {
  it('keeps order and drops duplicates', () => {
    expect(difference(['3', '1', '3', '2'], ['2'])).toEqual(['3', '1']);
  });
});

describe('computeRelationships', () => {
  it('splits accounts into mutuals, not following back, and fans', () => {
    const rel = computeRelationships({ followerIds: ['2', '3', '4'], followingIds: ['1', '2', '3'] });
    expect(rel.mutuals).toEqual(['2', '3']);
    expect(rel.notFollowingBack).toEqual(['1']);
    expect(rel.fans).toEqual(['4']);
  });

  it('handles empty lists', () => {
    expect(computeRelationships({ followerIds: [], followingIds: [] })).toEqual({
      mutuals: [],
      notFollowingBack: [],
      fans: [],
    });
  });
});

describe('diffSnapshots', () => {
  it('reports gained and lost followers and added and removed follows', () => {
    const diff = diffSnapshots(
      { followerIds: ['1', '2', '3'], followingIds: ['a', 'b'] },
      { followerIds: ['2', '3', '4'], followingIds: ['b', 'c'] },
    );
    expect(diff).toEqual({
      followersGained: ['4'],
      followersLost: ['1'],
      followingAdded: ['c'],
      followingRemoved: ['a'],
    });
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it('does not count someone you just followed as having unfollowed you', () => {
    // The legacy app reported "new non-follower" as "unfollowed you". Following a
    // new account that doesn't follow back must only show up as a follow you added.
    const diff = diffSnapshots(
      { followerIds: ['1'], followingIds: ['1'] },
      { followerIds: ['1'], followingIds: ['1', 'new'] },
    );
    expect(diff.followersLost).toEqual([]);
    expect(diff.followingAdded).toEqual(['new']);
  });

  it('detects an unfollow by someone you never followed back', () => {
    const diff = diffSnapshots({ followerIds: ['fan'], followingIds: [] }, { followerIds: [], followingIds: [] });
    expect(diff.followersLost).toEqual(['fan']);
  });

  it('is empty when nothing changed', () => {
    const sets = { followerIds: ['1'], followingIds: ['2'] };
    expect(isEmptyDiff(diffSnapshots(sets, sets))).toBe(true);
  });
});
