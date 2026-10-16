import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { collect, type CollectionProgress } from '../lib/collector/collect';
import { runProbe } from '../lib/collector/probe';
import { installDevBridge } from '../lib/devBridge';
import { BUILD_ID, DIAGNOSTICS_ENABLED } from '../lib/env';
import type { InstagramClient } from '../lib/instagram/api';
import { readSession } from '../lib/instagram/session';
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
    const client: InstagramClient = {
      fetch: (input, init) => window.fetch(input, init),
      csrfToken: () => readSession(document.cookie).csrfToken,
    };
    let running: AbortController | null = null;
    let lastProgress: CollectionProgress | null = null;

    // Extension reloaded or updated: this copy of the script is orphaned, so stop any sync.
    ctx.onInvalidated(() => running?.abort());

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
        scheduler: () => sendToBackground({ type: 'scheduler:status' }),
        trigger: () => sendToBackground({ type: 'scheduler:trigger' }),
        setAuto: args => sendToBackground({ type: 'scheduler:set', enabled: Boolean(args) }),
        reload: () => sendToBackground({ type: 'dev:reload' }),
      });
      ctx.onInvalidated(removeBridge);
    }
  },
});
