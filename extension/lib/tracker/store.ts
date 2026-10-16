/**
 * Local snapshot store in the extension's own IndexedDB (never instagram.com's
 * storage, which Instagram's scripts can read). Everything is scoped by the
 * signed-in account's id so several accounts can share one browser profile.
 *
 * History lives in two places:
 *   - `snapshots` keeps counts and stats for every accepted sync, forever;
 *   - `events` keeps one row per follower gained/lost and follow added/removed.
 * Full id lists are only kept for the newest few snapshots (`snapshotLists`),
 * which is all the next diff needs.
 *
 * A sync in progress is checkpointed in `checkpoints` (cursor and counters per
 * list) and `checkpointUsers` (accounts collected so far), so an interrupted
 * run can continue instead of starting over. Checkpoints are never snapshots.
 */
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type {
  CheckpointDelta,
  CheckpointProfile,
  CollectionResult,
  CollectionStats,
  ListProgress,
  ResumeState,
  Verification,
} from '../collector/collect';
import type { IgUser, ListKind } from '../instagram/api';
import { DEFAULT_COMMIT_GUARD, planCommit, type CommitGuard, type RejectReason, type TrackerEventType } from './commit';
import type { FollowSets } from './diff';

export const DB_NAME = 'follower-tracker';
const DB_VERSION = 2;
/** Snapshots whose full id lists are kept. Older ones keep counts only. */
export const KEEP_LISTS_FOR_SNAPSHOTS = 3;

export interface AccountRecord {
  readonly viewerId: string;
  readonly username: string | null;
  readonly firstSyncAt: number;
  readonly lastSyncAt: number;
  readonly lastSnapshotId: number;
  readonly snapshotCount: number;
}

export interface DiffCounts {
  readonly followersGained: number;
  readonly followersLost: number;
  readonly followersLostConfirmed: number;
  readonly followingAdded: number;
  readonly followingRemoved: number;
}

export interface SnapshotRecord {
  readonly id: number;
  readonly viewerId: string;
  readonly startedAt: number;
  readonly takenAt: number;
  readonly followerCount: number;
  readonly followingCount: number;
  readonly reportedFollowerCount: number | null;
  readonly reportedFollowingCount: number | null;
  readonly baseline: boolean;
  readonly diffCounts: DiffCounts | null;
  readonly stats: CollectionStats;
}

export interface SnapshotListsRecord {
  readonly snapshotId: number;
  readonly viewerId: string;
  readonly followerIds: readonly string[];
  readonly followingIds: readonly string[];
}

export interface ProfileRecord {
  readonly viewerId: string;
  readonly pk: string;
  readonly username: string;
  readonly fullName: string;
  readonly profilePicUrl: string;
  readonly isPrivate: boolean;
  readonly isVerified: boolean;
  readonly lastSeenAt: number;
}

export interface EventRecord {
  readonly id: number;
  readonly viewerId: string;
  readonly type: TrackerEventType;
  readonly pk: string;
  readonly detectedAt: number;
  readonly snapshotId: number;
  readonly verification?: Verification;
}

export type LatestSnapshot = SnapshotRecord & FollowSets;

export type CommitOutcome =
  | {
      readonly status: 'committed';
      readonly snapshotId: number;
      readonly viewerId: string;
      readonly baseline: boolean;
      readonly followerCount: number;
      readonly followingCount: number;
      readonly diffCounts: DiffCounts | null;
    }
  | { readonly status: 'rejected'; readonly reason: RejectReason; readonly detail: string };

export interface AccountExport {
  readonly exportedAt: string;
  readonly account: AccountRecord | null;
  readonly snapshots: readonly SnapshotRecord[];
  readonly latestLists: SnapshotListsRecord | null;
  readonly events: readonly EventRecord[];
  readonly profiles: readonly ProfileRecord[];
}

/** One sync in progress for one account. */
export interface CheckpointRecord {
  readonly viewerId: string;
  readonly runId: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** Requests made across every run of this sync so far. */
  readonly requests: number;
  readonly profile: CheckpointProfile | null;
  readonly following: ListProgress | null;
  readonly followers: ListProgress | null;
}

export interface CheckpointUserRecord {
  readonly viewerId: string;
  readonly list: ListKind;
  readonly pk: string;
  readonly user: IgUser;
}

export interface LoadedCheckpoint {
  readonly record: CheckpointRecord;
  readonly resume: ResumeState;
}

type WithoutId<T extends { id: number }> = Omit<T, 'id'> & { id?: number };

