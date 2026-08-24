/* Plotline - configuration.
 * Edit this file once and redeploy.
 *
 * Google Drive sync works out of the box — users just tap Sync now and
 * pick their Google account. To route sync through your own Google Cloud
 * project instead:
 *   1. Create a Google OAuth Client ID (Web application) in Google
 *      Cloud Console — see README for the 6-step walkthrough.
 *   2. Paste it in the app under ☰ → Google Drive sync → Advanced.
 *
 * Everything else has sensible defaults; leave it alone unless you
 * know you want a different behavior.
 */

/* App version — BUMP THIS on every change so you can confirm which
 * build is actually running on your device. Shown at the bottom of
 * the ☰ menu. Keep it in sync with CACHE_VERSION in sw.js. */
window.CW_VERSION = 'v7.7.0 · Plotline · 2026-08-23';

window.CW_CONFIG = {
  // Google OAuth 2.0 Client ID (Web application) used by default. Users can
  // override it per-device under ☰ → Google Drive sync to authorize through
  // their own Google Cloud project instead; that saved value wins over this.
  // Set to "" to ship a build with no default (Drive sync then stays off
  // until each user supplies an ID). Export / Import JSON always works.
  //
  // NOTE: for a public deployment the consent screen for this client must be
  // published to "In production" in Google Cloud Console — while it sits in
  // "Testing" it is capped at 100 users and shows an "unverified app" warning.
  driveClientId: '377102902188-joh759ie7vtmfd6uo2n4prucbgo1fde7.apps.googleusercontent.com',

  // If true, Drive sync only runs when the device is on Wi-Fi or
  // Ethernet (never on cellular). Recommended.
  wifiOnly: true,

  // If true, the app silently syncs to Drive a few seconds after
  // any event/topic change.
  autoSyncOnChange: true,

  // If true, the app attempts a silent sync at startup (if it's been
  // more than 15 minutes since the last sync).
  autoSyncOnStartup: true,

  // Minimum gap between auto-syncs (ms). Acts as a debounce.
  autoSyncDebounceMs: 5000,
};
