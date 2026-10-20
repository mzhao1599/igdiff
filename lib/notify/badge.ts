/**
 * Toolbar badge for unfollowers the user hasn't seen yet. A sync that records
 * followers lost adds to the count; opening the side panel clears it.
 */
import { browser } from 'wxt/browser';

const KEY = 'badge';
const COLOR = '#dc2626';

type Unseen = Record<string, number>;

export function badgeText(unseen: Readonly<Unseen>): string {
  const total = Object.values(unseen).reduce((sum, count) => sum + Math.max(0, count), 0);
  if (total <= 0) {
    return '';
  }
  return total > 99 ? '99+' : String(total);
}

async function read(): Promise<Unseen> {
  return ((await browser.storage.local.get(KEY))[KEY] as Unseen | undefined) ?? {};
}

async function show(unseen: Unseen): Promise<void> {
  const action = browser.action ?? browser.browserAction;
  await action.setBadgeText({ text: badgeText(unseen) });
  await action.setBadgeBackgroundColor({ color: COLOR });
}

export const unfollowerBadge = {
  /** Re-applies the stored count (badges reset when the extension reloads). */
  async restore(): Promise<void> {
    await show(await read());
  },

  async add(viewerId: string, count: number): Promise<void> {
    if (count <= 0) {
      return;
    }
    const unseen = await read();
    unseen[viewerId] = (unseen[viewerId] ?? 0) + count;
    await browser.storage.local.set({ [KEY]: unseen });
    await show(unseen);
  },

  async clear(viewerId: string | null): Promise<void> {
    const unseen = await read();
    if (viewerId) {
      delete unseen[viewerId];
    } else {
      for (const key of Object.keys(unseen)) {
        delete unseen[key];
      }
    }
    await browser.storage.local.set({ [KEY]: unseen });
    await show(unseen);
  },
};
