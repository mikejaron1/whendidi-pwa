/* Plotline - Insights engine.
 *
 * Turns the raw event log into:
 *   1. A per-day metric table (trips/day, total time/day, first/last meal,
 *      blood days, accidents, night trips, per-topic counts, #tags).
 *   2. Statistical tests between predictors and outcomes, with p-values,
 *      effect sizes and Benjamini-Hochberg FDR correction (so 40 tests
 *      don't produce 2 fake "findings").
 *   3. A robust baseline vs. current-window comparison -> status detection.
 *   4. Ranked, plain-English insights.
 *
 * Everything here is pure computation: no DOM, no IndexedDB. Wrapped in an
 * IIFE because classic scripts share one global lexical scope.
 */
(function () {
'use strict';

/* ==================== math / stats primitives ==================== */

function mean(xs) {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function variance(xs) {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (n - 1);
}

function sd(xs) { return Math.sqrt(variance(xs)); }

function quantile(sortedXs, q) {
  const n = sortedXs.length;
  if (!n) return NaN;
  if (n === 1) return sortedXs[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedXs[lo];
  return sortedXs[lo] + (pos - lo) * (sortedXs[hi] - sortedXs[lo]);
}

function median(xs) {
  if (!xs.length) return NaN;
  return quantile(xs.slice().sort((a, b) => a - b), 0.5);
}

/* Median absolute deviation, scaled to be a consistent estimator of sigma. */
function mad(xs) {
  if (xs.length < 2) return NaN;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

function logGamma(x) {
  // Lanczos approximation (g=7, n=9)
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = g[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += g[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/* Continued-fraction expansion for the incomplete beta function. */
function betacf(a, b, x) {
  const FPMIN = 1e-300, EPS = 3e-12;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/* Regularized incomplete beta I_x(a,b). */
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) +
    a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/* Two-tailed p-value for Student's t with df degrees of freedom. */
function tTestP(t, df) {
  if (!isFinite(t) || !isFinite(df) || df <= 0) return NaN;
  return betai(df / 2, 0.5, df / (df + t * t));
}

function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

/* P(X >= k) for Poisson(lambda). Used for rare-event marker checks. */
function poissonTailP(k, lambda) {
  if (lambda <= 0) return k > 0 ? 0 : 1;
  if (k <= 0) return 1;
  let cum = 0;
  let term = Math.exp(-lambda);
  for (let i = 0; i < k; i++) {
    cum += term;
    term *= lambda / (i + 1);
  }
  return Math.max(0, Math.min(1, 1 - cum));
}

/* Average ranks, ties shared. Returns { ranks, tieCorrection }. */
function rankWithTies(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(xs.length);
  let tieSum = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    const groupSize = j - i + 1;
    if (groupSize > 1) tieSum += groupSize ** 3 - groupSize;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return { ranks, tieCorrection: tieSum };
}

/* Pearson correlation + two-tailed p. */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return { n, r: NaN, p: NaN };
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return { n, r: NaN, p: NaN };
  const r = sxy / Math.sqrt(sxx * syy);
  const rc = Math.min(0.999999, Math.max(-0.999999, r));
  const t = rc * Math.sqrt((n - 2) / (1 - rc * rc));
  return { n, r, p: tTestP(t, n - 2) };
}

function spearman(xs, ys) {
  const rx = rankWithTies(xs).ranks;
  const ry = rankWithTies(ys).ranks;
  return pearson(rx, ry);
}

/* Welch's t-test for two independent samples. */
function welch(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return { n: na + nb, t: NaN, p: NaN, df: NaN };
  const ma = mean(a), mb = mean(b);
  const va = variance(a), vb = variance(b);
  const se2 = va / na + vb / nb;
  if (!(se2 > 0)) return { n: na + nb, t: NaN, p: NaN, df: NaN };
  const t = (ma - mb) / Math.sqrt(se2);
  const df = (se2 * se2) /
    ((va * va) / (na * na * (na - 1)) + (vb * vb) / (nb * nb * (nb - 1)));
  return { n: na + nb, t, df, p: tTestP(t, df), meanA: ma, meanB: mb };
}

/* Cohen's d with pooled SD. */
function cohensD(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return NaN;
  const va = variance(a), vb = variance(b);
  const pooled = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  if (!(pooled > 0)) return NaN;
  return (mean(a) - mean(b)) / pooled;
}

/* Mann-Whitney U with normal approximation + tie correction. */
function mannWhitney(a, b) {
  const na = a.length, nb = b.length;
  if (na < 3 || nb < 3) return { p: NaN, u: NaN };
  const all = a.concat(b);
  const { ranks, tieCorrection } = rankWithTies(all);
  let ra = 0;
  for (let i = 0; i < na; i++) ra += ranks[i];
  const u = ra - (na * (na + 1)) / 2;
  const n = na + nb;
  const mu = (na * nb) / 2;
  const sigma = Math.sqrt(
    ((na * nb) / 12) * ((n + 1) - tieCorrection / (n * (n - 1)))
  );
  if (!(sigma > 0)) return { p: NaN, u };
  const z = (u - mu) / sigma;
  return { p: 2 * (1 - normalCdf(Math.abs(z))), u, z };
}

/* Benjamini-Hochberg FDR. Mutates each test, adding `q`. */
function benjaminiHochberg(tests) {
  const valid = tests.filter((t) => Number.isFinite(t.p));
  const sorted = valid.slice().sort((a, b) => a.p - b.p);
  const m = sorted.length;
  let prev = 1;
  for (let i = m - 1; i >= 0; i--) {
    const q = Math.min(prev, (sorted[i].p * m) / (i + 1));
    sorted[i].q = q;
    prev = q;
  }
  for (const t of tests) if (!isFinite(t.p)) t.q = NaN;
  return tests;
}

/* ==================== roles ==================== */

/* A topic's role tells the engine what part it plays in an analysis. The
 * vocabulary is deliberately domain-neutral: the same three roles describe
 * bathroom trips vs. meals, migraines vs. caffeine, or workouts vs. sleep.
 *
 *   focus     - what you are trying to explain. Generates the outcomes
 *               ("<topic> per day", "time of first <topic>", …).
 *   marker    - a notable-day flag. Generates a yes/no outcome for the day.
 *   influence - a candidate cause. Untagged topics are treated as one of
 *               these, so you only have to tag what you actually care about.
 *
 * `timing` is an independent flag: when set, the *clock time* of that day's
 * first and last event becomes a predictor too (meals, bedtime, first
 * coffee, last screen).
 *
 * `dir` applies to a focus and says which way is better:
 *   'down' - fewer / less is better (symptoms, cigarettes, interruptions)
 *   'up'   - more is better (workouts, water, practice sessions)
 * It never changes the maths, only whether a rise is reported as a problem.
 */
const ROLES = [
  { key: 'focus', label: 'Focus', icon: '🎯',
    hint: 'What you want to understand. Everything else gets tested against it.' },
  { key: 'marker', label: 'Notable-day marker', icon: '🚩',
    hint: 'A yes/no flag for the day — a symptom, a setback, a milestone.' },
  { key: 'influence', label: 'Possible influence', icon: '⚡',
    hint: 'A candidate cause: food, meds, weather, stress, exercise.' },
];
const ROLE_KEYS = new Set(ROLES.map((r) => r.key));

/* Pre-generalisation installs stored a single domain-specific string per
 * topic. Map those onto the new vocabulary so an existing setup keeps
 * working — and keeps its insights — without the user re-tagging anything. */
const LEGACY_ROLE_MAP = {
  bathroom: { role: 'focus',     dir: 'down' },
  blood:    { role: 'marker' },
  accident: { role: 'marker' },
  meal:     { role: 'influence', timing: true },
  sleep:    { role: 'influence', timing: true },
  med:      { role: 'influence' },
  trigger:  { role: 'influence' },
};

/* Accepts a modern object, a legacy string, or junk; returns a normalised
 * role or null. */
function normalizeRole(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    if (ROLE_KEYS.has(v)) return { role: v, timing: false, dir: 'down' };
    const legacy = LEGACY_ROLE_MAP[v];
    if (!legacy) return null;
    return { role: legacy.role, timing: !!legacy.timing, dir: legacy.dir || 'down' };
  }
  if (typeof v === 'object' && ROLE_KEYS.has(v.role)) {
    return { role: v.role, timing: !!v.timing, dir: v.dir === 'up' ? 'up' : 'down' };
  }
  return null;
}

function normalizeRoles(roles = {}) {
  const out = {};
  for (const [tid, v] of Object.entries(roles || {})) {
    const n = normalizeRole(v);
    if (n) out[Number(tid)] = n;
  }
  return out;
}

/* ==================== daily table ==================== */

/* Logical day start: a trip at 2am belongs to the previous night, so days
 * roll over at `cutoffHour` (default 4am) rather than midnight. */
function dayKey(ts, cutoffHour = 4) {
  return window.CWSTATS.dayKey(ts, cutoffHour);
}

/* Step a day key by n calendar days. Never use key + n*MS_DAY: DST shifts
 * would produce keys that don't line up with dayKey() and manifest as
 * phantom empty days (which then fake correlations). */
function addDays(key, n) {
  return window.CWSTATS.addDays(key, n);
}

function minutesFromDayStart(ts, cutoffHour = 4) {
  return window.CWSTATS.minutesFromDayStart(ts, cutoffHour);
}

/* Convert "minutes from logical day start" back to a clock label. */
function fmtDayMinutes(min, cutoffHour) {
  if (min == null || !isFinite(min)) return '—';
  let total = Math.round(min) + cutoffHour * 60;
  const nextDay = total >= 1440;
  total = ((total % 1440) + 1440) % 1440;
  let h = Math.floor(total / 60);
  const m = total % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}${nextDay ? '' : ''}`;
}

/* Whole-hour clock label, for describing configurable windows ("10pm–6am"). */
function fmtHour(h) {
  const hr = ((Math.round(h) % 24) + 24) % 24;
  const ampm = hr >= 12 ? 'pm' : 'am';
  let display = hr % 12; if (display === 0) display = 12;
  return `${display}${ampm}`;
}

const TAG_RE = /#([A-Za-z0-9_][A-Za-z0-9_-]{0,30})/g;
function tagsOf(note) {
  if (!note) return [];
  const out = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(note)) !== null) out.push(m[1].toLowerCase());
  return out;
}

/**
 * Build the per-day metric table.
 *
 * @param {object} o
 * @param {Array}  o.events    all events
 * @param {Array}  o.topics    all topics
 * @param {object} o.roles     { topicId: roleKey }
 * @param {object} o.kinds     { topicId: 'timeonly'|'duration'|'amount' }
 * @param {number} o.cutoffHour logical day rollover hour (default 4)
 * @param {number} o.days      how many trailing days to include (default 400)
 */
function buildDaily({ events = [], topics = [], roles = {}, kinds = {}, cutoffHour = 4, days = 400,
                     nightStart = 22, nightEnd = 6, topicPrefs = {}, dayChecks = {},
                     measurements = {}, now = Date.now() } = {}) {
  days = Math.min(400, Math.max(1, Math.floor(Number(days) || 400)));
  const norm = normalizeRoles(roles);
  const byRole = { focus: [], marker: [], influence: [] };
  const timingIds = [];
  for (const [tid, r] of Object.entries(norm)) {
    byRole[r.role].push(Number(tid));
    if (r.timing) timingIds.push(Number(tid));
  }
  const focusIds = byRole.focus.slice();
  const markerIds = byRole.marker.slice();

  const durationTopics = new Set(
    topics.filter((t) => (kinds[t.id] || '') === 'duration').map((t) => t.id)
  );

  const todayKey = dayKey(now, cutoffHour);
  const startKey = addDays(todayKey, -(days - 1));

  const rows = new Map();
  const ensure = (key) => {
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        date: new Date(key),
        counts: {},        // topicId -> n
        sums: {},          // topicId -> summed qant (seconds for durations)
        firsts: {},        // topicId -> minutes from day start
        lasts: {},
        nights: {},        // topicId -> n logged inside the night window
        sevMax: {},        // topicId -> max severity
        sevMean: {}, sevCounts: {}, latest: {}, latestTimes: {}, values: {},
        observed: {}, check: dayChecks[window.CWSTATS.logicalDate(key)] || null,
        tags: new Set(),
        events: 0,
      });
    }
    return rows.get(key);
  };

  // Keep every calendar day: accessors distinguish observed zeros from gaps.
  for (let k = startKey; k <= todayKey; k = addDays(k, 1)) ensure(k);

  // A night window can wrap midnight (22 -> 6) or not (0 -> 6).
  const isNight = (hr) => (nightStart > nightEnd
    ? (hr >= nightStart || hr < nightEnd)
    : (hr >= nightStart && hr < nightEnd));

  const trackingStarts = {};
  for (const t of topics) {
    const configured = topicPrefs[t.id]?.trackingStart;
    if (Number.isFinite(configured)) trackingStarts[t.id] = dayKey(configured, cutoffHour);
  }
  for (const e of events) {
    if (e.time > now) continue;
    const key = dayKey(e.time, cutoffHour);
    if (!Number.isFinite(topicPrefs[e.topicid]?.trackingStart)) {
      trackingStarts[e.topicid] = Math.min(trackingStarts[e.topicid] ?? Infinity, key);
    }
  }
  for (const e of events) {
    if (e.time > now) continue;
    const key = dayKey(e.time, cutoffHour);
    if (key < startKey || key > todayKey) continue;
    const row = ensure(key);
    const tid = e.topicid;
    const min = minutesFromDayStart(e.time, cutoffHour);
    row.events++;
    row.counts[tid] = (row.counts[tid] || 0) + 1;
    const q = window.CWSTATS.quantity(e);
    row.sums[tid] = (row.sums[tid] || 0) + q;
    if (row.latestTimes[tid] == null || e.time >= row.latestTimes[tid]) {
      row.latestTimes[tid] = e.time; row.latest[tid] = q;
    }
    if (row.firsts[tid] == null || min < row.firsts[tid]) row.firsts[tid] = min;
    if (row.lasts[tid] == null || min > row.lasts[tid]) row.lasts[tid] = min;
    if (isNight(new Date(e.time).getHours())) row.nights[tid] = (row.nights[tid] || 0) + 1;
    const sev = e.cost == null || e.cost === '' ? 0 : Number(e.cost);
    if (!Number.isFinite(sev)) throw new Error(`Invalid severity for event ${e.id ?? ''}`);
    if (sev > 0) {
      row.sevMax[tid] = Math.max(row.sevMax[tid] || 0, sev);
      row.sevMean[tid] = (row.sevMean[tid] || 0) + sev;
      row.sevCounts[tid] = (row.sevCounts[tid] || 0) + 1;
    }
    for (const t of tagsOf(e.note)) row.tags.add(t);
  }

  const list = Array.from(rows.values()).sort((a, b) => a.key - b.key);
  for (const r of list) {
    const dow = r.date.getDay();
    r.dow = (dow + 6) % 7;              // 0 = Mon
    r.weekend = (dow === 0 || dow === 6) ? 1 : 0;
    r.usable = r.check !== 'incomplete' && (r.events > 0 || ['complete', 'none'].includes(r.check));
    for (const t of topics) {
      const tid = t.id;
      r.observed[tid] = r.usable && trackingStarts[tid] != null && r.key >= trackingStarts[tid];
      const aggregation = topicPrefs[tid]?.aggregation || 'sum';
      r.values[tid] = r.counts[tid]
        ? aggregation === 'mean' ? r.sums[tid] / r.counts[tid]
          : aggregation === 'latest' ? r.latest[tid] : r.sums[tid]
        : aggregation === 'sum' && r.observed[tid] ? 0 : null;
      if (r.sevCounts[tid]) r.sevMean[tid] /= r.sevCounts[tid];
    }
  }

  // Trim before tracking began; each topic still has its own observation floor.
  const earliest = Math.min(...Object.values(trackingStarts));
  let firstIdx = list.findIndex((r) => r.key >= earliest);
  if (firstIdx < 0) firstIdx = list.length;
  const trimmed = list.slice(firstIdx);

  // Which focus topics actually carry duration / night data worth analysing?
  const hasDurationFor = (tid) => durationTopics.has(tid)
    && trimmed.some((r) => r.sums[tid] > 0);
  const hasNightFor = (tid) => trimmed.some((r) => (r.nights[tid] || 0) > 0);

  return {
    days: trimmed,
    kinds, topicPrefs, measurements, trackingStarts, todayKey,
    dataQuality: {
      unknownDays: trimmed.filter((r) => !r.usable && r.check !== 'incomplete').length,
      incompleteDays: trimmed.filter((r) => r.check === 'incomplete').length,
      assumedZeroDays: trimmed.filter((r) => r.events > 0 && !['complete', 'none'].includes(r.check)).length,
      assumption: 'On logged days, unlogged tracked count topics are assumed zero. Unchecked empty days and incomplete days are excluded; observed mean/latest values remain missing.',
    },
    cutoffHour, nightStart, nightEnd,
    roles: norm,
    byRole, focusIds, markerIds, timingIds,
    durationTopics,
    hasDurationFor, hasNightFor,
    hasFocus: focusIds.length > 0,
  };
}

function observedValue(row, tid, value) {
  return row.observed[tid] ? value : null;
}

/* ==================== predictors & outcomes ==================== */

/**
 * Outcomes are generated from whatever the user tagged as a focus or a
 * marker, so the same engine explains bathroom trips, migraines, workouts or
 * cigarettes without knowing what any of them are.
 *
 * Each outcome carries the topic's `dir` ('down' = fewer is better) so the
 * narrative layer can say "worse" or "better" instead of just "higher".
 */
function buildOutcomes(table, topics) {
  const nameById = new Map(topics.map((t) => [t.id, t.name]));
  const nameOf = (id) => nameById.get(id) || nameById.get(Number(id)) || `topic ${id}`;
  const out = [];

  for (const tid of table.focusIds) {
    const name = nameOf(tid);
    const dir = table.roles[tid]?.dir || 'down';
    const base = { topicId: tid, dir, kind: 'continuous' };
    out.push({ ...base, key: `focus:${tid}:count`, label: `${name} per day`,
      unit: '/day', digits: 1, metric: 'count', get: (r) => observedValue(r, tid, r.counts[tid] || 0) });
    if (table.hasDurationFor(tid)) {
      out.push({ ...base, key: `focus:${tid}:minutes`, label: `time on ${name} per day`,
        unit: ' min', digits: 0, metric: 'minutes', primary: true,
        get: (r) => observedValue(r, tid, (r.sums[tid] || 0) / 60) });
    }
    if (table.kinds[tid] === 'amount') {
      const aggregation = table.topicPrefs[tid]?.aggregation || 'sum';
      const unit = table.measurements[tid]?.symbol || table.measurements[tid]?.unit || '';
      out.push({ ...base, key: `focus:${tid}:amount`, label: `${name} (${aggregation}${unit ? `, ${unit}` : ''})`,
        unit: unit ? ` ${unit}` : '', digits: 1, metric: 'amount', aggregation, primary: true,
        get: (r) => observedValue(r, tid, r.values[tid]) });
    }
    if (table.days.some((r) => r.sevCounts[tid])) {
      for (const [metric, field, label] of [['severity', 'sevMax', 'maximum'], ['severityMean', 'sevMean', 'mean']]) {
        out.push({ ...base, key: `focus:${tid}:${metric}`, label: `${name} severity (${label})`,
          unit: ' rating', digits: 1, metric, get: (r) => observedValue(r, tid, r[field][tid] ?? null) });
      }
    }
    if (table.hasNightFor(tid)) {
      out.push({ ...base, key: `focus:${tid}:night`, label: `${name} overnight`,
        unit: '/night', digits: 1, get: (r) => observedValue(r, tid, r.nights[tid] || 0) });
    }
    out.push({ ...base, key: `focus:${tid}:first`, label: `time of first ${name}`,
      unit: '', digits: 0, fmt: 'time',
      get: (r) => observedValue(r, tid, r.firsts[tid] ?? null) });
  }

  for (const tid of table.markerIds) {
    out.push({ key: `marker:${tid}:any`, label: `${nameOf(tid)} that day`,
      kind: 'binary', unit: '', digits: 1, topicId: tid, dir: 'down',
      get: (r) => observedValue(r, tid, r.counts[tid] ? 1 : 0) });
  }

  for (const tid of table.focusIds) {
    if (!out.some((o) => o.topicId === tid && o.primary)) out.find((o) => o.key === `focus:${tid}:count`).primary = true;
  }
  return out;
}

/**
 * Build the list of candidate predictors, each with an accessor.
 * Everything that isn't the outcome itself is fair game.
 */
function buildPredictors(table, topics, kinds = {}) {
  const out = [];
  const roles = table.roles;

  // Topics flagged "timing matters" contribute clock-time predictors: when
  // the first/last one happened and how wide the window between them was.
  for (const tid of table.timingIds) {
    const t = topics.find((x) => x.id === tid);
    if (!t) continue;
    const self = [`focus:${tid}:count`, `focus:${tid}:minutes`,
                  `focus:${tid}:night`, `focus:${tid}:first`, `focus:${tid}:amount`,
                  `focus:${tid}:severity`, `focus:${tid}:severityMean`, `marker:${tid}:any`];
    out.push({ key: `first:${tid}`, label: `First ${t.name} (time of day)`, type: 'time',
      excludeOutcomes: self, get: (r) => observedValue(r, tid, r.firsts[tid] ?? null) });
    out.push({ key: `last:${tid}`, label: `Last ${t.name} (time of day)`, type: 'time',
      excludeOutcomes: self, get: (r) => observedValue(r, tid, r.lasts[tid] ?? null) });
    out.push({ key: `window:${tid}`, label: `${t.name} window (first→last)`, type: 'hours',
      excludeOutcomes: self,
      get: (r) => observedValue(r, tid, r.firsts[tid] != null && r.lasts[tid] != null
        ? (r.lasts[tid] - r.firsts[tid]) / 60 : null) });
  }

  out.push({ key: 'weekend', label: 'Weekend', type: 'binary', get: (r) => r.weekend });

  // Every topic's daily count is a candidate cause — including other focus
  // topics, so "do my workouts affect my migraines?" works. A topic is only
  // barred from predicting *its own* outcomes, which would be circular.
  for (const t of topics) {
    if (t.archived) continue;
    const tid = t.id;
    const role = roles[tid]?.role || 'influence';
    const selfOutcomes = [`focus:${tid}:count`, `focus:${tid}:minutes`,
                          `focus:${tid}:night`, `focus:${tid}:first`, `focus:${tid}:amount`,
                          `focus:${tid}:severity`, `focus:${tid}:severityMean`, `marker:${tid}:any`];
    out.push({
      key: `topic:${tid}`,
      label: `${t.name} (count)`,
      type: 'count',
      role, excludeOutcomes: selfOutcomes,
      get: (r) => observedValue(r, tid, r.counts[tid] || 0),
    });
    if ((kinds[tid] || '') === 'amount') {
      out.push({
        key: `topicsum:${tid}`,
        label: `${t.name} (amount)`,
        type: 'amount',
        role, excludeOutcomes: selfOutcomes,
        get: (r) => observedValue(r, tid, r.values[tid]),
      });
    }
  }

  // #tags that appear on enough days.
  const tagDays = new Map();
  for (const r of table.days) for (const t of r.tags) tagDays.set(t, (tagDays.get(t) || 0) + 1);
  for (const [tag, n] of tagDays.entries()) {
    if (n < 5) continue;
    out.push({ key: `tag:${tag}`, label: `#${tag}`, type: 'binary',
      get: (r) => (r.tags.has(tag) ? 1 : 0) });
  }

  return out;
}

/* Pair up predictor (day d - lag) with outcome (day d), dropping nulls. */
function pairSeries(days, predictor, outcome, lag) {
  const xs = [], ys = [], dates = [], sourceDates = [];
  const byKey = new Map(days.map((r) => [r.key, r]));
  for (let i = 0; i < days.length; i++) {
    const src = byKey.get(addDays(days[i].key, -lag));
    if (!src || src.usable === false || days[i].usable === false) continue;
    const x = predictor.get(src);
    const y = outcome.get(days[i]);
    if (x == null || !isFinite(x)) continue;
    if (y == null || !isFinite(y)) continue;
    xs.push(x); ys.push(y);
    dates.push(days[i].key); sourceDates.push(src.key);
  }
  return { xs, ys, dates, sourceDates };
}

const MIN_N = 20;

/**
 * Run every predictor x outcome x lag test, FDR-correct, and return them
 * sorted by strength.
 */
function runTests({ table, predictors, outcomes, lags = [0, 1], minN = MIN_N }) {
  const days = table.days;
  const tests = [];
  for (const outcome of outcomes) {
    for (const predictor of predictors) {
      if (predictor.excludeOutcomes?.includes(outcome.key)) continue;
      for (const lag of lags) {
        const { xs, ys, dates, sourceDates } = pairSeries(days, predictor, outcome, lag);
        if (xs.length < minN) continue;
        const uniqX = new Set(xs);
        if (uniqX.size < 2) continue;
        const uniqY = new Set(ys);
        if (uniqY.size < 2) continue;

        const test = {
          predictorKey: predictor.key,
          predictorLabel: predictor.label,
          predictorType: predictor.type,
          outcomeKey: outcome.key,
          outcomeLabel: outcome.label,
          outcomeKind: outcome.kind,
          outcomeUnit: outcome.unit,
          outcomeDir: outcome.dir || 'down',
          outcomeFmt: outcome.fmt || null,
          lag,
          n: xs.length,
          sampleDates: dates, sourceDates,
        };

        const isBinaryX = uniqX.size === 2 && uniqX.has(0);
        if (isBinaryX || outcome.kind === 'binary') {
          // Group comparison is far more interpretable than r here.
          let groupA, groupB, aLabel, bLabel;
          if (isBinaryX) {
            groupA = []; groupB = [];
            for (let i = 0; i < xs.length; i++) (xs[i] ? groupA : groupB).push(ys[i]);
            aLabel = 'yes'; bLabel = 'no';
            test.groupMode = 'predictor';
          } else {
            groupA = []; groupB = [];
            for (let i = 0; i < ys.length; i++) (ys[i] ? groupA : groupB).push(xs[i]);
            aLabel = 'on those days'; bLabel = 'other days';
            test.groupMode = 'outcome';
          }
          if (Math.min(groupA.length, groupB.length) < 10) continue;
          const w = welch(groupA, groupB);
          const mw = mannWhitney(groupA, groupB);
          test.meanA = mean(groupA);
          test.meanB = mean(groupB);
          test.nA = groupA.length;
          test.nB = groupB.length;
          test.aLabel = aLabel;
          test.bLabel = bLabel;
          test.d = cohensD(groupA, groupB);
          test.p = w.p;
          test.pNonparam = mw.p;
          const pr = pearson(xs, ys);
          test.r = pr.r;
        } else {
          const pr = pearson(xs, ys);
          const sp = spearman(xs, ys);
          test.r = pr.r;
          test.rho = sp.r;
          test.p = pr.p;
          test.pNonparam = sp.p;
          // Slope in outcome-units per predictor-unit (for plain-English text).
          const mx = mean(xs), my = mean(ys);
          let sxy = 0, sxx = 0;
          for (let i = 0; i < xs.length; i++) {
            sxy += (xs[i] - mx) * (ys[i] - my);
            sxx += (xs[i] - mx) ** 2;
          }
          test.slope = sxx ? sxy / sxx : NaN;
          test.meanX = mx;
          test.meanY = my;
        }
        // Conservative combination: a finding must satisfy BOTH the
        // parametric and the rank-based test. This costs a little power but
        // kills outlier-driven false positives, which matter more here.
        test.pParametric = test.p;
        if (!Number.isFinite(test.p) || !Number.isFinite(test.pNonparam)) continue;
        test.p = Math.max(test.p, test.pNonparam);
        test.strength = Math.abs(isFinite(test.d) ? test.d : (test.r || 0));
        tests.push(test);
      }
    }
  }
  benjaminiHochberg(tests);
  tests.sort((a, b) => a.p - b.p);
  return tests;
}

function significanceLabel(t) {
  if (!Number.isFinite(t.q)) return { level: 'none', label: 'n/a' };
  if (t.q < 0.01) return { level: 'strong', label: 'significant (q<0.01)' };
  if (t.q < 0.05) return { level: 'strong', label: 'significant (q<0.05)' };
  if (t.q < 0.15) return { level: 'weak', label: 'suggestive (q<0.15)' };
  if (t.p < 0.05) return { level: 'noise', label: 'not significant after correction' };
  return { level: 'none', label: 'no effect' };
}

/* ==================== baseline / unusual-period detection ==================== */

/**
 * Compare the last `windowDays` against a robust baseline built from the
 * preceding `baselineDays` (excluding the current window).
 *
 * Everything here is direction-aware: a metric moving away from baseline is
 * only called "worse" when it moves the way the user said is bad. For a focus
 * marked 'up' (workouts, water) a drop is the problem, not a rise.
 */
function baselineStatus(table, topics = [], { windowDays = 7, baselineDays = 90 } = {}) {
  const days = table.days;
  const out = { ok: false, level: 'unknown', metrics: [], reasons: [], windowDays };
  if (days.length < windowDays + 21) {
    out.level = 'insufficient';
    out.reasons.push(`Need about ${windowDays + 21} days of history; have ${days.length}.`);
    return out;
  }
  const recent = days.slice(-windowDays);
  const baseStart = Math.max(0, days.length - windowDays - baselineDays);
  const base = days.slice(baseStart, days.length - windowDays);
  if (base.length < 14) {
    out.level = 'insufficient';
    out.reasons.push('Not enough baseline history yet.');
    return out;
  }
  out.baselineDays = base.length;

  const nameById = new Map(topics.map((t) => [t.id, t.name]));
  const nameOf = (id) => nameById.get(id) || `topic ${id}`;

  /* `dir` is the direction that counts as *worse* for this metric:
   * 'down' means a rise is bad, 'up' means a fall is bad. */
  const addContinuous = (key, label, values, baseValues, unit, digits = 1, dir = 'down') => {
    const v = values.filter((x) => x != null && isFinite(x));
    const b = baseValues.filter((x) => x != null && isFinite(x));
    if (v.length < 3 || b.length < 10) return null;
    const cur = mean(v);
    const med = median(b);
    const spread = mad(b) || sd(b) || 0;
    const delta = cur - med;
    const z = spread > 0 ? delta / spread : delta === 0 ? 0 : Math.sign(delta) * Infinity;
    const pct = med !== 0 ? (delta / Math.abs(med)) * 100 : null;
    // Significance of the window mean vs baseline distribution.
    const w = welch(v, b);
    const badWay = dir === 'up' ? -1 : 1;      // sign of a change that is bad
    const moved = z * badWay;
    const m = {
      key, label, unit, digits, dir,
      current: cur, baseline: med, z, pct, delta, changeLabel: med === 0 ? (cur === 0 ? 'unchanged' : 'from none') : null,
      sampleDays: v.length, baselineSampleDays: b.length,
      p: w.p,
      worse: moved > 0,
      elevated: moved >= 1.5 && (pct == null ? delta !== 0 : Math.abs(pct) >= 15) && (isFinite(w.p) ? w.p < 0.1 : true),
      improved: moved <= -1.5 && (pct == null ? delta !== 0 : Math.abs(pct) >= 15),
    };
    out.metrics.push(m);
    return m;
  };

  const addRare = (key, label, recentCount, baseCount, baseN, recentN) => {
    if (baseN < 21 || recentN < 3) return null;
    const rate = baseCount / baseN;               // events per day
    const lambda = rate * recentN;
    const p = poissonTailP(recentCount, lambda);
    const m = {
      key, label, rare: true, dir: 'down',
      current: recentCount, baseline: lambda, p,
      unit: ` in ${recentN} observed days`, digits: 1,
      pct: lambda > 0 ? ((recentCount - lambda) / lambda) * 100 : null,
      delta: recentCount - lambda, changeLabel: lambda === 0 ? 'from none' : null,
      z: lambda > 0 ? (recentCount - lambda) / Math.sqrt(lambda) : 0,
      worse: recentCount > lambda,
      elevated: recentCount >= 2 && p < 0.1 && recentCount > lambda,
      improved: recentCount === 0 && lambda >= 2,
    };
    out.metrics.push(m);
    return m;
  };

  for (const o of buildOutcomes(table, topics).filter((o) => o.kind === 'continuous' && !o.fmt)) {
    addContinuous(o.key, o.label, recent.map(o.get), base.map(o.get), o.unit, o.digits, o.dir);
  }

  // Markers are rare by nature, so they get a Poisson tail test rather than
  // a mean-vs-baseline comparison.
  for (const tid of table.markerIds) {
    const rv = recent.filter((r) => r.observed[tid]);
    const bv = base.filter((r) => r.observed[tid]);
    addRare(`marker:${tid}`, nameOf(tid),
      rv.reduce((s, r) => s + (r.counts[tid] || 0), 0),
      bv.reduce((s, r) => s + (r.counts[tid] || 0), 0), bv.length, rv.length);
  }
  if (!out.metrics.length) {
    out.level = 'insufficient';
    out.reasons.push('Not enough observed days for a baseline comparison.');
    return out;
  }

  const elevated = out.metrics.filter((m) => m.elevated);
  const improved = out.metrics.filter((m) => m.improved);
  const markerElevated = elevated.filter((m) => m.rare);

  if (markerElevated.length || elevated.length >= 2) out.level = 'alert';
  else if (elevated.length === 1) out.level = 'watch';
  else if (improved.length && !elevated.length) out.level = 'better';
  else out.level = 'ok';
  out.ok = out.level === 'ok' || out.level === 'better';

  for (const m of elevated) {
    const wayTxt = m.pct >= 0 ? '+' : '';
    out.reasons.push(
      `${m.label}: ${fmtNum(m.current, m.digits)}${m.unit} vs usual ${fmtNum(m.baseline, m.digits)}${m.unit} ` +
      (m.pct == null ? `(from none; +${fmtNum(m.delta, m.digits)}${m.unit})` : `(${wayTxt}${Math.round(m.pct)}%)`)
    );
  }
  for (const m of improved) {
    out.reasons.push(
      `${m.label} is ${m.dir === 'up' ? 'above' : 'below'} your usual ` +
      `(${fmtNum(m.current, m.digits)}${m.unit} vs ${fmtNum(m.baseline, m.digits)}${m.unit}).`
    );
  }
  if (!out.reasons.length) out.reasons.push('Everything is within your normal range.');

  // Where does this window rank against every other window of the same
  // length? Uses the primary focus topic.
  const primary = table.focusIds[0];
  if (primary != null && days.length >= 40 && recent.every((r) => r.observed[primary])) {
    const totals = [];
    for (let i = 0; i + windowDays <= days.length; i++) {
      if (!days.slice(i, i + windowDays).every((r) => r.observed[primary])) continue;
      let s = 0;
      for (let j = i; j < i + windowDays; j++) s += days[j].counts[primary] || 0;
      totals.push(s);
    }
    const curTotal = totals[totals.length - 1];
    const sorted = totals.slice().sort((a, b) => a - b);
    let below = 0;
    for (const v of sorted) if (v < curTotal) below++;
    const dir = table.roles[primary]?.dir || 'down';
    const pct = Math.round((below / sorted.length) * 100);
    out.percentile = pct;
    out.windowTotal = curTotal;
    out.primaryLabel = nameOf(primary);
    out.primaryDir = dir;
    // Don't let the headline say "normal" while this is one of the most
    // extreme windows on record in the direction that matters.
    const extreme = sorted[0] !== sorted[sorted.length - 1] &&
      (dir === 'up' ? pct <= 10 && curTotal < median(sorted) : pct >= 90 && curTotal > median(sorted));
    if (extreme && (out.level === 'ok' || out.level === 'better')) {
      out.level = 'watch';
      const cmp = dir === 'up'
        ? `lighter than ${100 - pct}% of all ${windowDays}-day windows on record`
        : `heavier than ${pct}% of all ${windowDays}-day windows on record`;
      out.reasons.unshift(
        `This stretch is ${cmp} (${curTotal} × ${nameOf(primary)}), ` +
        `even though no single metric crossed its alert threshold.`
      );
      out.ok = false;
    }
  }
  return out;
}

function fmtNum(x, digits = 1) {
  if (x == null || !isFinite(x)) return '—';
  return Number(x).toFixed(digits);
}

/* ==================== plain-English insights ==================== */

function pctChange(a, b) {
  if (!(b > 0)) return null;
  return ((a - b) / b) * 100;
}

function fmtByType(v, type, cutoffHour) {
  if (v == null || !isFinite(v)) return '—';
  if (type === 'time') return fmtDayMinutes(v, cutoffHour);
  if (type === 'hours') return `${fmtNum(v, 1)}h`;
  return fmtNum(v, 1);
}

function describeTest(test, cutoffHour, { withSignificance = false } = {}) {
  const lagTxt = test.lag === 1 ? ' the next day' : '';
  const sigTxt = withSignificance ? `, ${significanceLabel(test).label}` : '';
  const cleanLabel = test.predictorLabel.replace(/ \((count|amount|time of day)\)$/, '');
  const unit = test.outcomeUnit === ' min' ? ' min' : '';
  if (test.groupMode) {
    const dir = test.meanA > test.meanB ? 'higher' : 'lower';
    if (test.groupMode === 'predictor') {
      const delta = test.meanA - test.meanB;
      const subject = test.predictorType === 'binary'
        ? `days tagged ${cleanLabel}`
        : `days you logged ${cleanLabel}`;
      return `On ${subject}, ${test.outcomeLabel}${lagTxt} is ` +
        `${fmtNum(Math.abs(delta), 1)}${unit} ${dir} (${fmtNum(test.meanA, 1)} vs ${fmtNum(test.meanB, 1)}, ` +
        `n=${test.nA}/${test.nB}${sigTxt}).`;
    }
    // outcome is the binary one: compare the predictor across outcome groups
    const fmtV = (v) => fmtByType(v, test.predictorType, cutoffHour);
    return `${cleanLabel} differs on days with ${test.outcomeLabel}${lagTxt}: ` +
      `${fmtV(test.meanA)} vs ${fmtV(test.meanB)} on other days ` +
      `(n=${test.nA}/${test.nB}${sigTxt}).`;
  }
  const dir = test.r > 0 ? 'more' : 'less';
  if (test.predictorType === 'time') {
    const perHour = test.slope * 60;
    return `Every hour later your ${cleanLabel.toLowerCase()} is, ` +
      `${test.outcomeLabel}${lagTxt} changes by ${perHour >= 0 ? '+' : ''}${fmtNum(perHour, 2)}${unit} ` +
      `(r=${fmtNum(test.r, 2)}, n=${test.n}${sigTxt}).`;
  }
  return `${cleanLabel} tracks with ${dir} ${test.outcomeLabel}${lagTxt} ` +
    `(r=${fmtNum(test.r, 2)}, n=${test.n}${sigTxt}).`;
}

/* Descriptive, non-inferential observations about a recent window.
 *
 * Every sentence is generated from the user's own topic names and their
 * chosen direction, so the same code narrates bathroom trips, migraines,
 * workouts or cigarettes without any domain vocabulary of its own. */
function descriptiveInsights(table, topics = [], windowDays = 90) {
  const out = [];
  const window = table.days.slice(-windowDays);
  if (window.length < 21) return out;
  const cutoffHour = table.cutoffHour;
  const nameById = new Map(topics.map((t) => [t.id, t.name]));
  const nameOf = (id) => nameById.get(id) || `topic ${id}`;
  const dowNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  for (const tid of table.focusIds) {
    const days = window.filter((r) => r.observed[tid]);
    if (days.length < 3) continue;
    const name = nameOf(tid);
    const dir = table.roles[tid]?.dir || 'down';
    const counts = days.map((r) => r.counts[tid] || 0);
    const avg = mean(counts);
    if (!isFinite(avg)) continue;
    // "worst" only means "most" when more is the bad direction.
    const peak = Math.max(...counts);
    const peakWord = dir === 'up' ? 'best day' : 'worst day';

    out.push({
      kind: 'summary',
      score: 1,
      text: `Across ${days.length} observed days in the last ${window.length} calendar days you averaged ${fmtNum(avg, 1)} ${name}/day ` +
        `(median ${fmtNum(median(counts), 0)}, ${peakWord} ${peak}).`,
    });

    // Trend over the window
    if (counts.length >= 21) {
      const third = Math.floor(counts.length / 3);
      const first = mean(counts.slice(0, third));
      const last = mean(counts.slice(-third));
      const ch = pctChange(last, first);
      const rising = last > first;
      const good = (dir === 'up') === rising;
      out.push({
        kind: 'trend',
        score: 2,
        good,
        text: `Descriptively, ${name} is ${rising ? 'higher' : 'lower'} across observed days in this window: ` +
          `${fmtNum(first, 1)}/day early vs ${fmtNum(last, 1)}/day recently` +
          (ch != null ? ` (${ch >= 0 ? '+' : ''}${Math.round(ch)}%)` : '') +
          '.',
      });
    }

    // Time-of-day concentration
    const firsts = days.map((r) => r.firsts[tid]).filter((x) => x != null);
    if (firsts.length >= 20) {
      const sortedF = firsts.slice().sort((a, b) => a - b);
      out.push({
        kind: 'timing',
        score: 1.5,
        text: `Your first ${name} is usually around ${fmtDayMinutes(median(firsts), cutoffHour)} ` +
          `(middle 50% between ${fmtDayMinutes(quantile(sortedF, 0.25), cutoffHour)} ` +
          `and ${fmtDayMinutes(quantile(sortedF, 0.75), cutoffHour)}).`,
      });
    }

    const nightTotal = days.reduce((s, r) => s + (r.nights[tid] || 0), 0);
    const total = days.reduce((s, r) => s + (r.counts[tid] || 0), 0);
    if (total > 0 && nightTotal > 0) {
      out.push({
        kind: 'timing',
        score: 1.2,
        text: `${Math.round((nightTotal / total) * 100)}% of ${name} happens overnight ` +
          `(${fmtHour(table.nightStart)}–${fmtHour(table.nightEnd)}) — ` +
          `${fmtNum(nightTotal / days.length, 1)} per night.`,
      });
    }

    // Day-of-week extremes
    const buckets = Array.from({ length: 7 }, () => []);
    for (const r of days) buckets[r.dow].push(r.counts[tid] || 0);
    const avgs = buckets.map((b) => (b.length >= 4 ? mean(b) : NaN));
    const valid = avgs.map((v, i) => [v, i]).filter(([v]) => isFinite(v));
    if (valid.length === 7) {
      valid.sort((a, b) => b[0] - a[0]);
      const [hi, hiIdx] = valid[0];
      const [lo, loIdx] = valid[valid.length - 1];
      const ch = pctChange(hi, lo);
      if (ch != null && ch >= 20) {
        out.push({
          kind: 'dow',
          score: 2,
          text: `${dowNames[hiIdx]} is your highest day for ${name} (${fmtNum(hi, 1)}/day) ` +
            `and ${dowNames[loIdx]} your lowest (${fmtNum(lo, 1)}/day) — ${Math.round(ch)}% apart` +
            ' (descriptive).',
        });
      }
    }

    // Duration, when the topic records one
    if (table.hasDurationFor(tid)) {
      const mins = days.map((r) => (r.sums[tid] || 0) / 60).filter((x) => isFinite(x));
      if (mins.length >= 20) {
        out.push({
          kind: 'duration',
          score: 1.6,
          text: `You spend about ${fmtNum(median(mins), 0)} min/day on ${name} ` +
            `(${fmtNum(mean(mins), 0)} avg, peak ${fmtNum(Math.max(...mins), 0)} min).`,
        });
      }
    }

    // Month-over-month
    if (window.length >= 60) {
      const last30 = window.slice(-30).filter((r) => r.observed[tid]).map((r) => r.counts[tid] || 0);
      const prev30 = window.slice(-60, -30).filter((r) => r.observed[tid]).map((r) => r.counts[tid] || 0);
      const ch = pctChange(mean(last30), mean(prev30));
      if (ch != null && Math.abs(ch) >= 10) {
        out.push({
          kind: 'mom',
          score: 2.5,
          good: (ch > 0) === (dir === 'up'),
          text: `Last 30 days vs the 30 before: ${fmtNum(mean(last30), 1)} vs ` +
            `${fmtNum(mean(prev30), 1)} ${name}/day ` +
            `(${ch >= 0 ? '+' : ''}${Math.round(ch)}%; observed days only, descriptive).`,
        });
      }
    }
  }

  // Marker days: how often, and what they coincide with.
  if (table.markerIds.length) {
    const days = window.filter((r) => table.markerIds.every((tid) => r.observed[tid]));
    if (!days.length) return out;
    const anyMarker = (r) => table.markerIds.some((tid) => (r.counts[tid] || 0) > 0);
    const label = table.markerIds.map(nameOf).join(' or ');
    const badDays = days.filter(anyMarker).length;
    const primary = table.focusIds[0];
    if (badDays) {
      let text = `${badDays} of the last ${days.length} days had ${label} ` +
        `(${Math.round((badDays / days.length) * 100)}%).`;
      if (primary != null) {
        const withBad = days.filter((r) => r.observed[primary] && anyMarker(r)).map((r) => r.counts[primary] || 0);
        const without = days.filter((r) => r.observed[primary] && !anyMarker(r)).map((r) => r.counts[primary] || 0);
        if (withBad.length >= 3 && without.length >= 3) {
          text += ` On those days you averaged ${fmtNum(mean(withBad), 1)} ` +
            `${nameOf(primary)} vs ${fmtNum(mean(without), 1)} otherwise` +
            ' (descriptive).';
        }
      }
      out.push({ kind: 'marker', score: 3, text });
    } else {
      out.push({ kind: 'marker', score: 2,
        text: `No ${label} in the last ${days.length} days.` });
    }

    // Current clear streak
    let streak = 0;
    for (let i = window.length - 1; i >= 0; i--) {
      if (!table.markerIds.every((tid) => window[i].observed[tid]) || anyMarker(window[i])) break;
      streak++;
    }
    let best = 0, run = 0;
    for (const r of window) { if (!table.markerIds.every((tid) => r.observed[tid]) || anyMarker(r)) run = 0; else { run++; if (run > best) best = run; } }
    if (best > 0) {
      out.push({ kind: 'streak', score: 1.4,
        text: `Current clear streak: ${streak} day${streak === 1 ? '' : 's'} ` +
          `without ${label} (best in this window: ${best}).` });
    }
  }

  return out;
}

/* ==================== timing question ==================== */

/**
 * Directly answers "does *when* I do X change my outcomes?" for every topic
 * flagged as timing-relevant — first/last meal, bedtime, first coffee, last
 * screen. Splits days into early vs late thirds and reports the difference,
 * plus the continuous correlation.
 */
function timingAnalysis(table, topics) {
  if (!table.timingIds.length) return [];
  const rows = [];
  const cutoffHour = table.cutoffHour;
  const days = table.days;
  const nameById = new Map(topics.map((t) => [t.id, t.name]));
  const nameOf = (id) => nameById.get(id) || `topic ${id}`;

  const predictors = [];
  for (const tid of table.timingIds) {
    predictors.push({ key: `first:${tid}`, label: `First ${nameOf(tid)}`, topicId: tid,
      get: (r) => observedValue(r, tid, r.firsts[tid] ?? null) });
    predictors.push({ key: `last:${tid}`, label: `Last ${nameOf(tid)}`, topicId: tid,
      get: (r) => observedValue(r, tid, r.lasts[tid] ?? null) });
  }

  // Count/duration/marker outcomes answer "how much"; the time-of-first
  // outcome would just be comparing clocks to clocks, so skip it here.
  const outcomes = buildOutcomes(table, topics).filter((o) => !o.key.endsWith(':first'));

  for (const p of predictors) {
    for (const o of outcomes) {
      if (o.topicId === p.topicId) continue;    // don't explain a topic with itself
      for (const lag of [0, 1]) {
        const { xs, ys, dates, sourceDates } = pairSeries(days, p, o, lag);
        if (xs.length < MIN_N) continue;
        const sorted = xs.slice().sort((a, b) => a - b);
        const lo = quantile(sorted, 1 / 3);
        const hi = quantile(sorted, 2 / 3);
        if (lo >= hi) continue;
        const early = [], late = [];
        for (let i = 0; i < xs.length; i++) {
          if (xs[i] <= lo) early.push(ys[i]);
          else if (xs[i] >= hi) late.push(ys[i]);
        }
        if (early.length < 8 || late.length < 8) continue;
        const w = welch(late, early);
        const mw = mannWhitney(late, early);
        const pr = pearson(xs, ys);
        if (!Number.isFinite(w.p) || !Number.isFinite(mw.p)) continue;
        rows.push({
          predictor: p.label,
          predictorKey: p.key,
          outcome: o.label,
          outcomeKey: o.key,
          outcomeKind: o.kind,
          outcomeDir: o.dir || 'down',
          lag,
          n: xs.length,
          sampleDates: dates, sourceDates, family: 'timing-tertiles',
          outcomeUnit: o.unit,
          earlyThreshold: lo,
          lateThreshold: hi,
          earlyLabel: `at or before ${fmtDayMinutes(lo, cutoffHour)}`,
          lateLabel: `at or after ${fmtDayMinutes(hi, cutoffHour)}`,
          earlyMean: mean(early),
          lateMean: mean(late),
          nEarly: early.length,
          nLate: late.length,
          delta: mean(late) - mean(early),
          pct: pctChange(mean(late), mean(early)),
          p: Math.max(w.p, mw.p),
          pParametric: w.p,
          pNonparam: mw.p,
          r: pr.r,
          d: cohensD(late, early),
        });
      }
    }
  }
  benjaminiHochberg(rows);
  return rows;
}

/* ==================== top-level analyze ==================== */

function analyze({ events = [], topics = [], roles = {}, kinds = {}, cutoffHour = 4,
                   windowDays = 7, insightWindow = 90,
                   nightStart = 22, nightEnd = 6, topicPrefs = {}, dayChecks = {},
                   measurements = {}, now = Date.now() } = {}) {
  const table = buildDaily({ events, topics, roles, kinds, cutoffHour, nightStart, nightEnd,
    topicPrefs, dayChecks, measurements, now });
  insightWindow = Math.min(400, Math.max(1, Math.floor(Number(insightWindow) || 90)));
  const start = addDays(table.todayKey, -(insightWindow - 1));
  const recentTable = { ...table, days: table.days.filter((r) => r.key >= start) };
  const outcomes = buildOutcomes(table, topics);
  const predictors = buildPredictors(recentTable, topics, kinds);
  const tests = outcomes.length && recentTable.days.length >= 30
    ? runTests({ table: recentTable, predictors, outcomes })
    : [];
  const status = baselineStatus(table, topics, { windowDays });
  const timing = timingAnalysis(recentTable, topics);

  // Rank the narrative insights: significant tests first, then descriptives.
  // Keep only the stronger lag for each predictor/outcome pair so the list
  // doesn't repeat itself.
  const narrative = [];
  const seenPair = new Set();
  for (const t of tests) {
    const sig = significanceLabel(t);
    if (sig.level !== 'strong' && sig.level !== 'weak') continue;
    const pair = `${t.predictorKey}|${t.outcomeKey}`;
    if (seenPair.has(pair)) continue;   // tests are p-sorted: first = strongest
    seenPair.add(pair);
    narrative.push({
      kind: 'test',
      score: (sig.level === 'strong' ? 6 : 4) + Math.min(2, t.strength || 0),
      sig,
      test: t,
      text: describeTest(t, cutoffHour),
    });
  }
  for (const d of descriptiveInsights(recentTable, topics, insightWindow)) narrative.push(d);
  narrative.sort((a, b) => b.score - a.score);

  return { table, tests, status, timing, narrative, outcomes, predictors,
    dataQuality: table.dataQuality,
    window: { days: insightWindow, start, end: table.todayKey,
      from: window.CWSTATS.dayBoundary(start, cutoffHour), to: now + 1,
      startDate: window.CWSTATS.logicalDate(start), endDate: window.CWSTATS.logicalDate(table.todayKey),
      sampleDates: recentTable.days.filter((r) => r.usable).map((r) => r.key) } };
}

/* Rolling mean helper for charts. */
function rolling(values, window) {
  const out = [];
  let sum = 0;
  const q = [];
  for (const v of values) {
    const x = (v == null || !isFinite(v)) ? null : v;
    q.push(x); sum += x || 0;
    if (q.length > window) sum -= q.shift() || 0;
    out.push(q.length === window && q.every((x) => x != null) ? sum / window : null);
  }
  return out;
}

window.CWINSIGHTS = {
  ROLES, ROLE_KEYS, normalizeRole, normalizeRoles, LEGACY_ROLE_MAP,
  analyze, buildDaily, buildPredictors, buildOutcomes, runTests,
  baselineStatus, timingAnalysis, descriptiveInsights, describeTest,
  significanceLabel, pairSeries,
  dayKey, addDays, minutesFromDayStart, fmtDayMinutes, fmtHour, fmtByType, fmtNum, rolling,
  mean, median, sd, mad, quantile, pearson, spearman, welch, cohensD,
  mannWhitney, benjaminiHochberg, poissonTailP, tTestP, normalCdf,
};

})();
