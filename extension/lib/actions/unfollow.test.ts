import { describe, expect, it } from 'vitest';
import { accounts, createFakeInstagram, html, json, type FakeInstagramOptions } from '../testing/fake-instagram';
import { DEFAULT_UNFOLLOW_SETTINGS, runUnfollows, type UnfollowOptions } from './unfollow';

function run(fakeOptions: FakeInstagramOptions, pks: string[], overrides: Partial<UnfollowOptions> = {}) {
  const fake = createFakeInstagram(fakeOptions);
  const sleeps: number[] = [];
  const promise = runUnfollows({
    client: fake.client,
    viewerId: fake.viewerId,
    pks,
    maxUnfollows: 100,
    sleep: async ms => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...overrides,
  });
  return { fake, sleeps, promise };
}

const unfollowCalls = (requests: Array<{ path: string; method: string }>) =>
  requests.filter(r => r.method === 'POST' && /unfollow\/$|destroy\//.test(r.path)).map(r => r.path);

describe('runUnfollows', () => {
  it('unfollows exactly the chosen accounts, pacing between them but not after the last', async () => {
    const { promise, fake, sleeps } = run({ following: accounts('1', '2', '3', '4') }, ['1', '3']);
    const result = await promise;
    expect(result.outcome).toBe('completed');
    expect(fake.unfollowed).toEqual(['1', '3']);
    expect(result.results.map(r => [r.pk, r.outcome])).toEqual([
      ['1', 'unfollowed'],
      ['3', 'unfollowed'],
    ]);
    expect(result.endpoint).toBe('destroy');
    const { delayMs, jitterMs } = DEFAULT_UNFOLLOW_SETTINGS;
    expect(sleeps).toEqual([delayMs + Math.floor(0.5 * jitterMs)]);
  });

  it('takes a long pause after every few unfollows', async () => {
    const pks = ['1', '2', '3', '4', '5'];
    const { promise, sleeps } = run({ following: accounts(...pks) }, pks, {
      settings: { pauseEvery: 2, pauseMs: 999_000, delayMs: 1, jitterMs: 0 },
    });
    await promise;
    expect(sleeps).toEqual([1, 999_000, 1, 999_000]);
  });

  it('falls back to the older endpoint when the current one is gone, and sticks with it', async () => {
    const { promise, fake } = run({ following: accounts('1', '2'), destroyGone: true }, ['1', '2']);
    const result = await promise;
    expect(result.outcome).toBe('completed');
    expect(result.endpoint).toBe('web');
    expect(fake.unfollowed).toEqual(['1', '2']);
    expect(unfollowCalls(fake.requests)).toEqual([
      '/api/v1/friendships/destroy/1/',
      '/web/friendships/1/unfollow/',
      '/web/friendships/2/unfollow/',
    ]);
  });

  it('stops everything at the first action block and keeps the rest queued', async () => {
    const block = json(
      { message: 'feedback_required', spam: true, feedback_title: 'Try Again Later', status: 'fail' },
      400,
    );
    const { promise, fake } = run(
      {
        following: accounts('1', '2', '3'),
        intercept: r => (r.path.includes('/destroy/2/') ? block : undefined),
      },
      ['1', '2', '3'],
    );
    const result = await promise;
    expect(result.outcome).toBe('blocked');
    expect(fake.unfollowed).toEqual(['1']);
    expect(result.remaining).toEqual(['2', '3']);
    expect(result.message).toMatch(/Try Again Later|feedback_required|blocked/);
  });

  it('treats a 429 or "please wait" as a block too', async () => {
    for (const answer of [json({}, 429), json({ message: 'Please wait a few minutes before you try again.', status: 'fail' }, 400)]) {
      const { promise } = run({ following: accounts('1'), intercept: r => (r.method === 'POST' ? answer.clone() : undefined) }, ['1']);
      expect((await promise).outcome).toBe('blocked');
    }
  });

  it('stops when Instagram wants you to sign in again', async () => {
    const { promise } = run(
      {
        following: accounts('1'),
        intercept: r => (r.method === 'POST' ? html('<html/>', 200, 'https://www.instagram.com/accounts/login/') : undefined),
      },
      ['1'],
    );
    const result = await promise;
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/sign in/);
  });

  it('skips an account that no longer exists once the endpoint is known to work', async () => {
    const { promise, fake } = run({ following: accounts('1', '3') }, ['1', 'gone', '3']);
    const result = await promise;
    expect(result.outcome).toBe('completed');
    expect(result.results.map(r => [r.pk, r.outcome])).toEqual([
      ['1', 'unfollowed'],
      ['gone', 'not_found'],
      ['3', 'unfollowed'],
    ]);
    expect(fake.unfollowed).toEqual(['1', '3']);
  });

  it('never counts an HTML page as success', async () => {
    const { promise, fake } = run(
      { following: accounts('1'), intercept: r => (r.method === 'POST' && r.path.startsWith('/web/') ? html('<html/>') : undefined), destroyGone: true },
      ['1'],
    );
    const result = await promise;
    expect(result.results.some(r => r.outcome === 'unfollowed')).toBe(false);
    expect(fake.unfollowed).toEqual([]);
    expect(result.outcome).toBe('error');
    expect(result.remaining).toEqual(['1']);
  });

  it('falls back when the current endpoint answers a bare JSON 404 (seen on a real account)', async () => {
    const { promise, fake } = run({ following: accounts('1', '2'), destroy404: true }, ['1', '2']);
    const result = await promise;
    expect(result.outcome).toBe('completed');
    expect(result.endpoint).toBe('web');
    expect(fake.unfollowed).toEqual(['1', '2']);
  });

  it('stops without skipping through the selection when neither endpoint works', async () => {
    const { promise, fake } = run(
      {
        following: accounts('1', '2', '3'),
        destroy404: true,
        intercept: r => (r.method === 'POST' && r.path.startsWith('/web/') ? json({ status: 'fail' }, 404) : undefined),
      },
      ['1', '2', '3'],
    );
    const result = await promise;
    expect(result.outcome).toBe('error');
    expect(result.results).toEqual([]);
    expect(result.remaining).toEqual(['1', '2', '3']);
    expect(result.message).toMatch(/destroy: HTTP 404.*web: HTTP 404/);
    expect(fake.unfollowed).toEqual([]);
  });

  it('double-checks each unfollow and fails it if Instagram says ok but the follow remains', async () => {
    const { promise } = run(
      {
        following: accounts('1'),
        intercept: r => (r.method === 'POST' ? json({ status: 'ok' }) : undefined),
        friendships: { '1': { following: true, followed_by: false } },
      },
      ['1'],
    );
    const result = await promise;
    expect(result.results[0]).toMatchObject({ pk: '1', outcome: 'failed' });
    expect(result.results[0]?.detail).toMatch(/still follow/);
  });

  it('retries once after a network error', async () => {
    const fake = createFakeInstagram({ following: accounts('1') });
    let failed = false;
    const result = await runUnfollows({
      client: {
        ...fake.client,
        fetch: (input, init) => {
          if (!failed && init?.method === 'POST') {
            failed = true;
            return Promise.reject(new TypeError('offline'));
          }
          return fake.client.fetch(input, init);
        },
      },
      viewerId: fake.viewerId,
      pks: ['1'],
      maxUnfollows: 10,
      sleep: async () => undefined,
    });
    expect(result.outcome).toBe('completed');
    expect(fake.unfollowed).toEqual(['1']);
  });

  it('does not go over the allowed number of unfollows', async () => {
    const { promise, fake } = run({ following: accounts('1', '2', '3') }, ['1', '2', '3'], { maxUnfollows: 2 });
    const result = await promise;
    expect(result.outcome).toBe('limit');
    expect(fake.unfollowed).toEqual(['1', '2']);
    expect(result.remaining).toEqual(['3']);
  });

  it('stops when asked and reports what is left', async () => {
    const controller = new AbortController();
    const { promise, fake } = run({ following: accounts('1', '2', '3') }, ['1', '2', '3'], {
      signal: controller.signal,
      sleep: async () => controller.abort(),
    });
    const result = await promise;
    expect(result.outcome).toBe('stopped');
    expect(fake.unfollowed).toEqual(['1']);
    expect(result.remaining).toEqual(['2', '3']);
  });

  it('marks it failed if Instagram still reports the follow', async () => {
    const { promise } = run(
      { following: accounts('1'), intercept: r => (r.method === 'POST' ? json({ friendship_status: { following: true }, status: 'ok' }) : undefined) },
      ['1'],
    );
    expect((await promise).results[0]?.outcome).toBe('failed');
  });

  it('does nothing without a signed-in account, and ignores duplicates', async () => {
    const none = await run({ following: accounts('1') }, ['1'], { viewerId: null }).promise;
    expect(none.outcome).toBe('no_session');
    const { promise, fake } = run({ following: accounts('1') }, ['1', '1']);
    await promise;
    expect(fake.unfollowed).toEqual(['1']);
  });
});
