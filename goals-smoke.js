/* Goals / streaks smoke test.
 *
 * The streak rules have edge cases that are easy to get subtly wrong — zero
 * days, the asymmetry of "today", and clamping so a limit goal can't claim
 * credit for time before it existed. Each is pinned down here.
 *
 *   node goals-smoke.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const win = {};
new Function('window', fs.readFileSync(path.join(ROOT, 'js/stats.js'), 'utf8'))(win);
new Function('window', 'document', 'navigator',
  fs.readFileSync(path.join(ROOT, 'js/insights.js'), 'utf8'))(win, {}, {});
new Function('window', 'document', 'navigator',
  fs.readFileSync(path.join(ROOT, 'js/goals.js'), 'utf8'))(win, {}, {});
const G = win.CWGOALS;

const CUTOFF = 4;
const DAY = 86400000;

/* A fixed "now" well clear of a DST boundary, late evening so the logical day
 * is unambiguous. */
const NOW = new Date(2026, 4, 20, 23, 59, 0).getTime();

/* Builds an event `d` days ago at a given hour. */
function ev(daysAgo, hour = 12, qant = 0) {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return { topicid: 1, time: d.getTime(), qant };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* 1. The headline habit case: consecutive days with at least one workout. */
test('counts consecutive days meeting an "at least" goal', () => {
  const events = [0, 1, 2, 3, 4].map((d) => ev(d));
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 1, period: 'day', metric: 'count', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.current, 5, 'five logged days should be a five-day streak');
  assert.strictEqual(r.best, 5);
  assert.strictEqual(r.met, true, "today's goal is met");
});

/* 2. A gap in the middle ends the streak; the run before it becomes `best`. */
test('a missed day breaks the streak but is remembered as the best', () => {
  const events = [0, 1, 3, 4, 5, 6, 7].map((d) => ev(d));   // day 2 missing
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 1, period: 'day', metric: 'count', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.current, 2, 'only today and yesterday survive the gap');
  assert.strictEqual(r.best, 5, 'the earlier five-day run is the best');
});

/* 3. The asymmetry of today, part one. An "at least" goal not yet hit is
 *    still winnable, so it must not zero out a live streak. */
test('an unmet "at least" goal today is pending, not a broken streak', () => {
  const events = [1, 2, 3].map((d) => ev(d));   // nothing logged today
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 1, period: 'day', metric: 'count', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.pending, true, 'today should be pending');
  assert.strictEqual(r.current, 3, 'the streak of the three prior days survives');
  assert.strictEqual(r.remaining, 1, 'one more to go today');
});

/* 4. The asymmetry of today, part two. An "at most" goal you have already
 *    blown is broken now — there is no winning it back. */
test('an exceeded "at most" goal today breaks the streak immediately', () => {
  const events = [ev(0), ev(0, 14), ev(5)];   // two today, limit is one
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'lte', target: 1, period: 'day', metric: 'count', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.pending, false, 'a blown limit is not pending');
  assert.strictEqual(r.met, false);
  assert.strictEqual(r.current, 0, 'the streak is broken today');
});

/* 5. The quit-smoking case. Days with no events at all are the ones that
 *    count, which only works if periods come from the calendar. */
test('empty days satisfy an "at most 0" goal', () => {
  const events = [ev(9)];   // one slip, nine days ago, nothing since
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'lte', target: 0, period: 'day', metric: 'count', since: NOW - 60 * DAY },
  });
  assert.strictEqual(r.current, 9, 'nine clean days since the slip');
  assert.strictEqual(r.met, true);
});

/* 6. Without clamping, "at most 0" would claim every day since the epoch. */
test('a limit streak cannot start before the goal existed', () => {
  const r = G.evaluate({
    events: [], kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'lte', target: 0, period: 'day', metric: 'count', since: NOW - 4 * DAY },
  });
  assert.strictEqual(r.current, 5, 'four days plus today, not the whole lookback');
});

/* 7. ...but real history before the goal still counts, so adding a goal to a
 *    topic you have tracked for months doesn't throw that away. */
test('a limit streak may start from the first logged event', () => {
  const r = G.evaluate({
    events: [ev(20)], kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'lte', target: 0, period: 'day', metric: 'count', since: NOW },
  });
  assert.strictEqual(r.current, 20, 'twenty clean days since the only event');
});

