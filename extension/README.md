# Follower Tracker (working name)

A local-only browser extension that tracks your Instagram follow lists: who doesn't follow you back, your mutuals, your fans, and who unfollowed you over time. No exports, no extra login, no servers. Data stays in the extension's own IndexedDB.

> **Status: core only.** This folder has the collector, the snapshot store and diff engine, and a dev-only diagnostics page. Automatic syncing and the real UI are not built yet. The legacy app in the repo root is untouched.

## Develop

Requires Node 22+.

```bash
npm install
npm test            # unit + integration tests (fake Instagram, fake IndexedDB)
npm run typecheck
npm run lint
npm run build:dev   # → .output/chrome-mv3-dev (includes the diagnostics page)
npm run build       # → .output/chrome-mv3 (production, no diagnostics page)
```

### Load it into Chrome

Instagram only works in a profile where you're already signed in, so WXT does not launch its own browser (`webExt.disabled` in `wxt.config.ts`).

1. `npm run build:dev`
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `.output/chrome-mv3-dev`.
3. Open or reload a `https://www.instagram.com` tab where you're signed in.
4. Click the extension's toolbar icon. In dev builds it opens the diagnostics page.
5. Run **Run probe** first: 4 read-only requests that tell you whether the endpoints still answer. Then use **Sync now**.

After a code change, rebuild, click the reload icon on `chrome://extensions`, and reload the Instagram tab.

## How it works

```
diagnostics page ──sync:start──► background ──collector:run──► content script on www.instagram.com
       ▲                            │  ▲                               │ same-origin requests with your
       │ reads IndexedDB            │  └──── collector:finished ───────┘ session (4 private endpoints)
       └──── sync:committed ◄───────┘ commits to IndexedDB
```

| Path | Role |
|---|---|
| `lib/instagram/api.ts` | Thin client for the 4 endpoints. Returns status + failure hints; never throws, never retries. |
| `lib/instagram/session.ts` | Reads `ds_user_id` / `csrftoken` cookies. `sessionid` is never read. |
| `lib/collector/collect.ts` | One full sync: following, then followers, then one `show_many` check. Pacing, backoff, abort. Fail-closed. |
| `lib/collector/probe.ts` | Read-only endpoint health check. The report contains no usernames or ids. |
| `lib/tracker/diff.ts` | Pure set math: mutuals, not following back, fans, gained/lost. |
| `lib/tracker/commit.ts` | Decides whether a result may be saved and which events it produces. |
| `lib/tracker/store.ts` | IndexedDB store, per account: snapshots, latest id lists, profiles, events. |
| `entrypoints/background.ts` | Finds the Instagram tab, hands it the previous snapshot, commits results. |
| `entrypoints/instagram.content.ts` | Runs the collector in the page. Renders nothing and stores nothing. |
| `entrypoints/diagnostics/` | Dev-only page. Stripped from production builds. |

### Safety rules the code enforces

- **Only completed syncs are saved.** Rate limits, sign-in or challenge pages, page caps, a stop, or an empty first page while your profile reports a positive count all leave the stored data untouched.
- **"Unfollowed you" means they left your followers list**, not that they don't follow back. Following someone new never produces an unfollow event.
- **Every apparent loss is re-checked** with `show_many` before it's recorded. The check either restores the account (the list just skipped it), marks the loss `confirmed`, or marks it `unconfirmed` (Instagram returned nothing, e.g. a deactivated account).
- **Mass unexplained changes are rejected.** If more than max(25, 20%) of followers or follows vanish without confirmation, the snapshot is rejected and the previous one is kept.
- **Read-only.** There are no follow, unfollow, like or comment calls.

## Provenance

The endpoint parsing and the "fetch both lists, then classify" strategy are ported from the legacy app in this repo (EdvinCodes/InstagramUnfollowers), which in turn started from [davidarroyo1234/InstagramUnfollowers](https://github.com/davidarroyo1234/InstagramUnfollowers). Both are MIT-licensed; see `LICENSE`.

Not affiliated with or endorsed by Instagram or Meta.
