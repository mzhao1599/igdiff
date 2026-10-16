import { describe, expect, it } from 'vitest';
import { createFakeInstagram, html, json } from '../testing/fake-instagram';
import {
  clampPageSize,
  collectRawUserIds,
  describeListShape,
  fetchFriendshipStatus,
  fetchFriendshipStatuses,
  fetchListPage,
  fetchProfile,
  normalizeUser,
  parseFollowedBy,
  parseNextMaxId,
  parseRankToken,
  parseResponseBody,
  STATUS_NETWORK_ERROR,
  STATUS_SOFT_BLOCK,
  unfollowUser,
  type InstagramClient,
} from './api';

describe('normalizeUser', () => {
  it('maps pk, username, picture and followed_by', () => {
    expect(
      normalizeUser({
        pk: 123,
        username: 'alpha',
        full_name: 'Alpha One',
        profile_pic_url: 'https://example.com/pic.jpg',
        is_private: true,
        is_verified: false,
        friendship_status: { followed_by: true, following: true },
      }),
    ).toEqual({
      pk: '123',
      ids: ['123'],
      username: 'alpha',
      fullName: 'Alpha One',
      profilePicUrl: 'https://example.com/pic.jpg',
      isPrivate: true,
      isVerified: false,
      followedBy: true,
    });
  });

  it('collects pk, pk_id and id together for matching', () => {
    const user = normalizeUser({ pk: 123, pk_id: '123', id: '17841400000000000', username: 'beta' });
    expect(user?.pk).toBe('123');
    expect(user?.ids).toEqual(['123', '17841400000000000']);
  });

  it('falls back to pk_id or id when pk is missing', () => {
    expect(normalizeUser({ pk_id: '456', username: 'beta' })?.pk).toBe('456');
    expect(normalizeUser({ id: '789', username: 'gamma' })?.pk).toBe('789');
  });

  it('prefers the HD profile picture when available', () => {
    expect(
      normalizeUser({
        pk: '1',
        username: 'delta',
        profile_pic_url: 'https://example.com/small.jpg',
        profile_pic_url_hd: 'https://example.com/hd.jpg',
      })?.profilePicUrl,
    ).toBe('https://example.com/hd.jpg');
  });

  it('returns null when there is no id or no username', () => {
    expect(normalizeUser({ username: 'no-id' })).toBeNull();
    expect(normalizeUser({ pk: '1' })).toBeNull();
  });

  it('ignores empty id values', () => {
    expect(collectRawUserIds({ pk: '', pk_id: '5', username: 'x' })).toEqual(['5']);
  });
});

describe('parseFollowedBy', () => {
  it('reads nested friendship_status.followed_by', () => {
    expect(parseFollowedBy({ friendship_status: { followed_by: false } })).toBe(false);
  });

  it('reads a root-level followed_by flag', () => {
    expect(parseFollowedBy({ followed_by: true })).toBe(true);
  });

  it('returns null when Instagram omitted the flag', () => {
    expect(parseFollowedBy({ pk: '1', username: 'x' })).toBeNull();
  });
});

describe('parseNextMaxId', () => {
  it('stringifies numeric and object cursors', () => {
    expect(parseNextMaxId({ next_max_id: 50 }, '9')).toBe('50');
    expect(parseNextMaxId({ next_max_id: { cached_index: 12 } }, '9')).toBe('{"cached_index":12}');
  });

  it('uses the last pk only when has_more is true and there is no cursor', () => {
    expect(parseNextMaxId({ has_more: true }, '99')).toBe('99');
    expect(parseNextMaxId({ big_list: true }, '99')).toBeNull();
  });
});

describe('parseRankToken', () => {
  it('reads follow_ranking_token when Instagram sent it', () => {
    expect(parseRankToken({ follow_ranking_token: 'be11c209708f4fda|5537015771|osr' })).toBe(
      'be11c209708f4fda|5537015771|osr',
    );
  });

  it('returns null when Instagram omitted it', () => {
    expect(parseRankToken({})).toBeNull();
  });
});

describe('clampPageSize', () => {
  it('keeps the requested size inside 10-200 and defaults to 50', () => {
    expect(clampPageSize(80)).toBe(80);
    expect(clampPageSize(500)).toBe(200);
    expect(clampPageSize(1)).toBe(10);
    expect(clampPageSize(undefined)).toBe(50);
    expect(clampPageSize(Number.NaN)).toBe(50);
  });
});

