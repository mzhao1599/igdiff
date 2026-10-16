import { render } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { DAILY_UNFOLLOW_LIMIT } from '../../lib/actions/limits';
import type { UnfollowJob } from '../../lib/actions/state';
import type { UnfollowProgress } from '../../lib/actions/unfollow';
import type { CollectionProgress } from '../../lib/collector/collect';
import { DIAGNOSTICS_ENABLED } from '../../lib/env';
import { INSTAGRAM_ORIGIN } from '../../lib/instagram/api';
import {
  sendToBackground,
  type Broadcast,
  type EnvStatus,
  type SchedulerStatus,
  type SyncStartResponse,
  type UnfollowStartError,
  type UnfollowStartResponse,
  type UnfollowStatus,
} from '../../lib/messages';
import {
  estimateUnfollowMs,
  formatAgo,
  formatDuration,
  groupByDay,
  listsCsv,
  matchesSearch,
  panelLists,
  recentUnfollowers,
  selectable,
  type PanelLists,
} from '../../lib/panel/view';
import { computeRelationships } from '../../lib/tracker/diff';
import {
  TrackerStore,
  type ActionRecord,
  type EventRecord,
  type LatestSnapshot,
  type ProfileRecord,
} from '../../lib/tracker/store';
import './style.css';

const storePromise = TrackerStore.open();
const PAGE_SIZE = 100;

type Tab = 'nfb' | 'fans' | 'mutuals' | 'changes';

interface Data {
  readonly viewerId: string;
  readonly username: string | null;
  readonly latest: LatestSnapshot | null;
  readonly lists: PanelLists | null;
  readonly profiles: ReadonlyMap<string, ProfileRecord>;
  readonly keep: ReadonlySet<string>;
  readonly events: readonly EventRecord[];
  /** Unfollow attempts since the latest snapshot, newest first. */
  readonly actions: readonly ActionRecord[];
}

async function loadData(viewerId: string): Promise<Data> {
  const db = await storePromise;
  const [account, latest, keep, events] = await Promise.all([
    db.getAccount(viewerId),
    db.getLatestSnapshot(viewerId),
    db.listKeep(viewerId),
    db.listEvents(viewerId, 300),
  ]);
  const actions = latest ? await db.listActions(viewerId, latest.takenAt) : [];
  const lists = latest ? panelLists(computeRelationships(latest), actions) : null;
  const pks = new Set([
    ...actions.map(action => action.pk),
    ...(lists?.notFollowingBack ?? []),
    ...(lists?.fans ?? []),
    ...(lists?.mutuals ?? []),
    ...events.map(event => event.pk),
  ]);
  const profiles = await db.getProfiles(viewerId, Array.from(pks));
  return { viewerId, username: account?.username ?? null, latest, lists, profiles, keep, events, actions };
}

const START_ERRORS: Record<UnfollowStartError, string> = {
  no_instagram_tab: 'Open instagram.com in a tab. Unfollowing runs there, with your own session.',
  content_script_missing: 'Reload your Instagram tab, then try again.',
  signed_out: 'Sign in to Instagram in your Instagram tab, then try again.',
  wrong_account: 'Your Instagram tab is signed in to a different account than the one shown here.',
  already_running: 'Unfollowing is already running.',
  nothing_to_do: 'Nothing to unfollow: the selected accounts are all kept.',
  blocked: 'Instagram blocked unfollowing for now.',
  daily_limit: `You reached today's limit of ${DAILY_UNFOLLOW_LIMIT} unfollows.`,
};

const EVENT_TEXT: Record<EventRecord['type'], (who: string) => string> = {
  follower_lost: who => `${who} unfollowed you`,
  follower_gained: who => `${who} followed you`,
  following_removed: who => `You unfollowed ${who}`,
  following_added: who => `You followed ${who}`,
};

