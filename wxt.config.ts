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
  manifest: ({ mode, browser }) => ({
    // The store searches the name first, so it says what IgDiff does. Name and summary
    // live in public/_locales/<lang>/messages.json, so each store language gets its own
    // real translation. Dev builds keep a plain name to tell them apart in chrome://extensions.
    name: mode === 'production' ? '__MSG_extName__' : 'IgDiff (dev)',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    // unlimitedStorage keeps snapshot history from being evicted under disk pressure;
    // storage holds scheduler state; alarms re-checks long-lived Instagram tabs.
    permissions: ['unlimitedStorage', 'storage', 'alarms'],
    host_permissions: ['https://www.instagram.com/*'],
    action: {
      default_title: 'IgDiff',
      default_icon: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png' },
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'igdiff@extension',
              strict_min_version: '115.0',
              // Nothing leaves the user's device except requests to Instagram itself.
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : {}),
  }),
  hooks: {
    // MIT asks for the license notice in every copy, so it ships inside the build too.
    'build:publicAssets': (wxt, files) => {
      files.push({ absoluteSrc: `${wxt.config.root}/LICENSE`, relativeDest: 'LICENSE' });
    },
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
