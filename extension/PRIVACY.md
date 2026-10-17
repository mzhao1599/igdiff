# Privacy policy

_Follower Tracker (working name). Last updated: October 16, 2026._

**Short version:** everything stays in your browser. The extension talks only to Instagram, using the Instagram session you're already signed in with. It has no servers, no analytics, no ads, and it sells or shares nothing.

## What the extension reads

When you have a `www.instagram.com` tab open and signed in, the extension reads, from Instagram:

- the list of accounts you follow and the list of accounts that follow you;
- for each of those accounts: username, full name, profile picture link, and whether it is private or verified;
- whether a specific account follows you, to double-check apparent changes.

It reads two of Instagram's cookies in that tab: `ds_user_id` (which account is signed in) and `csrftoken` (a header Instagram requires on its own requests). For requests that send data (unfollowing, friendship checks), it also reads the request token Instagram puts in its own page and sends it back to Instagram, as Instagram's web app does; if that token has expired, it loads Instagram's home page once for a fresh one. It never reads your password or Instagram's `sessionid` cookie, and these values go nowhere but Instagram.

## What it stores, and where

Everything is stored in your browser's extension storage (IndexedDB and `chrome.storage`), separately for each Instagram account you use:

- your follower and following lists from the most recent syncs, and counts from every sync;
- a history of changes: who followed or unfollowed you, and whom you followed or unfollowed;
- the profile details listed above for those accounts;
- accounts you marked "keep", and a log of unfollows you made with the extension;
- scheduling details: when the last sync ran, how many requests were made today, and an unfinished sync's progress.

None of it is stored on instagram.com, where Instagram's own scripts could read it.

## What it sends, and to whom

Only to Instagram, from your Instagram tab, as normal requests of your signed-in session:

- **Reading:** the follower and following lists, and friendship status checks. These run automatically, at most about once a day, within a daily request limit.
- **Unfollowing:** only for accounts you choose, and only after you confirm in the side panel.

Nothing is sent to the extension's authors or to anyone else. There is no telemetry, crash reporting, or remote configuration.

## Your control

In the side panel's Settings (⚙):

- **Turn off automatic syncing.**
- **Export your data**, as CSV (the lists) or JSON (everything).
- **Delete your data:** "Delete this account's data" removes everything stored for that account. Uninstalling the extension removes all of it.

## Changes

Changes to this policy will be listed in the repository's history.

_Not affiliated with or endorsed by Instagram or Meta._