describe('fetchListPage', () => {
  it('sends the clamped count, cursor, rank token, csrf and app id', async () => {
    const fake = createFakeInstagram({ following: [{ pk: '1' }] });
    let headers: Record<string, string> = {};
    const client: InstagramClient = {
      ...fake.client,
      fetch: (input, init) => {
        headers = init?.headers as Record<string, string>;
        expect(init?.credentials).toBe('include');
        return fake.client.fetch(input, init);
      },
    };
    await fetchListPage(client, '1000', 'following', { count: 500, maxId: '50', rankToken: 'tok' });
    const params = fake.requests[0]!.params;
    expect(params.get('count')).toBe('200');
    expect(params.get('max_id')).toBe('50');
    expect(params.get('rank_token')).toBe('tok');
    expect(params.get('search_surface')).toBe('follow_list_page');
    expect(headers['x-csrftoken']).toBe('csrf-test');
    expect(headers['x-ig-app-id']).toBeTruthy();
  });

  it('parses users, cursor and response shape', async () => {
    const fake = createFakeInstagram({ followers: [{ pk: '1' }, { pk: '2' }, { pk: '3' }], followersChunk: 2 });
    const result = await fetchListPage(fake.client, '1000', 'followers');
    expect(result.status).toBe(200);
    expect(result.data?.users.map(u => u.pk)).toEqual(['1', '2']);
    expect(result.data?.nextMaxId).toBe('2');
    expect(result.data?.rankToken).toBe('rank-token');
    expect(result.data?.shape.topLevelKeys).toContain('users');
    expect(result.data?.shape.userKeys).toContain('username');
  });

  it('treats a 200 HTML page as a soft block instead of throwing', async () => {
    const fake = createFakeInstagram({ intercept: () => html('<html>Please wait</html>') });
    const result = await fetchListPage(fake.client, '1000', 'following');
    expect(result.status).toBe(STATUS_SOFT_BLOCK);
    expect(result.data).toBeNull();
  });

  it('treats a 200 {"status":"fail"} body as a soft block and keeps the message', async () => {
    const fake = createFakeInstagram({
      intercept: () => json({ message: 'Please wait a few minutes before you try again.', status: 'fail' }),
    });
    const result = await fetchListPage(fake.client, '1000', 'following');
    expect(result.status).toBe(STATUS_SOFT_BLOCK);
    expect(result.failure?.message).toMatch(/wait/);
  });

  it('flags a redirect to the login page as requireLogin', async () => {
    const fake = createFakeInstagram({
      intercept: () => html('<html>login</html>', 200, 'https://www.instagram.com/accounts/login/?next=x'),
    });
    const result = await fetchListPage(fake.client, '1000', 'following');
    expect(result.failure?.requireLogin).toBe(true);
  });

  it('reports checkpoint responses as a challenge', async () => {
    const fake = createFakeInstagram({
      intercept: () => json({ message: 'checkpoint_required', checkpoint_url: '/challenge/x', status: 'fail' }, 400),
    });
    const result = await fetchListPage(fake.client, '1000', 'following');
    expect(result.status).toBe(400);
    expect(result.failure?.challenge).toBe(true);
  });

  it('maps a rejected fetch to STATUS_NETWORK_ERROR', async () => {
    const client: InstagramClient = { fetch: () => Promise.reject(new TypeError('offline')), csrfToken: () => null };
    const result = await fetchListPage(client, '1000', 'following');
    expect(result.status).toBe(STATUS_NETWORK_ERROR);
  });
});

describe('fetchProfile', () => {
  it('reads username and counts', async () => {
    const fake = createFakeInstagram({ followers: [{ pk: '1' }], following: [], reportedFollowers: 7 });
    const result = await fetchProfile(fake.client, '1000');
    expect(result.data).toEqual({ pk: '1000', username: 'me', followerCount: 7, followingCount: 0 });
  });
});

describe('fetchFriendshipStatuses', () => {
  it('posts the ids and leaves accounts Instagram returned nothing for out of the map', async () => {
    const fake = createFakeInstagram({
      followers: [{ pk: '1' }],
      following: [{ pk: '2' }],
      friendships: { '3': null },
    });
    const result = await fetchFriendshipStatuses(fake.client, ['1', '2', '3']);
    expect(fake.requests[0]!.body).toBe('user_ids=1,2,3');
    expect(result.data?.get('1')).toEqual({ following: false, followedBy: true });
    expect(result.data?.get('2')).toEqual({ following: true, followedBy: false });
    expect(result.data?.has('3')).toBe(false);
  });
});

