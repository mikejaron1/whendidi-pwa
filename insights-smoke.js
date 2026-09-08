#!/usr/bin/env node
/* Smoke test for the generalized insights engine.
 *
 * Feeds synthetic logs with known, planted relationships through analyze()
 * and checks the engine recovers them — for several unrelated tracking
 * domains, not just one. Also pins the legacy-role migration.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

global.window = {};
new Function(fs.readFileSync(path.join(__dirname, 'js', 'stats.js'), 'utf8'))();
const src = fs.readFileSync(path.join(__dirname, 'js', 'insights.js'), 'utf8');
new Function(src)();
const I = window.CWINSIGHTS;
const S = window.CWSTATS;
const NOW = new Date(2026, 8, 8, 23, 59).getTime();
const analyze = I.analyze;
I.analyze = (opts) => {
  const dayChecks = {};
  for (let key = S.addDays(S.dayKey(NOW, 4), -400); key <= S.dayKey(NOW, 4); key = S.addDays(key, 1)) {
    dayChecks[S.logicalDate(key)] = 'complete';
  }
  return analyze({ now: NOW, dayChecks, ...opts });
};

/* ---- synthetic log builder ---- */
const DAY = 86400000;
// Deterministic PRNG so a failure is always reproducible.
let seed = 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function poisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rnd(); } while (p > L);
  return k - 1;
}

/* Build `days` days of events ending today. `plan(dayIndex)` returns
 * [{topicid, n, hour, qant}] for that day. */
function buildEvents(days, plan) {
  const events = [];
  let id = 1;
  const today = NOW;
  for (let d = 0; d < days; d++) {
    const dayStart = S.addDays(S.dayKey(today), -(days - 1 - d));
    const base = new Date(dayStart); base.setHours(0, 0, 0, 0);
    for (const spec of plan(d)) {
      for (let i = 0; i < spec.n; i++) {
        const hour = spec.hour == null ? 8 + Math.floor(rnd() * 12) : spec.hour;
        const t = new Date(base); t.setHours(hour, Math.floor(rnd() * 60), 0, 0);
        events.push({ id: id++, topicid: spec.topicid, time: t.getTime(),
          qant: spec.qant || 0, note: spec.note || '', cost: 0 });
      }
    }
  }
  return events;
}

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

console.log('generalized insights engine');

/* ---------------------------------------------------------------- *
 * 1. Migraine tracker: caffeine drives migraines the NEXT day.
 * ---------------------------------------------------------------- */
test('recovers a planted next-day cause (migraines vs caffeine)', () => {
  seed = 999;
  const COFFEE = 1, MIGRAINE = 2;
  const coffeeByDay = [];
  for (let d = 0; d < 200; d++) coffeeByDay.push(1 + Math.floor(rnd() * 5));
  const events = buildEvents(200, (d) => {
    const out = [{ topicid: COFFEE, n: coffeeByDay[d], hour: 9 }];
    // migraines tomorrow scale with today's coffee
    const prev = d > 0 ? coffeeByDay[d - 1] : 2;
    const n = poisson(0.2 + prev * 0.6);
    if (n > 0) out.push({ topicid: MIGRAINE, n, hour: 15 });
    return out;
  });
  const topics = [{ id: COFFEE, name: 'Coffee' }, { id: MIGRAINE, name: 'Migraine' }];
  const res = I.analyze({
    events, topics,
    roles: { [MIGRAINE]: { role: 'focus', dir: 'down' }, [COFFEE]: { role: 'influence' } },
  });
  const hit = res.tests.find((t) =>
    t.predictorKey === `topic:${COFFEE}` &&
    t.outcomeKey === `focus:${MIGRAINE}:count` && t.lag === 1);
  assert.ok(hit, 'no coffee->migraine lag-1 test was run');
  assert.ok(hit.q < 0.05, 'planted effect not significant (q=' + hit.q + ')');
  assert.ok(hit.r > 0, 'expected a positive relationship, got r=' + hit.r);
  const txt = res.narrative.map((n) => n.text).join(' ');
  assert.ok(/Coffee/.test(txt) && /Migraine/.test(txt), 'topic names missing from narrative');
  assert.ok(!/bathroom|trips|blood|flare/i.test(txt), 'domain vocabulary leaked: ' + txt.slice(0, 200));
});

