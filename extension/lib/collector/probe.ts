/**
 * Read-only health check of the four endpoints the collector depends on.
 *
 * Makes at most four requests (profile, first following page, first followers
 * page, one small show_many) and reports status, latency and response shape.
 * The report carries no usernames or ids, so it is safe to paste into a bug report.
 */
import {
  fetchFriendshipStatuses,
  fetchListPage,
  fetchProfile,
  isOkStatus,
  type ApiResult,
  type FailureInfo,
  type InstagramClient,
  type ListKind,
  type ListPageShape,
} from '../instagram/api';
import type { InstagramSession } from '../instagram/session';

export type ProbeVerdict = 'ok' | 'degraded' | 'failed' | 'signed_out';

export interface ProbeStep {
  readonly name: string;
  readonly endpoint: string;
  readonly status: number;
  readonly ok: boolean;
  readonly ms: number;
  readonly notes: readonly string[];
  readonly failure: FailureInfo | null;
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
  readonly now?: () => number;
}

async function timed<T>(now: () => number, run: () => Promise<ApiResult<T>>): Promise<{ result: ApiResult<T>; ms: number }> {
  const started = now();
  const result = await run();
  return { result, ms: Math.round(now() - started) };
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

  const profile = await timed(now, () => fetchProfile(client, viewerId));
  const reported = profile.result.data;
  steps.push({
    name: 'Profile counts',
    endpoint: 'GET /api/v1/users/{id}/info/',
    status: profile.result.status,
    ok: profile.result.data !== null,
    ms: profile.ms,
    failure: profile.result.failure,
    notes: reported
      ? [
          `follower_count ${reported.followerCount === null ? 'missing' : 'present'}`,
          `following_count ${reported.followingCount === null ? 'missing' : 'present'}`,
        ]
      : [],
  });

  let samplePks: string[] = [];
  for (const kind of ['following', 'followers'] as ListKind[]) {
    const page = await timed(now, () => fetchListPage(client, viewerId, kind, { count: options.pageSize }));
    const data = page.result.data;
    const reportedTotal = kind === 'following' ? reported?.followingCount : reported?.followerCount;
    const notes: string[] = [];
    let ok = data !== null;
    if (data) {
      notes.push(`${data.users.length} users on page 1 (${data.shape.rawUserCount} raw)`);
      notes.push(data.nextMaxId ? 'next page cursor present' : 'no next page cursor');
      notes.push(`friendship_status on ${data.shape.usersWithFriendshipStatus}/${data.shape.rawUserCount} users`);
      notes.push(data.shape.hasRankToken ? 'ranking token present' : 'no ranking token');
      if (data.users.length === 0 && reportedTotal !== null && reportedTotal !== undefined && reportedTotal > 0) {
        ok = false;
        notes.push(`empty page although the profile reports ${reportedTotal}: list endpoint looks blocked`);
      }
      if (kind === 'following') {
        samplePks = data.users.slice(0, 5).map(user => user.pk);
      }
    }
    steps.push({
      name: kind === 'following' ? 'Following list, page 1' : 'Followers list, page 1',
      endpoint: `GET /api/v1/friendships/{id}/${kind}/`,
      status: page.result.status,
      ok,
      ms: page.ms,
      failure: page.result.failure,
      notes,
      ...(data ? { shape: data.shape } : {}),
    });
  }

  if (samplePks.length > 0) {
    const many = await timed(now, () => fetchFriendshipStatuses(client, samplePks));
    const statuses = many.result.data;
    const withFlag = statuses ? Array.from(statuses.values()).filter(flags => flags.followedBy !== null).length : 0;
    steps.push({
      name: 'Bulk friendship check',
      endpoint: 'POST /api/v1/friendships/show_many/',
      status: many.result.status,
      ok: statuses !== null && isOkStatus(many.result.status),
      ms: many.ms,
      failure: many.result.failure,
      notes: statuses ? [`${statuses.size}/${samplePks.length} statuses returned`, `followed_by present on ${withFlag}`] : [],
    });
  }

  const listsOk = steps.filter(step => step.endpoint.includes('/friendships/{id}/')).every(step => step.ok);
  const verdict: ProbeVerdict = !listsOk ? 'failed' : steps.every(step => step.ok) ? 'ok' : 'degraded';
  return { ranAt, verdict, session: sessionInfo, steps };
}
