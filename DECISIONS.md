# Product & architecture decisions

Standing decisions for Plotline, with the reasoning behind them, so future
changes argue against a recorded position instead of a vague memory.

Last reviewed: 2026-08-21 (pre-launch, v7.6.0).

---

## 1. Distribution: free, ungated

**Decision:** ship v1 on Google Play as a **free** app with **no feature
gating**.

**Why:**

- The Android app is a TWA pointing at `https://plotline.day/`.
  A TWA must load a publicly reachable URL, so the full app is always
  usable for free in any browser. Gating would only inconvenience
  non-technical users.
- The repo is public and the app is 100% client-side. Any entitlement flag
  lives in IndexedDB on the user's device, and the code that reads it is
  readable by anyone. There is no server, so there is nothing to enforce
  with.
- The product's stated promise is "no server, no account, no analytics,
  your data is yours." Capping topics or history contradicts that and holds
  a user's own local data hostage.
- At zero users, the scarce resource is feedback, not revenue. A price is a
  wall placed before anyone can evaluate the app.

**The irreversible half.** Per Google Play policy, a **paid app can be made
free, but a free app can never be made paid** — that requires a brand new
app with a new package name. So launching free permanently forecloses
up-front pricing. It does *not* foreclose in-app purchases, which can be
added to a free app at any time. Free is therefore the option that keeps
the most doors open.

**Revisit when:** there is a real install base asking for more.

---

## 2. Monetization, if it ever happens: additive IAP

**Decision:** no monetization in v1. If the app gains traction, add a
single "Supporter"/Pro **in-app purchase** rather than a price.

**Never gate:**

- Number of topics, length of history, or anything else that makes a user's
  existing data unreachable. That is data hostage-taking, reliably punished
  in reviews, and it contradicts §1.
- Export / import JSON. It is the guarantee that the data is really theirs,
  and it is also the migration path in §3.

**Acceptable to gate (best candidate first):**

1. **Insights / correlation engine.** The genuinely differentiated feature,
   and *additive* — not having it removes nothing and locks nothing up.
   "Free tracker, paid analysis" is a bargain users understand.
2. Goals & streaks.
3. Cosmetics — extra themes, alternate icons.

**Implementation notes for later.** Inside a TWA, billing goes through the
**Digital Goods API** (`getDigitalGoodsService('https://play.google.com/billing')`),
which requires `alphaDependencies.enabled` and `features.playBilling.enabled`
in `twa-manifest.json` (both currently off), a rebuild, and an in-app
product SKU in Play Console. Two caveats:

- The Digital Goods API **does not exist outside the TWA**, so browser users
  could never buy the upgrade. Gating shared code would lock out people who
  are structurally unable to pay.
- With no server there is no way to verify a purchase. Entitlement would be
  a cached client-side flag.

Both caveats disappear under Capacitor (§3), which is the argument for
deferring monetization until after that move rather than building it twice.

**The privacy cost of monetizing.** Per Google Play's developer-information
policy, "merchant accounts (developer accounts with apps that monetize via
paid apps or in-app purchases) **must show their full address on Google
Play**", taken from the linked Google payments profile. Adding a single IAP
therefore publishes a physical address on the listing — a much larger
disclosure than the package name or the repo, and it is not avoidable by
declaring non-trader status.

The mitigation is to control *which* address that is: a registered LLC
address, a virtual mailbox, or a registered-agent address, set on the
payments profile **before** the first in-app product is created. This has to
be arranged ahead of monetizing, not after.

---

## 3. Architecture: TWA now, Capacitor when native is needed

**Decision:** stay on the Bubblewrap TWA for v1.

**What TWA genuinely costs.** These are not currently possible:

- Home screen widget for one-tap logging — the most valuable native feature
  for this app category.
- Quick Settings tile and notification quick-actions.
- Health Connect integration (sleep, steps, heart rate would feed the
  correlation engine well).
- Reliable scheduled local reminders without a push server.
- Wear OS, Assistant shortcuts.
- Standard Play Billing; network-level gating.

**What it does not cost.** Package name and signing key are not TWA
concepts — Play only checks package name, signing key, and versionCode, and
the contents of the AAB are arbitrary. A Capacitor or fully native build
shipped under `day.plotline.app` with the same key reaches
existing users as a normal **update**, preserving the listing, reviews,
ratings, and install base. Nothing about the store presence has to be
rebuilt.

