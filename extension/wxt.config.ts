import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

// Dev-only pages. They are stripped from production builds by the hook below,
// so nothing here ships to users.
const DEV_ONLY_ENTRYPOINTS = new Set(['diagnostics']);

// Stamped into every entrypoint so the diagnostics page can spot a stale background
// or Instagram tab after a rebuild. Computed once so all entrypoints agree.
const BUILD_ID = new Date().toISOString();

export default defineConfig({
  // Explicit imports everywhere: easier to read for contributors than auto-imports.
  imports: false,
  vite: () => ({
    plugins: [preact()],
    define: {
      __BUILD_ID__: JSON.stringify(BUILD_ID),
    },
  }),
  // Instagram only works in a profile where you are already signed in, so we load
  // the build into your normal Chrome profile by hand instead of letting WXT launch
  // a fresh, signed-out browser.
  webExt: {
    disabled: true,
  },
  manifest: ({ mode }) => ({
    name: mode === 'production' ? 'Follower Tracker' : 'Follower Tracker (dev)',
    description:
      'See who does not follow you back, your mutuals, and who unfollowed you. Runs locally in your browser.',
    // unlimitedStorage keeps snapshot history from being evicted under disk pressure;
    // storage holds scheduler state; alarms re-checks long-lived Instagram tabs.
    permissions: ['unlimitedStorage', 'storage', 'alarms'],
    host_permissions: ['https://www.instagram.com/*'],
    action: {
      default_title: 'Follower Tracker',
    },
  }),
  hooks: {
    // `entrypoints:grouped` only runs for real builds (not `wxt prepare`), so the
    // generated types still know about dev-only pages and typecheck covers them.
    'entrypoints:grouped': (wxt, groups) => {
      if (wxt.config.mode !== 'production') {
        return;
      }
      const isDevOnly = (entrypoint: { name: string }) => DEV_ONLY_ENTRYPOINTS.has(entrypoint.name);
      const kept = groups
        .map(group => (Array.isArray(group) ? group.filter(entrypoint => !isDevOnly(entrypoint)) : group))
        .filter(group => (Array.isArray(group) ? group.length > 0 : !isDevOnly(group)));
      groups.splice(0, groups.length, ...kept);
    },
  },
});