/* 8. Duration topics are stored in seconds but read in minutes. */
test('duration goals are measured in minutes', () => {
  const events = [0, 1, 2].map((d) => ev(d, 12, 1800));   // 30 min each
  const r = G.evaluate({
    events, kind: 'duration', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 30, period: 'day', metric: 'minutes', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.value, 30, '1800 seconds should read as 30 minutes');
  assert.strictEqual(r.current, 3);
});

/* 9. Amount topics sum their quantity. */
test('amount goals sum the logged quantity', () => {
  const events = [ev(0, 9, 32), ev(0, 15, 40), ev(1, 12, 10)];
  const r = G.evaluate({
    events, kind: 'amount', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 64, period: 'day', metric: 'amount', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.value, 72, 'today should total 72');
  assert.strictEqual(r.current, 1, 'yesterday fell short at 10');
});

/* 10. Weekly goals aggregate days, and judge on the week's total. */
test('weekly goals aggregate the whole week', () => {
  // Three workouts inside the current week, spread across days.
  const dow = (new Date(NOW).getDay() + 6) % 7;   // Mon = 0
  const events = [0, 1, 2].map((i) => ev(Math.min(dow, i)));
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 3, period: 'week', metric: 'count', since: NOW - 200 * DAY },
  });
  assert.ok(r.periods.length > 1, 'should produce multiple weeks');
  assert.strictEqual(r.periods[r.periods.length - 1].value, events.length,
    'the current week should hold all three');
});

/* 11. A partial leading week would be judged unfairly on fewer days. */
test('an incomplete first week is visible and excluded from rate', () => {
  const r = G.evaluate({
    events: [], kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'lte', target: 0, period: 'week', metric: 'count', since: NOW - 29 * DAY },
  });
  const first = r.periods[0];
  assert.strictEqual(first.partial, true);
  assert.strictEqual(first.status, 'partial');
  assert.strictEqual(first.excluded, true);
});

/* 12. Completion rate reports settled periods only. */
test('completion rate ignores the pending period', () => {
  const events = [1, 2, 4].map((d) => ev(d));   // day 3 missed, today empty
  const r = G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 1, period: 'day', metric: 'count', since: NOW - 4 * DAY },
  });
  assert.strictEqual(r.pending, true);
  assert.strictEqual(r.totalRecent, 4, 'today is excluded from the rate');
  assert.strictEqual(r.metRecent, 3);
});

/* 13. Garbage in must not throw. */
test('malformed goals are rejected rather than crashing', () => {
  for (const bad of [null, undefined, {}, 'gte', { target: 'x' }, { target: -1 },
                     { cmp: 'gte', target: 0 }]) {
    assert.strictEqual(G.normalizeGoal(bad), null, `should reject ${JSON.stringify(bad)}`);
    assert.strictEqual(G.evaluate({ events: [], goal: bad }), null);
  }
});

/* 14. The user-facing sentence adapts to the goal's shape. */
test('the streak line reads naturally in each direction', () => {
  const mk = (cmp, events, target = 1) => G.evaluate({
    events, kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp, target, period: 'day', metric: 'count', since: NOW - 30 * DAY },
  });
  assert.match(G.streakLine(mk('gte', [0, 1].map((d) => ev(d)))), /2 days in a row/);
  assert.match(G.streakLine(mk('gte', [ev(0)])), /1 day in a row/);
  assert.match(G.streakLine(mk('lte', [ev(9)], 0)), /9 days within your limit/);
  assert.match(G.streakLine(mk('lte', [ev(0), ev(0, 14)], 1)), /Over your limit/);
  assert.match(G.describeGoal({ cmp: 'lte', target: 2, period: 'week', metric: 'count' }),
    /at most 2× per week/);
});