**Why TWA is right for now.** Its superpower is that a fix ships in ~60
seconds with no Play review, which is exactly what is wanted while still
learning whether anyone wants the app. Building widgets for zero users is
the more expensive mistake.

**The escalation ladder:**

| Stage | What changes | Cost |
| --- | --- | --- |
| **TWA** (today) | Chrome shell around the live site | done |
| **Capacitor** | Same JS, bundled *inside* the APK. Own the WebView, add native plugins (widgets, Health Connect, local notifications), standard Play Billing, no public-hosting requirement, instant cold start. | ~1 week, reuses nearly all code |
| **Full native** | Rewrite | only if this becomes the main project |

**Trigger to move to Capacitor:** the first time a real tester says they
want to log from the home screen. That, or a serious need for Health
Connect data.

---

## 4. Data migration plan (required before any shell change)

**The risk.** App data lives in IndexedDB (`whendidi`) under the origin
`https://plotline.day`, inside **Chrome's** storage — that is how
TWAs work. A Capacitor or native app runs in a different storage partition
and **cannot read it**. A naive swap would look exactly like total data
loss to every existing user.

**This already bit us once.** Moving from `mikejaron1.github.io/countwhen/`
to `plotline.day` (§6) changed the *origin*, so IndexedDB did not follow —
anyone who had installed the old URL saw an empty app. It was survivable
only because the move happened during internal testing, with a handful of
testers and no real data. The same move after launch would be a disaster.
Treat origin as permanent from here on.

**The mitigation** — both hatches already exist and must keep working:

1. **Google Drive sync** — the clean path. The cutover release prompts
   "sync to Drive"; the new shell signs in and restores from the same
   backup file.
2. **Export / import JSON** — the offline fallback for anyone not using
   Drive.

**Cutover checklist, when the time comes:**

- [ ] Ship a TWA release that nags un-synced users to back up (Drive or JSON).
- [ ] Leave it live long enough for the slow-moving majority to open the app.
- [ ] Ensure the new shell offers **Restore from Drive** and **Import JSON**
      in first-run onboarding, before any empty state is shown.
- [ ] Keep `DB_NAME = 'whendidi'` and the export schema unchanged so old
      backup files still import cleanly.
- [ ] Test an upgrade install over the top of a real TWA install, not just
      a fresh install.

---

## 5. Google Drive OAuth: shipped default with per-device override

**Decision:** `js/config.js` carries the project's OAuth client ID as a
**default**, so a normal user just taps *Sync now* and picks an account. A
client ID saved in-app (☰ → Google Drive sync → *Advanced*) is stored per
device and **overrides** the default; clearing it reverts.

**Why:** requiring every user to create their own Google Cloud project was
a non-starter for a store app, while hard-coding the developer's ID with no
escape hatch removes control from self-hosters. The hybrid serves both.

**Notes:**

- The only scope used is `drive.file`, which Google classifies as
  **non-sensitive** — no demo video, app review, or third-party security
  assessment required.
- **While the consent screen sits in Testing, Drive sync is effectively
  broken for everyone, including the developer.** Google's docs are
  explicit: Testing projects are limited to at most 100 *explicitly listed*
  test users, and **"authorizations by a test user will expire seven days
  from the time of consent."** Nobody who is not on that list can connect
  at all, and everyone on it silently drops off weekly. The name/email/
  profile exception to this rule does not apply, because the app requests
  `drive.file`.
