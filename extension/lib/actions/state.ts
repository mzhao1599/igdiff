/**
 * Unfollow job and daily ledger in `storage.local`, so a running or paused job
 * survives the background worker restarting.
 */
import { browser } from 'wxt/browser';
import type { UnfollowLedger } from './limits';
import type { UnfollowEndpoint } from '../instagram/api';
import type { UnfollowRunOutcome } from './unfollow';

export type UnfollowJobStatus = 'running' | 'paused' | 'finished';

export interface UnfollowJob {
  readonly id: string;
  readonly viewerId: string;
  readonly tabId: number | null;
  /** Accounts still to unfollow, in order. */
  readonly queue: readonly string[];
  readonly total: number;
  readonly unfollowed: number;
  readonly skipped: number;
  readonly status: UnfollowJobStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly outcome: UnfollowRunOutcome | 'interrupted' | null;
  readonly message: string | null;
  /** The unfollow endpoint Instagram accepted on the last run, if any did. */
  readonly endpoint?: UnfollowEndpoint | null;
}

interface UnfollowState {
  job: UnfollowJob | null;
  ledgers: Record<string, UnfollowLedger>;
}

const KEY = 'unfollow';

async function read(): Promise<UnfollowState> {
  const stored = (await browser.storage.local.get(KEY))[KEY] as Partial<UnfollowState> | undefined;
  return { job: stored?.job ?? null, ledgers: stored?.ledgers ?? {} };
}

async function update(change: (state: UnfollowState) => void): Promise<UnfollowState> {
  const state = await read();
  change(state);
  await browser.storage.local.set({ [KEY]: state });
  return state;
}

export const unfollowState = {
  read,
  setJob: (job: UnfollowJob | null) =>
    update(state => {
      state.job = job;
    }),
  setLedger: (viewerId: string, ledger: UnfollowLedger) =>
    update(state => {
      state.ledgers[viewerId] = ledger;
    }),
};