describe('parseResponseBody', () => {
  it('strips the for (;;); prefix Meta puts in front of some JSON', () => {
    const { body, info } = parseResponseBody('for (;;);{"status":"ok"}', 'application/json');
    expect(body).toEqual({ status: 'ok' });
    expect(info.bodyKind).toBe('json-prefixed');
  });

  it('labels HTML, empty and other bodies without keeping them', () => {
    expect(parseResponseBody('<!doctype html><html></html>', 'text/html').info).toEqual({
      contentType: 'text/html',
      bodyKind: 'html',
      bytes: 28,
    });
    expect(parseResponseBody('', null).info.bodyKind).toBe('empty');
    expect(parseResponseBody('oops', 'text/plain').info.bodyKind).toBe('text');
  });
});

describe('describeListShape cursor', () => {
  it('recognizes offset, opaque and object cursors', () => {
    expect(describeListShape({ users: [{}, {}], next_max_id: '2' })).toMatchObject({
      cursorKind: 'numeric',
      cursorLooksLikeOffset: true,
    });
    expect(describeListShape({ users: [{}], next_max_id: 'QVFBc2' }).cursorKind).toBe('opaque');
    expect(describeListShape({ users: [], next_max_id: { a: 1 } }).cursorKind).toBe('json');
    expect(describeListShape({ users: [] }).cursorKind).toBeNull();
  });
});

describe('fetchFriendshipStatus', () => {
  it('reads top-level flags', async () => {
    const fake = createFakeInstagram({ followers: [{ pk: '7' }] });
    const result = await fetchFriendshipStatus(fake.client, '7');
    expect(fake.requests[0]!.path).toBe('/api/v1/friendships/show/7/');
    expect(result.data).toEqual({ following: false, followedBy: true });
  });

  it('reads nested friendship_status too', async () => {
    const fake = createFakeInstagram({
      intercept: () => json({ friendship_status: { following: true, followed_by: false }, status: 'ok' }),
    });
    const result = await fetchFriendshipStatus(fake.client, '7');
    expect(result.data).toEqual({ following: true, followedBy: false });
  });

  it('returns no data for an account Instagram does not know', async () => {
    const fake = createFakeInstagram({ friendships: { '9': null } });
    const result = await fetchFriendshipStatus(fake.client, '9');
    expect(result.status).toBe(404);
    expect(result.data).toBeNull();
  });
});

describe('fetchListPage options', () => {
  it('can drop search_surface and ask for a sort order', async () => {
    const fake = createFakeInstagram({ following: [{ pk: '1' }] });
    await fetchListPage(fake.client, '1000', 'following', { searchSurface: false, order: 'date_followed_latest' });
    const params = fake.requests[0]!.params;
    expect(params.has('search_surface')).toBe(false);
    expect(params.get('order')).toBe('date_followed_latest');
  });
});

describe('describeListShape list flags', () => {
  it('reads the hidden count, page_size and limit flags', () => {
    expect(
      describeListShape({
        users: [],
        hidden_following_account_count: 6,
        page_size: 50,
        should_limit_list_of_followers: false,
        should_limit_list_of_followings: true,
      }),
    ).toMatchObject({ hiddenCount: 6, pageSizeField: 50, shouldLimitFollowers: false, shouldLimitFollowings: true });
    expect(describeListShape({ users: [] })).toMatchObject({ hiddenCount: null, pageSizeField: null });
  });
});

describe('web client headers', () => {
  it('are added to the unfollow request only, never to reads', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fake = createFakeInstagram({ following: [{ pk: '1' }] });
    const client: InstagramClient = {
      fetch: (input, init) => {
        seen.push({ url: String(input), headers: init?.headers as Record<string, string> });
        return fake.client.fetch(input, init);
      },
      csrfToken: () => 'csrf',
      webClientHeaders: () => ({ 'x-ig-www-claim': 'claim', 'x-asbd-id': '1' }),
    };
    await fetchListPage(client, '1000', 'following');
    await unfollowUser(client, '1', 'destroy');
    const [read, write] = seen;
    expect(read?.headers['x-ig-www-claim']).toBeUndefined();
    expect(write?.headers).toMatchObject({ 'x-ig-www-claim': 'claim', 'x-asbd-id': '1', 'x-csrftoken': 'csrf' });
  });
});
