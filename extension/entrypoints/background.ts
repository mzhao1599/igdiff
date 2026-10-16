import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import type { CheckpointDelta, CollectionResult, ResumeState } from '../lib/collector/collect';
import type { ProbeReport } from '../lib/collector/probe';
import { BUILD_ID, DIAGNOSTICS_ENABLED } from '../lib/env';
import { INSTAGRAM_ORIGIN } from '../lib/instagram/api';
import {
  broadcast,
  handleMessages,
  sendToTab,
  type CollectorStatus,
  type EnvStatus,
  type ProbeResponse,
  type RuntimeMessage,
  type SchedulerStatus,
  type SyncStartResponse,
  type SyncStopResponse,
  type UnfollowStartError,
  type UnfollowStartResponse,
  type UnfollowStatus,
} from '../lib/messages';
import {
  budgetUsedToday,
  decideAutoSync,
  decideManualSync,
  DEFAULT_SYNC_ESTIMATE,
  isCheckpointFresh,
  isLeaseAlive,
  keepCheckpointAfter,
  type AutoSyncDecision,
  type Lease,
} from '../lib/scheduler/policy';
import { schedulerState } from '../lib/scheduler/state';
import { recordBlock, recordUnfollows, unfollowAllowance, unfollowsToday } from '../lib/actions/limits';
import { unfollowState, type UnfollowJob } from '../lib/actions/state';
import type { UnfollowItemResult, UnfollowRunResult } from '../lib/actions/unfollow';
import { unfollowerBadge } from '../lib/notify/badge';
import { computeRelationships } from '../lib/tracker/diff';
import { TrackerStore, type CommitOutcome } from '../lib/tracker/store';

const ALARM = 'follower-tracker-autosync';
const ALARM_PERIOD_MINUTES = 30;
/** Write the lease heartbeat at most this often. */
const HEARTBEAT_WRITE_MS = 5_000;

