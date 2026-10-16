# Follower Tracker (working name)

A local-only browser extension that tracks your Instagram follow lists: who doesn't follow you back, your mutuals, your fans, and who unfollowed you over time. No exports, no extra login, no servers. Data stays in the extension's own IndexedDB.

> **Status:** the collector, snapshot store, diff engine and automatic daily sync work and have been verified on a real account. There's no user-facing UI yet, only a dev-only diagnostics page. The legacy app in the repo root is untouched.

## Develop

Requires Node 22+.

```bash
npm install
npm test            # unit + integration tests (fake Instagram, fake IndexedDB)
npm run typecheck
npm run lint
npm run build:dev   # → .output/chrome-mv3-dev (diagnostics page + dev bridge)
npm run build       # → .output/chrome-mv3 (production: neither)
```

### Load it into Chrome

Instagram only works in a profile where you're already signed in, so WXT does not launch its own browser (`webExt.disabled` in `wxt.config.ts`).

1. Run `npm run build:dev`.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `.output/chrome-mv3-dev`.
3. Open or reload a `https://www.instagram.com` tab where you're signed in. About 10 seconds later it offers to sync, and the first sync runs automatically.
4. Click the extension's toolbar icon. In dev builds it opens the diagnostics page: probe, Sync now, the automatic-sync schedule, and the stored data.

After a code change, rebuild and reload the extension (on `chrome://extensions`, or with the dev bridge below), then reload the Instagram tab.

### Dev bridge

Dev builds let scripts on an `instagram.com` page talk to the extension, from the DevTools console or an automation tool driving your signed-in browser. Production builds don't contain the bridge.

```js
const ft = (command, args) => new Promise(resolve => {
  const id = crypto.randomUUID();
  addEventListener('message', function on(e) {
    if (e.data?.source === 'follower-tracker-dev' && e.data.direction === 'reply' && e.data.id === id) {
      removeEventListener('message', on);
      resolve(e.data.error ?? e.data.result);
    }
  });
  postMessage({ source: 'follower-tracker-dev', direction: 'request', id, command, args }, location.origin);
});
await ft('scheduler');
```

| Command | What it does |
|---|---|
| `build` | Build id of the code in this tab. |
| `env` | Which tab the background would use, and whether everything runs the same build. |
| `probe` | Runs the 5-request endpoint probe. |
| `sync` | Runs a sync and waits for the saved (or rejected) result. |
| `stop` | Stops a running sync. |
| `summary` | Latest counts, recent snapshots and events, with usernames. |
| `scheduler` | Automatic-sync status: last sync, next due, budget used, interrupted sync. |
| `trigger` | Runs the automatic check now, skipping the one-day wait. |
| `setAuto` | Turns automatic syncing on or off (`true` / `false`). |
| `reload` | Reloads the extension from disk. Reload the Instagram tab afterwards. |

All of these only read from Instagram.

## How it works

```
Instagram tab loads ──autosync:ready──► background ──collector:run──► content script on www.instagram.com
    (or 30-min alarm,                    │  decides, holds the         │ same-origin requests with your session
     or "Sync now")                      │  lease, keeps the budget    │ checkpoint after every page
                                         ◄── collector:checkpoint ─────┤
                                         ◄── collector:finished ───────┘
                                         commits to IndexedDB, releases the lease
```

| Path | Role |
|---|---|
| `lib/instagram/api.ts` | Thin client for the endpoints. Returns status and failure hints; never throws, never retries. |
| `lib/instagram/session.ts` | Reads the `ds_user_id` and `csrftoken` cookies. `sessionid` is never read. |
| `lib/collector/collect.ts` | One sync: both lists side by side (sorted by date followed), then friendship checks. Checkpoints, resume, budget cap, backoff, abort. Fail-closed. |
| `lib/collector/probe.ts` | Read-only endpoint health check. The report contains no usernames or ids. |
| `lib/tracker/diff.ts` | Pure set math: mutuals, not following back, fans, gained and lost. |
| `lib/tracker/commit.ts` | Decides whether a result may be saved and which events it produces. |
| `lib/tracker/store.ts` | IndexedDB, per account: snapshots, latest id lists, profiles, events, checkpoints. |
| `lib/scheduler/policy.ts` | Pure rules for when to sync, resume, back off or wait for budget. |
| `lib/scheduler/state.ts` | Scheduler settings, attempts and budget in `storage.local`; the lease in `storage.session`. |
| `entrypoints/background.ts` | Runs the scheduler: picks a tab, holds the lease, saves checkpoints, commits results. |
| `entrypoints/instagram.content.ts` | Runs the collector in the page. Renders nothing and stores nothing. |
| `entrypoints/diagnostics/` | Dev-only page. Stripped from production builds. |
| `lib/devBridge.ts` | Dev-only page ↔ extension bridge. Stripped from production builds. |

### Automatic sync

- **When:** at most once a day per account, while a signed-in `www.instagram.com` tab is open. It's triggered when a tab finishes loading, with a 30-minute alarm for tabs that stay open.
- **One at a time:** a lease in session storage names the tab and run. It counts as dead if no heartbeat arrives for 60 seconds, the tab closes, or the tab reloads.
- **Resume:** each page is checkpointed (new accounts plus the next cursor). An interrupted run continues from its cursor, in the same tab after a reload or in another tab after a close. Checkpoints older than 6 hours, or with a stale cursor, are discarded and the sync starts over.
- **Budget:** 600 requests per account per day by default. A sync only starts when the remaining budget covers the last sync's cost, and the collector stops at the cap.
- **Back-off:** after a rate limit or a sign-in or challenge problem, wait 6 h; after an error, 2 h; after Stop, 12 h.

### Safety rules the code enforces

- **Only completed syncs are saved.** Rate limits, sign-in or challenge pages, page caps, a stop, the budget, or an empty list where data was expected all leave stored data untouched.
- **"Unfollowed you" means they left your followers list,** not that they don't follow back. Following someone new never produces an unfollow event.
- **Every apparent loss is re-checked** before it's recorded: in bulk, or one by one when Instagram refuses the bulk check. A loss is restored (the list skipped them), `confirmed`, or `unconfirmed` (Instagram returned nothing, e.g. a deactivated account).
- **Mass unexplained changes are rejected.** If more than max(25, 20%) of followers or follows vanish without confirmation, the snapshot is rejected and the previous one is kept.
- **Read-only.** There are no follow, unfollow, like or comment calls.

## Provenance

The endpoint parsing and the "fetch both lists, then classify" strategy are ported from the legacy app in this repo (EdvinCodes/InstagramUnfollowers), which in turn started from [davidarroyo1234/InstagramUnfollowers](https://github.com/davidarroyo1234/InstagramUnfollowers). Both are MIT-licensed; see `LICENSE`.

Not affiliated with or endorsed by Instagram or Meta.
