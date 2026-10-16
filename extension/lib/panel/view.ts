/**
 * What the side panel shows, computed from stored data. Pure, so it is tested
 * without a browser.
 */
import { DEFAULT_UNFOLLOW_SETTINGS, type UnfollowSettings } from '../actions/unfollow';
import type { Relationships } from '../tracker/diff';
import type { ActionRecord, EventRecord, ProfileRecord } from '../tracker/store';

export interface PanelLists {
  /** You follow them, they don't follow back, and you haven't unfollowed them here since the last sync. */
  readonly notFollowingBack: readonly string[];
  readonly fans: readonly string[];
  readonly mutuals: readonly string[];
}

/**
 * Accounts the extension unfollowed after the latest snapshot drop out right
 * away; the next sync then records them as "You unfollowed". Anything that
 * failed or was skipped stays listed, so nothing looks done that isn't.
 */
export function panelLists(
  relationships: Relationships,
  actionsSinceSnapshot: readonly ActionRecord[],
): PanelLists {
  const handled = new Set(
    actionsSinceSnapshot.filter(action => action.outcome === 'unfollowed').map(action => action.pk),
  );
  return {
    notFollowingBack: relationships.notFollowingBack.filter(pk => !handled.has(pk)),
    fans: relationships.fans,
    mutuals: relationships.mutuals.filter(pk => !handled.has(pk)),
  };
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