/* ---------------------------------------------------------------- *
 * 2. Habit tracker with an "up is good" focus.
 * ---------------------------------------------------------------- */
test('direction up: a drop in workouts reads as worse, not better', () => {
  seed = 4242;
  const WORKOUT = 1;
  // Steady ~1/day for months, then a slump in the last week.
  const events = buildEvents(160, (d) => {
    const slump = d >= 153;
    const n = slump ? (rnd() < 0.15 ? 1 : 0) : (rnd() < 0.85 ? 1 : 0);
    return n ? [{ topicid: WORKOUT, n, hour: 7 }] : [];
  });
  const topics = [{ id: WORKOUT, name: 'Workout' }];
  const res = I.analyze({
    events, topics,
    roles: { [WORKOUT]: { role: 'focus', dir: 'up' } },
  });
  assert.ok(['alert', 'watch'].includes(res.status.level),
    'a collapse in an up-is-good focus should raise a flag, got ' + res.status.level);
  const m = res.status.metrics.find((x) => x.key === `focus:${WORKOUT}:count`);
  assert.ok(m, 'no metric for the focus topic');
  assert.ok(m.current < m.baseline, 'sanity: current should be below baseline');
  assert.strictEqual(m.worse, true, 'a drop must be "worse" when more is better');
});

test('direction down: the same drop reads as improvement', () => {
  seed = 4242;
  const CIGS = 1;
  const events = buildEvents(160, (d) => {
    const quit = d >= 153;
    const n = quit ? (rnd() < 0.15 ? 1 : 0) : (rnd() < 0.85 ? 1 : 0);
    return n ? [{ topicid: CIGS, n, hour: 7 }] : [];
  });
  const topics = [{ id: CIGS, name: 'Cigarette' }];
  const res = I.analyze({ events, topics, roles: { [CIGS]: { role: 'focus', dir: 'down' } } });
  const m = res.status.metrics.find((x) => x.key === `focus:${CIGS}:count`);
  assert.strictEqual(m.worse, false, 'a drop must not be "worse" when less is better');
  assert.ok(['better', 'ok'].includes(res.status.level),
    'quitting should not raise an alert, got ' + res.status.level);
});

/* ---------------------------------------------------------------- *
 * 3. Legacy IBD setup keeps working after the rename.
 * ---------------------------------------------------------------- */
test('legacy role strings migrate to the new vocabulary', () => {
  const n = I.normalizeRoles({
    1: 'bathroom', 2: 'blood', 3: 'accident', 4: 'meal',
    5: 'sleep', 6: 'med', 7: 'trigger', 8: 'nonsense',
  });
  assert.deepStrictEqual(n[1], { role: 'focus', timing: false, dir: 'down' });
  assert.deepStrictEqual(n[2], { role: 'marker', timing: false, dir: 'down' });
  assert.deepStrictEqual(n[3], { role: 'marker', timing: false, dir: 'down' });
  assert.deepStrictEqual(n[4], { role: 'influence', timing: true, dir: 'down' });
  assert.deepStrictEqual(n[5], { role: 'influence', timing: true, dir: 'down' });
  assert.deepStrictEqual(n[6], { role: 'influence', timing: false, dir: 'down' });
  assert.strictEqual(n[8], undefined, 'unknown roles must be dropped, not kept');
});

