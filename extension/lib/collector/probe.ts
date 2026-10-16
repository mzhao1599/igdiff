/**
 * Read-only health check of the endpoints the collector depends on, requested
 * exactly the way a sync requests them (same sort order).
 *
 * Makes at most five requests (profile, first page of each list, one small bulk
 * friendship check, one single friendship check) and reports status, latency
 * and response shape. The report carries no usernames or ids, so it is safe to
 * paste into a bug report.
 */
import {
  fetchFriendshipStatus,
  fetchFriendshipStatuses,
  fetchListPage,
  fetchProfile,
  isOkStatus,
  type ApiResult,
  type FailureInfo,
  type InstagramClient,
  type ListKind,
  type ListOrder,
  type ListPageShape,
  type ResponseInfo,
} from '../instagram/api';
import type { InstagramSession } from '../instagram/session';
import { DEFAULT_COLLECTOR_SETTINGS } from './collect';

export type ProbeVerdict = 'ok' | 'degraded' | 'failed' | 'signed_out';

export interface ProbeStep {
  readonly name: string;
  readonly endpoint: string;
  readonly status: number;
  readonly ok: boolean;
  readonly ms: number;
  readonly notes: readonly string[];
  readonly failure: FailureInfo | null;
  readonly response: ResponseInfo | null;
  readonly shape?: ListPageShape;
}

export interface ProbeReport {
  readonly ranAt: string;
  readonly verdict: ProbeVerdict;
  readonly session: { readonly signedIn: boolean; readonly hasCsrfToken: boolean };
  readonly steps: readonly ProbeStep[];
}

export interface ProbeOptions {
  readonly client: InstagramClient;
  readonly session: InstagramSession;
  readonly pageSize?: number;
  /** Defaults to the order a sync uses. */
  readonly order?: ListOrder | null;
  readonly now?: () => number;
}

async function timed<T>(now: () => number, run: () => Promise<ApiResult<T>>): Promise<{ result: ApiResult<T>; ms: number }> {
  const started = now();
  const result = await run();
  return { result, ms: Math.round(now() - started) };
}

/** "text/html, 2.4 kB HTML" style summary of a response that was not usable data. */
export function describeResponse(response: ResponseInfo | undefined | null): string {
  if (!response) {
    return 'no response (network error)';
  }
  const size = response.bytes >= 1024 ? `${(response.bytes / 1024).toFixed(1)} kB` : `${response.bytes} B`;
  return `${response.contentType ?? 'no content-type'}, ${size}, body: ${response.bodyKind}`;
}

function listFlagNotes(shape: ListPageShape): string[] {
  const notes: string[] = [];
  if (shape.hiddenCount !== null) {
    notes.push(`Instagram hides ${shape.hiddenCount} accounts from this list`);
  }
  if (shape.pageSizeField !== null) {
    notes.push(`page_size ${shape.pageSizeField}`);
  }
  if (shape.shouldLimitFollowers || shape.shouldLimitFollowings) {
    notes.push('Instagram flags this list as limited');
  }
  return notes;
}

function cursorNote(shape: ListPageShape): string | null {
  switch (shape.cursorKind) {
    case null:
      return null;
    case 'numeric':
      return shape.cursorLooksLikeOffset ? 'cursor is a plain offset' : 'cursor is numeric (not the page size)';
    case 'json':
      return 'cursor is a JSON object';
    default:
      return 'cursor is opaque';
  }
}

