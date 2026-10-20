import { describe, expect, it } from 'vitest';
import type { ActionRecord, EventRecord, ProfileRecord } from '../tracker/store';
import {
  countSeries,
  csvField,
  estimateUnfollowMs,
  followerDiff,
  linePath,
  listsCsv,
  formatAgo,
  formatDuration,
  groupByDay,
  matchesSearch,
  panelLists,
  recentUnfollowers,
  selectable,
  sortAccounts,
} from './view';

const action = (
  pk: string,
  outcome: ActionRecord['outcome'],
  type: ActionRecord['type'] = outcome === 'removed' ? 'remove_follower' : 'unfollow',
): ActionRecord => ({
  id: 1,
  viewerId: 'v',
  pk,
  type,
  outcome,
  detail: null,
  at: 1,
});

const profile = (username: string, fullName = ''): ProfileRecord => ({
  viewerId: 'v',
  pk: username,
  username,
  fullName,
  profilePicUrl: '',
  isPrivate: false,
  isVerified: false,
  lastSeenAt: 0,
});

const event = (type: EventRecord['type'], detectedAt: number): EventRecord => ({
  id: detectedAt,
  viewerId: 'v',
  type,
  pk: String(detectedAt),
  detectedAt,
  snapshotId: 1,
});

describe('panelLists', () => {
  const sets = { followerIds: ['f', 'g', 'm', 'n'], followingIds: ['1', '2', '3', 'm', 'n'] };

  it('splits the snapshot into the five lists, keeping order', () => {
    expect(panelLists(sets, [])).toEqual({
      followers: ['f', 'g', 'm', 'n'],
      following: ['1', '2', '3', 'm', 'n'],
      notFollowingBack: ['1', '2', '3'],
      fans: ['f', 'g'],
      mutuals: ['m', 'n'],
    });
  });

  it('applies only actions that actually happened since the last sync', () => {
    const lists = panelLists(sets, [
      action('1', 'unfollowed'),
      action('2', 'failed'),
      action('3', 'not_found'),
      action('n', 'unfollowed'),
      action('g', 'removed'),
      action('m', 'failed', 'remove_follower'),
    ]);
    expect(lists.notFollowingBack).toEqual(['2', '3']);
    // A mutual you unfollowed still follows you: now a fan.
    expect(lists.fans).toEqual(['f', 'n']);
    expect(lists.mutuals).toEqual(['m']);
    expect(lists.followers).toEqual(['f', 'm', 'n']);
  });

  it('makes a fan you followed back a mutual, but not one who only got a request', () => {
    const lists = panelLists(sets, [action('f', 'followed', 'follow'), action('g', 'requested', 'follow')]);
    expect(lists.following).toEqual(['f', '1', '2', '3', 'm', 'n']);
    expect(lists.mutuals).toEqual(['f', 'm', 'n']);
    expect(lists.fans).toEqual(['g']);
  });

  it('moves a mutual you removed to "don\'t follow back"', () => {
    const lists = panelLists(sets, [action('m', 'removed')]);
    expect(lists.mutuals).toEqual(['n']);
    expect(lists.notFollowingBack).toEqual(['1', '2', '3', 'm']);
  });
});

describe('sortAccounts', () => {
  const profiles = new Map(['b', 'a', 'c'].map(name => [name, profile(name === 'a' ? 'zed' : name)]));

  it('keeps Instagram order, reverses it, or sorts by username', () => {
    expect(sortAccounts(['b', 'a', 'c'], 'recent', profiles)).toEqual(['b', 'a', 'c']);
    expect(sortAccounts(['b', 'a', 'c'], 'oldest', profiles)).toEqual(['c', 'a', 'b']);
    expect(sortAccounts(['b', 'a', 'c'], 'az', profiles)).toEqual(['b', 'c', 'a']);
  });
});

