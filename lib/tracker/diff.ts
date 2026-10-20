/**
 * Pure set arithmetic over follower/following id lists. No I/O.
 */

export interface FollowSets {
  readonly followerIds: readonly string[];
  readonly followingIds: readonly string[];
}

export interface Relationships {
  /** You follow them and they follow you. */
  readonly mutuals: readonly string[];
  /** You follow them; they don't follow you. */
  readonly notFollowingBack: readonly string[];
  /** They follow you; you don't follow them. */
  readonly fans: readonly string[];
}

export interface SnapshotDiff {
  readonly followersGained: readonly string[];
  readonly followersLost: readonly string[];
  readonly followingAdded: readonly string[];
  readonly followingRemoved: readonly string[];
}

/** Items of `a` not in `b`, in `a`'s order, without duplicates. */
export function difference(a: readonly string[], b: readonly string[]): string[] {
  const exclude = new Set(b);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of a) {
    if (!exclude.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function computeRelationships(sets: FollowSets): Relationships {
  const followers = new Set(sets.followerIds);
  const following = new Set(sets.followingIds);
  return {
    mutuals: Array.from(following).filter(id => followers.has(id)),
    notFollowingBack: Array.from(following).filter(id => !followers.has(id)),
    fans: Array.from(followers).filter(id => !following.has(id)),
  };
}

export function diffSnapshots(previous: FollowSets, current: FollowSets): SnapshotDiff {
  return {
    followersGained: difference(current.followerIds, previous.followerIds),
    followersLost: difference(previous.followerIds, current.followerIds),
    followingAdded: difference(current.followingIds, previous.followingIds),
    followingRemoved: difference(previous.followingIds, current.followingIds),
  };
}

export function isEmptyDiff(diff: SnapshotDiff): boolean {
  return (
    diff.followersGained.length === 0 &&
    diff.followersLost.length === 0 &&
    diff.followingAdded.length === 0 &&
    diff.followingRemoved.length === 0
  );
}
