/**
 * Scheduler state in extension storage.
 *
 * - `storage.local`: preferences, last attempt, today's request budget and the
 *   cost of the last sync, per account. Survives restarts.
 * - `storage.session`: the lease on the running sync. Survives the background
 *   worker restarting, but not a browser restart (where nothing is running anyway).
 */
import { browser } from 'wxt/browser';
import {
  addToBudget,
  DEFAULT_DAILY_BUDGET,
  type Attempt,
  type BudgetDay,
  type Lease,
} from './policy';

export interface SchedulerPrefs {
  readonly enabled: boolean;
  readonly dailyBudget: number;
}

export const DEFAULT_PREFS: SchedulerPrefs = { enabled: true, dailyBudget: DEFAULT_DAILY_BUDGET };

interface LocalState {
  prefs: SchedulerPrefs;
  attempts: Record<string, Attempt>;
  budget: Record<string, BudgetDay>;
  estimates: Record<string, number>;
}

const LOCAL_KEY = 'scheduler';
const LEASE_KEY = 'scheduler.lease';

/**
 * The lease belongs in session storage (gone after a browser restart, when nothing
 * runs anyway). Firefox's MV2 builds may lack it; local storage is fine there because
 * a lease without heartbeats expires after a minute.
 */
const leaseArea = () => browser.storage.session ?? browser.storage.local;

async function readLocal(): Promise<LocalState> {
  const stored = (await browser.storage.local.get(LOCAL_KEY))[LOCAL_KEY] as Partial<LocalState> | undefined;
  return {
    prefs: { ...DEFAULT_PREFS, ...stored?.prefs },
    attempts: stored?.attempts ?? {},
    budget: stored?.budget ?? {},
    estimates: stored?.estimates ?? {},
  };
}

async function updateLocal(change: (state: LocalState) => void): Promise<LocalState> {
  const state = await readLocal();
  change(state);
  await browser.storage.local.set({ [LOCAL_KEY]: state });
  return state;
}

export const schedulerState = {
  read: readLocal,

  setPrefs: (prefs: Partial<SchedulerPrefs>) =>
    updateLocal(state => {
      state.prefs = { ...state.prefs, ...prefs };
    }),

  recordAttempt: (viewerId: string, attempt: Attempt) =>
    updateLocal(state => {
      state.attempts[viewerId] = attempt;
    }),

  addRequests: (viewerId: string, requests: number, now: number) =>
    requests <= 0
      ? readLocal()
      : updateLocal(state => {
          state.budget[viewerId] = addToBudget(state.budget[viewerId], requests, now);
        }),

  recordEstimate: (viewerId: string, requests: number) =>
    updateLocal(state => {
      state.estimates[viewerId] = requests;
    }),

  async getLease(): Promise<Lease | null> {
    return ((await leaseArea().get(LEASE_KEY))[LEASE_KEY] as Lease | undefined) ?? null;
  },

  async setLease(lease: Lease | null): Promise<void> {
    if (lease) {
      await leaseArea().set({ [LEASE_KEY]: lease });
    } else {
      await leaseArea().remove(LEASE_KEY);
    }
  },
};
