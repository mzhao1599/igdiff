import { defineContentScript } from 'wxt/utils/define-content-script';
import { collect, type CollectionProgress } from '../lib/collector/collect';
import { runProbe } from '../lib/collector/probe';
import type { InstagramClient } from '../lib/instagram/api';
import { BUILD_ID } from '../lib/env';
import { readSession } from '../lib/instagram/session';
import { broadcast, handleMessages, type CollectorStatus, type ContentRequest } from '../lib/messages';

/** While a sync runs, re-send the latest progress this often so pages can tell it is alive. */
const HEARTBEAT_MS = 5_000;

/**
 * Runs on www.instagram.com only. Collection has to happen here: requests made
 * from this page carry the user's own Instagram session, exactly like the web
 * app's. Nothing is rendered into the page and nothing is stored here.
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
            settings: message.settings,
            signal: controller.signal,
            onProgress: progress => {
              lastProgress = progress;
              broadcast({ type: 'collector:progress', progress });
            },
          })
            .then(result => broadcast({ type: 'collector:finished', result }))
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
  },
});
