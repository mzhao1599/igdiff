import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { runUnfollows } from '../lib/actions/unfollow';
import { fetchAvatars } from '../lib/avatars';
import { collect, type CollectionProgress } from '../lib/collector/collect';
import { runProbe } from '../lib/collector/probe';
import { installDevBridge } from '../lib/devBridge';
import { BUILD_ID, DIAGNOSTICS_ENABLED } from '../lib/env';
import { INSTAGRAM_ORIGIN, type InstagramClient } from '../lib/instagram/api';
import { buildWebClient, parsePageConfig, randomPageId, readSession, type PageConfig } from '../lib/instagram/session';
import {
  broadcast,
  handleMessages,
  sendToBackground,
  type CollectorStatus,
  type ContentRequest,
} from '../lib/messages';

/** While a sync runs, re-send the latest progress this often so pages can tell it is alive. */
const HEARTBEAT_MS = 5_000;
/** Let Instagram finish loading before offering to sync. */
const READY_DELAY_MS = 10_000;
/** The web app's X-ASBD-ID (its BDHeaderConfig module); not in the page's HTML. */
const WEB_ASBD_ID = '359341';
/** Fetch a fresh copy of Instagram's page for a new request token at most this often. */
const FRESH_PAGE_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Runs on www.instagram.com only. Collection has to happen here: requests made
 * from this page carry the user's own Instagram session, exactly like the web
 * app's. Nothing is rendered into the page and nothing is stored here; the
 * background decides when to sync and keeps the data.
 */