interface TrackerSchema extends DBSchema {
  accounts: { key: string; value: AccountRecord };
  snapshots: { key: number; value: WithoutId<SnapshotRecord>; indexes: { byViewer: [string, number] } };
  snapshotLists: { key: number; value: SnapshotListsRecord; indexes: { byViewer: string } };
  profiles: { key: [string, string]; value: ProfileRecord; indexes: { byViewer: string } };
  events: { key: number; value: WithoutId<EventRecord>; indexes: { byViewer: [string, number] } };
  checkpoints: { key: string; value: CheckpointRecord };
  checkpointUsers: {
    key: [string, string, string];
    value: CheckpointUserRecord;
    indexes: { byViewer: string; byList: [string, string] };
  };
}

type StoreName = 'accounts' | 'snapshots' | 'snapshotLists' | 'profiles' | 'events';
const ALL_STORES: StoreName[] = ['accounts', 'snapshots', 'snapshotLists', 'profiles', 'events'];
const CHECKPOINT_STORES: Array<'checkpoints' | 'checkpointUsers'> = ['checkpoints', 'checkpointUsers'];

function viewerTimeRange(viewerId: string): IDBKeyRange {
  return IDBKeyRange.bound([viewerId, -Infinity], [viewerId, Infinity]);
}

async function readLatest(
  tx: IDBPTransaction<TrackerSchema, StoreName[], 'readonly' | 'readwrite'>,
  viewerId: string,
): Promise<LatestSnapshot | null> {
  const cursor = await tx.objectStore('snapshots').index('byViewer').openCursor(viewerTimeRange(viewerId), 'prev');
  if (!cursor) {
    return null;
  }
  const snapshot = cursor.value as SnapshotRecord;
  const lists = await tx.objectStore('snapshotLists').get(snapshot.id);
  if (!lists) {
    return null;
  }
  return { ...snapshot, followerIds: lists.followerIds, followingIds: lists.followingIds };
}

export class TrackerStore {
  private constructor(private readonly db: IDBPDatabase<TrackerSchema>) {}