test('a legacy install still analyzes end to end', () => {
  seed = 77;
  const GO = 1, MEAL = 2, BLOOD = 3;
  const events = buildEvents(180, (d) => {
    const out = [];
    const late = rnd() < 0.5;
    out.push({ topicid: MEAL, n: 1, hour: late ? 21 : 18 });
    out.push({ topicid: GO, n: poisson(late ? 5 : 3), hour: null, qant: 300 });
    if (rnd() < 0.08) out.push({ topicid: BLOOD, n: 1, hour: 10 });
    return out;
  });
  const topics = [{ id: GO, name: 'Bathroom' }, { id: MEAL, name: 'Meal' },
                  { id: BLOOD, name: 'Blood' }];
  const res = I.analyze({
    events, topics,
    roles: { [GO]: 'bathroom', [MEAL]: 'meal', [BLOOD]: 'blood' },  // legacy strings
    kinds: { [GO]: 'duration' },
  });
  assert.ok(res.table.focusIds.includes(GO), 'legacy bathroom topic should become the focus');
  assert.ok(res.table.markerIds.includes(BLOOD), 'legacy blood topic should become a marker');
  assert.ok(res.table.timingIds.includes(MEAL), 'legacy meal topic should keep timing analysis');
  assert.ok(res.outcomes.some((o) => o.key === `focus:${GO}:minutes`),
    'duration outcome missing for a duration-kind focus');
  assert.ok(res.timing.length > 0, 'timing analysis produced nothing for a meal topic');
  assert.ok(res.tests.length > 0, 'no tests ran for a legacy setup');
});

/* ---------------------------------------------------------------- *
 * 4. General guarantees.
 * ---------------------------------------------------------------- */
test('a topic never predicts its own outcome', () => {
  seed = 5;
  const A = 1;
  const events = buildEvents(120, () => [{ topicid: A, n: 1 + poisson(2) }]);
  const topics = [{ id: A, name: 'Thing' }];
  const res = I.analyze({ events, topics, roles: { [A]: { role: 'focus', dir: 'down' } } });
  const circular = res.tests.filter((t) =>
    t.predictorKey === `topic:${A}` && t.outcomeKey.startsWith(`focus:${A}:`));
  assert.strictEqual(circular.length, 0,
    'found ' + circular.length + ' circular self-predicting tests');
});

test('two focus topics can be tested against each other', () => {
  seed = 31;
  const SLEEP = 1, MOOD = 2;
  const events = buildEvents(200, (d) => {
    const slept = rnd() < 0.5 ? 1 : 0;
    const out = [];
    if (slept) out.push({ topicid: SLEEP, n: 1, hour: 23 });
    const n = slept ? poisson(0.4) : poisson(2.0);
    if (n) out.push({ topicid: MOOD, n, hour: 14 });
    return out;
  });
  const topics = [{ id: SLEEP, name: 'Good sleep' }, { id: MOOD, name: 'Low mood' }];
  const res = I.analyze({
    events, topics,
    roles: { [SLEEP]: { role: 'focus', dir: 'up' }, [MOOD]: { role: 'focus', dir: 'down' } },
  });
  const cross = res.tests.find((t) =>
    t.predictorKey === `topic:${SLEEP}` && t.outcomeKey === `focus:${MOOD}:count`);
  assert.ok(cross, 'focus topics should still predict each other');
  assert.ok(cross.q < 0.05, 'planted cross-focus effect missed (q=' + cross.q + ')');
});

test('no roles configured yields no outcomes and no crash', () => {
  seed = 8;
  const events = buildEvents(90, () => [{ topicid: 1, n: 2 }]);
  const res = I.analyze({ events, topics: [{ id: 1, name: 'Water' }], roles: {} });
  assert.strictEqual(res.outcomes.length, 0);
  assert.strictEqual(res.tests.length, 0);
  assert.ok(Array.isArray(res.narrative));
});

