/**
 * Message contracts between the extension's three contexts:
 *
 *   page (diagnostics, later the side panel) ──► background ──► Instagram content script
 *                                    ◄── broadcasts (progress, finished, committed) ──┘
 *
 * The content script only collects. The background owns the store and decides
 * what gets saved. Pages read the store directly (same extension origin).
 */
import { browser, type Browser } from 'wxt/browser';
import type { Baseline, CollectionProgress, CollectionResult, CollectorSettings } from './collector/collect';
import type { ProbeReport } from './collector/probe';
import type { CommitOutcome } from './tracker/store';

// Background → content script (via tabs.sendMessage).
export type ContentRequest =
  | { readonly type: 'collector:status' }
  | { readonly type: 'collector:probe' }
  | { readonly type: 'collector:run'; readonly baseline: Baseline | null; readonly settings?: Partial<CollectorSettings> }
  | { readonly type: 'collector:stop' };

export interface CollectorStatus {
  /** Build of the content script answering. Older than the page's build means the tab needs a reload. */
  readonly buildId: string;
  readonly viewerId: string | null;
  readonly running: boolean;
  /** Latest progress of the running sync, so a freshly opened page can pick it up. */
  readonly progress: CollectionProgress | null;
}

export interface SyncStopResponse {
  readonly ok: true;
  /** How many tabs actually had a sync running. 0 means there was nothing to stop. */
  readonly stopped: number;
}

// Page → background (via runtime.sendMessage).
export type BackgroundRequest =
  | { readonly type: 'env:status' }
  | { readonly type: 'probe:run' }
  | { readonly type: 'sync:start' }
  | { readonly type: 'sync:stop' };

export type EnvProblem = 'no_instagram_tab' | 'content_script_missing' | 'signed_out';

export interface EnvStatus {
  readonly backgroundBuildId: string;
  readonly tabId: number | null;
  readonly tabUrl: string | null;
  readonly collector: CollectorStatus | null;
  readonly problem: EnvProblem | null;
}

export type SyncStartResponse =
  | { readonly ok: true; readonly tabId: number; readonly viewerId: string; readonly hasBaseline: boolean }
  | { readonly ok: false; readonly error: EnvProblem | 'already_running' };

export type ProbeResponse = { readonly ok: true; readonly report: ProbeReport } | { readonly ok: false; readonly error: EnvProblem };

// Content script / background → everyone listening (fire and forget).
export type Broadcast =
  | { readonly type: 'collector:progress'; readonly progress: CollectionProgress }
  | { readonly type: 'collector:finished'; readonly result: CollectionResult }
  | { readonly type: 'sync:committed'; readonly viewerId: string | null; readonly outcome: CommitOutcome };

export type RuntimeMessage = BackgroundRequest | Broadcast;

/**
 * Registers an async handler. Returning `undefined` means "not mine", so other
 * listeners (or nobody) can answer.
 */
export function handleMessages<M>(
  handler: (message: M, sender: Browser.runtime.MessageSender) => Promise<unknown> | undefined,
): () => void {
  const listener = (message: unknown, sender: Browser.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
    const pending = handler(message as M, sender);
    if (pending === undefined) {
      return false;
    }
    pending.then(sendResponse, (error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}

export function sendToBackground<R>(message: BackgroundRequest): Promise<R> {
  return browser.runtime.sendMessage(message) as Promise<R>;
}

export function sendToTab<R>(tabId: number, message: ContentRequest): Promise<R> {
  return browser.tabs.sendMessage(tabId, message) as Promise<R>;
}

/** Fire-and-forget. Nobody listening (e.g. no diagnostics page open) is not an error. */
export function broadcast(message: Broadcast): void {
  browser.runtime.sendMessage(message).catch(() => undefined);
}
