import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckpointDelta } from '../collector/collect';
import type { IgUser } from '../instagram/api';
import { makeResult } from '../testing/fixtures';
import { KEEP_LISTS_FOR_SNAPSHOTS, TrackerStore } from './store';

function user(pk: string): IgUser {
  return {
    pk,
    ids: [pk],
    username: `user${pk}`,
    fullName: `User ${pk}`,
    profilePicUrl: '',
    isPrivate: false,
    isVerified: false,
    followedBy: null,
  };
}

let store: TrackerStore;
let dbName: string;
let counter = 0;

beforeEach(async () => {
  dbName = `test-${Date.now()}-${counter++}`;
  store = await TrackerStore.open(dbName);
});

afterEach(() => {
  store.close();
  indexedDB.deleteDatabase(dbName);
});

describe('TrackerStore.commit', () => {
  it('saves the first sync as a baseline and records the account', async () => {
    const outcome = await store.commit(
      makeResult({ followerIds: ['1', '2'], followingIds: ['2', '3'], users: ['1', '2', '3'].map(user), finishedAt: 100 }),
    );
    expect(outcome).toMatchObject({ status: 'committed', baseline: true, followerCount: 2, followingCount: 2 });

    const latest = await store.getLatestSnapshot('1000');
    expect(latest?.followerIds).toEqual(['1', '2']);
    expect(latest?.followingIds).toEqual(['2', '3']);
    expect(await store.listEvents('1000')).toEqual([]);

    const [account] = await store.listAccounts();
    expect(account).toMatchObject({ viewerId: '1000', username: 'me', snapshotCount: 1, lastSyncAt: 100 });
    expect((await store.getProfiles('1000', ['3'])).get('3')?.username).toBe('user3');
  });

  it('records what changed on the next sync', async () => {
    await store.commit(makeResult({ followerIds: ['1', '2'], followingIds: ['2'], finishedAt: 100 }));
    const outcome = await store.commit(
      makeResult({
        followerIds: ['2', '3'],
        followingIds: ['2', '4'],
        lostFollowerChecks: { '1': 'confirmed' },
        finishedAt: 200,
      }),
    );
    expect(outcome).toMatchObject({
      status: 'committed',
      baseline: false,
      diffCounts: { followersGained: 1, followersLost: 1, followersLostConfirmed: 1, followingAdded: 1, followingRemoved: 0 },
    });

    const events = await store.listEvents('1000');
    expect(events.map(e => [e.type, e.pk, e.verification ?? null])).toEqual(
      expect.arrayContaining([
        ['follower_gained', '3', null],
        ['follower_lost', '1', 'confirmed'],
        ['following_added', '4', null],
      ]),
    );
    expect(events.every(e => e.detectedAt === 200)).toBe(true);
    expect((await store.listAccounts())[0]?.snapshotCount).toBe(2);
  });

  it('leaves the store untouched when a result is rejected', async () => {
    await store.commit(makeResult({ followerIds: ['1'], followingIds: [], finishedAt: 100 }));
    const outcome = await store.commit(makeResult({ outcome: 'rate_limited', followerIds: [], finishedAt: 200 }));
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'incomplete' });
    expect((await store.getLatestSnapshot('1000'))?.followerIds).toEqual(['1']);
    expect(await store.listSnapshots('1000')).toHaveLength(1);
    expect(await store.listEvents('1000')).toEqual([]);
  });

  it('keeps full lists only for the newest snapshots but keeps every snapshot row', async () => {
    for (let i = 0; i < KEEP_LISTS_FOR_SNAPSHOTS + 2; i++) {
      await store.commit(makeResult({ followerIds: [String(i)], followingIds: [], finishedAt: 100 + i }));
    }
    const snapshots = await store.listSnapshots('1000');
    expect(snapshots).toHaveLength(KEEP_LISTS_FOR_SNAPSHOTS + 2);
    const exported = await store.exportAccount('1000');
    expect(exported.latestLists?.followerIds).toEqual([String(KEEP_LISTS_FOR_SNAPSHOTS + 1)]);
    expect((await store.getLatestSnapshot('1000'))?.followerIds).toEqual([String(KEEP_LISTS_FOR_SNAPSHOTS + 1)]);
  });

  it('keeps accounts separate', async () => {
    await store.commit(makeResult({ viewerId: 'A', followerIds: ['1'], finishedAt: 100 }));
    await store.commit(makeResult({ viewerId: 'B', followerIds: ['9'], finishedAt: 100 }));
    await store.commit(makeResult({ viewerId: 'A', followerIds: ['1', '2'], finishedAt: 200 }));
    expect((await store.listEvents('B'))).toEqual([]);
    expect((await store.listEvents('A')).map(e => e.pk)).toEqual(['2']);
    expect((await store.getLatestSnapshot('B'))?.followerIds).toEqual(['9']);
  });

  it('lists snapshots and events newest first', async () => {
    await store.commit(makeResult({ followerIds: [], finishedAt: 100 }));
    await store.commit(makeResult({ followerIds: ['1'], finishedAt: 200 }));
    await store.commit(makeResult({ followerIds: ['1', '2'], finishedAt: 300 }));
    expect((await store.listSnapshots('1000')).map(s => s.takenAt)).toEqual([300, 200, 100]);
    expect((await store.listEvents('1000')).map(e => e.detectedAt)).toEqual([300, 200]);
  });
});

