import { describe, expect, it } from 'vitest';
import { accounts, createFakeInstagram, html, json, type FakeInstagramOptions } from '../testing/fake-instagram';
import { backoffMs, classifyFailure, collect, type CollectionProgress, type CollectorOptions } from './collect';

function run(fakeOptions: FakeInstagramOptions, overrides: Partial<CollectorOptions> = {}) {
  const fake = createFakeInstagram(fakeOptions);
  const sleeps: number[] = [];
  const progress: CollectionProgress[] = [];
  let clock = 1_000;
  const promise = collect({
    client: fake.client,
    viewerId: fake.viewerId,
    sleep: async ms => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    now: () => (clock += 10),
    onProgress: p => progress.push(p),
    ...overrides,
  });
  return { fake, sleeps, progress, promise };
}

const sorted = (ids: readonly string[]) => [...ids].sort();

describe('collect: happy path', () => {
  it('fetches following, then followers, and reports both sets', async () => {
    const { promise, fake } = run({
      following: accounts('1', '2', '3'),
      followers: accounts('2', '3', '4'),
      followersChunk: 2,
    });
    const result = await promise;
    expect(result.outcome).toBe('completed');
    expect(result.viewerUsername).toBe('me');
    expect(sorted(result.followingIds)).toEqual(['1', '2', '3']);
    expect(sorted(result.followerIds)).toEqual(['2', '3', '4']);
    expect(result.reportedFollowers).toBe(3);
    expect(result.stats.followersPages).toBe(2);
    expect(result.users).toHaveLength(4);

    const order = fake.requests.map(r => r.path.split('/').filter(Boolean).pop());
    expect(order.indexOf('following')).toBeLessThan(order.indexOf('followers'));
  });

  it('checks only unresolved accounts with show_many', async () => {
    const { promise, fake } = run({ following: accounts('1', '2'), followers: accounts('2') });
    const result = await promise;
    const sweeps = fake.requests.filter(r => r.path.endsWith('/show_many/'));
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]!.body).toBe('user_ids=1');
    expect(result.stats.sweepChecked).toBe(1);
  });

  it('keeps one row when Instagram repeats an account on a later page', async () => {
    const { promise } = run({ following: [{ pk: '1' }, { pk: '2' }, { pk: '2' }, { pk: '3' }], followingChunk: 2 });
    const result = await promise;
    expect(sorted(result.followingIds)).toEqual(['1', '2', '3']);
  });

  it('handles an account that follows nobody and has no followers', async () => {
    const { promise } = run({});
    const result = await promise;
    expect(result.outcome).toBe('completed');
    expect(result.followerIds).toEqual([]);
    expect(result.followingIds).toEqual([]);
  });

  it('paces between pages and adds a cooldown every 5 pages', async () => {
    const { promise, sleeps } = run(
      { following: accounts('1', '2', '3', '4', '5', '6', '7'), followingChunk: 1 },
      { settings: { pageDelayMs: 100, pageJitterMs: 0, cooldownEveryPages: 5, cooldownMs: 9_000, cooldownJitterMs: 0 } },
    );
    await promise;
    expect(sleeps.filter(ms => ms === 9_000)).toHaveLength(1);
    expect(sleeps.filter(ms => ms === 100).length).toBeGreaterThanOrEqual(7);
  });
});