export async function runProbe(options: ProbeOptions): Promise<ProbeReport> {
  const now = options.now ?? (() => performance.now());
  const { client, session } = options;
  const ranAt = new Date().toISOString();
  const sessionInfo = { signedIn: session.viewerId !== null, hasCsrfToken: session.csrfToken !== null };
  if (!session.viewerId) {
    return { ranAt, verdict: 'signed_out', session: sessionInfo, steps: [] };
  }
  const viewerId = session.viewerId;
  const steps: ProbeStep[] = [];
  const failureNotes = (result: ApiResult<unknown>, ok: boolean) =>
    ok ? [] : [`response: ${describeResponse(result.response)}`];

  const profile = await timed(now, () => fetchProfile(client, viewerId));
  const reported = profile.result.data;
  steps.push({
    name: 'Profile counts',
    endpoint: 'GET /api/v1/users/{id}/info/',
    status: profile.result.status,
    ok: reported !== null,
    ms: profile.ms,
    failure: profile.result.failure,
    response: profile.result.response ?? null,
    notes: reported
      ? [
          `follower_count ${reported.followerCount === null ? 'missing' : 'present'}`,
          `following_count ${reported.followingCount === null ? 'missing' : 'present'}`,
        ]
      : failureNotes(profile.result, false),
  });

  const order = options.order === undefined ? DEFAULT_COLLECTOR_SETTINGS.listOrder : options.order;
  let samplePks: string[] = [];
  for (const kind of ['following', 'followers'] as ListKind[]) {
    const page = await timed(now, () => fetchListPage(client, viewerId, kind, { count: options.pageSize, order }));
    const data = page.result.data;
    const reportedTotal = kind === 'following' ? reported?.followingCount : reported?.followerCount;
    const notes: string[] = [];
    let ok = data !== null;
    if (data) {
      notes.push(`${data.users.length} users on page 1 (${data.shape.rawUserCount} raw)`);
      notes.push(data.nextMaxId ? 'next page cursor present' : 'no next page cursor');
      const cursor = cursorNote(data.shape);
      if (cursor) {
        notes.push(cursor);
      }
      notes.push(`friendship_status on ${data.shape.usersWithFriendshipStatus}/${data.shape.rawUserCount} users`);
      notes.push(data.shape.hasRankToken ? 'ranking token present' : 'no ranking token');
      notes.push(...listFlagNotes(data.shape));
      if (data.users.length === 0 && reportedTotal !== null && reportedTotal !== undefined && reportedTotal > 0) {
        ok = false;
        notes.push(`empty page although the profile reports ${reportedTotal}: list endpoint looks blocked`);
      }
      if (kind === 'following') {
        samplePks = data.users.slice(0, 5).map(user => user.pk);
      }
    } else {
      notes.push(...failureNotes(page.result, false));
    }
    steps.push({
      name: kind === 'following' ? 'Following list, page 1' : 'Followers list, page 1',
      endpoint: `GET /api/v1/friendships/{id}/${kind}/${order ? `?order=${order}` : ''}`,
      status: page.result.status,
      ok,
      ms: page.ms,
      failure: page.result.failure,
      response: page.result.response ?? null,
      notes,
      ...(data ? { shape: data.shape } : {}),
    });
  }

  const samplePk = samplePks[0];
  if (samplePk !== undefined) {
    const many = await timed(now, () => fetchFriendshipStatuses(client, samplePks));
    const statuses = many.result.data;
    const manyOk = statuses !== null && isOkStatus(many.result.status);
    const withFlag = statuses ? Array.from(statuses.values()).filter(flags => flags.followedBy !== null).length : 0;
    steps.push({
      name: 'Bulk friendship check',
      endpoint: 'POST /api/v1/friendships/show_many/',
      status: many.result.status,
      ok: manyOk,
      ms: many.ms,
      failure: many.result.failure,
      response: many.result.response ?? null,
      notes: statuses
        ? [`${statuses.size}/${samplePks.length} statuses returned`, `followed_by present on ${withFlag}`]
        : failureNotes(many.result, false),
    });

    const single = await timed(now, () => fetchFriendshipStatus(client, samplePk));
    const flags = single.result.data;
    steps.push({
      name: 'Single friendship check',
      endpoint: 'GET /api/v1/friendships/show/{id}/',
      status: single.result.status,
      ok: flags !== null,
      ms: single.ms,
      failure: single.result.failure,
      response: single.result.response ?? null,
      notes: flags
        ? [`followed_by ${flags.followedBy === null ? 'missing' : 'present'}`, `following ${flags.following === null ? 'missing' : 'present'}`]
        : failureNotes(single.result, false),
    });
  }

  const listsOk = steps.filter(step => step.endpoint.includes('/friendships/{id}/')).every(step => step.ok);
  const verdict: ProbeVerdict = !listsOk ? 'failed' : steps.every(step => step.ok) ? 'ok' : 'degraded';
  return { ranAt, verdict, session: sessionInfo, steps };
}
