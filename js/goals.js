/* goals.js — targets and streaks.
 *
 * The insights engine explains *variance*: what makes a number move. That
 * suits symptoms, but habit tracking asks a different question — "am I
 * keeping it up?" This module answers that one.
 *
 * A goal is a threshold on a period's value:
 *
 *   at least N per day/week   (gte) — build something: workouts, water, pages
 *   at most  N per day/week   (lte) — limit something: cigarettes, spending
 *
 * Three subtleties drive the whole design:
 *
 *   1. Periods follow the calendar. When dayChecks is supplied, empty days
 *      require an explicit complete/none check-in; omitted dayChecks retains
 *      legacy zero-event assumptions.
 *   2. Today is asymmetric. An "at least" goal you haven't hit yet is still
 *      winnable, so it must not break the streak — it's pending. An "at most"
 *      goal you've already blown is broken now.
 *   3. Legacy history starts at the earlier of goal creation/first event.
 *      Checked-day history additionally respects the topic's tracking start.
 *      Revisions take effect at a period boundary. Paused, unknown and partial
 *      periods stay visible but neither contribute to nor break streaks.
 */
(function () {
  'use strict';

  const N = window.CWSTATS;
  const dayKey = N.dayKey;
  const addDays = N.addDays;

  const PERIODS = [
    { key: 'day',  label: 'day',  plural: 'days'  },
    { key: 'week', label: 'week', plural: 'weeks' },
  ];

  const CMPS = [
    { key: 'gte', label: 'at least' },
    { key: 'lte', label: 'at most' },
  ];

  /* What a goal measures depends on what the topic records. */
  function defaultMetric(kind) {
    if (kind === 'duration') return 'minutes';
    if (kind === 'amount') return 'amount';
    return 'count';
  }

  /* Sensible starting point when the user first opens the goal editor. */
  function suggestGoal(kind) {
    return {
      metric: defaultMetric(kind),
      cmp: 'gte',
      target: kind === 'duration' ? 30 : 1,
      period: 'day',
      since: Date.now(),
    };
  }

  /* Accepts whatever is in storage and returns a usable goal, or null.
   * Tolerates partial objects so an older or hand-edited record can't throw. */
  function normalizeGoal(goal, kind = 'timeonly') {
    if (!goal || typeof goal !== 'object') return null;
    const target = Number(goal.target);
    if (!isFinite(target) || target < 0) return null;
    const cmp = goal.cmp === 'lte' ? 'lte' : 'gte';
    // "at least 0" is vacuous — every period passes. Treat it as no goal.
    if (cmp === 'gte' && target === 0) return null;
    const period = goal.period === 'week' ? 'week' : 'day';
    const metric = ['count', 'minutes', 'amount'].includes(goal.metric)
      ? goal.metric : defaultMetric(kind);
    const since = Number(goal.since) || 0;
    const effectiveFrom = Number.isFinite(goal.effectiveFrom) ? goal.effectiveFrom : since;
    const history = (Array.isArray(goal.history) ? goal.history : []).flatMap((s) => {
      const config = normalizeGoal({ ...s, history: [], pauses: [] }, kind);
      return config && Number.isFinite(s.effectiveFrom)
        ? [{ effectiveFrom: s.effectiveFrom, metric: config.metric, cmp: config.cmp,
          target: config.target, period: config.period }] : [];
    }).sort((a, b) => a.effectiveFrom - b.effectiveFrom);
    const pauses = (Array.isArray(goal.pauses) ? goal.pauses : []).filter((p) =>
      Number.isFinite(p.from) && (p.to == null || (Number.isFinite(p.to) && p.to > p.from)))
      .map((p) => ({ from: p.from, to: p.to ?? null })).sort((a, b) => a.from - b.from);
    return { metric, cmp, target, period, since, effectiveFrom, history, pauses };
  }

  function reviseGoal(existing, changes, now = Date.now()) {
    const old = normalizeGoal(existing);
    const next = normalizeGoal({ ...existing, ...changes, since: old?.since || now });
    if (!next) throw new Error('Invalid goal');
    if (!old) return { ...next, since: now, effectiveFrom: now };
    const keys = ['metric', 'cmp', 'target', 'period'];
    if (keys.every((k) => old[k] === next[k])) return old;
    if (now < old.effectiveFrom) throw new Error('Goal edits must be chronological');
    const snapshot = { effectiveFrom: old.effectiveFrom,
      metric: old.metric, cmp: old.cmp, target: old.target, period: old.period };
    return { ...next, since: old.since, effectiveFrom: now,
      history: [...old.history, snapshot], pauses: old.pauses };
  }

  function setPaused(goal, paused, now = Date.now()) {
    const g = normalizeGoal(goal);
    if (!g) throw new Error('Invalid goal');
    const open = g.pauses.find((p) => p.to == null);
    if (paused && !open) g.pauses.push({ from: now, to: null });
    if (!paused && open) {
      if (now < open.from) throw new Error('Pause end precedes start');
      open.to = now;
      g.pauses = g.pauses.filter((p) => p.to == null || p.to > p.from);
    }
    return g;
  }

  function normalizeGoals(map, kinds = {}) {
    const out = {};
    for (const [tid, g] of Object.entries(map || {})) {
      const norm = normalizeGoal(g, kinds[tid]);
      if (norm) out[tid] = norm;
    }
    return out;
  }

  /* Monday-based week bucket for a logical day. */
  function weekKeyOf(dk) {
    const d = new Date(dk);
    const dow = (d.getDay() + 6) % 7;   // Mon = 0
    return addDays(dk, -dow);
  }

  /* One event's contribution to a period total. */
  function eventValue(ev, metric) {
    if (metric === 'count') return 1;
    const q = N.quantity(ev);
    return metric === 'minutes' ? q / 60 : q;
  }

  /* Builds every period from the goal's floor up to now, marks each met or
   * not, and derives the streaks. Returns null when there is no goal. */
  function evaluate({ events = [], goal, kind = 'timeonly', cutoffHour = 4,
                      now = Date.now(), lookbackDays = 400, topicId,
                      topicPrefs = {}, dayChecks } = {}) {
    const g = normalizeGoal(goal, kind);
    if (!g) return null;

    const todayKey = dayKey(now, cutoffHour);
    const horizonKey = addDays(todayKey, -(lookbackDays - 1));

    if (topicId != null) events = events.filter((e) => e.topicid === topicId);
    events = events.filter((e) => e.time <= now);
    const tid = topicId ?? events[0]?.topicid;
    const strictObservation = dayChecks != null;
    const pref = topicPrefs[tid] || {};
    const explicitTrackingKey = Number.isFinite(pref.trackingStart) ? dayKey(pref.trackingStart, cutoffHour) : null;
    let firstEventKey = null;
    for (const e of events) {
      const k = dayKey(e.time, cutoffHour);
      if (firstEventKey == null || k < firstEventKey) firstEventKey = k;
    }

    // Where the record legitimately begins (see note 3 at the top).
    const sinceKey = g.since ? dayKey(g.since, cutoffHour) : null;
    let floorKey;
    if (sinceKey != null && firstEventKey != null) floorKey = Math.min(sinceKey, firstEventKey);
    else if (sinceKey != null) floorKey = sinceKey;
    else if (firstEventKey != null) floorKey = firstEventKey;
    else floorKey = todayKey;
    floorKey = Math.max(floorKey, horizonKey);
    if (strictObservation) {
      const tracking = explicitTrackingKey ?? firstEventKey;
      floorKey = Math.max(floorKey, tracking ?? todayKey);
    }
    if (floorKey > todayKey) floorKey = todayKey;

    // Keep calendar rows even when their observation or pause status excludes them.
    const daily = new Map();
    for (let k = floorKey; k <= todayKey; k = addDays(k, 1)) daily.set(k, []);
    for (const e of events) {
      const k = dayKey(e.time, cutoffHour);
      if (k < floorKey || k > todayKey) continue;
      daily.get(k).push(e);
    }

    const versions = [...g.history, g].sort((a, b) => a.effectiveFrom - b.effectiveFrom);
    // A revision takes effect at the next period boundary, never halfway through a period.
    const versionAt = (key) => {
      const boundary = N.dayBoundary(key, cutoffHour);
      return versions.filter((v) => v.effectiveFrom <= boundary).pop() || versions[0];
    };
    const periods = [];
    let cursor = floorKey;
    while (cursor <= todayKey) {
      let config = versionAt(cursor);
      let key = config.period === 'week' ? weekKeyOf(cursor) : cursor;
      config = versionAt(key);
      key = config.period === 'week' ? weekKeyOf(cursor) : cursor;
      const end = addDays(key, config.period === 'week' ? 7 : 1);
      const p = { key, end, config: { ...config, history: undefined, pauses: undefined },
        value: 0, days: 0, observedDays: 0, pausedDays: 0, partial: cursor > key,
        current: todayKey < end, pending: false, met: null };
      const periodEvents = [];
      let pauseOverlap = false;
      for (let k = cursor; k < end && k <= todayKey; k = addDays(k, 1)) {
        const es = daily.get(k) || [];
        const from = N.dayBoundary(k, cutoffHour), to = N.dayBoundary(addDays(k, 1), cutoffHour);
        const paused = g.pauses.some((s) => s.from < to && (s.to == null || s.to > from));
        const check = dayChecks?.[N.logicalDate(k)];
        const known = !strictObservation || (k >= (explicitTrackingKey ?? firstEventKey ?? Infinity) && check !== 'incomplete' &&
          (es.length > 0 || check === 'complete' || check === 'none'));
        p.days++;
        if (paused) { p.pausedDays++; pauseOverlap = true; }
        if (known) p.observedDays++;
        periodEvents.push(...es);
      }
      const aggregation = config.metric === 'amount' ? (pref.aggregation || 'sum') : 'sum';
      if (aggregation === 'latest') {
        periodEvents.sort((a, b) => a.time - b.time);
        p.value = periodEvents.length ? eventValue(periodEvents[periodEvents.length - 1], config.metric) : null;
      } else {
        p.value = periodEvents.reduce((s, e) => s + eventValue(e, config.metric), 0);
        if (aggregation === 'mean') p.value = periodEvents.length ? p.value / periodEvents.length : null;
      }
      p.paused = p.pausedDays === p.days;
      p.partial = p.partial || (pauseOverlap && !p.paused);
      p.date = new Date(key);
      p.unknown = p.observedDays < p.days || p.value == null;
      p.excluded = p.paused || p.partial || p.unknown;
      if (!p.excluded) p.met = config.cmp === 'gte' ? p.value >= config.target : p.value <= config.target;
      p.pending = p.current && !p.excluded && !p.met && config.cmp === 'gte';
      p.status = p.paused ? 'paused' : p.partial ? 'partial' : p.unknown ? 'unknown'
        : p.pending ? 'pending' : p.met ? 'met' : 'missed';
      periods.push(p);
      cursor = end;
    }
    const cur = periods[periods.length - 1];

    // Current streak: walk back from now. A pending period is skipped rather
    // than counted, so today's incomplete progress neither adds nor breaks.
    let i = periods.length - 1;
    let current = 0;
    while (i >= 0) {
      const p = periods[i--];
      if (p.config.period !== cur.config.period) break;
      if (p.excluded || p.pending) continue;
      if (!p.met) break;
      current++;
    }

    // Best streak only judges periods that actually finished.
    let best = 0;
    let run = 0;
    let previousPeriod;
    for (const p of periods) {
      if (p.config.period !== previousPeriod) run = 0;
      previousPeriod = p.config.period;
      if (p.pending || p.excluded) continue;
      if (p.met) { run++; if (p.config.period === cur.config.period && run > best) best = run; }
      else run = 0;
    }
    if (current > best) best = current;

    const settled = periods.filter((p) => !p.current && !p.excluded);
    const recent = settled.slice(-30);
    const metRecent = recent.filter((p) => p.met).length;

    const value = cur ? cur.value : null;
    const activeGoal = cur?.config || g;
    const remaining = value == null ? null : activeGoal.cmp === 'gte'
      ? Math.max(0, activeGoal.target - value)
      : activeGoal.target - value;

    return {
      goal: g,
      activeGoal,
      status: cur?.status || 'unknown',
      paused: cur?.paused || false, partial: cur?.partial || false,
      observationMode: strictObservation ? 'checked-days' : 'legacy-zero-days',
      excludedPeriods: periods.filter((p) => p.excluded).length,
      periods,
      current,
      best,
      value,
      met: cur ? cur.met : false,
      pending: cur ? cur.pending : false,
      remaining,
      metRecent,
      totalRecent: recent.length,
      rate: recent.length ? metRecent / recent.length : null,
      totalPeriods: settled.length,
    };
  }

  /* ---- formatting ---- */

  function unitLabel(goal, measurement) {
    if (goal.metric === 'minutes') return 'min';
    if (goal.metric === 'amount') return (measurement && measurement.symbol) || '';
    return '×';
  }

  function fmtValue(v, goal, measurement) {
    if (v == null || !Number.isFinite(v)) return '—';
    const rounded = Math.round(v * 10) / 10;
    const num = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    const unit = unitLabel(goal, measurement);
    return unit === '×' ? `${num}×` : `${num} ${unit}`.trim();
  }

  /* "at least 3× per day" */
  function describeGoal(goal, measurement) {
    const g = normalizeGoal(goal);
    if (!g) return '';
    const cmp = CMPS.find((c) => c.key === g.cmp).label;
    const per = PERIODS.find((p) => p.key === g.period).label;
    return `${cmp} ${fmtValue(g.target, g, measurement)} per ${per}`;
  }

  /* The headline sentence: what the user actually wants to read. */
  function streakLine(result, measurement) {
    if (!result) return '';
    if (result.status === 'paused') return 'Goal paused — your completed streak is preserved.';
    if (result.status === 'partial') return 'Partial period — excluded from your completion rate.';
    if (result.status === 'unknown') return 'Not enough observations — check in to evaluate this period.';
    const g = result.activeGoal || result.goal;
    const unit = PERIODS.find((p) => p.key === g.period);
    const n = result.current;
    const noun = n === 1 ? unit.label : unit.plural;
    if (n > 0 && result.excludedPeriods) {
      return `${n} observed ${noun} meeting your goal (excluded periods skipped)`;
    }
    if (n === 0) {
      if (g.cmp === 'lte' && !result.met) {
        return `Over your limit today — ${fmtValue(result.value, g, measurement)} logged.`;
      }
      return `No streak yet — hit your goal to start one.`;
    }
    return g.cmp === 'lte'
      ? `${n} ${noun} within your limit`
      : `${n} ${noun} in a row`;
  }

  /* Short badge text for a topic card. */
  function badge(result) {
    if (!result || !result.current) return null;
    return { n: result.current, hot: result.current >= 3, at_risk: result.pending };
  }

  window.CWGOALS = {
    PERIODS, CMPS,
    defaultMetric, suggestGoal, normalizeGoal, normalizeGoals, reviseGoal, setPaused,
    weekKeyOf, evaluate,
    unitLabel, fmtValue, describeGoal, streakLine, badge,
  };
})();
