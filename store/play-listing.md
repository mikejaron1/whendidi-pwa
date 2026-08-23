# Google Play listing — copy & form answers

Paste-ready content for the Play Console listing of
`day.plotline.app`. Character counts verified against Play limits: name 29/30, short 77/80, full 2949/4000.

## Store listing

**App name** (30 max — uses 29)

```
Plotline: Track & Find Trends
```

**Short description** (80 max — uses 77)

```
Track habits and symptoms, then find which ones actually affect how you feel.
```

**Full description** (4000 max — uses 2949)

```
Most trackers just count things. Plotline tells you what your numbers mean.

Log a headache, a coffee, a workout, a bad night's sleep - one tap each. Then Plotline does the part other trackers skip: it runs real statistics across your history and tells you, in plain language, which things actually go together.

FIND WHAT ACTUALLY MATTERS
Mark which topics are outcomes you care about - headaches, mood, energy, sleep - and which ones might influence them, like caffeine, workouts, or screen time. Plotline then:

- Compares every influence against every outcome
- Corrects for multiple comparisons using Benjamini-Hochberg FDR, so you are not chasing coincidences
- Reports only the associations that survive that correction
- Tests timing effects, such as whether something in the evening changes the next day
- Explains every finding in plain English, using your own topic names

That last part is the point. "You logged coffee after 4pm on 12 days, and slept 47 minutes less on those nights" is something you can act on. A bar chart is not.

Statistics are hard to do honestly. Most apps show you a chart and let you draw your own conclusions, which is how people end up certain about things that never happened. Plotline is built to tell you when a pattern is real and, just as importantly, when it is not.

ONE TAP TO LOG
- One-tap timestamps, the fastest possible entry
- Counts and amounts in your own units - oz, mg, reps, miles
- Durations, for anything you time rather than count
- A 0-5 severity rating when intensity matters, not just frequency
- Notes with #tags you can search and filter later
- Edit or backdate any entry when you forget in the moment
- A pinned quick-access bar for whatever you log most

SEE THE SHAPE OF IT
- Time since last, on every topic at a glance
- Day view, searchable history, and per-topic statistics
- Charts of counts and trends over time
- Goals and streaks - "at least 8 a day", "at most 2 a week" - with a live streak counter and a best-ever record

TRACK ANYTHING
Water, caffeine, workouts, medications, symptoms, moods, migraines, chores, screen breaks, the dog's walks. If it happens and you want a record of when, it fits.

SET IT UP IN SECONDS
Start from a preset - Symptom Tracker, Daily Habits, or Fitness & Health - or build your own. Rename, reorder, and delete anything.

YOUR DATA STAYS YOURS
- No account, no sign-up, no server
- No ads, no trackers, no analytics of any kind
- Everything stored on your device
- Works completely offline
- Export your full history to JSON at any time
- Optional backup to your own Google Drive

The developer never sees your data, because there is nowhere for it to go. The analysis runs on your phone, not on a server.

FREE
No ads, no subscription, no paid tier, no upsell.

Plotline is a personal record-keeping tool. It is not a medical device, and it does not diagnose, treat, or provide medical advice. Talk to a clinician about health decisions.
```

## Listing fields

| Field | Value |
|---|---|
| App category | Health & Fitness (or Productivity — see note) |
| Tags | habit tracker, symptom tracker, counter, log, statistics |
| Contact email | hello@plotline.day |
| Website | https://plotline.day/ |
| Privacy policy | https://plotline.day/privacy.html |

**Category note:** *Health & Fitness* matches user intent and searches better for
a symptom tracker, but it triggers Play's **Health Apps declaration**. *Productivity*
avoids that extra form. Both are defensible; Health & Fitness is the better fit if
you don't mind one more questionnaire.

## Graphics

| Asset | Status |
|---|---|
| App icon 512×512 | ✅ `store/icon-512.png` |
| Feature graphic 1024×500 | ✅ `store/feature-graphic.png` |
| Phone screenshots (2–8 required) | ✅ `store/screenshots/framed/` (6 @ 1080×1920) |

Regenerate any time with `npm run screenshots` — it seeds deterministic demo
data in a throwaway Chrome profile, so no personal data ever reaches the store.

Two sets are produced:

- `store/screenshots/framed/` — **upload these.** Each pairs a headline with a
  partial, bleeding screenshot on the brand background. Play crops the listing
  carousel tightly, so a plain capture loses its detail at thumbnail size while
  a headline still reads.
