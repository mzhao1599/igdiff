import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
