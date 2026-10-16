import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import type { CollectionProgress, CollectionResult } from '../../lib/collector/collect';
import type { ProbeReport } from '../../lib/collector/probe';
import { INSTAGRAM_ORIGIN } from '../../lib/instagram/api';
import {
  sendToBackground,
  type Broadcast,
  type EnvProblem,
  type EnvStatus,
  type ProbeResponse,
  type SyncStartResponse,
} from '../../lib/messages';
import { computeRelationships, type Relationships } from '../../lib/tracker/diff';
import {
  TrackerStore,
  type AccountRecord,
  type CommitOutcome,
  type EventRecord,
  type LatestSnapshot,
  type ProfileRecord,
  type SnapshotRecord,
} from '../../lib/tracker/store';
import './style.css';

const PROBLEM_HINTS: Record<EnvProblem | 'already_running', string> = {
  no_instagram_tab: 'Open https://www.instagram.com in a tab and sign in.',
  content_script_missing: 'Reload the Instagram tab. It was open before this build of the extension loaded.',
  signed_out: 'Sign in to Instagram in that tab, then refresh this page.',
  already_running: 'A sync is already running in the Instagram tab.',
};

const EVENT_LABELS: Record<EventRecord['type'], string> = {
  follower_gained: 'New follower',
  follower_lost: 'Unfollowed you',
  following_added: 'You followed',
  following_removed: 'You unfollowed',
};

