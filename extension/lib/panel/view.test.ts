import { describe, expect, it } from 'vitest';
import type { ActionRecord, EventRecord, ProfileRecord } from '../tracker/store';
import {
  csvField,
  estimateUnfollowMs,
  listsCsv,
  formatAgo,
  formatDuration,
  groupByDay,
  matchesSearch,
  panelLists,
  recentUnfollowers,
  selectable,
} from './view';

const action = (pk: string, outcome: ActionRecord['outcome']): ActionRecord => ({
  id: 1,
  viewerId: 'v',
  pk,
  type: 'unfollow',
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
  it('drops only accounts actually unfollowed here since the last sync', () => {
    const lists = panelLists(
      { notFollowingBack: ['1', '2', '3'], fans: ['f'], mutuals: ['m', 'n'] },
      [action('1', 'unfollowed'), action('2', 'failed'), action('3', 'not_found'), action('n', 'unfollowed')],
    );
    expect(lists.notFollowingBack).toEqual(['2', '3']);
    expect(lists.mutuals).toEqual(['m']);
    expect(lists.fans).toEqual(['f']);
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
      { notFollowingBack: ['a'], fans: ['b'], mutuals: [] },
      new Map([['a', profile('alpha', 'Alpha, Inc')]]),
      new Set(['a']),
    );
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('list,username,full_name,profile_url,verified,private,kept,id');
    expect(lines[1]).toBe('not_following_back,alpha,"Alpha, Inc",https://www.instagram.com/alpha/,false,false,true,a');
    expect(lines[2]).toBe('fan,,,,false,false,false,b');
  });
});