test('night window is configurable', () => {
  seed = 3;
  const A = 1;
  // Everything at 23:00 — inside a 22->6 window, outside a 0->5 one.
  const events = buildEvents(120, () => [{ topicid: A, n: 2, hour: 23 }]);
  const topics = [{ id: A, name: 'Waking' }];
  const roles = { [A]: { role: 'focus', dir: 'down' } };
  const wide = I.analyze({ events, topics, roles, nightStart: 22, nightEnd: 6 });
  const narrow = I.analyze({ events, topics, roles, nightStart: 0, nightEnd: 5 });
  assert.ok(wide.outcomes.some((o) => o.key === `focus:${A}:night`),
    '11pm events should count as night in a 22-6 window');
  assert.ok(!narrow.outcomes.some((o) => o.key === `focus:${A}:night`),
    '11pm events must not count as night in a 0-5 window');
});

test('tracking starts and daily check-ins preserve missing values', () => {
  const today = S.dayKey(NOW, 4), start = S.addDays(today, -5);
  const events = [
    { topicid: 1, time: S.dayBoundary(start, 12), qant: 60 },
    { topicid: 1, time: S.dayBoundary(S.addDays(start, 1), 12), qant: 62 },
    { topicid: 1, time: S.dayBoundary(S.addDays(start, 1), 18), qant: 64 },
    { topicid: 2, time: S.dayBoundary(S.addDays(start, 2), 12), qant: 2 },
  ];
  const res = analyze({ now: NOW, events, topics: [{ id: 1, name: 'Weight' }, { id: 2, name: 'Water' }],
    roles: { 1: 'focus' }, kinds: { 1: 'amount', 2: 'amount' },
    topicPrefs: { 1: { aggregation: 'latest' }, 2: { aggregation: 'sum' } },
    dayChecks: { [S.logicalDate(S.addDays(start, 1))]: 'none',
      [S.logicalDate(S.addDays(start, 3))]: 'complete',
      [S.logicalDate(S.addDays(start, 4))]: 'incomplete' }, measurements: { 1: { symbol: 'kg' } } });
  const amount = res.outcomes.find((o) => o.metric === 'amount');
  const count = res.outcomes.find((o) => o.metric === 'count');
  assert.strictEqual(amount.get(res.table.days[1]), 64, 'data wins over none');
  assert.strictEqual(amount.get(res.table.days[2]), null, 'unmeasured is not zero');
  assert.strictEqual(amount.get(res.table.days[3]), null, 'complete does not invent weight');
  assert.strictEqual(count.get(res.table.days[3]), 0);
  assert.strictEqual(count.get(res.table.days[4]), null);
  assert.strictEqual(count.get(res.table.days[5]), null);
  assert.strictEqual(res.table.days[0].observed[2], false, 'no earlier history for later topic');
  assert.match(amount.label, /kg/);
  assert.strictEqual(res.dataQuality.unknownDays, 1);
});

test('mean amount, duration and rating outcomes retain their units', () => {
  const time = S.dayBoundary(S.dayKey(NOW), 12);
  const res = analyze({ now: NOW, topics: [{ id: 1, name: 'Score' }, { id: 2, name: 'Walk' }],
    events: [{ topicid: 1, time, qant: 4, cost: 2 }, { topicid: 1, time: time + 1000, qant: 8, cost: 4 },
      { topicid: 2, time, qant: 1800 }],
    kinds: { 1: 'amount', 2: 'duration' }, roles: { 1: 'focus', 2: 'focus' },
    topicPrefs: { 1: { aggregation: 'mean' } } });
  const row = res.table.days[0];
  const get = (key) => res.outcomes.find((o) => o.key === key).get(row);
  assert.strictEqual(get('focus:1:amount'), 6);
  assert.strictEqual(get('focus:1:severity'), 4);
  assert.strictEqual(get('focus:1:severityMean'), 3);
  assert.strictEqual(get('focus:2:minutes'), 30);
  assert.throws(() => analyze({ events: [{ topicid: 1, time, qant: 'bad' }], now: NOW }), /quantity/);
});

