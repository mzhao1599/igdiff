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
} from '../lib/messages';
import type { ProbeReport } from '../lib/collector/probe';
import { TrackerStore } from '../lib/tracker/store';
import { DIAGNOSTICS_ENABLED } from '../lib/env';

export default defineBackground(() => {
  const store = TrackerStore.open();

  async function findInstagramTab(): Promise<Browser.tabs.Tab | null> {
    const tabs = await browser.tabs.query({ url: `${INSTAGRAM_ORIGIN}/*` });
    const usable = tabs.filter(tab => tab.id !== undefined && !tab.discarded);
    return usable.find(tab => tab.active) ?? usable[0] ?? null;
  }

  async function readEnv(): Promise<EnvStatus> {
    const tab = await findInstagramTab();
    if (!tab?.id) {
      return { tabId: null, tabUrl: null, collector: null, problem: 'no_instagram_tab' };
    }
    try {
      const collector = await sendToTab<CollectorStatus>(tab.id, { type: 'collector:status' });
      return {
        tabId: tab.id,
        tabUrl: tab.url ?? null,
        collector,
        problem: collector.viewerId ? null : 'signed_out',
      };
    } catch {
      // Tabs opened before the extension was installed or reloaded have no content script yet.
      return { tabId: tab.id, tabUrl: tab.url ?? null, collector: null, problem: 'content_script_missing' };
    }
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
        return (async () => {
          const env = await readEnv();
          if (env.tabId !== null && env.collector) {
            await sendToTab(env.tabId, { type: 'collector:stop' });
          }
          return { ok: true };
        })();
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