describe('collect: classification safety (ported from the legacy scanner)', () => {
  it('trusts a followed_by: true flag for an account missing from the followers list', async () => {
    const { promise, fake } = run({ following: [{ pk: '1', followedBy: true }], followers: [], reportedFollowers: 0 });
    const result = await promise;
    expect(result.followerIds).toEqual(['1']);
    expect(result.stats.confirmedByListFlag).toBe(1);
    expect(fake.requests.some(r => r.path.endsWith('/show_many/'))).toBe(false);
  });

  it('re-checks a followed_by: false flag instead of trusting it', async () => {
    const { promise } = run({
      following: [{ pk: '1', followedBy: false }],
      followers: [],
      reportedFollowers: 0,
      friendships: { '1': { following: true, followed_by: true } },
    });
    const result = await promise;
    expect(result.followerIds).toEqual(['1']);
    expect(result.stats.confirmedBySweep).toBe(1);
  });

  it('matches the same account across id schemes and keeps the following-list pk', async () => {
    const { promise } = run({
      following: [{ pk: '123', id: '178414' }],
      followers: [{ pk: '178414' }],
    });
    const result = await promise;
    expect(result.followerIds).toEqual(['123']);
  });

  it('matches by username when ids differ', async () => {
    const { promise } = run({
      following: [{ pk: '1', username: 'Same' }],
      followers: [{ pk: '9', username: 'same' }],
    });
    const result = await promise;
    expect(result.followerIds).toEqual(['1']);
  });

  it('refuses an empty first following page when the profile reports a positive count', async () => {
    const { promise } = run({ following: [], reportedFollowing: 2834 });
    const result = await promise;
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/2834/);
  });

  it('refuses an empty first followers page when the profile reports a positive count', async () => {
    const { promise } = run({ following: accounts('1'), followers: [], reportedFollowers: 50 });
    const result = await promise;
    expect(result.outcome).toBe('blocked');
  });

  it('stops as partial when a list hits the page cap', async () => {
    const { promise } = run(
      { following: accounts('1', '2', '3', '4'), followingChunk: 1 },
      { settings: { followingPageCap: 2 } },
    );
    const result = await promise;
    expect(result.outcome).toBe('partial');
  });

  it('treats a repeated cursor as the end of the list and records it', async () => {
    const { promise } = run({
      following: accounts('1'),
      intercept: r =>
        r.path.endsWith('/following/')
          ? json({ users: [{ pk: String(r.nth), username: `u${r.nth}` }], next_max_id: 'same', status: 'ok' })
          : undefined,
    });
    const result = await promise;
    expect(result.outcome).toBe('completed');
    expect(result.stats.cursorRepeated).toBe(true);
    expect(sorted(result.followingIds)).toEqual(['1', '2']);
  });
});

describe('collect: failures', () => {
  it('backs off after a 429 and continues', async () => {
    const { promise, sleeps } = run({
      following: accounts('1'),
      intercept: r => (r.path.endsWith('/following/') && r.nth === 1 ? json({ status: 'fail' }, 429) : undefined),
    });
    const result = await promise;
    expect(result.outcome).toBe('completed');
    expect(result.stats.retries).toBe(1);
    expect(sleeps).toContain(backoffMs(1, 120_000, 600_000, () => 0.5));
  });

  it('gives up as rate_limited after maxRetries consecutive 429s', async () => {
    const { promise } = run(
      { following: accounts('1'), intercept: r => (r.path.endsWith('/following/') ? json({}, 429) : undefined) },
      { settings: { maxRetries: 2 } },
    );
    const result = await promise;
    expect(result.outcome).toBe('rate_limited');
    expect(result.stats.retries).toBe(3);
  });

  it('treats a 200 HTML challenge page like throttling', async () => {
    const { promise } = run({
      following: accounts('1'),
      intercept: r => (r.path.endsWith('/following/') && r.nth === 1 ? html('<html/>') : undefined),
    });
    const result = await promise;
    expect(result.outcome).toBe('completed');
    expect(result.stats.retries).toBe(1);
  });

  it('stops as blocked when Instagram asks to sign in again', async () => {
    const { promise } = run({
      following: accounts('1'),
      intercept: r =>
        r.path.endsWith('/following/') ? json({ message: 'login_required', require_login: true, status: 'fail' }, 401) : undefined,
    });
    const result = await promise;
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/sign in/i);
  });

  it('stops as error on an unexpected 404 without retrying', async () => {
    const { promise } = run({
      intercept: r => (r.path.endsWith('/following/') ? json({ status: 'fail' }, 404) : undefined),
    });
    const result = await promise;
    expect(result.outcome).toBe('error');
    expect(result.stats.retries).toBe(0);
  });

  it('retries network errors with the short backoff', async () => {
    const fake = createFakeInstagram({ following: accounts('1') });
    let failed = false;
    const sleeps: number[] = [];
    const result = await collect({
      client: {
        ...fake.client,
        fetch: (input, init) => {
          if (!failed && String(input).includes('/following/')) {
            failed = true;
            return Promise.reject(new TypeError('offline'));
          }
          return fake.client.fetch(input, init);
        },
      },
      viewerId: fake.viewerId,
      sleep: async ms => {
        sleeps.push(ms);
      },
      random: () => 0,
    });
    expect(result.outcome).toBe('completed');
    expect(sleeps).toContain(5_000);
  });

  it('fails the whole sync when the friendship check stays rate limited', async () => {
    const { promise } = run(
      {
        following: accounts('1'),
        followers: [],
        reportedFollowers: 0,
        intercept: r => (r.path.endsWith('/show_many/') ? json({}, 429) : undefined),
      },
      { settings: { maxRetries: 1 } },
    );
    const result = await promise;
    expect(result.outcome).toBe('rate_limited');
  });

  it('returns no_session without any request when nobody is signed in', async () => {
    const { promise, fake } = run({}, { viewerId: null });
    const result = await promise;
    expect(result.outcome).toBe('no_session');
    expect(fake.requests).toHaveLength(0);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    const { promise } = run(
      { following: accounts('1', '2', '3'), followingChunk: 1 },
      {
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
        },
      },
    );
    const result = await promise;
    expect(result.outcome).toBe('stopped');
  });
});

