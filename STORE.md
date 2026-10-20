# Chrome Web Store listing

Everything to paste into the developer dashboard. Keep it in sync with `wxt.config.ts` and `PRIVACY.md`.

## Package

`npm run zip` → upload `.output/igdiff-<version>-chrome.zip`.

## Store listing tab

**Name:** IgDiff (from the manifest)

**Summary** (from the manifest, 124 of 132 characters):
See who doesn't follow you back, who unfollowed you, and your mutuals on Instagram. Automatic, private, all in your browser.

**Category:** Social Networking. **Language:** English.

**Description:**

```
IgDiff shows you, automatically, who doesn't follow you back on Instagram, who unfollowed you, your mutuals and your fans.

Open Instagram in a tab where you're already signed in. IgDiff reads your follower and following lists in the background (about 20 seconds for 1,000 accounts), then keeps a daily snapshot, so you can see exactly who came and went.

WHAT YOU GET
• Followers and following, with a 7-day diff and a trend graph
• Don't follow back: everyone you follow who doesn't follow you
• Fans: people who follow you that you don't follow back
• Mutuals
• Changes: who followed and unfollowed you, day by day, with unfollows double-checked with Instagram
• Unfollow, remove followers or follow back, one at a time or in bulk, at a slow, safe pace (at most 100 a day; it stops at the first sign Instagram objects)
• Keep list: star accounts you never want to unfollow or remove
• Sort by recent, oldest or A–Z, search, and export to CSV or JSON
• Light and dark mode

PRIVATE BY DESIGN
• No login: it uses the Instagram session you already have
• No servers: your data stays in your browser, and nothing is sent anywhere but Instagram
• No tracking, no ads, no analytics
• Delete everything with one click

HOW TO USE
1. Install IgDiff and pin it to the toolbar.
2. Open instagram.com, signed in. Your first sync starts on its own.
3. Click the IgDiff icon to open the side panel.

IgDiff is not affiliated with, endorsed by, or sponsored by Instagram or Meta. Instagram is a trademark of Instagram, LLC.
```

**Graphics** (in `store-assets/`):

| Field | File |
|---|---|
| Store icon (128×128) | `public/icon/128.png` |
| Screenshots (1280×800) | `store-assets/1-dont-follow-back.png` … `5-private.png` |
| Small promo tile (440×280) | `store-assets/promo-tile-440x280.png` |

The screenshots use fictional demo accounts, not real people.

## Privacy practices tab

**Single purpose:**
Shows who doesn't follow you back on Instagram, your mutuals and fans, and who unfollowed you over time, and lets you unfollow, remove or follow back accounts you choose.

**Permission justifications:**

| Permission | Justification |
|---|---|
| Host access to `https://www.instagram.com/*` | The follow lists are read from the user's signed-in Instagram tab, with their own session. The content script runs only on www.instagram.com and renders nothing into the page. |
| `storage` | Stores the sync schedule, today's request and action counts, and the queue of a running batch of unfollows, removals or follow-backs, so they survive the background worker restarting. |
| `unlimitedStorage` | Follower history and profile pictures live in IndexedDB. Without this, Chrome may evict them under disk pressure and the user would lose their history. |
| `alarms` | Rechecks every 30 minutes whether the daily sync is due, for Instagram tabs that stay open for days. |
| `sidePanel` | The extension's whole interface is a side panel opened from the toolbar button. |

**Remote code:** No. Everything that runs ships in the package. The bundle contains no `eval`, and nothing is fetched or executed from a server.

**Data usage:** tick **Personally identifiable information** (usernames and names of the user's followers and followings) and **Website content** (follow lists, profile pictures). All of it stays on the user's device.

Certify all three: not sold to third parties, not used for purposes unrelated to the single purpose, not used to determine creditworthiness.

**Privacy policy URL:** https://github.com/mzhao1599/igdiff/blob/main/PRIVACY.md

(Version 0.1.0 was submitted with `.../blob/main/extension/PRIVACY.md`. That copy stays until the dashboard points at the new address.)

**Homepage URL:** https://github.com/mzhao1599/igdiff · **Support URL:** https://github.com/mzhao1599/igdiff/issues

## Before submitting

- [ ] Bump `version` in `package.json` for every new upload. The store rejects a version it has already seen.
- [ ] `npm run zip` and upload the zip.
- [ ] Check the name. Instagram's brand guidelines have asked third-party apps not to use "IG", "Insta" or "Gram" in their names; a trademark complaint could force a rename later.