describe('TrackerStore.deleteAccount', () => {
  it('removes everything for one account and nothing for others', async () => {
    await store.commit(makeResult({ viewerId: 'A', followerIds: ['1'], users: [user('1')], finishedAt: 100 }));
    await store.commit(makeResult({ viewerId: 'A', followerIds: ['2'], users: [user('2')], finishedAt: 200 }));
    await store.commit(makeResult({ viewerId: 'B', followerIds: ['3'], users: [user('3')], finishedAt: 100 }));

    await store.deleteAccount('A');

    expect((await store.listAccounts()).map(a => a.viewerId)).toEqual(['B']);
    expect(await store.getLatestSnapshot('A')).toBeNull();
    expect(await store.listSnapshots('A')).toEqual([]);
    expect(await store.listEvents('A')).toEqual([]);
    expect((await store.getProfiles('A', ['1', '2'])).size).toBe(0);
    expect((await store.getLatestSnapshot('B'))?.followerIds).toEqual(['3']);
  });
});

describe('TrackerStore checkpoints', () => {
  const delta = (patch: Partial<CheckpointDelta>): CheckpointDelta => ({ runId: 'run-1', startedAt: 10, requests: 1, ...patch });
  const page = (kind: 'following' | 'followers', pks: string[], done: boolean, maxId: string | null) => ({
    kind,
    users: pks.map(user),
    maxId,
    rankToken: 'tok',
    pages: 1,
    rows: pks.length,
    done,
    order: 'date_followed_latest' as const,
  });

  it('collects deltas into a checkpoint the collector can resume from', async () => {
    await store.startCheckpoint('A', 'run-1', 10);
    await store.applyCheckpointDelta(
      'A',
      delta({ requests: 1, profile: { reportedFollowers: null, reportedFollowing: null, viewerUsername: 'me', profileUnavailable: true } }),
      0,
      20,
    );
    await store.applyCheckpointDelta('A', delta({ requests: 2, list: page('following', ['1', '2'], true, null) }), 1, 30);
    await store.applyCheckpointDelta('A', delta({ requests: 3, list: page('followers', ['a'], false, 'cursor-1') }), 2, 40);

    const loaded = await store.loadCheckpoint('A');
    expect(loaded?.record).toMatchObject({ runId: 'run-1', startedAt: 10, updatedAt: 40, requests: 3 });
    expect(loaded?.resume.profile?.viewerUsername).toBe('me');
    expect(loaded?.resume.following?.users.map(u => u.pk).sort()).toEqual(['1', '2']);
    expect(loaded?.resume.following?.done).toBe(true);
    expect(loaded?.resume.followers).toMatchObject({ maxId: 'cursor-1', done: false });
    expect(loaded?.resume.followers?.users.map(u => u.pk)).toEqual(['a']);
  });

  it('ignores deltas from a run that is not the current one', async () => {
    await store.startCheckpoint('A', 'run-2', 10);
    const applied = await store.applyCheckpointDelta('A', delta({ list: page('following', ['1'], true, null) }), 0, 20);
    expect(applied).toBe(false);
    expect((await store.loadCheckpoint('A'))?.resume.following).toBeNull();
  });

  it('adds only the new requests of each run to the total', async () => {
    await store.startCheckpoint('A', 'run-1', 10);
    await store.applyCheckpointDelta('A', delta({ requests: 5 }), 0, 20);
    await store.applyCheckpointDelta('A', delta({ requests: 8 }), 5, 30);
    // A resumed run counts from zero again.
    await store.applyCheckpointDelta('A', delta({ requests: 2 }), 0, 40);
    expect((await store.getCheckpoint('A'))?.requests).toBe(10);
  });

  it('drops the old run’s accounts when a new run starts', async () => {
    await store.startCheckpoint('A', 'run-1', 10);
    await store.applyCheckpointDelta('A', delta({ list: page('followers', ['a', 'b'], false, 'c') }), 0, 20);
    await store.startCheckpoint('A', 'run-2', 30);
    const loaded = await store.loadCheckpoint('A');
    expect(loaded?.record.runId).toBe('run-2');
    expect(loaded?.resume.followers).toBeNull();
  });

  it('is cleared on request and when the account is deleted, without touching other accounts', async () => {
    await store.startCheckpoint('A', 'run-1', 10);
    await store.startCheckpoint('B', 'run-9', 10);
    await store.applyCheckpointDelta('B', delta({ runId: 'run-9', list: page('followers', ['z'], false, 'c') }), 0, 20);
    await store.clearCheckpoint('A');
    expect(await store.getCheckpoint('A')).toBeNull();
    await store.deleteAccount('B');
    expect(await store.loadCheckpoint('B')).toBeNull();
  });
});