/* 15. The day cutoff applies, so a 2am log belongs to the night before. */
test('goals respect the logical day cutoff', () => {
  const late = new Date(NOW);
  late.setHours(2, 0, 0, 0);            // 2am today -> counts as yesterday
  const r = G.evaluate({
    events: [{ topicid: 1, time: late.getTime(), qant: 0 }],
    kind: 'timeonly', cutoffHour: CUTOFF, now: NOW,
    goal: { cmp: 'gte', target: 1, period: 'day', metric: 'count', since: NOW - 30 * DAY },
  });
  assert.strictEqual(r.met, false, 'a 2am log should not satisfy today');
  assert.strictEqual(r.current, 1, 'it satisfies yesterday, keeping a 1-day streak');
});

  test('goal revisions retain previous targets and apply at next period boundary', () => {
    const goal = { cmp: 'gte', target: 1, period: 'day', metric: 'count', since: ev(5).time };
    const changed = G.reviseGoal(goal, { target: 2 }, ev(2).time);
    assert.strictEqual(changed.history[0].target, 1);
    assert.strictEqual(changed.history[0].effectiveFrom, goal.since);
    const r = G.evaluate({ goal: changed, events: [0, 1, 2, 3, 4].map((d) => ev(d)), now: NOW });
    assert.strictEqual(r.periods.find((p) => p.key === win.CWSTATS.dayKey(ev(3).time, 4)).met, true);
    assert.strictEqual(r.periods.find((p) => p.key === win.CWSTATS.dayKey(ev(1).time, 4)).met, false);
    assert.strictEqual(r.periods.find((p) => p.key === win.CWSTATS.dayKey(ev(2).time, 4)).config.target, 1);
    assert.strictEqual(r.activeGoal.target, 2);
    assert.strictEqual(G.normalizeGoal(changed).history.length, 1);
  });

  test('pause intervals preserve completed streaks and survive normalization', () => {
    let goal = { cmp: 'gte', target: 1, period: 'day', metric: 'count', since: ev(5).time };
    const S = win.CWSTATS;
    goal = G.setPaused(goal, true, S.dayBoundary(S.dayKey(ev(2).time, 4), 4));
    goal = G.setPaused(goal, false, S.dayBoundary(S.dayKey(ev(0).time, 4), 4));
    const r = G.evaluate({ goal, events: [0, 3, 4].map((d) => ev(d)), now: NOW });
    assert.strictEqual(r.current, 3);
    assert.strictEqual(r.periods.filter((p) => p.paused).length, 2);
    assert.strictEqual(G.normalizeGoal(goal).pauses.length, 1);
    const paused = G.evaluate({ goal: G.setPaused(goal, true, NOW - 1000), now: NOW, events: [ev(0)] });
    assert.strictEqual(paused.status, 'paused');
    assert.match(G.streakLine(paused), /paused/);
  });

  test('strict check-ins exclude unknown days and mean/latest goals do not invent observations', () => {
    const S = win.CWSTATS;
    const goal = { cmp: 'lte', target: 0, period: 'day', metric: 'count', since: ev(5).time };
    const opts = { goal, events: [], topicId: 1, now: NOW,
      topicPrefs: { 1: { trackingStart: ev(5).time } }, dayChecks: {
        [S.logicalDate(NOW, 4)]: 'complete',
        [S.logicalDate(ev(1).time, 4)]: 'incomplete',
      } };
    const r = G.evaluate(opts);
    assert.strictEqual(r.current, 1);
    assert.strictEqual(r.totalRecent, 0);
    assert.strictEqual(r.periods.at(-2).status, 'unknown');
    assert.match(G.streakLine(r), /observed day/);
    assert.doesNotMatch(G.streakLine(r), /in a row/);
    const observed = G.evaluate({ ...opts, goal: { ...goal, metric: 'amount', target: 70 },
      topicPrefs: { 1: { trackingStart: ev(5).time, aggregation: 'latest' } } });
    assert.strictEqual(observed.value, null);
    assert.strictEqual(observed.status, 'unknown');
  });

  test('weekly revisions do not rewrite the week already in progress', () => {
    const base = { cmp: 'gte', target: 1, period: 'week', metric: 'count', since: ev(30).time };
    const changed = G.reviseGoal(base, { target: 20 }, NOW);
    const r = G.evaluate({ goal: changed, now: NOW, events: [ev(0), ev(8), ev(15)] });
    assert.strictEqual(r.activeGoal.target, 1);
    assert.strictEqual(r.goal.target, 20);
  });

  test('daily and weekly goal boundaries stay on the calendar across both DST changes', () => {
    const S = win.CWSTATS;
    for (const month of [2, 10]) {
      const now = new Date(2026, month, month === 2 ? 12 : 5, 23).getTime();
      const today = S.dayKey(now, 4);
      const events = Array.from({ length: 12 }, (_, i) => ({ topicid: 1, qant: 60,
        time: S.dayBoundary(S.addDays(today, -i), 12) }));
      const goal = { cmp: 'gte', target: 1, period: 'day', metric: 'count', since: events.at(-1).time };
      const r = G.evaluate({ goal, events, now, cutoffHour: 4 });
      assert.strictEqual(r.current, 12);
      assert.strictEqual(new Set(r.periods.map((p) => S.logicalDate(p.key))).size, 12);
      assert.ok(r.periods.every((p) => new Date(p.key).getHours() === 0));
      const w = G.evaluate({ goal: { ...goal, period: 'week' }, events, now, cutoffHour: 4 });
      assert.ok(w.periods.every((p) => new Date(p.key).getDay() === 1));
      assert.strictEqual(w.periods.reduce((sum, p) => sum + p.value, 0), 12);
    }
  });

  test('future tracking dates and invalid measured quantities cannot fabricate goal progress', () => {
    const S = win.CWSTATS;
    const goal = { metric: 'amount', cmp: 'gte', target: 2, period: 'day', since: NOW };
    assert.throws(() => G.evaluate({ goal, now: NOW, events: [ev(0, 12, 'bad')] }), /quantity/);
    const r = G.evaluate({ goal, now: NOW, topicId: 1,
      topicPrefs: { 1: { trackingStart: S.dayBoundary(S.addDays(S.dayKey(NOW, 4), 1), 4) } },
      dayChecks: { [S.logicalDate(NOW, 4)]: 'complete' } });
    assert.strictEqual(r.status, 'unknown');
    assert.strictEqual(r.current, 0);
  });
let failed = 0;
console.log('goals and streaks');
for (const [name, fn] of tests) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