describe('diff and graph', () => {
  it('counts follower changes in the window, not removals', () => {
    const day = 86_400_000;
    const now = 100 * day;
    const events = [
      event('follower_gained', now - day),
      event('follower_lost', now - 2 * day),
      event('follower_removed', now - 2 * day),
      event('follower_lost', now - 9 * day),
      event('following_added', now - day),
    ];
    expect(followerDiff(events, now)).toEqual({ gained: 1, lost: 1 });
    expect(followerDiff(events, now, 30)).toEqual({ gained: 1, lost: 2 });
  });

  it('orders snapshot counts oldest first', () => {
    const snap = (takenAt: number, followerCount: number) =>
      ({ takenAt, followerCount, followingCount: 5 }) as Parameters<typeof countSeries>[0][number];
    expect(countSeries([snap(30, 3), snap(10, 1), snap(20, 2)]).map(point => point.followers)).toEqual([1, 2, 3]);
  });

  it('draws a path spanning the box, flat for constant or single values', () => {
    expect(linePath([], 100, 20)).toBe('');
    expect(linePath([5], 100, 20)).toBe('M2,10H98');
    expect(linePath([1, 3], 100, 20)).toBe('M2.0,18.0L98.0,2.0');
    expect(linePath([4, 4, 4], 100, 20)).toBe('M2.0,10.0L50.0,10.0L98.0,10.0');
  });
});

describe('search and selection', () => {
  it('matches username or full name, with or without @', () => {
    expect(matchesSearch(profile('stanford', 'Stanford University'), '@stan')).toBe(true);
    expect(matchesSearch(profile('x', 'Stanford University'), 'univ')).toBe(true);
    expect(matchesSearch(profile('x'), 'nope')).toBe(false);
    expect(matchesSearch(undefined, '')).toBe(true);
    expect(matchesSearch(undefined, 'a')).toBe(false);
  });

  it('never selects kept accounts', () => {
    expect(selectable(['1', '2', '3'], new Set(['2']))).toEqual(['1', '3']);
  });
});

describe('estimates and formatting', () => {
  it('estimates gaps between unfollows plus the long pauses', () => {
    const settings = { delayMs: 10_000, jitterMs: 0, pauseEvery: 2, pauseMs: 60_000, retryAfterMs: 0, verify: true };
    expect(estimateUnfollowMs(1, settings)).toBe(0);
    expect(estimateUnfollowMs(2, settings)).toBe(10_000);
    // 4 accounts: gaps 1,2,3 → a pause after the 2nd unfollow.
    expect(estimateUnfollowMs(4, settings)).toBe(2 * 10_000 + 60_000);
  });

  it('formats durations and ages for people', () => {
    expect(formatDuration(0)).toBe('a moment');
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(10 * 60_000)).toBe('10 min');
    expect(formatDuration(125 * 60_000)).toBe('2 h 5 min');
    expect(formatAgo(1000, 1000 + 30_000)).toBe('just now');
    expect(formatAgo(0, 5 * 60_000)).toBe('5 min ago');
    expect(formatAgo(0, 3 * 3_600_000)).toBe('3 h ago');
  });
});

describe('changes timeline', () => {
  it('groups newest-first events by day', () => {
    const groups = groupByDay([event('follower_lost', 30), event('follower_gained', 20), event('following_added', 10)], ms =>
      ms >= 20 ? 'today' : 'yesterday',
    );
    expect(groups.map(g => [g.day, g.items.length])).toEqual([
      ['today', 2],
      ['yesterday', 1],
    ]);
  });

  it('counts recent unfollowers', () => {
    const now = 100 * 86_400_000;
    expect(
      recentUnfollowers([event('follower_lost', now - 86_400_000), event('follower_lost', now - 40 * 86_400_000), event('follower_gained', now)], now),
    ).toBe(1);
  });
});

describe('CSV export', () => {
  it('quotes and escapes fields and defuses formulas', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('-1')).toBe("'-1");
    expect(csvField(true)).toBe('true');
  });

  it('writes one row per account with its list', () => {
    const csv = listsCsv(
      { followers: ['b'], following: ['a'], notFollowingBack: ['a'], fans: ['b'], mutuals: [] },
      new Map([['a', profile('alpha', 'Alpha, Inc')]]),
      new Set(['a']),
    );
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('list,username,full_name,profile_url,verified,private,kept,id');
    expect(lines[1]).toBe('not_following_back,alpha,"Alpha, Inc",https://www.instagram.com/alpha/,false,false,true,a');
    expect(lines[2]).toBe('fan,,,,false,false,false,b');
  });
});