describe('TrackerStore upgrade', () => {
  it('keeps version 1 data when adding the checkpoint stores', async () => {
    const name = `upgrade-${Date.now()}`;
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('accounts', { keyPath: 'viewerId' });
        db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true }).createIndex('byViewer', ['viewerId', 'takenAt']);
        db.createObjectStore('snapshotLists', { keyPath: 'snapshotId' }).createIndex('byViewer', 'viewerId');
        db.createObjectStore('profiles', { keyPath: ['viewerId', 'pk'] }).createIndex('byViewer', 'viewerId');
        db.createObjectStore('events', { keyPath: 'id', autoIncrement: true }).createIndex('byViewer', ['viewerId', 'detectedAt']);
      },
    });
    await v1.put('accounts', { viewerId: 'old', username: 'kept', firstSyncAt: 1, lastSyncAt: 1, lastSnapshotId: 1, snapshotCount: 1 });
    v1.close();

    const upgraded = await TrackerStore.open(name);
    expect((await upgraded.listAccounts()).map(a => a.username)).toEqual(['kept']);
    await upgraded.startCheckpoint('old', 'run-1', 5);
    expect((await upgraded.getCheckpoint('old'))?.runId).toBe('run-1');
    upgraded.close();
    indexedDB.deleteDatabase(name);
  });
});

describe('TrackerStore keep list and actions', () => {
  it('keeps and un-keeps accounts per viewer', async () => {
    await store.setKeep('A', ['1', '2'], true, 10);
    await store.setKeep('B', ['9'], true, 10);
    await store.setKeep('A', ['1'], false, 20);
    expect([...(await store.listKeep('A'))]).toEqual(['2']);
    expect([...(await store.listKeep('B'))]).toEqual(['9']);
  });

  it('logs unfollows newest first and filters by time', async () => {
    await store.recordAction({ viewerId: 'A', pk: '1', type: 'unfollow', outcome: 'unfollowed', detail: null, at: 100 });
    await store.recordAction({ viewerId: 'A', pk: '2', type: 'unfollow', outcome: 'not_found', detail: 'gone', at: 200 });
    await store.recordAction({ viewerId: 'B', pk: '3', type: 'unfollow', outcome: 'unfollowed', detail: null, at: 300 });
    expect((await store.listActions('A')).map(a => a.pk)).toEqual(['2', '1']);
    expect((await store.listActions('A', 150)).map(a => a.pk)).toEqual(['2']);
  });

  it('deleting an account removes its keep list, actions and pictures too', async () => {
    await store.setKeep('A', ['1'], true, 10);
    await store.recordAction({ viewerId: 'A', pk: '1', type: 'unfollow', outcome: 'unfollowed', detail: null, at: 100 });
    await store.putAvatars([{ viewerId: 'A', pk: '1', key: 'cdn/1.jpg', dataUrl: 'data:image/jpeg;base64,AQ==', fetchedAt: 1 }]);
    await store.deleteAccount('A');
    expect((await store.listKeep('A')).size).toBe(0);
    expect(await store.listActions('A')).toEqual([]);
    expect((await store.getAvatars('A', ['1'])).size).toBe(0);
  });
});

describe('TrackerStore avatars', () => {
  it('stores pictures per account and replaces them by pk', async () => {
    await store.putAvatars([
      { viewerId: 'A', pk: '1', key: 'cdn/old.jpg', dataUrl: 'data:,old', fetchedAt: 1 },
      { viewerId: 'B', pk: '1', key: 'cdn/b.jpg', dataUrl: 'data:,b', fetchedAt: 1 },
    ]);
    await store.putAvatars([{ viewerId: 'A', pk: '1', key: 'cdn/new.jpg', dataUrl: 'data:,new', fetchedAt: 2 }]);
    const a = await store.getAvatars('A', ['1', '2']);
    expect([...a.keys()]).toEqual(['1']);
    expect(a.get('1')).toMatchObject({ key: 'cdn/new.jpg', dataUrl: 'data:,new' });
    expect((await store.getAvatars('B', ['1'])).get('1')?.dataUrl).toBe('data:,b');
  });
});