test('lags pair actual calendar days rather than adjacent observed rows', () => {
  const key = S.dayKey(NOW);
  const rows = [{ key: S.addDays(key, -2), x: 1 }, { key, x: 2 }];
  const p = { get: (r) => r.x };
  assert.strictEqual(I.pairSeries(rows, p, p, 1).xs.length, 0);
  assert.deepStrictEqual(I.pairSeries(rows, p, p, 2).xs, [1]);
  assert.deepStrictEqual(I.rolling([1, null, 3, 5], 2), [null, null, null, 4]);
});

test('zero baselines report additive change, unavailable baselines never normal', () => {
  const start = S.addDays(S.dayKey(NOW), -99), checks = {};
  for (let k = start; k <= S.dayKey(NOW); k = S.addDays(k, 1)) checks[S.logicalDate(k)] = 'complete';
  const args = { now: NOW, topics: [{ id: 1, name: 'Thing' }], roles: { 1: 'focus' },
    topicPrefs: { 1: { trackingStart: start } }, dayChecks: checks,
    events: Array.from({ length: 7 }, (_, i) => ({ topicid: 1, qant: 0,
      time: S.dayBoundary(S.addDays(S.dayKey(NOW), -i), 12) })) };
  const res = analyze(args);
  const m = res.status.metrics.find((m) => m.key === 'focus:1:count');
  assert.strictEqual(m.pct, null);
  assert.strictEqual(m.delta, 1);
  assert.strictEqual(m.changeLabel, 'from none');
  assert.match(res.status.reasons.join(' '), /from none/);
  const unknown = analyze({ ...args, events: [], dayChecks: {} });
  assert.strictEqual(unknown.status.level, 'insufficient');
});

test('all inference is bounded by recent calendar days and timing corrects its own p family', () => {
  seed = 312;
  const events = buildEvents(200, (d) => {
    const hour = 10 + (d % 8);
    return [{ topicid: 1, n: 1, hour }, { topicid: 2, n: 1 + poisson(hour / 4), hour: 20 }];
  });
  const res = I.analyze({ events, topics: [{ id: 1, name: 'Meal' }, { id: 2, name: 'Focus' }],
    roles: { 1: { role: 'influence', timing: true }, 2: 'focus' }, insightWindow: 60 });
  assert.ok(res.timing.length > 0);
  for (const t of [...res.tests, ...res.timing]) {
    assert.ok(t.n <= 60);
    assert.ok(t.sampleDates.every((k) => k >= res.window.start && k <= res.window.end));
    assert.ok(t.sourceDates.every((k) => k >= res.window.start));
  }
  const expected = res.timing.map((t) => ({ p: Math.max(t.pParametric, t.pNonparam) }));
  I.benjaminiHochberg(expected);
  res.timing.forEach((t, i) => {
    assert.strictEqual(t.p, expected[i].p);
    assert.strictEqual(t.q, expected[i].q);
  });
  assert.ok(res.table.days.length > 60, 'baseline retains older history');
});

test('reports anchor analysis to a historical exclusive end and cap the calendar window', () => {
  const endKey = new Date(2026, 5, 20).getTime();
  const to = S.dayBoundary(endKey, 4);
  const from = S.dayBoundary(S.addDays(endKey, -30), 4);
  const res = analyze({ now: to - 1, insightWindow: 30,
    topics: [{ id: 1, name: 'History' }], roles: { 1: 'focus' },
    events: [{ topicid: 1, time: from, qant: 0 }, { topicid: 1, time: to, qant: 0 }] });
  assert.strictEqual(res.window.from, from);
  assert.strictEqual(res.window.to, to);
  assert.strictEqual(res.window.days, 30);
  assert.strictEqual(res.table.days.reduce((n, r) => n + r.events, 0), 1);
  assert.strictEqual(res.table.todayKey, S.addDays(endKey, -1));
  const bounded = analyze({ now: to - 1, insightWindow: 1000 });
  assert.strictEqual(bounded.window.days, 400);
  assert.strictEqual(bounded.window.from, S.dayBoundary(S.addDays(endKey, -400), 4));
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
