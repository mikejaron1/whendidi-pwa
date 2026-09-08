# Plotline: Timestamp & Tally

**Log exact moments and counts for habits, symptoms, and daily routines.**

A self-hosted, offline-first Progressive Web App for tracking how often
something happens and how long it's been since the last time — then
helping you explore associations in your own log.

Log anything you want to keep a count of (symptoms, meds, water, habits,
chores, moods), see time-since-last at a glance, and let the built-in
statistics engine surface real, FDR-corrected correlations rather than
pretty charts.

Everything lives on your device (IndexedDB) and, optionally, in your own
Google Drive. There is no server, no account, and no analytics.

> **Coming from another tracker?** Plotline imports the widely used
> flat JSON event-backup schema (topics + events + measurements), so an
> existing export loads without conversion. See
> [Data format](#data-format).

## Live URL

**<https://plotline.day/>**

Open in Chrome on your phone, tap ⋮ → **Install app**. Done.

On a fresh install you pick a starting point — 🩺 **Symptom Tracker**,
🥤 **Daily Habits**, 🏋️ **Fitness & Health**, or 🛠️ **Custom** (blank).
A preset just seeds a handful of topics with sensible insight roles
and starter goals; rename, delete or add to them freely. Restoring a
backup skips it.

## Update workflow (for the dev)

This repo auto-deploys to GitHub Pages on every push to `main`.

```sh
cd ~/projects/countwhen
# (make edits, then explicitly stage only the intended release files)
git add <paths>
./deploy.sh "what changed"
# After Pages rebuilds, tap "Update now" when the complete offline update is ready.
```

No drag-and-drop, no console clicks. Pages handles the rest.

`deploy.sh` requires `main`, staged changes, and no unstaged or untracked files.
It runs the Node and real-browser regression suites before committing or pushing.
It never stages unrelated work automatically.

### Development and regression coverage

```sh
npm ci
npm test
npm run test:browser
```

Browser coverage uses Playwright Chromium, or installed Google Chrome when the
Playwright executable is absent. CI installs Chromium explicitly. Every fixture
is synthetic and browser runs use an isolated profile, never your installed app's
data or Google account.

`js/version.js` is the single release identifier shared by the app and service
worker. Bump it for a release. Essential assets must all cache successfully before
an update is offered; a failed download leaves the previous offline release intact.

### Data and workflow improvements (v8)

- **Complete backups:** goals, goal history, pauses, topic preferences and daily
  check-ins travel with the existing JSON format. Device timers and Drive
  connection state do not.
- **Safer storage:** replacement imports validate before an atomic database
  replacement. Merge remaps incoming identities and topic settings together.
  Newly created records use collision-resistant numeric IDs compatible with
  existing backup readers.
- **Local reset:** Menu → Reset this device disconnects Drive and removes only
  local data after a safety export. It does not overwrite the Drive backup.
- **Quick values and timers:** measured topics ask for a quantity unless you
  configure an explicit quick-log default. Duration timers persist their start
  timestamp across app closes and save elapsed seconds when stopped.
- **Measured observations:** choose Total, Average or Latest for amount topics.
  Existing history locks its type and unit; use a new topic for a different unit.
- **Daily check-ins:** confirm complete logging, no events, or an incomplete day.
  Unobserved days and dates before a topic's tracking start are not automatically
  symptom-free days in the analysis.
- **Goal changes:** target revisions preserve historical configurations; pause
  periods are shown separately rather than counted as failures.
- **Readable summaries:** export a date-range HTML summary with values and notes;
  open it offline and print it to PDF. It is not a replacement for a JSON backup.
- **Accessible navigation:** keyboard-operable views, labeled controls, focused
  dialogs, visible focus, zoom support, and larger touch targets.

### Hosting notes

**Site layout.** The root is a marketing page; the app is served from
`/app/`. Assets (`js/`, `css/`, `icons/`, `vendor/`) stay at the root and
`app/index.html` references them with absolute paths. `sw.js` also stays at
the root so its scope covers the whole site, and is registered as `/sw.js`.

The manifest `id` is deliberately `/` while `start_url` and `scope` are
`/app/`. Changing `id` would orphan every existing PWA install. See
DECISIONS.md section 8.


The site is served from the custom domain **`plotline.day`**, so this repo
publishes at the *domain root* rather than under a `/countwhen/` path.

Three files exist only to make that work, and none should be deleted:

| File | Why it matters |
| --- | --- |
| `CNAME` | Tells GitHub Pages which custom domain to serve. |
| `.nojekyll` | Disables Jekyll, which strips dot-directories. Without it `.well-known/` silently 404s. |
| `.well-known/assetlinks.json` | Digital Asset Links. Proves the domain and the Android app belong together; if it 404s or the fingerprints are wrong, the TWA renders with a browser URL bar. |

`assetlinks.json` must list **two** SHA-256 fingerprints: the local upload
key (`android.keystore`) and the Play App Signing key that Google generates
(Play Console → Test and release → Setup → App integrity).

DNS lives at Cloudflare. The apex `A` records must stay **unproxied (grey
cloud)** — with the orange proxy on, GitHub cannot issue the certificate.

**Changing the origin breaks Google sign-in until the OAuth client is
updated.** Drive sync uses Google Identity Services `initTokenClient`, an
implicit token flow that validates the caller against the **Authorized
JavaScript origins** list on the OAuth client (there is no redirect URI to
change). After any origin move, add the new origin at
<https://console.cloud.google.com/apis/credentials> — scheme and host only,
no trailing slash and no path — or every sign-in fails with
`Error 400: origin_mismatch`.


## Features

### Logging

- **Topics** — full topic list with time-since-last + last-event
  date. A Log button per row. **Long-
  press a card** to drag it into a new order; the order is saved.
  Tap a card to edit/archive/delete the topic. **+ New topic** button
  at the end of the list.
- **Quick-access bar** — pinned chips at the top of Topics
  for fast logging. Stays fixed in place (sticky) and keeps a fixed
  order. Curate exactly which topics appear and their order via
  ☰ menu → **Quick-access bar…**. When none are pinned, the bar falls
  back to auto-showing your most frequent recent topics.
- **Add / Edit Event** — date, time, duration (hh:mm) or amount, note,
  plus a **severity** badge and free-form **`#tags`** typed into the
  note (they become filterable chips).
- **Emoji + colour per topic** — set an icon and colour so the list,
  charts, and quick bar are scannable at a glance.
- **Undo** — every delete (and most edits) drops an undo snackbar.

### Reviewing

- **Recent** — chronological event feed with a topic / tag filter;
  edit or delete any event inline.
- **Day** — a single day at a time, laid out on a timeline, for
  answering "what actually happened on Tuesday?".
- **Statistics** — daily / weekly / monthly counts (and sums for
  measured topics like ounces / gallons) with a bar chart.
- **Goals & streaks** — see below.
- **Insights** — see below.

### Goals & streaks (v7.2)

Insights explain *variance* — what makes a number move. Habits ask a
different question: *am I keeping it up?* A goal answers that one.

Set a goal on any topic (⚙️ in the topic editor, the 🎯 button, or by
tapping a streak chip):

- **at least N per day / week** — build something. Workouts, water,
  pages read, meds taken.
- **at most N per day / week** — limit something. Cigarettes, coffees,
  takeaways, slip-ups. *At most 0 per day* is the classic
  quit-something counter.

The unit follows the topic type: times for a time-only topic, minutes
for a duration, the measurement's unit for an amount.

Your current streak shows as a chip on the home screen, and the
Statistics tab adds a full panel — current streak, best ever, the
completion rate over the last 30 periods, and a dot per period so a
run of misses is visible without reading a number.

Three rules are worth knowing, because they're what make a streak
honest:

- **Missing logs are not automatically successes.** Confirm complete logging or
  "Nothing happened" to evaluate an empty day. Unknown and incomplete periods
  remain visible, but neither add to nor break the observed streak.
- **Today is treated asymmetrically.** An *at least* goal you haven't
  hit yet is still winnable, so it shows as pending and doesn't break
  the streak. An *at most* goal you've already blown is broken now. The current
  period is excluded from the completed-period success rate.
- **A streak can't predate its goal.** It starts from whichever came
  first: the day you set the goal, or your first logged event. Without
  that, *at most 0* would claim a streak running back to the dawn of
  time.

Days roll over at 4am (configurable), same as everywhere else, so a
2am log counts toward the night before.

Target edits take effect at the next period boundary. The current period still
uses its original target, and older periods retain their historical targets.
Any period touched by a pause is excluded from the rate; a partly paused week is
shown as partial. Resuming a paused day does not retroactively grade that day.

### Insights (v7)

A statistics engine that looks for what actually moves your numbers,
rather than just plotting them. It is domain-agnostic — it works the
same whether you track migraines, cigarettes, workouts or water.

- **Topic roles** — you tell the app once (☰ → *Insight topics…*)
  what each of *your* topics is. Nothing is guessed from names:
  - **Focus** — the thing you're trying to understand. You also say
    which direction is *better*: **down** (symptoms, cigarettes,
    spending) or **up** (workouts, water, pages read).
  - **Marker** — a notable-day flag that is rare and always bad
    (a flare, a relapse, a slip-up). Tested with a Poisson tail test.
  - **Influence** — a candidate cause. This is the default, so
    anything you log is tested against your focus without tagging.
  - **Time of day matters** — an extra tick on any topic. Its first
    and last occurrence each day become predictors, so you can ask
    "does a later last meal / later first coffee change tomorrow?"
- **Daily outcomes** — for each focus topic: count per day, total
  time per day (for duration topics), overnight count, and time of
  first occurrence. Days roll over at 4am and the overnight window
  (default 10pm–6am) are both configurable.
- **Correlations that are actually tested** — every candidate driver
  is tested at **lag 0** (same day) and **lag 1** (yesterday → today).
  Each test must clear *both* a parametric test (Pearson / Welch) and
  a rank-based one (Spearman / Mann-Whitney); the worse of the two
  p-values is kept, then **Benjamini–Hochberg FDR correction** is
  applied across every test run. Results are labelled *significant*
  (q < 0.05) or *suggestive* (q < 0.15) — never "significant" on a
  single lucky comparison.
- **Timing** — a dedicated section comparing your latest third of days
  against your earliest third for every topic marked *time of day
  matters*.
- **Status detection** — a robust baseline (median + MAD over the
  preceding ~90 days) is compared against the last 7 days. The app
  tells you plainly whether you're well **outside your usual range**,
  worth **watching**, having a **typical stretch**, or actually
  **better than usual**, and lists which metrics moved and by how
  much. "Worse" respects each focus topic's direction.
- **Alerts** — opt in (☰ → *Status alerts…*) and the app checks on
  launch, notifying you when things drift instead of waiting for you
  to go looking.
- **Plain-English narrative** — findings are written out as sentences
  using *your* topic names, with effect sizes and units.

Guardrails: minimum sample sizes (20 paired days, 10 per group),
tautological self-correlations excluded, and DST-safe day bucketing.
If there isn't enough data yet, it says so rather than inventing a
finding.

### Data

- **Import / Export JSON** — preserves records, portable settings, and unknown
  interchange fields (export timestamps and counts are regenerated).
  Import preview shows topic / event counts + date range; choose
  *Replace* (with auto-downloaded safety backup) or *Merge*
  (deduplicates identical records and remaps conflicting IDs).
- **CSV export** — for spreadsheets and anything else.
- **Offline-first** — service worker caches the app shell, all data
  in IndexedDB. Requests persistent storage so Chrome won't evict.
- **Installable** — Chrome will offer "Install" on first visit; lives
  as a real app icon on your home screen.
- **Google Drive sync** — opt-in, two-way, automatic after changes once connected.
  Sign in under ☰ → Google Drive sync; bring your own OAuth client if
  you'd rather. Wi-Fi only by default. Keeps rolling versioned
  snapshots on Drive.

## Install it on a Pixel (or any Android)

### Step 1 — Open the URL in Chrome

<https://plotline.day/>

### Step 2 — Install on the phone

1. Chrome shows an "Install app" prompt (or open the ⋮ menu →
   *Install app* / *Add to Home Screen*).
2. Confirm — the app appears on your home screen and launches in a
   standalone window, no browser chrome.

### Step 3 — Import your old data

1. Copy your JSON backup to your phone (email it, Drive it,
   USB, whatever).
2. Open the app → ☰ menu → **Import JSON** → pick the file.
3. Review the preview (topic + event counts + date range).
4. Tap **Replace** the first time. A safety backup of the current
   (empty) state will download first; then your old data loads.

## Local development / testing

The simplest dev loop:

```sh
cd ~/projects/countwhen
python3 -m http.server 8000
```

Open <http://localhost:8000> in a browser. Service worker + Drive
sync work on `localhost`.

To test on your phone over LAN:

```sh
python3 -m http.server 8000 --bind 0.0.0.0
```

Then on the phone: `http://<your-mac-IP>:8000`. (Service worker
*won't* register over LAN HTTP though — install needs HTTPS.)

Node smoke suites and isolated browser workflows:

```sh
npm ci                                     # dev-only test dependencies
npm test                                   # stats, insights, goals, storage, Drive, sync, SW, UI
npm run test:browser                        # Chromium workflows; install it with npx playwright install chromium

node insights-smoke.js                     # statistics engine + role migration
node goals-smoke.js                        # streak rules and edge cases
node drive-smoke.js                        # Drive snapshot rotation + legacy cleanup
node ui-smoke.js                           # onboarding, every tab, goal + role editors
node smoke-test.js <path-to-backup.json>   # import → DB → export round-trip
```

The app itself has no dependencies and no build step — `package.json`
exists only so the tests can run.

- `insights-smoke.js` plants a known cause in synthetic data and checks
  the engine recovers it, in both directions, and that legacy role
  strings still migrate.
- `goals-smoke.js` pins the streak rules: zero days, the asymmetry of
  today, clamping, weekly aggregation and the day cutoff.
- `drive-smoke.js` runs `js/drive.js` against an in-memory fake of the
  Drive v3 API, so it needs no credentials and touches no real files.
- `ui-smoke.js` loads the real `app/index.html` and app scripts in jsdom
  against a fake IndexedDB and renders every tab, so a runtime error
  fails there rather than on your phone.

## Google Drive sync

Drive sync works out of the box on the public build: open ☰ →
**Google Drive sync…**, tap **Sync now**, and pick your Google account.
The app only ever sees the files it created itself (`drive.file` scope) —
never the rest of your Drive.

### Optional: use your own Google Cloud project

If you'd rather authorize through a project you control (self-hosting,
or you just don't want to go through someone else's OAuth client), set
this up once:

1. Go to <https://console.cloud.google.com/>, create a project (free).
2. Enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → External → add your
   own Google account as a Test user.
4. **Credentials → Create Credentials → OAuth Client ID →
   Web application**.
5. Under **Authorized JavaScript origins** add the origin you serve the
   app from, e.g. `https://plotline.day` (no path, no trailing
   slash).
6. Copy the resulting Client ID.
7. In the app, open ☰ → **Google Drive sync…** → **Advanced: use your
   own Google project**, paste the Client ID, and tap **Save ID**. It's
   stored on that device only and takes precedence over the built-in
   default. Clearing the field reverts to the default.
8. Tap **Sync now** to connect. The first time you'll see Google's
   "unverified app" warning — tap *Advanced → Go to Plotline
    (unsafe)* (it's *your* Cloud project, talking to *your* Drive).

Self-hosting for a group and want *everyone* on your own project? Set
`driveClientId` in `js/config.js` instead — that becomes the default for
that deployment (set it to `''` to ship with Drive sync off entirely).

Once you explicitly connect, the app attempts background sync after changes and
at launch. Expired authorization may require a foreground tap; it does not open
an account picker in a hidden tab. Disconnecting disables automatic sync on that
device without deleting the remote backup.

### Sync behavior

Sync is **two-way**. Every sync compares the file on Drive against the
snapshot the device stored at its last successful sync:

| Situation | What happens |
|---|---|
| No file on Drive yet | It's created from this device's data. |
| Drive file unchanged since our last sync | Straight upload (fast-forward). |
| Drive file changed (another device synced) | Download, **three-way merge**, apply locally, upload the result. |

The merge works record-by-record on topics, events, measurements,
pending times and app settings:

- Added on either side → kept.
- Deleted on one side, untouched on the other → the delete is honoured.
- Deleted on one side, *edited* on the other → the edit wins. Data is
  never silently lost to a delete race.
- Edited differently on both sides → whichever device was touched most
  recently wins, and the sync reports how many conflicts it resolved.

Merges that pull in remote changes refresh the UI and tell you what arrived.
Remote version checks, readback, and bounded retries detect many concurrent
writes, but do not provide a server-side compare-and-swap guarantee. A simultaneous
write can still race, and simultaneous first connections can create duplicate
folders. Five local recovery snapshots are retained for export, including
confirmed uploads; keep independent JSON backups for important history.

Other behaviour:

- **Wi-Fi only** (default): the app skips sync when on cellular data.
  Toggle this by editing `wifiOnly` in `config.js`.
- **Auto-sync on every change**: edit `autoSyncOnChange` to disable.
- **Auto-sync at startup**: edit `autoSyncOnStartup` to disable.
- The small **☁ pill** next to the app title shows current sync state
  (`queued…`, `synced`, `merged`, `off (cellular)`, `tap to fix`).
  Tap it to force an interactive sync.
- **Restore from Drive** (☰ → Google Drive sync) is the escape hatch:
  it *replaces* everything on this device with the Drive copy, after
  downloading a safety backup. Use it for a fresh device or a bad
  mistake — day to day, plain sync is what you want.
- Rolling snapshots (`plotline-1.json`, `-2.json`, … up to 5) are kept
  beside the live file to provide older recovery points. The
  Drive folder normally holds up to six similar-looking files: that's
  expected. A snapshot is only cut when the live file's contents
  actually changed *and* the newest snapshot is at least 12h old, so the
  five slots reach back ~2.5 days at worst instead of piling up five
  near-identical copies from one busy afternoon. (Drive also keeps its
  own 30-day revision history on `plotline.json` itself, which covers
  the "undo the last few minutes" case.)
- In-app settings (topic colours, emoji, kinds, insight roles, quick
  bar) ride along inside the backup under a `_plotline` key, so a new
  device gets your setup too. Readers that don't know the key ignore it.

Scope used: `drive.file` — the app can only see / modify files it
creates. The sync file lives at `Plotline/plotline.json` in your
Drive. Nothing else in your Drive is visible to the app. Backups made
under an earlier name are renamed in place on first sync, so their Drive
file IDs and revision history carry over instead of being orphaned. If a
device had already created the new folder, the leftover old files and
folder can't be renamed into place — a once-a-day sweep moves the
orphans over and sends true duplicates to the Drive trash (recoverable).
A leftover old folder is only trashed once it's empty.

## Data format

Plotline reads and writes a flat JSON document (`plotline.json`).
The schema is shared with other trackers built on it, and unknown keys
survive a round-trip, so backups move both ways. Top-level keys:

```jsonc
{
  "version": 4,
  "saveddatelong": 1779533919112,
  "saveddate": "May 23, 2026",
  "eventcount": 17425,
  "topiccount": 10,
  "measurements": [/* id, name, symbol, type, format */],
  "pendtimes":    [/* time-of-day buckets */],
  "topics":       [/* id, name, desc, msureid, optype, type, archived */],
  "events":       [/* id, cost, qant, time(ms), topicid, note */],
  "appdata":      [/* key/value app settings */]
}
```

Any extra top-level keys we don't recognize are preserved verbatim on
export. This app adds one of its own, `_plotline`, holding in-app-only
settings (topic emoji / colour / kind, insight roles, quick-access
bar). Other readers ignore unknown keys, so backups stay
interchangeable. New IDs are allocated as `max(existing) + 1`. `qant` is
stored exactly as given — display formatting is driven by the topic's
referenced measurement (`msureid` → `measurements[*]`).

## Data safety

- Persistent IndexedDB storage is requested on first launch
  (`navigator.storage.persist()`).
- Before any destructive operation (Import → Replace, Wipe data,
  Restore from Drive) the app **auto-downloads** a JSON backup of
  your current data.
- Menu → **Save safety backup** lets you take one any time.
- Use Export JSON regularly. The app is great, but it's still
  *just* a web app — nothing replaces a real backup.

## Known limitations / next ideas

- No scheduled reminders ("you haven't gone in N hours"). Alerts today
  are status-detection only, checked when you open the app.
- Insights need history to work: roughly 20+ days with the relevant
  topics logged before correlations are attempted, and ~90 days before
  the status baseline is meaningful.
- Correlation is not causation. The engine is deliberately
  conservative, but a *suggestive* finding is a hypothesis to test,
  not a diagnosis. It is not medical advice.
- Merge conflicts are resolved automatically (most-recently-touched
  device wins) — there's no interactive "pick a side" UI.
- Preset quick-add *values* from imported backups (e.g., "1 glass
  of water = 8 oz") aren't carried over; long-press a quick-access
  chip to enter a custom amount.
- Native-only features (home screen widget, Quick Settings tile,
  Health Connect, scheduled local reminders) aren't reachable from
  the current TWA shell — see [DECISIONS.md](DECISIONS.md) §3 for the
  Capacitor migration path and §4 for the data-migration plan that
  must precede it.

## Product & architecture decisions

Standing decisions — free vs. paid, what may and may not be gated, the
TWA → Capacitor ladder, and the data-migration checklist — are recorded
in **[DECISIONS.md](DECISIONS.md)**. Read it before changing the
distribution model or the Android shell.

## License

Personal use. Distributed without warranty.