export default defineContentScript({
  matches: ['https://www.instagram.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    // The page's HTML is large; read Instagram's request token and revision from it once, on the first POST.
    let pageConfig: PageConfig | null = null;
    let freshPageAt = 0;
    const pageId = randomPageId();
    // Firefox runs content-script fetch() as the extension; content.fetch() runs it as the page,
    // with the page's cookies, which is what these requests need. Chrome's fetch already does.
    const pageFetch: typeof fetch =
      (globalThis as { content?: { fetch?: typeof fetch } }).content?.fetch?.bind(
        (globalThis as { content?: object }).content,
      ) ?? window.fetch.bind(window);
    const loadPageConfig = async (fresh: boolean): Promise<PageConfig> => {
      // A tab open for days can hold an expired token; a newly loaded page has a current one.
      if (fresh && Date.now() - freshPageAt > FRESH_PAGE_MIN_INTERVAL_MS) {
        freshPageAt = Date.now();
        try {
          const next = parsePageConfig(await (await pageFetch(`${INSTAGRAM_ORIGIN}/`, { credentials: 'include' })).text());
          if (next.dtsg) {
            pageConfig = next;
          }
        } catch {
          // Keep the page's own values.
        }
      }
      return (pageConfig ??= parsePageConfig(document.documentElement.innerHTML));
    };
    const client: InstagramClient = {
      fetch: (input, init) => pageFetch(input, init),
      csrfToken: () => readSession(document.cookie).csrfToken,
      webClient: async ({ fresh = false } = {}) =>
        buildWebClient({
          page: await loadPageConfig(fresh),
          csrfToken: readSession(document.cookie).csrfToken,
          sessionStore: window.sessionStorage,
          localStore: window.localStorage,
          asbdId: WEB_ASBD_ID,
          pageId,
          now: Date.now(),
        }),
    };
    let running: AbortController | null = null;
    let lastProgress: CollectionProgress | null = null;
    let unfollowing: AbortController | null = null;

    // Extension reloaded or updated: this copy of the script is orphaned, so stop everything.
    ctx.onInvalidated(() => {
      running?.abort();
      unfollowing?.abort();
    });

    handleMessages<ContentRequest>(message => {
      switch (message.type) {
        case 'collector:status':
          return Promise.resolve<CollectorStatus>({
            buildId: BUILD_ID,
            viewerId: readSession(document.cookie).viewerId,
            running: running !== null,
            progress: running ? lastProgress : null,
          });
        case 'collector:probe':
          return runProbe({ client, session: readSession(document.cookie) });
        case 'collector:run': {
          if (running) {
            return Promise.resolve({ started: false });
          }
          const controller = new AbortController();
          const { runId } = message;
          running = controller;
          lastProgress = null;
          const heartbeat = setInterval(() => {
            if (lastProgress) {
              broadcast({ type: 'collector:progress', progress: lastProgress });
            }
          }, HEARTBEAT_MS);
          void collect({
            client,
            viewerId: readSession(document.cookie).viewerId,
            baseline: message.baseline,
            resume: message.resume,
            maxRequests: message.maxRequests,
            runId,
            settings: message.settings,
            signal: controller.signal,
            onProgress: progress => {
              lastProgress = progress;
              broadcast({ type: 'collector:progress', progress });
            },
            onCheckpoint: delta => broadcast({ type: 'collector:checkpoint', delta }),
          })
            .then(result => broadcast({ type: 'collector:finished', runId, result }))
            .finally(() => {
              clearInterval(heartbeat);
              running = null;
              lastProgress = null;
            });
          return Promise.resolve({ started: true });
        }
        case 'collector:stop': {
          const wasRunning = running !== null;
          running?.abort();
          return Promise.resolve({ stopping: wasRunning });
        }
        case 'unfollow:run': {
          // Only ever sent after the user chose these accounts in the side panel.
          if (unfollowing) {
            return Promise.resolve({ started: false });
          }
          const controller = new AbortController();
          const { jobId } = message;
          unfollowing = controller;
          void runUnfollows({
            kind: message.kind,
            client,
            viewerId: readSession(document.cookie).viewerId,
            pks: message.pks,
            maxUnfollows: message.maxUnfollows,
            signal: controller.signal,
            onItem: item => broadcast({ type: 'unfollow:item', jobId, item }),
            onProgress: progress => broadcast({ type: 'unfollow:progress', jobId, progress }),
          })
            .then(result => broadcast({ type: 'unfollow:finished', jobId, result }))
            .finally(() => {
              unfollowing = null;
            });
          return Promise.resolve({ started: true });
        }
        case 'unfollow:stop': {
          const wasRunning = unfollowing !== null;
          unfollowing?.abort();
          return Promise.resolve({ stopping: wasRunning });
        }
        case 'avatars:fetch':
          // No cookies: the pictures are public, signed URLs.
          return fetchAvatars(pageFetch, message.requests);
        default:
          return undefined;
      }
    });

    // Offer to sync once the page has settled. The background decides whether one is due.
    ctx.setTimeout(() => {
      if (readSession(document.cookie).viewerId && !running) {
        void browser.runtime.sendMessage({ type: 'autosync:ready' }).catch(() => undefined);
      }
    }, READY_DELAY_MS);

    if (DIAGNOSTICS_ENABLED) {
      const removeBridge = installDevBridge({
        build: async () => BUILD_ID,
        env: () => sendToBackground({ type: 'env:status' }),
        probe: () => runProbe({ client, session: readSession(document.cookie) }),
        sync: () => sendToBackground({ type: 'dev:sync' }),
        stop: () => sendToBackground({ type: 'sync:stop' }),
        summary: () => sendToBackground({ type: 'dev:summary' }),
        avatars: () => sendToBackground({ type: 'dev:avatars' }),
        scheduler: () => sendToBackground({ type: 'scheduler:status' }),
        // Read-only. Starting an unfollow is deliberately not a bridge command: page scripts must never change the account.
        unfollowStatus: () => sendToBackground({ type: 'unfollow:status', viewerId: readSession(document.cookie).viewerId }),
        trigger: () => sendToBackground({ type: 'scheduler:trigger' }),
        setAuto: args => sendToBackground({ type: 'scheduler:set', enabled: Boolean(args) }),
        reload: () => sendToBackground({ type: 'dev:reload' }),
      });
      ctx.onInvalidated(removeBridge);
    }
  },
});