- **Publishing to In production is free and unblocks everything.** Because
  the only scope is non-sensitive: verification is not mandatory ("if your
  app utilizes only non-sensitive scopes, it is not mandatory for your app
  to complete the app verification process"); the OAuth user cap does not
  apply, since it "limits the number of users that can grant permission to
  your app when requesting unapproved **sensitive or restricted** scopes";
  and no "unverified app" warning is shown, since that too is triggered by
  sensitive or restricted scopes. The 7-day expiry disappears with it.
- The one thing production does *not* grant is branding: the app name and
  logo appear on the consent screen only after the lighter-weight "brand
  verification". Until then users see a less polished screen, which is
  cosmetic and not a blocker.
- Data safety remains **no collection**: the token is issued to the user,
  files land in the user's own Drive, and nothing reaches a developer
  server.
- **Token requests only happen while the app is on screen.** GIS opens a
  real popup window for *every* `requestAccessToken()` call, including the
  "silent" `prompt: 'none'` one — on Android that popup is a Custom Tab
  stacked over the installed PWA. Fired from a background trigger (a
  throttled auto-sync timer, an `online` event, a Wi-Fi↔cellular
  `connection change`) the handshake with the frozen opener never
  completes: the popup's `/gsi/transform` POST aborts, and the resulting
  *"This site can't be reached — ERR_CONNECTION_ABORTED"* tab (plus a
  *Confirm Form Resubmission* prompt if reloaded) is still sitting on top
  of the app when the user returns to it. `js/drive.js` therefore refuses
  background token requests when `document.visibilityState === 'hidden'`,
  throwing `BACKGROUNDED` — which does **not** count toward the
  silent-failure backoff — and re-runs the sync on the next
  `visibilitychange` back to visible.

---

## 6. Identity: own domain, neutral package name

**Decision:** serve the app from **`plotline.day`** and ship the Android app
as **`day.plotline.app`**. Both replace the pre-launch
`mikejaron1.github.io/countwhen/` and `io.github.mikejaron1.countwhen`.

**Why:**

- **The old names were wrong on the merits.** The URL and package advertised
  `countwhen`, a name abandoned after a Play Store collision with an existing
  app of the same name. Shipping a product whose store URL names a different
  product is confusing and unfixable later — package names are permanent.
- **Timing forced the decision.** A package name can only be changed by
  deleting the app and creating a new one. That is an hour of form-filling
  before closed testing starts, versus an hour *plus* a restarted 14-day
  tester clock afterwards. There was no cheaper moment than this one.
- **It reads as a product, not a hobby.** Relevant because monetization (§2)
  is now an explicit goal.
- Removing the `mikejaron1` username from public URLs is a **side benefit,
  not the rationale**. Real anonymity is not achievable — the repo is public
  and every commit carries the author's name — and it is not wanted:
  attribution is useful, and open source is a trust asset for a privacy app.
  The goal is only that the identity is not *advertised*.

**Consequences:**

- GitHub Pages serves a project repo at the **domain root** under a custom
  domain, so `.well-known/assetlinks.json` moved into this repo and the
  separate `mikejaron1.github.io` repo is retired.
- **`.nojekyll` is mandatory.** Jekyll strips dot-directories, which would
  silently 404 `.well-known/assetlinks.json` and leave the TWA showing a
  browser URL bar.
- The manifest `id` changed `/countwhen/` → `/` to match the new scope. Safe
  only because the origin changed at the same time, making it a new PWA
  identity regardless.
- The origin change discarded existing IndexedDB data — see §4.
- Cloudflare DNS must stay **unproxied (grey cloud)** for the apex A records,
  or GitHub cannot issue the certificate.

---

## 7. Third-party health data (Health Connect, Strava, Garmin)

**Decision:** do nothing now. No Play Console setting has to be chosen today
to keep this option open, and none of the irreversible choices block it.

**What is genuinely irreversible, and why none of it is in the way:**

| Choice | Status |
| --- | --- |
| Package name | Fixed at `day.plotline.app` (§6). Carries across any shell change. |
| Free vs paid | Free, permanently. IAP can still be added at any time (§2). |
| Everything else | Data safety, permissions, category, health declarations, target audience — all editable, and all *expected* to change when features change. |

So the answer to "must I decide now or lose the option" is: **no**. The
blockers are architectural, and they are already on the roadmap in §3.

**Google Fit is not an option at all.** Google's own docs state the Fit APIs
"will be deprecated in 2026" and that **as of May 1, 2024 developers cannot
sign up to use these APIs**. There is no path in, even if we wanted one.
Health Connect is the designated replacement.

**Health Connect is native-only.** It is an Android API surface
(`androidx.health.connect`) with no web equivalent, so it cannot be reached
from a TWA. It requires the Capacitor step in §3. At that point it also
requires a Play Console health-apps declaration and an approved permissions
request — filled in *then*, not now.

**Strava and Garmin are a different problem: they need a server.** Both use
OAuth flows whose token exchange requires a client secret, which cannot be
shipped in a public client — and this repo is public. Options, worst to
best:

1. Ship the secret in the app. Not viable; it is public immediately.
2. Ask each user to register their own API application. Technically honest,
   but a wall almost no one will climb.
3. A minimal token-exchange endpoint (a Cloudflare Worker on the domain we
   already own) that holds the secret and brokers tokens.

Option 3 is the only realistic one, and it is the reason to think before
building: it puts a server into a product whose central promise is "no
server, no account, no analytics". That promise can survive a narrowly
scoped broker that never stores health data — but it stops being literally
true, and the store listing and privacy policy would both need rewriting.

**Consequences to accept before starting:**

- Data safety changes from "no data collected" to collecting health and
  fitness data. Permitted, but it is a visible downgrade on the listing.
- Play's health-apps policy adds review steps and forbids using the data for
  ads or sale.
- The privacy policy needs a third-party-data section.

**Recommended sequencing:** Health Connect first, when the app is already
native. It is on-device, needs no server, keeps the privacy promise intact,
and covers sleep, steps and heart rate — the inputs the correlation engine
would benefit from most. Treat Strava and Garmin as a separate, later
decision, weighed against the cost of running a server at all.

---

## 8. Marketing site at the root, app at `/app/`

**Decision:** `plotline.day/` is a marketing page; the app moved to
`plotline.day/app/`.

**Why:** the root used to serve the PWA itself, which is what GitHub Pages
does by default with this repo. That is a poor landing page for a product
about to be listed on Play — the listing links to the site, and a visitor
who lands in a bare app with no explanation has nothing to convert on. It
is also a weak answer to Google's OAuth requirement that the homepage
"must describe your app's functionality to its users" and "can not be only
a login page". A marketing page is additionally where pricing has to live
if the freemium plan in §2 ever happens.

**The one dangerous part: `id`.** The web app manifest `id` is left at `/`
even though `start_url` and `scope` are now `/app/`. `id` is an opaque
same-origin identifier and is not required to match either. Repointing it
at `/app/` would make Chrome treat this as a *different* application:
existing installs would be orphaned on the old identity, exactly the class
of failure §6 already caused once with IndexedDB. Do not "tidy" this.

**Why this move is safe where the domain move was not:** IndexedDB is
scoped to origin, not path. `plotline.day/` and `plotline.day/app/` are
the same origin, so all existing data carries over untouched. The §6
migration changed the origin, which is why it destroyed access.

**What had to move with it:**

- Asset references in `app/index.html` are now root-absolute; the assets
  themselves did not move.
- `sw.js` stays at the root, so its scope still covers the whole site. Its
  shell list is now absolute and includes both `/` and `/app/`.
- The service worker registration is `/sw.js`, not `sw.js`, which would
  otherwise resolve to a non-existent `/app/sw.js`.
- `ui-smoke.js` reads `app/index.html`, and normalises a leading `/` as
  well as `./` when extracting the script list.
- `.well-known/assetlinks.json` stays at the root. It is tied to the
  domain, not to where the app is served from.

---

## 9. Reliability before a framework or native migration (v8, 2026-09-08)

**Decision:** retain vanilla JavaScript, local IndexedDB, the current origin and
manifest identity. Extract shared UI, mutation, chart and report modules without
adding a runtime framework or build step.

**Data integrity:** new records use insert-only, collision-resistant numeric IDs.
Backup replacement validates first and commits all stores atomically; merge
remaps records and their settings together. Device reset disconnects Drive before
clearing local storage and never uploads an empty replacement.

**Synchronization:** local mutations and Drive snapshots share `plotline-data`
locking, with a same-page queue fallback. Remote checks, bounded remerges and
retained recovery snapshots reduce conflict risk; they are not an atomic
server-side write precondition and must not be described as one.

**Observation semantics:** unknown and incomplete days are not inferred to be
symptom-free. Mean/latest quantities require observations. Goals retain revision
and pause history; changed targets apply at the next period boundary. Findings
describe associations and uncertainty rather than causes.

**Release safety:** one release identifier, complete essential-shell caching,
explicit update activation after accepted local mutations drain, and regression
gates before the deployment helper commits or pushes. Native integrations and
monetization remain separate future decisions.