describe('collect: verifying changes against the previous snapshot', () => {
  it('restores a previous follower the list skipped when show_many says they still follow', async () => {
    const { promise } = run(
      {
        following: [],
        followers: accounts('1'),
        friendships: { '2': { following: false, followed_by: true } },
      },
      { baseline: { followerIds: ['1', '2'], followingIds: [] } },
    );
    const result = await promise;
    expect(sorted(result.followerIds)).toEqual(['1', '2']);
    expect(result.stats.restoredFollowers).toBe(1);
    expect(result.lostFollowerChecks).toEqual({});
  });

  it('confirms a lost follower when show_many says followed_by: false', async () => {
    const { promise } = run(
      { followers: accounts('1'), friendships: { '2': { following: false, followed_by: false } } },
      { baseline: { followerIds: ['1', '2'], followingIds: [] } },
    );
    const result = await promise;
    expect(result.followerIds).toEqual(['1']);
    expect(result.lostFollowerChecks).toEqual({ '2': 'confirmed' });
  });

  it('marks a lost follower unconfirmed when Instagram returns nothing for them', async () => {
    const { promise } = run(
      { followers: accounts('1'), friendships: { '2': null } },
      { baseline: { followerIds: ['1', '2'], followingIds: [] } },
    );
    const result = await promise;
    expect(result.lostFollowerChecks).toEqual({ '2': 'unconfirmed' });
  });

  it('verifies follows that disappeared from the following list too', async () => {
    const { promise } = run(
      {
        following: accounts('1'),
        followers: accounts('1'),
        friendships: { '2': { following: true, followed_by: false }, '3': { following: false, followed_by: false } },
      },
      { baseline: { followerIds: ['1'], followingIds: ['1', '2', '3'] } },
    );
    const result = await promise;
    expect(sorted(result.followingIds)).toEqual(['1', '2']);
    expect(result.stats.restoredFollowing).toBe(1);
    expect(result.removedFollowingChecks).toEqual({ '3': 'confirmed' });
  });

  it('checks each account once even when it is in several candidate groups', async () => {
    const { promise, fake } = run(
      { following: accounts('1'), followers: [], reportedFollowers: 0, friendships: { '1': { following: true, followed_by: false } } },
      { baseline: { followerIds: ['1'], followingIds: ['1'] } },
    );
    await promise;
    const bodies = fake.requests.filter(r => r.path.endsWith('/show_many/')).map(r => r.body);
    expect(bodies).toEqual(['user_ids=1']);
  });
});

describe('progress', () => {
  it('reports phases in order and ends with done', async () => {
    const { promise, progress } = run({ following: accounts('1'), followers: accounts('1') });
    await promise;
    const phases = progress.map(p => p.phase).filter((phase, i, all) => all[i - 1] !== phase);
    expect(phases).toEqual(['profile', 'following', 'followers', 'verifying', 'done']);
  });
});

describe('classifyFailure', () => {
  it('maps statuses and Instagram messages to a retry policy', () => {
    const none = null;
    const info = (patch: object) => ({ message: null, requireLogin: false, challenge: false, spam: false, ...patch });
    expect(classifyFailure(429, none)).toBe('throttled');
    expect(classifyFailure(0, none)).toBe('throttled');
    expect(classifyFailure(400, info({ message: 'Please wait a few minutes' }))).toBe('throttled');
    expect(classifyFailure(-1, none)).toBe('transient');
    expect(classifyFailure(503, none)).toBe('transient');
    expect(classifyFailure(403, none)).toBe('auth');
    expect(classifyFailure(400, info({ challenge: true }))).toBe('auth');
    expect(classifyFailure(404, none)).toBe('fatal');
  });
});
