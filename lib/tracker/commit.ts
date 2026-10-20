/**
 * Decides whether a collection result may become a saved snapshot, and which
 * events it produces. Pure: the store applies the plan inside one transaction.
 */
import type { CollectionResult, Verification } from '../collector/collect';
import { diffSnapshots, type FollowSets, type SnapshotDiff } from './diff';

export type TrackerEventType =
  | 'follower_gained'
  | 'follower_lost'
  /** A follower the user removed with IgDiff: not an unfollow by them. */
  | 'follower_removed'
  | 'following_added'
  | 'following_removed';

export interface PlannedEvent {
  readonly type: TrackerEventType;
  readonly pk: string;
  /** Only on losses/removals: did show_many confirm the change, or return nothing for that account? */
  readonly verification?: Verification;
}

export type RejectReason = 'incomplete' | 'no_viewer' | 'suspicious_change';

export type CommitPlan =
  | { readonly kind: 'rejected'; readonly reason: RejectReason; readonly detail: string }
  | {
      readonly kind: 'accepted';
      readonly baseline: boolean;
      readonly sets: FollowSets;
      readonly diff: SnapshotDiff | null;
      readonly events: readonly PlannedEvent[];
    };

export interface CommitGuard {
  /** Unconfirmed losses above max(minimum, ratio × previous size) reject the snapshot. */
  readonly suspiciousMinimum: number;
  readonly suspiciousRatio: number;
}

export const DEFAULT_COMMIT_GUARD: CommitGuard = {
  suspiciousMinimum: 25,
  suspiciousRatio: 0.2,
};

function unconfirmed(ids: readonly string[], checks: Readonly<Record<string, Verification>>): number {
  return ids.filter(id => checks[id] !== 'confirmed').length;
}

function isSuspicious(unconfirmedCount: number, previousSize: number, guard: CommitGuard): boolean {
  return unconfirmedCount > Math.max(guard.suspiciousMinimum, guard.suspiciousRatio * previousSize);
}

/**
 * `removedByYou`: followers the user removed with IgDiff since the previous
 * snapshot. Their disappearance is expected, so it is recorded as "You removed"
 * and never counts as a suspicious loss.
 */
export function planCommit(
  previous: FollowSets | null,
  result: CollectionResult,
  guard: CommitGuard = DEFAULT_COMMIT_GUARD,
  removedByYou: ReadonlySet<string> = new Set(),
): CommitPlan {
  if (result.outcome !== 'completed') {
    return {
      kind: 'rejected',
      reason: 'incomplete',
      detail: `Sync ended with "${result.outcome}"${result.message ? `: ${result.message}` : ''}`,
    };
  }
  if (!result.viewerId) {
    return { kind: 'rejected', reason: 'no_viewer', detail: 'No signed-in account on the result.' };
  }

  const sets: FollowSets = { followerIds: result.followerIds, followingIds: result.followingIds };
  if (!previous) {
    return { kind: 'accepted', baseline: true, sets, diff: null, events: [] };
  }

  const diff = diffSnapshots(previous, sets);

  // Many accounts vanishing at once without show_many confirming it looks like a
  // broken list, not a mass unfollow. Keep the previous snapshot instead.
  const lostUnconfirmed = unconfirmed(
    diff.followersLost.filter(pk => !removedByYou.has(pk)),
    result.lostFollowerChecks,
  );
  if (isSuspicious(lostUnconfirmed, previous.followerIds.length, guard)) {
    return {
      kind: 'rejected',
      reason: 'suspicious_change',
      detail: `${lostUnconfirmed} followers disappeared without confirmation. Kept the previous snapshot.`,
    };
  }
  const removedUnconfirmed = unconfirmed(diff.followingRemoved, result.removedFollowingChecks);
  if (isSuspicious(removedUnconfirmed, previous.followingIds.length, guard)) {
    return {
      kind: 'rejected',
      reason: 'suspicious_change',
      detail: `${removedUnconfirmed} followed accounts disappeared without confirmation. Kept the previous snapshot.`,
    };
  }

  const events: PlannedEvent[] = [
    ...diff.followersGained.map(pk => ({ type: 'follower_gained' as const, pk })),
    ...diff.followersLost.map(pk =>
      removedByYou.has(pk)
        ? { type: 'follower_removed' as const, pk }
        : {
            type: 'follower_lost' as const,
            pk,
            verification: result.lostFollowerChecks[pk] ?? ('unconfirmed' as const),
          },
    ),
    ...diff.followingAdded.map(pk => ({ type: 'following_added' as const, pk })),
    ...diff.followingRemoved.map(pk => ({
      type: 'following_removed' as const,
      pk,
      verification: result.removedFollowingChecks[pk] ?? ('unconfirmed' as const),
    })),
  ];
  return { kind: 'accepted', baseline: false, sets, diff, events };
}