function formatClock(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function Avatar({ profile }: { profile: ProfileRecord | undefined }) {
  const [broken, setBroken] = useState(false);
  if (!profile?.profilePicUrl || broken) {
    return <div class='avatar'>{(profile?.username ?? '?').slice(0, 1).toUpperCase()}</div>;
  }
  return (
    <img
      class='avatar'
      src={profile.profilePicUrl}
      alt=''
      loading='lazy'
      referrerpolicy='no-referrer'
      onError={() => setBroken(true)}
    />
  );
}

function Who({ pk, profile }: { pk: string; profile: ProfileRecord | undefined }) {
  return (
    <div class='who'>
      {profile ? (
        <a href={`${INSTAGRAM_ORIGIN}/${encodeURIComponent(profile.username)}/`} target='_blank' rel='noreferrer'>
          @{profile.username}
        </a>
      ) : (
        <span>id {pk}</span>
      )}
      {profile?.isVerified && (
        <span class='verified' title='Verified'>
          ✓
        </span>
      )}
      {profile?.fullName && <div class='name'>{profile.fullName}</div>}
    </div>
  );
}

function SyncLine({
  env,
  scheduler,
  progress,
  now,
}: {
  env: EnvStatus | null;
  scheduler: SchedulerStatus | null;
  progress: CollectionProgress | null;
  now: number;
}) {
  if (progress && progress.phase !== 'done') {
    const total = progress.reportedFollowers;
    return (
      <div class='sync-line'>
        <span class='spinner' />
        Syncing… {progress.followers}
        {total ? ` of ${total}` : ''} followers
      </div>
    );
  }
  if (scheduler?.running) {
    return (
      <div class='sync-line'>
        <span class='spinner' />
        Syncing…
      </div>
    );
  }
  const parts: string[] = [];
  parts.push(scheduler?.lastSyncAt ? `Synced ${formatAgo(scheduler.lastSyncAt, now)}` : 'Not synced yet');
  const next = scheduler?.next;
  if (next?.action === 'wait' && next.reason === 'fresh' && next.until) {
    parts.push(`next ${formatClock(next.until)}`);
  } else if (next?.action === 'wait' && next.reason === 'disabled') {
    parts.push('automatic sync off');
  }
  if (env?.problem === 'no_instagram_tab') {
    parts.push('open Instagram to sync');
  }
  return <div class='sync-line'>{parts.join(' · ')}</div>;
}

function Failures({ failures }: { failures: ReadonlyArray<{ readonly who: string; readonly detail: string | null }> }) {
  if (failures.length === 0) {
    return null;
  }
  return (
    <div class='sync-line' style={{ display: 'block' }}>
      {failures.slice(0, 3).map(failure => (
        <div key={failure.who}>
          Couldn't unfollow {failure.who}
          {failure.detail ? `: ${failure.detail}` : ''}
        </div>
      ))}
      {failures.length > 3 && <div>and {failures.length - 3} more</div>}
    </div>
  );
}

function JobBanner({
  job,
  progress,
  failures,
  now,
  onStop,
  onResume,
  onDismiss,
}: {
  job: UnfollowJob;
  progress: UnfollowProgress | null;
  failures: ReadonlyArray<{ readonly who: string; readonly detail: string | null }>;
  now: number;
  onStop: () => void;
  onResume: () => void;
  onDismiss: () => void;
}) {
  const done = job.total - job.queue.length;
  const percent = job.total ? Math.round((done / job.total) * 100) : 0;
  if (job.status === 'running') {
    const waiting = progress?.waiting;
    const left = waiting ? Math.max(0, waiting.endsAt - now) : 0;
    return (
      <div class='notice'>
        <b>
          Unfollowing… {job.unfollowed} of {job.total}
        </b>
        <div class='progress'>
          <div style={{ width: `${percent}%` }} />
        </div>
        <div class='sync-line'>
          {waiting
            ? waiting.reason === 'pause'
              ? `Taking a short break, ${formatDuration(left)} left`
              : `Next in ${formatDuration(left)}`
            : 'Working…'}
          {' · keep your Instagram tab open'}
        </div>
        <div class='actions'>
          <button onClick={onStop}>Stop</button>
        </div>
      </div>
    );
  }
  if (job.status === 'paused') {
    return (
      <div class={`notice ${job.outcome === 'blocked' ? 'bad' : 'warn'}`}>
        <b>
          Paused with {job.queue.length} left ({job.unfollowed} unfollowed)
        </b>
        {job.message && <div class='sync-line'>{job.message}</div>}
        <Failures failures={failures} />
        <div class='actions'>
          <button class='primary' onClick={onResume}>
            Resume
          </button>
          <button onClick={onDismiss}>Discard the rest</button>
        </div>
      </div>
    );
  }
  return (
    <div class={`notice${job.unfollowed === 0 ? ' bad' : job.skipped ? ' warn' : ''}`}>
      <b>
        Done: {job.unfollowed} unfollowed{job.skipped ? `, ${job.skipped} not` : ''}.
      </b>
      <Failures failures={failures} />
      {job.unfollowed > 0 && <div class='sync-line'>They'll show as "You unfollowed" after the next sync.</div>}
      <div class='actions'>
        <button onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

function download(filename: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function SettingsView({
  data,
  scheduler,
  unfollow,
  onChanged,
}: {
  data: Data;
  scheduler: SchedulerStatus | null;
  unfollow: UnfollowStatus | null;
  onChanged: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const stamp = new Date().toISOString().slice(0, 10);
  const name = data.username ?? data.viewerId;

  const toggleAuto = async (enabled: boolean) => {
    await sendToBackground({ type: 'scheduler:set', enabled });
    onChanged();
  };

  const exportJson = async () => {
    const everything = await (await storePromise).exportAccount(data.viewerId);
    download(`follower-tracker-${name}-${stamp}.json`, 'application/json', JSON.stringify(everything, null, 2));
  };

  const deleteAll = async () => {
    await (await storePromise).deleteAccount(data.viewerId);
    await sendToBackground({ type: 'badge:clear', viewerId: data.viewerId });
    setConfirmDelete(false);
    onChanged();
  };

  return (
    <div class='settings'>
      <section>
        <h3>Automatic sync</h3>
        <label class='check'>
          <input
            type='checkbox'
            checked={scheduler?.enabled ?? true}
            onChange={event => void toggleAuto((event.currentTarget as HTMLInputElement).checked)}
          />
          Sync once a day while an Instagram tab is open
        </label>
        <p class='muted'>
          {scheduler
            ? `${scheduler.budgetUsed} of ${scheduler.dailyBudget} sync requests used today.`
            : 'Loading…'}
        </p>
      </section>
      <section>
        <h3>Unfollowing</h3>
        <p class='muted'>
          {unfollow ? `${unfollow.today} of ${DAILY_UNFOLLOW_LIMIT} unfollows used today.` : 'Loading…'} Accounts you star
          are never unfollowed.
        </p>
      </section>
      <section>
        <h3>Your data</h3>
        <p class='muted'>Everything stays in this browser. Export it any time.</p>
        <div class='buttons'>
          <button
            disabled={!data.lists}
            onClick={() => data.lists && download(`follower-tracker-${name}-${stamp}.csv`, 'text/csv', listsCsv(data.lists, data.profiles, data.keep))}
          >
            Export lists (CSV)
          </button>
          <button onClick={() => void exportJson()}>Export everything (JSON)</button>
        </div>
        <div class='buttons'>
          {confirmDelete ? (
            <>
              <span>Delete all history for @{name}?</span>
              <button class='danger' onClick={() => void deleteAll()}>
                Delete
              </button>
              <button onClick={() => setConfirmDelete(false)}>Cancel</button>
            </>
          ) : (
            <button class='danger' onClick={() => setConfirmDelete(true)}>
              Delete this account's data
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function ConfirmSheet({
  count,
  remainingToday,
  onCancel,
  onConfirm,
}: {
  count: number;
  remainingToday: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const runs = Math.min(count, remainingToday);
  return (
    <div class='sheet-backdrop' onClick={onCancel}>
      <div class='sheet' role='dialog' aria-modal='true' onClick={event => event.stopPropagation()}>
        <h2>
          Unfollow {count} {count === 1 ? 'account' : 'accounts'}?
        </h2>
        <p>
          It runs in your Instagram tab at a deliberately slow pace, about {formatDuration(estimateUnfollowMs(runs))}.
          You can stop at any time.
        </p>
        {count > remainingToday && (
          <p>
            Only {remainingToday} more are allowed today. The rest stay queued and you can resume tomorrow.
          </p>
        )}
        <p>If Instagram pushes back, it stops right away and waits a day.</p>
        <div class='actions'>
          <button onClick={onCancel}>Cancel</button>
          <button class='primary' onClick={onConfirm}>
            Unfollow {count}
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [unfollow, setUnfollow] = useState<UnfollowStatus | null>(null);
  const [syncProgress, setSyncProgress] = useState<CollectionProgress | null>(null);
  const [unfollowProgress, setUnfollowProgress] = useState<UnfollowProgress | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [tab, setTab] = useState<Tab>('nfb');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmingRow, setConfirmingRow] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<'main' | 'settings'>('main');

  const liveViewerId = env?.collector?.viewerId ?? null;

  const refreshStatus = useCallback(async (forViewer: string | null) => {
    const [schedulerStatus, unfollowStatus] = await Promise.all([
      sendToBackground<SchedulerStatus>({ type: 'scheduler:status' }),
      sendToBackground<UnfollowStatus>({ type: 'unfollow:status', viewerId: forViewer }),
    ]);
    setScheduler(schedulerStatus);
    setUnfollow(unfollowStatus);
  }, []);

  const refreshAll = useCallback(async () => {
    const status = await sendToBackground<EnvStatus>({ type: 'env:status' });
    setEnv(status);
    let viewer = status.collector?.viewerId ?? null;
    if (!viewer) {
      viewer = (await (await storePromise).listAccounts())[0]?.viewerId ?? null;
    }
    setViewerId(viewer);
    setData(viewer ? await loadData(viewer) : null);
    setLoaded(true);
    await refreshStatus(viewer);
  }, [refreshStatus]);

  const refreshData = useCallback(async () => {
    if (viewerId) {
      setData(await loadData(viewerId));
    }
  }, [viewerId]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // Whatever this panel shows has been seen: clear the toolbar badge for it, now and whenever it is shown again.
  useEffect(() => {
    if (!viewerId) {
      return;
    }
    const clear = () => {
      if (document.visibilityState === 'visible') {
        void sendToBackground({ type: 'badge:clear', viewerId });
      }
    };
    clear();
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, [viewerId, data]);

  useEffect(() => {
    // Listen only: never return true here, or this page would swallow replies meant for the background.
    const onMessage = (message: unknown) => {
      const msg = message as Broadcast;
      switch (msg.type) {
        case 'collector:progress':
          setSyncProgress(msg.progress);
          break;
        case 'collector:finished':
          setSyncProgress(null);
          break;
        case 'sync:committed':
          void refreshData();
          void refreshStatus(viewerId);
          break;
        case 'scheduler:changed':
          void refreshStatus(viewerId);
          break;
        case 'unfollow:progress':
          setUnfollowProgress(msg.progress);
          break;
        case 'unfollow:finished':
          setUnfollowProgress(null);
          break;
        case 'unfollow:changed':
          void refreshStatus(viewerId);
          void refreshData();
          break;
        default:
          break;
      }
    };
    const onTabUpdated = (_tabId: number, change: { status?: string }) => {
      if (change.status === 'complete') {
        void refreshAll();
      }
    };
    const onTabRemoved = () => void refreshAll();
    browser.runtime.onMessage.addListener(onMessage);
    browser.tabs.onUpdated.addListener(onTabUpdated);
    browser.tabs.onRemoved.addListener(onTabRemoved);
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      browser.tabs.onUpdated.removeListener(onTabUpdated);
      browser.tabs.onRemoved.removeListener(onTabRemoved);
    };
  }, [refreshAll, refreshData, refreshStatus, viewerId]);

  const job = unfollow?.job && unfollow.job.viewerId === viewerId ? unfollow.job : null;
  const busy = job?.status === 'running' || (syncProgress !== null && syncProgress.phase !== 'done');
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), busy ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [busy]);

  const list = useMemo(() => {
    if (!data?.lists) {
      return [];
    }
    const source = tab === 'fans' ? data.lists.fans : tab === 'mutuals' ? data.lists.mutuals : data.lists.notFollowingBack;
    return source.filter(pk => matchesSearch(data.profiles.get(pk), query));
  }, [data, tab, query]);

  const canUnfollow = viewerId !== null && liveViewerId === viewerId && job?.status !== 'running';
  const allowance = unfollow?.allowance ?? null;
  const remainingToday = allowance?.allowed ? allowance.remaining : 0;
  const keep = data?.keep ?? new Set<string>();
  const visibleSelectable = selectable(list, keep);
  const allSelected = visibleSelectable.length > 0 && visibleSelectable.every(pk => selected.has(pk));

  const switchTab = (next: Tab) => {
    setTab(next);
    setShown(PAGE_SIZE);
    setConfirmingRow(null);
  };

  const toggleSelected = (pk: string) => {
    const next = new Set(selected);
    if (next.has(pk)) {
      next.delete(pk);
    } else {
      next.add(pk);
    }
    setSelected(next);
  };

  const toggleKeep = async (pk: string) => {
    if (!viewerId || !data) {
      return;
    }
    const kept = data.keep.has(pk);
    await (await storePromise).setKeep(viewerId, [pk], !kept, Date.now());
    const nextKeep = new Set(data.keep);
    if (kept) {
      nextKeep.delete(pk);
    } else {
      nextKeep.add(pk);
      const nextSelected = new Set(selected);
      nextSelected.delete(pk);
      setSelected(nextSelected);
    }
    setData({ ...data, keep: nextKeep });
  };

  const startUnfollow = async (pks: readonly string[]) => {
    if (!viewerId) {
      return;
    }
    setNotice(null);
    const response = await sendToBackground<UnfollowStartResponse>({ type: 'unfollow:start', viewerId, pks });
    if (response.ok) {
      setSelected(new Set());
      setConfirmingRow(null);
      setSheetOpen(false);
    } else {
      setSheetOpen(false);
      setNotice(
        `${START_ERRORS[response.error]}${response.until ? ` Try again after ${formatClock(response.until)}.` : ''}`,
      );
    }
    await refreshStatus(viewerId);
  };

  const syncNow = async () => {
    setNotice(null);
    const response = await sendToBackground<SyncStartResponse>({ type: 'sync:start' });
    if (!response.ok) {
      setNotice(
        response.error === 'budget'
          ? "Today's sync budget is used up. It continues tomorrow."
          : response.error === 'already_running'
            ? 'A sync is already running.'
            : 'Open instagram.com in a tab and sign in to sync.',
      );
    }
    await refreshStatus(viewerId);
  };

  const unfollowersRecent = data ? recentUnfollowers(data.events, now) : 0;
  const stats: Array<{ key: Tab; value: number; label: string }> = [
    { key: 'nfb', value: data?.lists?.notFollowingBack.length ?? 0, label: "don't follow back" },
    { key: 'fans', value: data?.lists?.fans.length ?? 0, label: 'fans' },
    { key: 'mutuals', value: data?.lists?.mutuals.length ?? 0, label: 'mutuals' },
    { key: 'changes', value: unfollowersRecent, label: 'unfollowed you (30 d)' },
  ];

  return (
    <div class='app'>
      <header class='top'>
        <div class='top-row'>
          <div>
            <div class='brand'>Follower Tracker</div>
            {data?.username && <div class='account'>@{data.username}</div>}
          </div>
          <div class='header-buttons'>
            <button onClick={() => void syncNow()} disabled={busy || env?.problem !== null}>
              Sync now
            </button>
            <button
              class='icon'
              aria-label='Settings'
              aria-pressed={view === 'settings'}
              title='Settings'
              onClick={() => setView(view === 'settings' ? 'main' : 'settings')}
            >
              <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' aria-hidden='true'>
                <circle cx='12' cy='12' r='3' />
                <path d='M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z' />
              </svg>
            </button>
          </div>
        </div>
        <SyncLine env={env} scheduler={scheduler} progress={syncProgress} now={now} />
      </header>

      {view === 'settings' && data ? (
        <SettingsView
          data={data}
          scheduler={scheduler}
          unfollow={unfollow}
          onChanged={() => void refreshAll()}
        />
      ) : (
        <>
      {data?.lists && (
        <div class='stats'>
          {stats.map(stat => (
            <button key={stat.key} class='stat' aria-pressed={tab === stat.key} onClick={() => switchTab(stat.key)}>
              <b>{stat.value}</b>
              <span>{stat.label}</span>
            </button>
          ))}
        </div>
      )}

      {notice && <div class='notice bad'>{notice}</div>}
      {allowance && !allowance.allowed && allowance.reason === 'blocked' && (
        <div class='notice bad'>Instagram blocked unfollowing. You can try again after {formatClock(allowance.until)}.</div>
      )}
      {viewerId && liveViewerId && liveViewerId !== viewerId && (
        <div class='notice warn'>Your Instagram tab is signed in to a different account than the one shown.</div>
      )}
      {job && (
        <JobBanner
          job={job}
          progress={unfollowProgress}
          failures={(data?.actions ?? [])
            .filter(action => action.at >= job.startedAt && action.outcome !== 'unfollowed')
            .map(action => ({
              who: `@${data?.profiles.get(action.pk)?.username ?? action.pk}`,
              detail: action.detail,
            }))}
          now={now}
          onStop={() => void sendToBackground({ type: 'unfollow:stop' })}
          onResume={() => void sendToBackground<UnfollowStartResponse>({ type: 'unfollow:resume' }).then(response => {
            if (!response.ok) {
              setNotice(START_ERRORS[response.error]);
            }
          })}
          onDismiss={() => void sendToBackground({ type: 'unfollow:discard' }).then(() => refreshStatus(viewerId))}
        />
      )}

      {!loaded ? (
        <div class='empty'>Loading…</div>
      ) : !data?.lists ? (
        <div class='empty'>
          {env?.problem === 'no_instagram_tab'
            ? 'Open instagram.com in a tab and sign in. Your first sync starts automatically.'
            : 'Your first sync starts automatically in a few seconds, or press Sync now.'}
        </div>
      ) : tab === 'changes' ? (
        <ChangesList events={data.events} profiles={data.profiles} />
      ) : (
        <>
          <div class='toolbar'>
            {tab === 'nfb' && (
              <input
                type='checkbox'
                aria-label='Select all shown, except kept accounts'
                title='Select all shown (kept accounts are skipped)'
                checked={allSelected}
                disabled={!canUnfollow || visibleSelectable.length === 0}
                onChange={() => setSelected(allSelected ? new Set() : new Set(visibleSelectable))}
              />
            )}
            <input
              type='search'
              placeholder='Search'
              value={query}
              onInput={event => {
                setQuery((event.currentTarget as HTMLInputElement).value);
                setShown(PAGE_SIZE);
              }}
            />
          </div>
          {list.length === 0 ? (
            <div class='empty'>{query ? 'No matches.' : tab === 'nfb' ? 'Everyone you follow follows you back.' : 'Nobody here.'}</div>
          ) : (
            <ul class='list'>
              {list.slice(0, shown).map(pk => {
                const profile = data.profiles.get(pk);
                const kept = keep.has(pk);
                const lastAttempt = data.actions.find(action => action.pk === pk);
                return (
                  <li key={pk} class={`row${kept ? ' kept' : ''}`}>
                    {tab === 'nfb' && (
                      <input
                        type='checkbox'
                        aria-label={`Select @${profile?.username ?? pk}`}
                        checked={selected.has(pk)}
                        disabled={kept || !canUnfollow}
                        onChange={() => toggleSelected(pk)}
                      />
                    )}
                    <Avatar profile={profile} />
                    <Who pk={pk} profile={profile} />
                    {lastAttempt && lastAttempt.outcome !== 'unfollowed' && (
                      <span class='status-tag bad' title={lastAttempt.detail ?? undefined}>
                        not unfollowed
                      </span>
                    )}
                    {tab === 'nfb' && (
                      <>
                        <button
                          class='keep'
                          aria-pressed={kept}
                          title={kept ? 'Kept: never unfollowed by this tool' : 'Keep (never unfollow)'}
                          onClick={() => void toggleKeep(pk)}
                        >
                          {kept ? '★' : '☆'}
                        </button>
                        {confirmingRow === pk ? (
                          <span class='confirm'>
                            Sure?
                            <button class='danger' onClick={() => void startUnfollow([pk])}>
                              Unfollow
                            </button>
                            <button onClick={() => setConfirmingRow(null)}>No</button>
                          </span>
                        ) : (
                          <button disabled={kept || !canUnfollow} onClick={() => setConfirmingRow(pk)}>
                            Unfollow
                          </button>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {list.length > shown && (
            <button class='more' onClick={() => setShown(shown + PAGE_SIZE)}>
              Show more ({list.length - shown} left)
            </button>
          )}
        </>
      )}

      {tab === 'nfb' && selected.size > 0 && (
        <div class='selection-bar'>
          <span>
            {selected.size} selected · <button class='link' onClick={() => setSelected(new Set())}>clear</button>
          </span>
          <button class='primary' disabled={!canUnfollow || !allowance?.allowed} onClick={() => setSheetOpen(true)}>
            Unfollow {selected.size}
          </button>
        </div>
      )}

        </>
      )}

      {sheetOpen && (
        <ConfirmSheet
          count={selected.size}
          remainingToday={remainingToday}
          onCancel={() => setSheetOpen(false)}
          onConfirm={() => void startUnfollow(Array.from(selected))}
        />
      )}

      <footer>
        <span>Data stays in this browser.</span>
        {DIAGNOSTICS_ENABLED && (
          <button class='link' onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/diagnostics.html') })}>
            Diagnostics
          </button>
        )}
      </footer>
    </div>
  );
}

function ChangesList({
  events,
  profiles,
}: {
  events: readonly EventRecord[];
  profiles: ReadonlyMap<string, ProfileRecord>;
}) {
  if (events.length === 0) {
    return <div class='empty'>No changes yet. They appear after your second sync.</div>;
  }
  const groups = groupByDay(events, ms =>
    new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
  );
  return (
    <div class='list'>
      {groups.map(group => (
        <div key={group.day}>
          <div class='day'>{group.day}</div>
          {group.items.map(event => {
            const profile = profiles.get(event.pk);
            const who = profile ? `@${profile.username}` : `id ${event.pk}`;
            return (
              <div key={event.id} class='row'>
                <Avatar profile={profile} />
                <div class='who'>{EVENT_TEXT[event.type](who)}</div>
                {event.verification && (
                  <span
                    class={`status-tag ${event.verification === 'confirmed' ? 'ok' : ''}`}
                    title={
                      event.verification === 'confirmed'
                        ? 'Checked with Instagram'
                        : 'Instagram returned nothing for this account; it may be deactivated'
                    }
                  >
                    {event.verification}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
