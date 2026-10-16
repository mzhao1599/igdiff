# Store listing notes

Draft answers for the Chrome Web Store dashboard. Keep these in sync with `wxt.config.ts` and `PRIVACY.md`.

## Single purpose

Shows who doesn't follow you back on Instagram, your mutuals and fans, and who unfollowed you over time, and lets you unfollow accounts you choose.

## Permission justifications

| Permission | Why it's needed |
|---|---|
| Host access to `https://www.instagram.com/*` | The follow lists are read from the signed-in Instagram tab, with the user's own session. The content script runs only on `www.instagram.com`, and renders nothing into the page. |
| `storage` | Stores the sync schedule, today's request and unfollow counts, and the unfollow queue, so they survive the background worker restarting. |
| `unlimitedStorage` | Follower history lives in IndexedDB. Without this, Chrome may evict it under disk pressure and the user would lose their unfollow history. |
| `alarms` | Rechecks every 30 minutes whether a daily sync is due, for Instagram tabs that stay open for days. |
| `sidePanel` | The extension's whole interface is a side panel opened from the toolbar button. |

No remote code: everything that runs ships in the package. The bundle contains no `eval`, and nothing is fetched or executed from a server.

## Data use disclosures

- **Collects:** "Personally identifiable information" (Instagram usernames and names of the user's followers and followings) and "Website content" (follow lists). All of it stays on the user's device.
- **Not sold** to third parties, **not used** for purposes unrelated to the single purpose, **not used** to determine creditworthiness.

## Listing copy

**Name:** pick one without "Instagram", "Insta" or "Gram" in it (Meta's brand guidelines). "for Instagram" can appear in the description.

**Short description (≤132 characters):**
See who doesn't follow you back, who unfollowed you, and your mutuals. Private: everything stays in your browser.

**What to show in screenshots:** the side panel's four tiles, the "don't follow back" list with selection, the confirmation sheet, and the changes timeline.

## Before submitting

- [ ] Final name and icon (current icon: `assets/icon.svg`, rendered to `public/icon/`).
- [ ] Host `PRIVACY.md` at a public URL and link it in the dashboard.
- [ ] `npm run zip` and upload `.output/*-chrome.zip`.
