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
import type {
  Baseline,
  CheckpointDelta,
  CollectionProgress,
  CollectionResult,
  CollectorSettings,
  ResumeState,
} from './collector/collect';
import type { ProbeReport } from './collector/probe';
import type { Attempt, AutoSyncDecision } from './scheduler/policy';
import type { CommitOutcome } from './tracker/store';

// Background → content script (via tabs.sendMessage).
export type ContentRequest =
  | { readonly type: 'collector:status' }
  | { readonly type: 'collector:probe' }
  | {
      readonly type: 'collector:run';
      readonly runId: string;
      readonly baseline: Baseline | null;
      readonly resume: ResumeState | null;
      readonly maxRequests: number;
      readonly settings?: Partial<CollectorSettings>;
    }
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
  | { readonly type: 'sync:stop' }
  /** From an Instagram tab that finished loading and is signed in: sync now if one is due. */
  | { readonly type: 'autosync:ready' }
  | { readonly type: 'scheduler:status' }
  | { readonly type: 'scheduler:set'; readonly enabled: boolean }
  /** Run the automatic check now, ignoring the 24-hour wait and failure back-off. */
  | { readonly type: 'scheduler:trigger' }
  // Dev builds only (see lib/devBridge.ts).
  | { readonly type: 'dev:reload' }
  | { readonly type: 'dev:summary' }
  | { readonly type: 'dev:sync' };

export type EnvProblem = 'no_instagram_tab' | 'content_script_missing' | 'signed_out';

export interface EnvStatus {
  readonly backgroundBuildId: string;
  readonly tabId: number | null;
  readonly tabUrl: string | null;
  readonly collector: CollectorStatus | null;
  readonly problem: EnvProblem | null;
}

export type SyncStartResponse =
  | {
      readonly ok: true;
      readonly tabId: number;
      readonly viewerId: string;
      readonly hasBaseline: boolean;
      readonly resumed: boolean;
    }
  | { readonly ok: false; readonly error: EnvProblem | 'already_running' | 'budget' };

export interface SchedulerStatus {
  readonly enabled: boolean;
  readonly dailyBudget: number;
  /** The sync running right now, if any. */
  readonly running: { readonly tabId: number; readonly mode: 'auto' | 'manual'; readonly startedAt: number } | null;
  /** Everything below is for the account signed in to the Instagram tab, when there is one. */
  readonly viewerId: string | null;
  readonly lastSyncAt: number | null;
  readonly lastAttempt: Attempt | null;
  readonly budgetUsed: number;
  readonly estimate: number;
  readonly checkpoint: {
    readonly updatedAt: number;
    readonly requests: number;
    readonly following: { readonly rows: number; readonly done: boolean } | null;
    readonly followers: { readonly rows: number; readonly done: boolean } | null;
  } | null;
  readonly next: AutoSyncDecision | null;
}

export type ProbeResponse = { readonly ok: true; readonly report: ProbeReport } | { readonly ok: false; readonly error: EnvProblem };

// Content script / background → everyone listening (fire and forget).
export type Broadcast =
  | { readonly type: 'collector:progress'; readonly progress: CollectionProgress }
  | { readonly type: 'collector:finished'; readonly runId: string; readonly result: CollectionResult }
  | { readonly type: 'collector:checkpoint'; readonly delta: CheckpointDelta }
  /** The scheduler started or released a sync; pages should refresh their status. */
  | { readonly type: 'scheduler:changed' }
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
