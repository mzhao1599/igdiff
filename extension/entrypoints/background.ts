import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { INSTAGRAM_ORIGIN } from '../lib/instagram/api';
import {
  broadcast,
  handleMessages,
  sendToTab,
  type CollectorStatus,
  type EnvStatus,
  type ProbeResponse,
  type RuntimeMessage,
  type SyncStartResponse,
  type SyncStopResponse,
} from '../lib/messages';
import type { ProbeReport } from '../lib/collector/probe';
import { TrackerStore } from '../lib/tracker/store';
import { BUILD_ID, DIAGNOSTICS_ENABLED } from '../lib/env';

export default defineBackground(() => {
  const store = TrackerStore.open();

  async function instagramTabs(): Promise<Array<Browser.tabs.Tab & { id: number }>> {
    const tabs = await browser.tabs.query({ url: `${INSTAGRAM_ORIGIN}/*` });
    return tabs.filter((tab): tab is Browser.tabs.Tab & { id: number } => tab.id !== undefined && !tab.discarded);
  }

  /**
   * Asks every Instagram tab for its status and picks the one to talk to: the tab
   * already syncing, else the active signed-in one, else any signed-in one.
   */
  async function readEnv(): Promise<EnvStatus> {
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

  async function startSync(): Promise<SyncStartResponse> {
    const env = await readEnv();
    if (env.problem || env.tabId === null || !env.collector?.viewerId) {
      return { ok: false, error: env.problem ?? 'signed_out' };
    }
    if (env.collector.running) {
      return { ok: false, error: 'already_running' };
    }
    const latest = await (await store).getLatestSnapshot(env.collector.viewerId);
    const baseline = latest ? { followerIds: latest.followerIds, followingIds: latest.followingIds } : null;
    const ack = await sendToTab<{ started: boolean }>(env.tabId, { type: 'collector:run', baseline });
    if (!ack.started) {
      return { ok: false, error: 'already_running' };
    }
    return { ok: true, tabId: env.tabId, viewerId: env.collector.viewerId, hasBaseline: baseline !== null };
  }

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
        return startSync();
      case 'sync:stop':
        return stopSync();
      case 'collector:finished': {
        // Only accept results from our own content script on an Instagram tab.
        if (!sender.tab || sender.id !== browser.runtime.id || !sender.url?.startsWith(`${INSTAGRAM_ORIGIN}/`)) {
          return undefined;
        }
        return (async () => {
          const outcome = await (await store).commit(message.result);
          broadcast({ type: 'sync:committed', viewerId: message.result.viewerId, outcome });
          return outcome;
        })();
      }
      default:
        return undefined;
    }
  });

  if (DIAGNOSTICS_ENABLED) {
    // Firefox builds default to MV2, where the toolbar button is `browserAction`.
    const action = browser.action ?? browser.browserAction;
    action.onClicked.addListener(() => {
      void browser.tabs.create({ url: browser.runtime.getURL('/diagnostics.html') });
    });
  }
});