export default defineBackground(() => {
  const store = TrackerStore.open();

  // Every decision that reads and then changes the lease runs one at a time,
  // so two Instagram tabs announcing themselves together can't both start a sync.
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function instagramTabs(): Promise<Array<Browser.tabs.Tab & { id: number }>> {
    const tabs = await browser.tabs.query({ url: `${INSTAGRAM_ORIGIN}/*` });
    return tabs.filter((tab): tab is Browser.tabs.Tab & { id: number } => tab.id !== undefined && !tab.discarded);
  }

  /**
   * Asks every Instagram tab for its status and picks the one to talk to: the tab
   * already syncing, else `preferTabId`, else the active signed-in one, else any signed-in one.
   */
  async function readEnv(preferTabId?: number): Promise<EnvStatus> {
    const tabs = await instagramTabs();
    if (tabs.length === 0) {
      return { backgroundBuildId: BUILD_ID, tabId: null, tabUrl: null, collector: null, problem: 'no_instagram_tab' };
    }
    const statuses = await Promise.all(
      tabs.map(async tab => {
        try {
          return { tab, collector: await sendToTab<CollectorStatus>(tab.id, { type: 'collector:status' }) };
        } catch {
          // Tabs opened before the extension was installed or reloaded have no content script yet.
          return { tab, collector: null };
        }
      }),
    );
    const reachable = statuses.filter(entry => entry.collector !== null);
    const pick =
      reachable.find(entry => entry.collector?.running) ??
      reachable.find(entry => entry.collector?.viewerId && entry.tab.id === preferTabId) ??
      reachable.find(entry => entry.collector?.viewerId && entry.tab.active) ??
      reachable.find(entry => entry.collector?.viewerId) ??
      reachable[0];
    if (!pick) {
      const tab = tabs.find(candidate => candidate.active) ?? tabs[0]!;
      return { backgroundBuildId: BUILD_ID, tabId: tab.id, tabUrl: tab.url ?? null, collector: null, problem: 'content_script_missing' };
    }
    return {
      backgroundBuildId: BUILD_ID,
      tabId: pick.tab.id,
      tabUrl: pick.tab.url ?? null,
      collector: pick.collector,
      problem: pick.collector?.viewerId ? null : 'signed_out',
    };
  }

  // --- Lease ----------------------------------------------------------------------

  async function tabExists(tabId: number): Promise<boolean> {
    try {
      await browser.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  }

  /** A lease is dead when heartbeats stop, its tab is gone, or its tab just reloaded. */
  async function currentLease(reloadedTabId?: number): Promise<Lease | null> {
    const lease = await schedulerState.getLease();
    if (!lease) {
      return null;
    }
    const alive = isLeaseAlive(lease, Date.now()) && lease.tabId !== reloadedTabId && (await tabExists(lease.tabId));
    if (alive) {
      return lease;
    }
    // The run died mid-way. Its checkpoint stays, so the next sync resumes it.
    await schedulerState.recordAttempt(lease.viewerId, { at: Date.now(), outcome: 'interrupted' });
    await schedulerState.setLease(null);
    if (lease.tabId !== reloadedTabId) {
      void sendToTab(lease.tabId, { type: 'collector:stop' }).catch(() => undefined);
    }
    broadcast({ type: 'scheduler:changed' });
    return null;
  }

  /** Adds the requests a run made since it last reported to today's budget. */
  async function accountRequests(lease: Lease, runRequests: number): Promise<Lease> {
    const added = Math.max(0, runRequests - lease.accountedRequests);
    if (added === 0) {
      return lease;
    }
    await schedulerState.addRequests(lease.viewerId, added, Date.now());
    return { ...lease, accountedRequests: runRequests };
  }

  // --- Starting a sync ----------------------------------------------------------

  async function decisionInputs(viewerId: string, now: number) {
    const db = await store;
    const [state, account, checkpoint] = await Promise.all([
      schedulerState.read(),
      db.getAccount(viewerId),
      db.getCheckpoint(viewerId),
    ]);
    return {
      state,
      checkpoint,
      lastSyncAt: account?.lastSyncAt ?? null,
      lastAttempt: state.attempts[viewerId] ?? null,
      budgetUsed: budgetUsedToday(state.budget[viewerId], now),
      estimate: state.estimates[viewerId] ?? DEFAULT_SYNC_ESTIMATE,
    };
  }

  async function launch(
    tabId: number,
    viewerId: string,
    mode: Lease['mode'],
    decision: Extract<AutoSyncDecision, { action: 'start' | 'resume' }>,
  ): Promise<SyncStartResponse> {
    const db = await store;
    const now = Date.now();
    let runId: string | null = null;
    let resume: ResumeState | null = null;
    if (decision.action === 'resume') {
      const loaded = await db.loadCheckpoint(viewerId);
      if (loaded) {
        runId = loaded.record.runId;
        resume = loaded.resume;
      }
    }
    if (!runId) {
      runId = crypto.randomUUID();
      await db.startCheckpoint(viewerId, runId, now);
    }
    const latest = await db.getLatestSnapshot(viewerId);
    const baseline = latest ? { followerIds: latest.followerIds, followingIds: latest.followingIds } : null;

    await schedulerState.setLease({ runId, tabId, viewerId, mode, startedAt: now, heartbeatAt: now, accountedRequests: 0 });
    const ack = await sendToTab<{ started: boolean }>(tabId, {
      type: 'collector:run',
      runId,
      baseline,
      resume,
      maxRequests: decision.maxRequests,
    }).catch(() => ({ started: false }));
    if (!ack.started) {
      await schedulerState.setLease(null);
      return { ok: false, error: 'already_running' };
    }
    broadcast({ type: 'scheduler:changed' });
    return { ok: true, tabId, viewerId, hasBaseline: baseline !== null, resumed: resume !== null };
  }

  /** Starts (or resumes) a sync if one is due. Safe to call often. */
  function tryAutoSync(options: { preferTabId?: number; reloadedTabId?: number; ignoreSchedule?: boolean } = {}) {
    return exclusive(async () => {
      const lease = await currentLease(options.reloadedTabId);
      const env = await readEnv(options.preferTabId);
      const viewerId = env.collector?.viewerId;
      if (env.problem || env.tabId === null || !viewerId) {
        return { started: false as const, reason: env.problem ?? 'signed_out' };
      }
      if (env.collector?.running) {
        return { started: false as const, reason: 'running' };
      }
      const now = Date.now();
      const inputs = await decisionInputs(viewerId, now);
      const decision = decideAutoSync({
        now,
        enabled: inputs.state.prefs.enabled,
        leaseAlive: lease !== null,
        lastSyncAt: inputs.lastSyncAt,
        lastAttempt: inputs.lastAttempt,
        checkpointUpdatedAt: inputs.checkpoint?.updatedAt ?? null,
        budgetUsed: inputs.budgetUsed,
        dailyBudget: inputs.state.prefs.dailyBudget,
        estimate: inputs.estimate,
        ignoreSchedule: options.ignoreSchedule,
      });
      if (decision.action === 'wait') {
        return { started: false as const, reason: decision.reason, decision };
      }
      return { started: true as const, decision, launched: await launch(env.tabId, viewerId, 'auto', decision) };
    });
  }

  /** "Sync now": no schedule, but still one sync at a time and within the daily budget. */
  function startManualSync(): Promise<SyncStartResponse> {
    return exclusive(async () => {
      const lease = await currentLease();
      const env = await readEnv();
      const viewerId = env.collector?.viewerId;
      if (env.problem || env.tabId === null || !viewerId) {
        return { ok: false, error: env.problem ?? 'signed_out' };
      }
      if (lease || env.collector?.running) {
        return { ok: false, error: 'already_running' };
      }
      const now = Date.now();
      const inputs = await decisionInputs(viewerId, now);
      const decision = decideManualSync({
        now,
        leaseAlive: false,
        checkpointUpdatedAt: inputs.checkpoint?.updatedAt ?? null,
        budgetUsed: inputs.budgetUsed,
        dailyBudget: inputs.state.prefs.dailyBudget,
      });
      if (decision.action === 'wait') {
        return { ok: false, error: decision.reason === 'budget' ? 'budget' : 'already_running' };
      }
      return launch(env.tabId, viewerId, 'manual', decision);
    });
  }

  /** Sends Stop to every Instagram tab, so it reaches the sync wherever it runs. */
  async function stopSync(): Promise<SyncStopResponse> {
    const tabs = await instagramTabs();
    const answers = await Promise.all(
      tabs.map(tab =>
        sendToTab<{ stopping: boolean }>(tab.id, { type: 'collector:stop' }).catch(() => ({ stopping: false })),
      ),
    );
    return { ok: true, stopped: answers.filter(answer => answer.stopping).length };
  }

  // --- While a sync runs ----------------------------------------------------------

  function onCheckpoint(tabId: number, delta: CheckpointDelta) {
    return exclusive(async () => {
      const lease = await schedulerState.getLease();
      if (!lease || lease.runId !== delta.runId || lease.tabId !== tabId) {
        return;
      }
      const now = Date.now();
      await (await store).applyCheckpointDelta(lease.viewerId, delta, lease.accountedRequests, now);
      const accounted = await accountRequests(lease, delta.requests);
      await schedulerState.setLease({ ...accounted, heartbeatAt: now });
    });
  }

  function onHeartbeat(tabId: number) {
    return exclusive(async () => {
      const lease = await schedulerState.getLease();
      const now = Date.now();
      if (lease && lease.tabId === tabId && now - lease.heartbeatAt >= HEARTBEAT_WRITE_MS) {
        await schedulerState.setLease({ ...lease, heartbeatAt: now });
      }
    });
  }

  /** Pending `dev:sync` callers, resolved when the next result is committed or rejected. */
  const syncWaiters: Array<(finished: { result: unknown; outcome: CommitOutcome }) => void> = [];

  function onFinished(runId: string, result: CollectionResult): Promise<CommitOutcome> {
    return exclusive(async () => {
      const db = await store;
      const now = Date.now();
      const lease = await schedulerState.getLease();
      const ours = lease !== null && lease.runId === runId;
      const viewerId = result.viewerId;

      // Results from a run whose lease was already declared dead are still saved when complete.
      const outcome = await db.commit(result);
      if (outcome.status === 'committed' && outcome.diffCounts) {
        await unfollowerBadge.add(outcome.viewerId, outcome.diffCounts.followersLost);
      }

      if (ours && viewerId) {
        const checkpoint = await db.getCheckpoint(viewerId);
        const finalRunRequests = Math.max(0, result.stats.requests - lease.accountedRequests);
        await accountRequests(lease, result.stats.requests);
        if (result.outcome === 'completed') {
          await schedulerState.recordEstimate(viewerId, (checkpoint?.requests ?? 0) + finalRunRequests);
        }
        if (!keepCheckpointAfter(result.outcome)) {
          await db.clearCheckpoint(viewerId);
        }
        await schedulerState.recordAttempt(viewerId, { at: now, outcome: result.outcome });
        await schedulerState.setLease(null);
      }

      broadcast({ type: 'sync:committed', viewerId, outcome });
      broadcast({ type: 'scheduler:changed' });
      syncWaiters.splice(0).forEach(resolve => resolve({ result: summarizeResult(result), outcome }));
      return outcome;
    });
  }

  // --- Unfollowing ---------------------------------------------------------------
  // Only ever started by the user from the side panel. Runs in an Instagram tab;
  // the job (queue and counts) lives in storage so a closed tab or a restarted
  // worker leaves it paused, never lost and never resumed without the user.

  async function launchUnfollows(job: UnfollowJob, maxUnfollows: number): Promise<UnfollowStartResponse> {
    if (job.tabId === null) {
      return { ok: false, error: 'no_instagram_tab' };
    }
    const running: UnfollowJob = { ...job, status: 'running', outcome: null, message: null, updatedAt: Date.now() };
    await unfollowState.setJob(running);
    const ack = await sendToTab<{ started: boolean }>(job.tabId, {
      type: 'unfollow:run',
      jobId: job.id,
      pks: job.queue,
      maxUnfollows,
    }).catch(() => ({ started: false }));
    if (!ack.started) {
      await unfollowState.setJob({ ...running, status: 'paused', outcome: 'interrupted', message: 'Could not start in the Instagram tab.' });
      broadcast({ type: 'unfollow:changed' });
      return { ok: false, error: 'already_running' };
    }
    broadcast({ type: 'unfollow:changed' });
    return { ok: true, job: running };
  }

  type Preflight =
    | { readonly ok: true; readonly tabId: number; readonly remaining: number }
    | { readonly ok: false; readonly error: UnfollowStartError; readonly until?: number };

  /** Common checks before unfollowing anything: right account, nothing running, allowed today. */
  async function unfollowPreflight(viewerId: string): Promise<Preflight> {
    const env = await readEnv();
    if (env.problem || env.tabId === null || !env.collector?.viewerId) {
      return { ok: false, error: env.problem ?? 'signed_out' };
    }
    if (env.collector.viewerId !== viewerId) {
      return { ok: false, error: 'wrong_account' };
    }
    const state = await unfollowState.read();
    if (state.job?.status === 'running') {
      return { ok: false, error: 'already_running' };
    }
    const allowance = unfollowAllowance(state.ledgers[viewerId], Date.now());
    if (!allowance.allowed) {
      return { ok: false, error: allowance.reason, until: allowance.until };
    }
    return { ok: true, tabId: env.tabId, remaining: allowance.remaining };
  }

  function startUnfollows(viewerId: string, pks: readonly string[]): Promise<UnfollowStartResponse> {
    return exclusive(async () => {
      const check = await unfollowPreflight(viewerId);
      if (!check.ok) {
        return check;
      }
      // Kept accounts are never unfollowed, whatever the page sent.
      const kept = await (await store).listKeep(viewerId);
      const queue = Array.from(new Set(pks)).filter(pk => !kept.has(pk));
      if (queue.length === 0) {
        return { ok: false, error: 'nothing_to_do' };
      }
      const now = Date.now();
      return launchUnfollows(
        {
          id: crypto.randomUUID(),
          viewerId,
          tabId: check.tabId,
          queue,
          total: queue.length,
          unfollowed: 0,
          skipped: 0,
          status: 'running',
          startedAt: now,
          updatedAt: now,
          outcome: null,
          message: null,
        },
        check.remaining,
      );
    });
  }

  function resumeUnfollows(): Promise<UnfollowStartResponse> {
    return exclusive(async () => {
      const job = (await unfollowState.read()).job;
      if (!job || job.status !== 'paused' || job.queue.length === 0) {
        return { ok: false, error: 'nothing_to_do' };
      }
      const check = await unfollowPreflight(job.viewerId);
      if (!check.ok) {
        return check;
      }
      const kept = await (await store).listKeep(job.viewerId);
      return launchUnfollows({ ...job, tabId: check.tabId, queue: job.queue.filter(pk => !kept.has(pk)) }, check.remaining);
    });
  }

  function onUnfollowItem(jobId: string, item: UnfollowItemResult) {
    return exclusive(async () => {
      const state = await unfollowState.read();
      const job = state.job;
      if (!job || job.id !== jobId) {
        return;
      }
      await (await store).recordAction({
        viewerId: job.viewerId,
        pk: item.pk,
        type: 'unfollow',
        outcome: item.outcome,
        detail: item.detail,
        at: item.at,
      });
      if (item.outcome === 'unfollowed') {
        await unfollowState.setLedger(job.viewerId, recordUnfollows(state.ledgers[job.viewerId], 1, item.at));
      }
      await unfollowState.setJob({
        ...job,
        queue: job.queue.filter(pk => pk !== item.pk),
        unfollowed: job.unfollowed + (item.outcome === 'unfollowed' ? 1 : 0),
        skipped: job.skipped + (item.outcome === 'unfollowed' ? 0 : 1),
        updatedAt: item.at,
      });
      broadcast({ type: 'unfollow:changed' });
    });
  }

  function onUnfollowFinished(jobId: string, result: UnfollowRunResult) {
    return exclusive(async () => {
      const state = await unfollowState.read();
      const job = state.job;
      if (!job || job.id !== jobId) {
        return;
      }
      const now = Date.now();
      if (result.outcome === 'blocked') {
        await unfollowState.setLedger(job.viewerId, recordBlock(state.ledgers[job.viewerId], now));
      }
      const finished = result.outcome === 'completed' || result.remaining.length === 0;
      await unfollowState.setJob({
        ...job,
        queue: result.remaining,
        status: finished ? 'finished' : 'paused',
        outcome: result.outcome,
        message: result.message,
        endpoint: result.endpoint ?? job.endpoint ?? null,
        updatedAt: now,
      });
      broadcast({ type: 'unfollow:changed' });
    });
  }

  /** The job's tab closed or reloaded mid-run: keep what's left, paused. */
  function pauseInterruptedUnfollows(tabId: number) {
    return exclusive(async () => {
      const job = (await unfollowState.read()).job;
      if (job?.status === 'running' && job.tabId === tabId) {
        await unfollowState.setJob({
          ...job,
          status: 'paused',
          outcome: 'interrupted',
          message: 'The Instagram tab was closed or reloaded. Resume to continue.',
          updatedAt: Date.now(),
        });
        broadcast({ type: 'unfollow:changed' });
      }
    });
  }

  async function unfollowStatus(viewerId: string | null): Promise<UnfollowStatus> {
    const state = await unfollowState.read();
    const now = Date.now();
    return {
      job: state.job,
      allowance: viewerId ? unfollowAllowance(state.ledgers[viewerId], now) : null,
      today: viewerId ? unfollowsToday(state.ledgers[viewerId], now) : 0,
    };
  }

  // --- Status --------------------------------------------------------------------

  async function schedulerStatus(): Promise<SchedulerStatus> {
    const lease = await exclusive(() => currentLease());
    const env = await readEnv();
    const viewerId = env.collector?.viewerId ?? null;
    const state = await schedulerState.read();
    const base = {
      enabled: state.prefs.enabled,
      dailyBudget: state.prefs.dailyBudget,
      running: lease ? { tabId: lease.tabId, mode: lease.mode, startedAt: lease.startedAt } : null,
    };
    if (!viewerId) {
      return { ...base, viewerId: null, lastSyncAt: null, lastAttempt: null, budgetUsed: 0, estimate: DEFAULT_SYNC_ESTIMATE, checkpoint: null, next: null };
    }
    const now = Date.now();
    const inputs = await decisionInputs(viewerId, now);
    const checkpoint = inputs.checkpoint;
    return {
      ...base,
      viewerId,
      lastSyncAt: inputs.lastSyncAt,
      lastAttempt: inputs.lastAttempt,
      budgetUsed: inputs.budgetUsed,
      estimate: inputs.estimate,
      checkpoint:
        checkpoint && isCheckpointFresh(checkpoint.updatedAt, now)
          ? {
              updatedAt: checkpoint.updatedAt,
              requests: checkpoint.requests,
              following: checkpoint.following && { rows: checkpoint.following.rows, done: checkpoint.following.done },
              followers: checkpoint.followers && { rows: checkpoint.followers.rows, done: checkpoint.followers.done },
            }
          : null,
      next: decideAutoSync({
        now,
        enabled: state.prefs.enabled,
        leaseAlive: lease !== null,
        lastSyncAt: inputs.lastSyncAt,
        lastAttempt: inputs.lastAttempt,
        checkpointUpdatedAt: checkpoint?.updatedAt ?? null,
        budgetUsed: inputs.budgetUsed,
        dailyBudget: state.prefs.dailyBudget,
        estimate: inputs.estimate,
      }),
    };
  }

  // --- Messages ------------------------------------------------------------------

  const fromInstagramTab = (sender: Browser.runtime.MessageSender): sender is Browser.runtime.MessageSender & { tab: { id: number } } =>
    sender.id === browser.runtime.id && sender.tab?.id !== undefined && !!sender.url?.startsWith(`${INSTAGRAM_ORIGIN}/`);

  handleMessages<RuntimeMessage>((message, sender) => {
    switch (message.type) {
      case 'env:status':
        return readEnv();
      case 'probe:run':
        return (async (): Promise<ProbeResponse> => {
          const env = await readEnv();
          if (env.problem || env.tabId === null) {
            return { ok: false, error: env.problem ?? 'no_instagram_tab' };
          }
          const report = await sendToTab<ProbeReport>(env.tabId, { type: 'collector:probe' });
          return { ok: true, report };
        })();
      case 'sync:start':
        return startManualSync();
      case 'sync:stop':
        return stopSync();
      case 'scheduler:status':
        return schedulerStatus();
      case 'scheduler:set':
        return (async () => {
          await schedulerState.setPrefs({ enabled: message.enabled });
          broadcast({ type: 'scheduler:changed' });
          if (message.enabled) {
            void tryAutoSync();
          }
          return { ok: true };
        })();
      case 'scheduler:trigger':
        return tryAutoSync({ ignoreSchedule: true });
      case 'autosync:ready':
        if (!fromInstagramTab(sender)) {
          return undefined;
        }
        // A tab that just (re)loaded is not running anything, whatever the lease or job says.
        void pauseInterruptedUnfollows(sender.tab.id);
        return tryAutoSync({ preferTabId: sender.tab.id, reloadedTabId: sender.tab.id });
      case 'unfollow:start':
        return startUnfollows(message.viewerId, message.pks);
      case 'unfollow:resume':
        return resumeUnfollows();
      case 'unfollow:stop':
        return (async () => {
          const job = (await unfollowState.read()).job;
          const tabs = job?.tabId !== null && job?.tabId !== undefined ? [job.tabId] : (await instagramTabs()).map(tab => tab.id);
          await Promise.all(tabs.map(tabId => sendToTab(tabId, { type: 'unfollow:stop' }).catch(() => undefined)));
          return { ok: true };
        })();
      case 'unfollow:discard':
        return exclusive(async () => {
          const job = (await unfollowState.read()).job;
          if (job?.status !== 'running') {
            await unfollowState.setJob(null);
            broadcast({ type: 'unfollow:changed' });
          }
          return { ok: true };
        });
      case 'unfollow:status':
        return unfollowStatus(message.viewerId);
      case 'badge:clear':
        return unfollowerBadge.clear(message.viewerId).then(() => ({ ok: true }));
      case 'unfollow:item':
        if (fromInstagramTab(sender)) {
          void onUnfollowItem(message.jobId, message.item);
        }
        return undefined;
      case 'unfollow:finished':
        if (fromInstagramTab(sender)) {
          void onUnfollowFinished(message.jobId, message.result);
        }
        return undefined;
      case 'collector:progress':
        if (fromInstagramTab(sender)) {
          void onHeartbeat(sender.tab.id);
        }
        return undefined;
      case 'collector:checkpoint':
        if (fromInstagramTab(sender)) {
          void onCheckpoint(sender.tab.id, message.delta);
        }
        return undefined;
      case 'collector:finished':
        return fromInstagramTab(sender) ? onFinished(message.runId, message.result) : undefined;
      case 'dev:reload':
        if (!DIAGNOSTICS_ENABLED) {
          return undefined;
        }
        setTimeout(() => browser.runtime.reload(), 100);
        return Promise.resolve({ ok: true, reloading: true });
      case 'dev:summary':
        return DIAGNOSTICS_ENABLED ? devSummary() : undefined;
      case 'dev:sync':
        return DIAGNOSTICS_ENABLED
          ? (async () => {
              const started = await startManualSync();
              if (!started.ok) {
                return { started };
              }
              return new Promise(resolve => {
                syncWaiters.push(finished => resolve({ started, ...finished }));
              });
            })()
          : undefined;
      default:
        return undefined;
    }
  });

  // --- Triggers ------------------------------------------------------------------

  // Catches Instagram tabs that stay open for days without reloading.
  void browser.alarms.get(ALARM).then(existing => {
    if (!existing) {
      void browser.alarms.create(ALARM, { periodInMinutes: ALARM_PERIOD_MINUTES });
    }
  });
  browser.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) {
      void tryAutoSync();
    }
  });

  // The syncing tab was closed: release the lease and resume in another tab if there is one.
  browser.tabs.onRemoved.addListener(tabId => {
    void pauseInterruptedUnfollows(tabId);
    void (async () => {
      const lease = await schedulerState.getLease();
      if (lease?.tabId === tabId) {
        await exclusive(() => currentLease(tabId));
        void tryAutoSync();
      }
    })();
  });

  // --- Dev helpers ---------------------------------------------------------------

  function summarizeResult(result: CollectionResult) {
    return {
      outcome: result.outcome,
      message: result.message,
      seconds: Math.round((result.finishedAt - result.startedAt) / 1000),
      followers: result.followerIds.length,
      following: result.followingIds.length,
      stats: result.stats,
    };
  }

  /** Dev-only: counts, recent snapshots and events with usernames for the most recent account. */
  async function devSummary() {
    const db = await store;
    const [account] = await db.listAccounts();
    if (!account) {
      return { account: null };
    }
    const latest = await db.getLatestSnapshot(account.viewerId);
    const relationships = latest ? computeRelationships(latest) : null;
    const snapshots = await db.listSnapshots(account.viewerId, 10);
    const events = await db.listEvents(account.viewerId, 50);
    const actions = await db.listActions(account.viewerId, -Infinity, 20);
    const profiles = await db.getProfiles(account.viewerId, [...events.map(event => event.pk), ...actions.map(action => action.pk)]);
    return {
      account,
      latest: latest && {
        id: latest.id,
        takenAt: new Date(latest.takenAt).toISOString(),
        followers: latest.followerCount,
        following: latest.followingCount,
        notFollowingBack: relationships?.notFollowingBack.length,
        fans: relationships?.fans.length,
        mutuals: relationships?.mutuals.length,
      },
      snapshots: snapshots.map(s => ({
        id: s.id,
        takenAt: new Date(s.takenAt).toISOString(),
        followers: s.followerCount,
        following: s.followingCount,
        diff: s.diffCounts,
        requests: s.stats.requests,
        seconds: Math.round((s.takenAt - s.startedAt) / 1000),
      })),
      events: events.map(event => ({
        at: new Date(event.detectedAt).toISOString(),
        type: event.type,
        username: profiles.get(event.pk)?.username ?? event.pk,
        verification: event.verification ?? null,
      })),
      actions: actions.map(action => ({
        at: new Date(action.at).toISOString(),
        username: profiles.get(action.pk)?.username ?? action.pk,
        outcome: action.outcome,
        detail: action.detail,
      })),
    };
  }

  // Badges reset when the extension reloads; put the unseen count back.
  void unfollowerBadge.restore().catch(() => undefined);

  // The toolbar button opens the side panel (Chrome) or the sidebar (Firefox).
  if (browser.sidePanel) {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  } else {
    // Firefox-only API, missing from WXT's Chrome-based types.
    const sidebar = (browser as unknown as { sidebarAction?: { open(): Promise<void> } }).sidebarAction;
    if (sidebar) {
      (browser.action ?? browser.browserAction).onClicked.addListener(() => {
        void sidebar.open();
      });
    }
  }
});