const storePromise = TrackerStore.open();

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function formatSeconds(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

function coverage(listed: number, reported: number | null): string {
  if (reported === null || reported === 0) {
    return '';
  }
  return ` (${Math.round((listed / reported) * 1000) / 10}% of ${reported} reported)`;
}

function outcomeTone(outcome: string): 'ok' | 'warn' | 'bad' {
  if (outcome === 'completed' || outcome === 'committed' || outcome === 'ok') {
    return 'ok';
  }
  if (outcome === 'stopped' || outcome === 'partial' || outcome === 'degraded' || outcome === 'rejected') {
    return 'warn';
  }
  return 'bad';
}

function Badge({ value }: { value: string }) {
  return <span class={`badge ${outcomeTone(value)}`}>{value}</span>;
}

function Person({ pk, profiles }: { pk: string; profiles: ReadonlyMap<string, ProfileRecord> }) {
  const profile = profiles.get(pk);
  if (!profile) {
    return <span class='muted'>id {pk}</span>;
  }
  return (
    <a href={`${INSTAGRAM_ORIGIN}/${encodeURIComponent(profile.username)}/`} target='_blank' rel='noreferrer'>
      @{profile.username}
    </a>
  );
}

function EnvSection({ env, onRefresh }: { env: EnvStatus | null; onRefresh: () => void }) {
  return (
    <section>
      <h2>
        Instagram tab {env && <Badge value={env.problem ? 'not ready' : 'ok'} />}
      </h2>
      {env ? (
        <dl class='facts'>
          <dt>Tab</dt>
          <dd>{env.tabUrl ?? 'none found'}</dd>
          <dt>Signed-in account id</dt>
          <dd>{env.collector?.viewerId ?? '—'}</dd>
          <dt>Collector</dt>
          <dd>{env.collector ? (env.collector.running ? 'syncing' : 'idle') : 'not reachable'}</dd>
        </dl>
      ) : (
        <p class='muted'>Checking…</p>
      )}
      {env?.problem && <p class='hint'>{PROBLEM_HINTS[env.problem]}</p>}
      <div class='row' style={{ marginTop: '12px' }}>
        <button onClick={onRefresh}>Refresh</button>
      </div>
    </section>
  );
}

function ProbeSection({ ready }: { ready: boolean }) {
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await sendToBackground<ProbeResponse>({ type: 'probe:run' });
      if (response.ok) {
        setReport(response.report);
      } else {
        setError(PROBLEM_HINTS[response.error]);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Endpoint probe {report && <Badge value={report.verdict} />}</h2>
      <p class='muted'>
        Up to 4 read-only requests (profile, first page of each list, one small friendship check). The report contains
        no usernames or ids, so you can paste it into an issue.
      </p>
      <div class='row'>
        <button class='primary' disabled={!ready || busy} onClick={run}>
          {busy ? 'Probing…' : 'Run probe'}
        </button>
        {report && (
          <button onClick={() => void navigator.clipboard.writeText(JSON.stringify(report, null, 2))}>Copy report</button>
        )}
      </div>
      {error && <p class='hint'>{error}</p>}
      {report && (
        <div class='table-wrap'>
          <table style={{ marginTop: '12px' }}>
            <thead>
              <tr>
                <th>Step</th>
                <th>Status</th>
                <th>Time</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {report.steps.map(step => (
                <tr key={step.name}>
                  <td>
                    {step.name}
                    <div class='muted'>{step.endpoint}</div>
                  </td>
                  <td>
                    <Badge value={step.ok ? 'ok' : 'failed'} /> {step.status}
                  </td>
                  <td>{step.ms} ms</td>
                  <td>
                    {step.notes.join(' · ')}
                    {step.failure?.message && <div class='muted'>Instagram said: {step.failure.message}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SyncSection({
  ready,
  collectorRunning,
  progress,
  result,
  commit,
  onStarted,
}: {
  ready: boolean;
  collectorRunning: boolean;
  progress: CollectionProgress | null;
  result: CollectionResult | null;
  commit: CommitOutcome | null;
  onStarted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const running = collectorRunning || (progress !== null && progress.phase !== 'done');

  const start = async () => {
    setError(null);
    const response = await sendToBackground<SyncStartResponse>({ type: 'sync:start' });
    if (response.ok) {
      onStarted();
    } else {
      setError(PROBLEM_HINTS[response.error]);
    }
  };

  return (
    <section>
      <h2>Sync {result && <Badge value={result.outcome} />}</h2>
      <p class='muted'>
        Full read-only pass over both lists with the default pacing (about 2–3.5 s per page plus a cooldown every 5
        pages). Large accounts take a while. Only a completed sync is saved.
      </p>
      <div class='row'>
        <button class='primary' disabled={!ready || running} onClick={() => void start()}>
          Sync now
        </button>
        <button disabled={!running} onClick={() => void sendToBackground({ type: 'sync:stop' })}>
          Stop
        </button>
      </div>
      {error && <p class='hint'>{error}</p>}
      {progress && (
        <dl class='facts' style={{ marginTop: '12px' }}>
          <dt>Phase</dt>
          <dd>{progress.phase}</dd>
          <dt>Following</dt>
          <dd>
            {progress.following}
            {progress.reportedFollowing !== null && ` / ${progress.reportedFollowing}`}
          </dd>
          <dt>Followers</dt>
          <dd>
            {progress.followers}
            {progress.reportedFollowers !== null && ` / ${progress.reportedFollowers}`}
          </dd>
          <dt>Requests</dt>
          <dd>{progress.requests}</dd>
          <dt>Last HTTP status</dt>
          <dd>{progress.lastStatus ?? '—'}</dd>
          {progress.waiting && (
            <>
              <dt>Waiting</dt>
              <dd>
                {progress.waiting.reason} for {formatSeconds(progress.waiting.ms)}
                {progress.waiting.attempt > 0 && ` (retry ${progress.waiting.attempt})`}
              </dd>
            </>
          )}
        </dl>
      )}
      {result && (
        <>
          {result.message && <p class='hint'>{result.message}</p>}
          <details style={{ marginTop: '8px' }}>
            <summary>Collection stats</summary>
            <pre>{JSON.stringify(result.stats, null, 2)}</pre>
          </details>
        </>
      )}
      {commit && (
        <p class='hint'>
          <Badge value={commit.status} />{' '}
          {commit.status === 'committed'
            ? commit.baseline
              ? `Saved the first snapshot (${commit.followerCount} followers, ${commit.followingCount} following). Unfollowers show up from the next sync on.`
              : `Saved snapshot #${commit.snapshotId}: +${commit.diffCounts?.followersGained ?? 0} / −${commit.diffCounts?.followersLost ?? 0} followers (${commit.diffCounts?.followersLostConfirmed ?? 0} confirmed), +${commit.diffCounts?.followingAdded ?? 0} / −${commit.diffCounts?.followingRemoved ?? 0} following.`
            : `Not saved: ${commit.detail}`}
        </p>
      )}
    </section>
  );
}

interface AccountView {
  readonly latest: LatestSnapshot | null;
  readonly relationships: Relationships | null;
  readonly snapshots: readonly SnapshotRecord[];
  readonly events: readonly EventRecord[];
  readonly profiles: ReadonlyMap<string, ProfileRecord>;
}

const LIST_LIMIT = 300;

async function loadAccountView(store: TrackerStore, viewerId: string): Promise<AccountView> {
  const [latest, snapshots, events] = await Promise.all([
    store.getLatestSnapshot(viewerId),
    store.listSnapshots(viewerId, 30),
    store.listEvents(viewerId, 200),
  ]);
  const relationships = latest ? computeRelationships(latest) : null;
  const pks = new Set<string>(events.map(event => event.pk));
  if (relationships) {
    for (const list of [relationships.notFollowingBack, relationships.fans, relationships.mutuals]) {
      list.slice(0, LIST_LIMIT).forEach(pk => pks.add(pk));
    }
  }
  const profiles = await store.getProfiles(viewerId, Array.from(pks));
  return { latest, relationships, snapshots, events, profiles };
}

type ListTab = 'notFollowingBack' | 'fans' | 'mutuals';

function DataSection({ refreshKey }: { refreshKey: number }) {
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [view, setView] = useState<AccountView | null>(null);
  const [tab, setTab] = useState<ListTab>('notFollowingBack');
  const [localRefresh, setLocalRefresh] = useState(0);

  useEffect(() => {
    void (async () => {
      const list = await (await storePromise).listAccounts();
      setAccounts(list);
      setViewerId(current => (current && list.some(a => a.viewerId === current) ? current : (list[0]?.viewerId ?? null)));
    })();
  }, [refreshKey, localRefresh]);

  useEffect(() => {
    if (!viewerId) {
      setView(null);
      return;
    }
    void (async () => setView(await loadAccountView(await storePromise, viewerId)))();
  }, [viewerId, refreshKey, localRefresh]);

  const exportJson = async () => {
    if (!viewerId) {
      return;
    }
    const data = await (await storePromise).exportAccount(viewerId);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `follower-tracker-${viewerId}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const deleteData = async () => {
    if (!viewerId || !confirm('Delete every snapshot and event stored for this account?')) {
      return;
    }
    await (await storePromise).deleteAccount(viewerId);
    setLocalRefresh(n => n + 1);
  };

  const latest = view?.latest ?? null;
  const rel = view?.relationships ?? null;
  const tabs: Array<{ key: ListTab; label: string; ids: readonly string[] }> = rel
    ? [
        { key: 'notFollowingBack', label: 'Not following back', ids: rel.notFollowingBack },
        { key: 'fans', label: 'Fans', ids: rel.fans },
        { key: 'mutuals', label: 'Mutuals', ids: rel.mutuals },
      ]
    : [];
  const activeIds = tabs.find(t => t.key === tab)?.ids ?? [];

  return (
    <section>
      <h2>Stored data</h2>
      {accounts.length === 0 ? (
        <p class='muted'>Nothing saved yet. Run a sync.</p>
      ) : (
        <>
          <div class='row'>
            <select value={viewerId ?? ''} onChange={e => setViewerId((e.currentTarget as HTMLSelectElement).value)}>
              {accounts.map(account => (
                <option key={account.viewerId} value={account.viewerId}>
                  {account.username ? `@${account.username}` : account.viewerId} · {account.snapshotCount} snapshots
                </option>
              ))}
            </select>
            <button onClick={exportJson}>Export JSON</button>
            <button class='danger' onClick={deleteData}>
              Delete this account's data
            </button>
          </div>

          {latest && rel && (
            <>
              <p class='muted' style={{ margin: '12px 0 0' }}>
                Latest snapshot #{latest.id} from {formatTime(latest.takenAt)}
                {latest.baseline && ' (baseline)'}
              </p>
              <div class='stats'>
                <div class='stat'>
                  <b>{latest.followerCount}</b>
                  <span>followers{coverage(latest.stats.listedFollowers, latest.reportedFollowerCount)}</span>
                </div>
                <div class='stat'>
                  <b>{latest.followingCount}</b>
                  <span>following{coverage(latest.followingCount, latest.reportedFollowingCount)}</span>
                </div>
                <div class='stat'>
                  <b>{rel.notFollowingBack.length}</b>
                  <span>not following back</span>
                </div>
                <div class='stat'>
                  <b>{rel.fans.length}</b>
                  <span>fans</span>
                </div>
                <div class='stat'>
                  <b>{rel.mutuals.length}</b>
                  <span>mutuals</span>
                </div>
              </div>

              <div class='tabs'>
                {tabs.map(t => (
                  <button key={t.key} aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>
                    {t.label} ({t.ids.length})
                  </button>
                ))}
              </div>
              <ul class='people'>
                {activeIds.slice(0, LIST_LIMIT).map(pk => (
                  <li key={pk}>
                    <Person pk={pk} profiles={view!.profiles} />
                  </li>
                ))}
              </ul>
              {activeIds.length > LIST_LIMIT && <p class='muted'>Showing the first {LIST_LIMIT}.</p>}
            </>
          )}

          <h2 style={{ marginTop: '20px' }}>Events</h2>
          {view && view.events.length > 0 ? (
            <div class='table-wrap'>
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Change</th>
                    <th>Account</th>
                    <th>Check</th>
                  </tr>
                </thead>
                <tbody>
                  {view.events.map(event => (
                    <tr key={event.id}>
                      <td>{formatTime(event.detectedAt)}</td>
                      <td>{EVENT_LABELS[event.type]}</td>
                      <td>
                        <Person pk={event.pk} profiles={view.profiles} />
                      </td>
                      <td class='muted'>{event.verification ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p class='muted'>No changes recorded yet. The first sync is the baseline; changes appear after the next one.</p>
          )}

          <h2 style={{ marginTop: '20px' }}>Snapshots</h2>
          {view && (
            <div class='table-wrap'>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Taken</th>
                    <th>Followers</th>
                    <th>Following</th>
                    <th>Changes</th>
                    <th>Requests</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {view.snapshots.map(snapshot => (
                    <tr key={snapshot.id}>
                      <td>{snapshot.id}</td>
                      <td>{formatTime(snapshot.takenAt)}</td>
                      <td>{snapshot.followerCount}</td>
                      <td>{snapshot.followingCount}</td>
                      <td>
                        {snapshot.diffCounts
                          ? `+${snapshot.diffCounts.followersGained} / −${snapshot.diffCounts.followersLost} followers`
                          : 'baseline'}
                      </td>
                      <td>{snapshot.stats.requests}</td>
                      <td>{formatSeconds(snapshot.takenAt - snapshot.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function App() {
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [progress, setProgress] = useState<CollectionProgress | null>(null);
  const [result, setResult] = useState<CollectionResult | null>(null);
  const [commit, setCommit] = useState<CommitOutcome | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refreshEnv = useCallback(() => {
    void sendToBackground<EnvStatus>({ type: 'env:status' }).then(setEnv);
  }, []);

  useEffect(() => {
    refreshEnv();
    const onTabUpdated = (_tabId: number, change: { status?: string }) => {
      if (change.status === 'complete') {
        refreshEnv();
      }
    };
    const onTabRemoved = () => refreshEnv();
    browser.tabs.onUpdated.addListener(onTabUpdated);
    browser.tabs.onRemoved.addListener(onTabRemoved);

    // Listen only: never return true here, or this page would swallow replies meant for the background.
    const onBroadcast = (message: unknown) => {
      const msg = message as Broadcast;
      if (msg.type === 'collector:progress') {
        setProgress(msg.progress);
      } else if (msg.type === 'collector:finished') {
        setResult(msg.result);
      } else if (msg.type === 'sync:committed') {
        setCommit(msg.outcome);
        setRefreshKey(n => n + 1);
        refreshEnv();
      }
    };
    browser.runtime.onMessage.addListener(onBroadcast);
    return () => {
      browser.tabs.onUpdated.removeListener(onTabUpdated);
      browser.tabs.onRemoved.removeListener(onTabRemoved);
      browser.runtime.onMessage.removeListener(onBroadcast);
    };
  }, [refreshEnv]);

  const ready = env !== null && env.problem === null;

  return (
    <main>
      <header>
        <h1>Follower Tracker diagnostics</h1>
        <p>
          Development build only. Version {browser.runtime.getManifest().version}. All data stays in this browser's
          extension storage.
        </p>
      </header>
      <EnvSection env={env} onRefresh={refreshEnv} />
      <ProbeSection ready={ready} />
      <SyncSection
        ready={ready}
        collectorRunning={env?.collector?.running ?? false}
        progress={progress}
        result={result}
        commit={commit}
        onStarted={() => {
          setResult(null);
          setCommit(null);
          setProgress(null);
          refreshEnv();
        }}
      />
      <DataSection refreshKey={refreshKey} />
    </main>
  );
}

render(<App />, document.getElementById('app')!);
