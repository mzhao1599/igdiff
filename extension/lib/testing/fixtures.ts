/** Shared test builders. Test-only. */
import type { CollectionResult } from '../collector/collect';

export function makeResult(patch: Partial<CollectionResult> = {}): CollectionResult {
  return {
    outcome: 'completed',
    message: null,
    viewerId: '1000',
    viewerUsername: 'me',
    startedAt: 1,
    finishedAt: 2,
    reportedFollowers: null,
    reportedFollowing: null,
    users: [],
    followerIds: [],
    followingIds: [],
    lostFollowerChecks: {},
    removedFollowingChecks: {},
    stats: {
      requests: 0,
      followingPages: 0,
      followersPages: 0,
      retries: 0,
      listedFollowers: 0,
      followingRows: 0,
      followerRows: 0,
      hiddenFollowing: null,
      confirmedByListFlag: 0,
      confirmedBySweep: 0,
      restoredFollowers: 0,
      restoredFollowing: 0,
      sweepChecked: 0,
      singleChecks: 0,
      cursorRepeated: false,
      profileUnavailable: false,
      bulkCheckUnavailable: false,
      singleCheckUnavailable: false,
    },
    ...patch,
  };
}
