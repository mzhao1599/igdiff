# Chrome Web Store listing

Everything to paste into the developer dashboard. Keep it in sync with `wxt.config.ts` and `PRIVACY.md`.

## Package

`npm run zip` → upload `.output/igdiff-<version>-chrome.zip`.

## Store listing tab

**Name** (from the manifest, 54 of 75 characters; the store searches it first):
IgDiff: Unfollowers & Not Following Back for Instagram

**Summary** (from the manifest, 120 of 132 characters):
See who unfollowed you and who doesn't follow you back on Instagram. Free, no password, and nothing leaves your browser.

**Category:** Social Networking. **Language:** English.

**Description** (say "Instagram" at most five times: the store treats more as keyword spam):

```
See who unfollowed you on Instagram and who doesn't follow you back, automatically. IgDiff is free and open source. It never asks for your password, and your data never leaves your browser.

Stay signed in as usual. IgDiff reads your followers and following in the background from your open tab (about 20 seconds for 1,000 accounts) and keeps a daily snapshot, so you can see exactly who came and went.

WHAT YOU GET
• Unfollowers: who unfollowed you, day by day. Each one is double-checked before it shows up.
• Not following back: everyone you follow who doesn't follow you back
• Fans: people who follow you that you don't follow back
• Mutuals
• Follower and following counts, with a 7-day change and a follower graph
• Unfollow, remove followers or follow back, one at a time or in bulk, at a slow, safe pace (at most 100 a day; it stops at the first sign of trouble)
• Keep list: star accounts you never want to unfollow or remove
• A toolbar badge when someone unfollows you
• Sort by recent, oldest or A–Z, search, and export to CSV or JSON
• Light and dark mode

PRIVATE BY DESIGN
• No login: it uses the session you already have in your browser
• No servers: everything is stored on your computer, and nothing is sent anywhere else
• No tracking, no ads, no analytics
• Delete everything with one click
• Open source: anyone can read the code on GitHub

QUESTIONS
How do I see who unfollowed me?
Install IgDiff and open your account in a signed-in tab. The first sync shows who doesn't follow you back right away. After that, IgDiff compares each day's snapshot with the last and lists anyone who unfollowed you.

Does it need my password?
No. It works inside your own signed-in tab and never sees your password.

Will my account get blocked?
IgDiff reads your lists once a day. Unfollows and removals go one at a time, 15 to 35 seconds apart, at most 100 a day, and stop the moment anything looks wrong.

Does it work on my phone?
No. It's a Chrome extension, so it runs on a computer.

Is it free?
Yes. There's no premium tier and no account to create.

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