- `store/screenshots/*.png` — the raw captures the framed set is built from.
  Kept for the web listing and as a fallback.

Upload order matters: Play shows the first two or three most often, so the
sequence leads with the differentiator rather than the logging basics.

| # | File | Headline |
| --- | --- | --- |
| 1 | `f1-insights.png` | Most trackers count. Plotline explains. |
| 2 | `f2-findings.png` | Findings in plain English. |
| 3 | `f3-categories.png` | One tap to log. |
| 4 | `f4-statistics.png` | See the shape of a habit. |
| 5 | `f5-recent.png` | Goals that hold you to it. |
| 6 | `f6-day.png` | Nothing leaves your phone. |

## Data safety form

**Does your app collect or share any of the required user data types? → No**

That single answer completes the form. Grounds for it:

- All data is stored on-device in IndexedDB. The app has no backend.
- The only outbound network call in the codebase is `js/drive.js` →
  `googleapis.com`, and only when the user explicitly triggers a backup.
- Drive backup writes to the **user's own Google Drive** under the narrow
  `drive.file` scope, which only grants access to files the app itself created.
  Play's rules exempt user-initiated transfers to a user's own account, and the
  developer has no access to the contents.
- No analytics, ads, crash reporting, or third-party SDKs of any kind.

Because nothing is collected, the follow-ups (encryption in transit, deletion
requests) are not applicable.

## Content rating questionnaire

Category: **Utility, Productivity, Communication or Other**. Answer **No** to
everything — violence, sexuality, profanity, controlled substances, gambling,
user-generated content, data sharing, location sharing. Medication and symptom
entries are user-typed data, not app content, so the drug-reference question is
still No. Expected result: **Everyone / PEGI 3**.

## Other declarations

| Question | Answer |
|---|---|
| Ads | No ads |
| App access | All functionality available without special access (no login) |
| Government app | No |
| Financial features | None |
| Target audience | 18+ (avoids the extra Families policy requirements) |
| Data deletion URL | Not required — nothing is collected |

## Drive OAuth client ID — resolved (hybrid)

`js/config.js` ships the developer's OAuth client ID as a **default**, so a
normal user just taps *Sync now* and picks a Google account — no setup. Under
☰ → Google Drive sync → *Advanced* they can paste their **own** client ID,
which is stored per-device in IndexedDB and **overrides** the default; clearing
the field reverts to it.

Data safety stays at **no collection**: the token is issued to the user, the
files land in the user's own Drive, and nothing reaches a developer server.

Pre-launch requirement: the consent screen for the default client must be
published **Testing → In production** in Google Cloud Console. Until then it is
capped at 100 users and shows the "unverified app" warning. The only scope used
is `drive.file`, which Google classifies as **non-sensitive**, so this needs no
demo video, app review, or third-party security assessment.

## Pricing — resolved: free, ungated

Launching **free** with no feature gating. A free app can never be converted to
paid (that needs a new package name), but in-app purchases can be added to a
free app at any time, so this preserves the most optionality.

Full reasoning, plus what may and may not be gated if a Pro tier is ever added,
is in [`../DECISIONS.md`](../DECISIONS.md) §1–§2.

Play Console: **Products → App pricing → Make your app free**. No payments
profile or merchant account is needed for a free app with no IAP.

## Public identity

The Play listing contact address is a project-specific mailbox, separate from
the Play *account*, which remains under a personal address.

As of the `plotline.day` move, the public URLs and the package name are
brand-neutral — `day.plotline.app` and `https://plotline.day/` name the
product, not the developer. What remains discoverable:

- the **public GitHub repo** and its commit history, authored under the
  developer's real name (the commit email is GitHub's `noreply` proxy, so the
  real address is not exposed);
- the **developer name** on the Play listing, if left as a personal name —
  set this to *Plotline* under Developer account → About you;
- **WHOIS** for `plotline.day`, unless registrar privacy is enabled.

This is deliberate. Full anonymity is not achievable — Google holds a verified
legal identity for every developer account — and it is not the goal.
Attribution is useful, and an open repo is a trust asset for an app whose core
claim is privacy. The aim is only that the identity is not *advertised*.

**One thing that changes this calculus: monetization.** Google requires
merchant accounts — any account with paid apps or in-app purchases — to
publish a **full physical address** on the store listing, taken from the linked
payments profile. See `DECISIONS.md` §2 before creating a first in-app product.
