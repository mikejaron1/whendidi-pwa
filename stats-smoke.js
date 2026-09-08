const assert = require('assert');
const fs = require('fs');
global.window = {};
new Function(fs.readFileSync(require('path').join(__dirname, 'js/stats.js'), 'utf8'))();
const S = window.CWSTATS;
const now = new Date(2026, 8, 8, 12).getTime();
const iv = S.intervalStats([{ time: 0 }, { time: 10 }, { time: 40 }], 100);
assert.strictEqual(iv.median, 20);
assert.strictEqual(iv.last, 60);
assert.strictEqual(iv.lastInterval, 30);
assert.strictEqual(S.intervalStats([{ time: 10 }], 100).last, 90);
assert.strictEqual(S.intervalStats([{ time: 10 }], 100).median, null);
const start = S.dayKey(now), end = S.addDays(start, 3) - 1;
const events = [{ time: start + 3600000, qant: 10 }, { time: start + 7200000, qant: 20 }];
for (const [aggregation, value] of Object.entries({ sum: 30, mean: 15, latest: 20, min: 10, max: 20 })) {
  const rows = S.aggregate(events, 'daily', { start, end, fill: true, aggregation });
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[2].value, value);
  assert.strictEqual(rows[0].value, aggregation === 'sum' ? 0 : null);
}
assert.throws(() => S.aggregate([{ time: now, qant: 'bad' }], 'daily'), /quantity/);
assert.throws(() => S.aggregate([], 'daily', { fill: true }), /bounded/);
for (const [year, month, date] of [[2026, 2, 8], [2026, 10, 1]]) {
  const midnight = new Date(year, month, date).getTime();
  const before = new Date(year, month, date, 3, 30).getTime();
  const after = new Date(year, month, date, 4, 30).getTime();
  assert.strictEqual(S.dayKey(before, 4), S.addDays(midnight, -1));
  assert.strictEqual(S.dayKey(after, 4), midnight);
  assert.strictEqual(S.minutesFromDayStart(before, 4), 1410);
  assert.strictEqual(S.minutesFromDayStart(after, 4), 30);
  for (let n = -4; n < 4; n++) {
    const day = S.addDays(midnight, n);
    assert.strictEqual(new Date(day).getHours(), 0);
    assert.strictEqual(S.dayKey(S.dayBoundary(day, 12), 4), day);
  }
  const matrix = S.calendarMatrix([], 3, 4, after);
  const flat = matrix.weeks.flat();
  assert.strictEqual(new Set(flat.map((d) => S.logicalDate(d.date))).size, 21);
  assert.ok(flat.every((d) => new Date(d.date).getHours() === 0));
}
console.log(`stats smoke passing (${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
