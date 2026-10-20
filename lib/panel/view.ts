/**
 * What the side panel shows, computed from stored data. Pure, so it is tested
 * without a browser.
 */
import { DEFAULT_UNFOLLOW_SETTINGS, type UnfollowSettings } from '../actions/unfollow';
import { computeRelationships, type FollowSets } from '../tracker/diff';
import type { ActionRecord, EventRecord, ProfileRecord, SnapshotRecord } from '../tracker/store';

export interface PanelLists {
  readonly followers: readonly string[];
  readonly following: readonly string[];
  /** You follow them and they don't follow you. */
  readonly notFollowingBack: readonly string[];
  readonly fans: readonly string[];
  readonly mutuals: readonly string[];
}

/**
 * The lists as of the latest snapshot, plus what IgDiff did since: accounts
 * unfollowed, removed or followed back here change lists right away (a mutual
 * you unfollowed becomes a fan, a fan you followed back becomes a mutual),
 * before the next sync records it. Follow requests to private accounts change
 * nothing until they're approved. Anything that failed or was skipped stays
 * where it was, so nothing looks done that isn't.
 */
export function panelLists(sets: FollowSets, actionsSinceSnapshot: readonly ActionRecord[]): PanelLists {
  const done = (type: ActionRecord['type'], outcome: ActionRecord['outcome']) =>
    new Set(actionsSinceSnapshot.filter(action => action.type === type && action.outcome === outcome).map(action => action.pk));
  const unfollowed = done('unfollow', 'unfollowed');
  const removed = done('remove_follower', 'removed');
  const followed = done('follow', 'followed');
  const followers = sets.followerIds.filter(pk => !removed.has(pk));
  const already = new Set(sets.followingIds);
  // Newest first, like Instagram's own order.
  const following = [
    ...[...followed].filter(pk => !already.has(pk) && !unfollowed.has(pk)),
    ...sets.followingIds.filter(pk => !unfollowed.has(pk)),
  ];
  return { followers, following, ...computeRelationships({ followerIds: followers, followingIds: following }) };
}

export type SortOrder = 'recent' | 'oldest' | 'az';

/**
 * `recent` keeps Instagram's order: most recently followed first for lists
 * built from your following (don't follow back, mutuals), Instagram's own
 * order (in practice newest first) for followers and fans.
 */
export function sortAccounts(
  pks: readonly string[],
  order: SortOrder,
  profiles: ReadonlyMap<string, ProfileRecord>,
): readonly string[] {
  if (order === 'oldest') {
    return [...pks].reverse();
  }
  if (order === 'az') {
    const name = (pk: string) => profiles.get(pk)?.username ?? '';
    return [...pks].sort((a, b) => name(a).localeCompare(name(b)));
  }
  return pks;
}

/** Followers gained and lost in the last `days` days. Removed followers don't count as lost. */
export function followerDiff(events: readonly EventRecord[], now: number, days = 7): { gained: number; lost: number } {
  const since = now - days * 86_400_000;
  const recent = events.filter(event => event.detectedAt >= since);
  return {
    gained: recent.filter(event => event.type === 'follower_gained').length,
    lost: recent.filter(event => event.type === 'follower_lost').length,
  };
}

/** Oldest-first follower and following counts, one point per snapshot. */
export function countSeries(
  snapshots: readonly SnapshotRecord[],
): Array<{ at: number; followers: number; following: number }> {
  return [...snapshots]
    .sort((a, b) => a.takenAt - b.takenAt)
    .map(snapshot => ({ at: snapshot.takenAt, followers: snapshot.followerCount, following: snapshot.followingCount }));
}

/** An SVG path through `values`, scaled to fill `width` x `height` (flat line for a single value). */
export function linePath(values: readonly number[], width: number, height: number, pad = 2): string {
  if (values.length === 0) {
    return '';
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (values.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (values.length - 1));
  const y = (value: number) => (max === min ? height / 2 : pad + ((max - value) * (height - 2 * pad)) / span);
  if (values.length === 1) {
    return `M${pad},${y(values[0]!)}H${width - pad}`;
  }
  return values.map((value, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(value).toFixed(1)}`).join('');
}

export function matchesSearch(profile: ProfileRecord | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase().replace(/^@/, '');
  if (!needle) {
    return true;
  }
  if (!profile) {
    return false;
  }
  return profile.username.toLowerCase().includes(needle) || profile.fullName.toLowerCase().includes(needle);
}

/** The accounts "Select all" picks: everything shown, minus kept ones. */
export function selectable(pks: readonly string[], keep: ReadonlySet<string>): string[] {
  return pks.filter(pk => !keep.has(pk));
}

/** Rough duration of unfollowing `count` accounts at the runner's pace. */
export function estimateUnfollowMs(count: number, settings: UnfollowSettings = DEFAULT_UNFOLLOW_SETTINGS): number {
  if (count <= 1) {
    return 0;
  }
  const gaps = count - 1;
  const pauses = settings.pauseEvery > 0 ? Math.floor(gaps / settings.pauseEvery) : 0;
  const averageGap = settings.delayMs + settings.jitterMs / 2;
  return (gaps - pauses) * averageGap + pauses * settings.pauseMs;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return ms <= 0 ? 'a moment' : `${Math.max(1, Math.round(ms / 1000))} s`;
  }
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function formatAgo(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export interface DayGroup<T> {
  readonly day: string;
  readonly items: readonly T[];
}

/** Groups newest-first events by local calendar day, keeping order. */
export function groupByDay(events: readonly EventRecord[], label: (ms: number) => string): Array<DayGroup<EventRecord>> {
  const groups: Array<{ day: string; items: EventRecord[] }> = [];
  for (const event of events) {
    const day = label(event.detectedAt);
    const last = groups.at(-1);
    if (last && last.day === day) {
      last.items.push(event);
    } else {
      groups.push({ day, items: [event] });
    }
  }
  return groups;
}

/** Followers lost in the last `days` days, confirmed or not. */
export function recentUnfollowers(events: readonly EventRecord[], now: number, days = 30): number {
  const since = now - days * 86_400_000;
  return events.filter(event => event.type === 'follower_lost' && event.detectedAt >= since).length;
}

/** One CSV field: quoted when it contains a comma, quote or line break; formula-looking text is defused. */
export function csvField(value: string | number | boolean): string {
  let text = String(value);
  // Spreadsheet apps run cells starting with these as formulas; usernames and names are user-controlled.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | boolean>>): string {
  return [header, ...rows].map(row => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** The three lists as one CSV, one row per account, with the list it belongs to. */
export function listsCsv(
  lists: PanelLists,
  profiles: ReadonlyMap<string, ProfileRecord>,
  keep: ReadonlySet<string>,
): string {
  const rows: Array<Array<string | boolean>> = [];
  const add = (list: string, pks: readonly string[]) => {
    for (const pk of pks) {
      const profile = profiles.get(pk);
      rows.push([
        list,
        profile?.username ?? '',
        profile?.fullName ?? '',
        profile ? `https://www.instagram.com/${profile.username}/` : '',
        profile?.isVerified ?? false,
        profile?.isPrivate ?? false,
        keep.has(pk),
        pk,
      ]);
    }
  };
  add('not_following_back', lists.notFollowingBack);
  add('fan', lists.fans);
  add('mutual', lists.mutuals);
  return toCsv(['list', 'username', 'full_name', 'profile_url', 'verified', 'private', 'kept', 'id'], rows);
}