  static async open(name: string = DB_NAME): Promise<TrackerStore> {
    const db = await openDB<TrackerSchema>(name, DB_VERSION, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          database.createObjectStore('accounts', { keyPath: 'viewerId' });
          const snapshots = database.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
          snapshots.createIndex('byViewer', ['viewerId', 'takenAt']);
          const lists = database.createObjectStore('snapshotLists', { keyPath: 'snapshotId' });
          lists.createIndex('byViewer', 'viewerId');
          const profiles = database.createObjectStore('profiles', { keyPath: ['viewerId', 'pk'] });
          profiles.createIndex('byViewer', 'viewerId');
          const events = database.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
          events.createIndex('byViewer', ['viewerId', 'detectedAt']);
        }
        if (oldVersion < 2) {
          database.createObjectStore('checkpoints', { keyPath: 'viewerId' });
          const users = database.createObjectStore('checkpointUsers', { keyPath: ['viewerId', 'list', 'pk'] });
          users.createIndex('byViewer', 'viewerId');
          users.createIndex('byList', ['viewerId', 'list']);
        }
      },
    });
    return new TrackerStore(db);
  }

  close(): void {
    this.db.close();
  }

  async getAccount(viewerId: string): Promise<AccountRecord | null> {
    return (await this.db.get('accounts', viewerId)) ?? null;
  }

  async listAccounts(): Promise<AccountRecord[]> {
    const accounts = await this.db.getAll('accounts');
    return accounts.sort((a, b) => b.lastSyncAt - a.lastSyncAt);
  }

  async getLatestSnapshot(viewerId: string): Promise<LatestSnapshot | null> {
    const tx = this.db.transaction(ALL_STORES, 'readonly');
    const latest = await readLatest(tx, viewerId);
    await tx.done;
    return latest;
  }

  /** Newest first. */
  async listSnapshots(viewerId: string, limit = 50): Promise<SnapshotRecord[]> {
    const out: SnapshotRecord[] = [];
    let cursor = await this.db
      .transaction('snapshots')
      .store.index('byViewer')
      .openCursor(viewerTimeRange(viewerId), 'prev');
    while (cursor && out.length < limit) {
      out.push(cursor.value as SnapshotRecord);
      cursor = await cursor.continue();
    }
    return out;
  }

  /** Newest first. */
  async listEvents(viewerId: string, limit = 200): Promise<EventRecord[]> {
    const out: EventRecord[] = [];
    let cursor = await this.db
      .transaction('events')
      .store.index('byViewer')
      .openCursor(viewerTimeRange(viewerId), 'prev');
    while (cursor && out.length < limit) {
      out.push(cursor.value as EventRecord);
      cursor = await cursor.continue();
    }
    return out;
  }

  async getProfiles(viewerId: string, pks: readonly string[]): Promise<Map<string, ProfileRecord>> {
    const store = this.db.transaction('profiles').store;
    const records = await Promise.all(pks.map(pk => store.get([viewerId, pk])));
    const out = new Map<string, ProfileRecord>();
    records.forEach(record => {
      if (record) {
        out.set(record.pk, record);
      }
    });
    return out;
  }

  /**
   * Saves a completed collection as the newest snapshot and records what changed
   * since the previous one. Incomplete or suspicious results are rejected and
   * leave the store untouched.
   */
  async commit(result: CollectionResult, guard: CommitGuard = DEFAULT_COMMIT_GUARD): Promise<CommitOutcome> {
    const viewerId = result.viewerId;
    if (!viewerId) {
      const plan = planCommit(null, result, guard);
      return plan.kind === 'rejected'
        ? { status: 'rejected', reason: plan.reason, detail: plan.detail }
        : { status: 'rejected', reason: 'no_viewer', detail: 'No signed-in account on the result.' };
    }

    const tx = this.db.transaction(ALL_STORES, 'readwrite');
    const previous = await readLatest(tx, viewerId);
    const plan = planCommit(previous, result, guard);
    if (plan.kind === 'rejected') {
      await tx.done;
      return { status: 'rejected', reason: plan.reason, detail: plan.detail };
    }

    const takenAt = result.finishedAt;
    const diffCounts: DiffCounts | null = plan.diff
      ? {
          followersGained: plan.diff.followersGained.length,
          followersLost: plan.diff.followersLost.length,
          followersLostConfirmed: plan.events.filter(
            event => event.type === 'follower_lost' && event.verification === 'confirmed',
          ).length,
          followingAdded: plan.diff.followingAdded.length,
          followingRemoved: plan.diff.followingRemoved.length,
        }
      : null;

    const snapshotId = await tx.objectStore('snapshots').add({
      viewerId,
      startedAt: result.startedAt,
      takenAt,
      followerCount: plan.sets.followerIds.length,
      followingCount: plan.sets.followingIds.length,
      reportedFollowerCount: result.reportedFollowers,
      reportedFollowingCount: result.reportedFollowing,
      baseline: plan.baseline,
      diffCounts,
      stats: result.stats,
    });

    const writes: Array<Promise<unknown>> = [
      tx.objectStore('snapshotLists').put({
        snapshotId,
        viewerId,
        followerIds: [...plan.sets.followerIds],
        followingIds: [...plan.sets.followingIds],
      }),
    ];
    const profiles = tx.objectStore('profiles');
    for (const user of result.users) {
      writes.push(
        profiles.put({
          viewerId,
          pk: user.pk,
          username: user.username,
          fullName: user.fullName,
          profilePicUrl: user.profilePicUrl,
          isPrivate: user.isPrivate,
          isVerified: user.isVerified,
          lastSeenAt: takenAt,
        }),
      );
    }
    const events = tx.objectStore('events');
    for (const event of plan.events) {
      writes.push(
        events.add({
          viewerId,
          type: event.type,
          pk: event.pk,
          detectedAt: takenAt,
          snapshotId,
          ...(event.verification ? { verification: event.verification } : {}),
        }),
      );
    }

    const accounts = tx.objectStore('accounts');
    const existing = await accounts.get(viewerId);
    writes.push(
      accounts.put({
        viewerId,
        username: result.viewerUsername ?? existing?.username ?? null,
        firstSyncAt: existing?.firstSyncAt ?? takenAt,
        lastSyncAt: takenAt,
        lastSnapshotId: snapshotId,
        snapshotCount: (existing?.snapshotCount ?? 0) + 1,
      }),
    );

    // Drop full id lists of all but the newest few snapshots.
    let kept = 0;
    let cursor = await tx.objectStore('snapshots').index('byViewer').openCursor(viewerTimeRange(viewerId), 'prev');
    while (cursor) {
      kept++;
      if (kept > KEEP_LISTS_FOR_SNAPSHOTS && cursor.value.id !== undefined) {
        writes.push(tx.objectStore('snapshotLists').delete(cursor.value.id));
      }
      cursor = await cursor.continue();
    }

    await Promise.all(writes);
    await tx.done;

    return {
      status: 'committed',
      snapshotId,
      viewerId,
      baseline: plan.baseline,
      followerCount: plan.sets.followerIds.length,
      followingCount: plan.sets.followingIds.length,
      diffCounts,
    };
  }

  /** Starts a fresh checkpoint for a new run, dropping whatever an older run left. */
  async startCheckpoint(viewerId: string, runId: string, startedAt: number): Promise<void> {
    const tx = this.db.transaction(CHECKPOINT_STORES, 'readwrite');
    const users = tx.objectStore('checkpointUsers');
    const stale = await users.index('byViewer').getAllKeys(viewerId);
    await Promise.all([
      ...stale.map(key => users.delete(key)),
      tx.objectStore('checkpoints').put({
        viewerId,
        runId,
        startedAt,
        updatedAt: startedAt,
        requests: 0,
        profile: null,
        following: null,
        followers: null,
      }),
    ]);
    await tx.done;
  }

  /**
   * Records what a run reported. `runRequestsBefore` is how many requests the
   * same run had reported earlier, so the total only grows by the difference.
   * Deltas from a different run than the current checkpoint are ignored.
   */
  async applyCheckpointDelta(
    viewerId: string,
    delta: CheckpointDelta,
    runRequestsBefore: number,
    now: number,
  ): Promise<boolean> {
    const tx = this.db.transaction(CHECKPOINT_STORES, 'readwrite');
    const header = await tx.objectStore('checkpoints').get(viewerId);
    if (!header || header.runId !== delta.runId) {
      await tx.done;
      return false;
    }
    const writes: Array<Promise<unknown>> = [];
    let next: CheckpointRecord = {
      ...header,
      updatedAt: now,
      requests: header.requests + Math.max(0, delta.requests - runRequestsBefore),
      ...(delta.profile ? { profile: delta.profile } : {}),
    };
    if (delta.list) {
      const { kind, users, ...progress } = delta.list;
      next = { ...next, [kind]: progress };
      const store = tx.objectStore('checkpointUsers');
      for (const user of users) {
        writes.push(store.put({ viewerId, list: kind, pk: user.pk, user }));
      }
    }
    writes.push(tx.objectStore('checkpoints').put(next));
    await Promise.all(writes);
    await tx.done;
    return true;
  }

  async getCheckpoint(viewerId: string): Promise<CheckpointRecord | null> {
    return (await this.db.get('checkpoints', viewerId)) ?? null;
  }

  /** The checkpoint plus everything collected so far, ready to hand to the collector. */
  async loadCheckpoint(viewerId: string): Promise<LoadedCheckpoint | null> {
    const tx = this.db.transaction(CHECKPOINT_STORES, 'readonly');
    const record = await tx.objectStore('checkpoints').get(viewerId);
    if (!record) {
      await tx.done;
      return null;
    }
    const byList = tx.objectStore('checkpointUsers').index('byList');
    const [following, followers] = await Promise.all([
      byList.getAll([viewerId, 'following']),
      byList.getAll([viewerId, 'followers']),
    ]);
    await tx.done;
    const withUsers = (progress: ListProgress | null, rows: CheckpointUserRecord[]) =>
      progress ? { ...progress, users: rows.map(row => row.user) } : null;
    return {
      record,
      resume: {
        startedAt: record.startedAt,
        profile: record.profile,
        following: withUsers(record.following, following),
        followers: withUsers(record.followers, followers),
      },
    };
  }

  async clearCheckpoint(viewerId: string): Promise<void> {
    const tx = this.db.transaction(CHECKPOINT_STORES, 'readwrite');
    const users = tx.objectStore('checkpointUsers');
    const keys = await users.index('byViewer').getAllKeys(viewerId);
    await Promise.all([...keys.map(key => users.delete(key)), tx.objectStore('checkpoints').delete(viewerId)]);
    await tx.done;
  }

  async deleteAccount(viewerId: string): Promise<void> {
    await this.clearCheckpoint(viewerId);
    const tx = this.db.transaction(ALL_STORES, 'readwrite');
    const deletes: Array<Promise<unknown>> = [tx.objectStore('accounts').delete(viewerId)];
    for (const name of ['snapshots', 'events'] as const) {
      const keys = await tx.objectStore(name).index('byViewer').getAllKeys(viewerTimeRange(viewerId));
      keys.forEach(key => deletes.push(tx.objectStore(name).delete(key)));
    }
    const listKeys = await tx.objectStore('snapshotLists').index('byViewer').getAllKeys(viewerId);
    listKeys.forEach(key => deletes.push(tx.objectStore('snapshotLists').delete(key)));
    const profileKeys = await tx.objectStore('profiles').index('byViewer').getAllKeys(viewerId);
    profileKeys.forEach(key => deletes.push(tx.objectStore('profiles').delete(key)));
    await Promise.all(deletes);
    await tx.done;
  }

  async exportAccount(viewerId: string): Promise<AccountExport> {
    const tx = this.db.transaction(ALL_STORES, 'readonly');
    const account = (await tx.objectStore('accounts').get(viewerId)) ?? null;
    const snapshots = (await tx
      .objectStore('snapshots')
      .index('byViewer')
      .getAll(viewerTimeRange(viewerId))) as SnapshotRecord[];
    const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
    const latestLists = latest ? ((await tx.objectStore('snapshotLists').get(latest.id)) ?? null) : null;
    const events = (await tx.objectStore('events').index('byViewer').getAll(viewerTimeRange(viewerId))) as EventRecord[];
    const profiles = await tx.objectStore('profiles').index('byViewer').getAll(viewerId);
    await tx.done;
    return { exportedAt: new Date().toISOString(), account, snapshots, latestLists, events, profiles };
  }
}
