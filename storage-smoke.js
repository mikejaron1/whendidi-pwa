#!/usr/bin/env node
/* Synthetic IndexedDB transaction/backup regression checks: node storage-smoke.js */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange, IDBObjectStore } = require('fake-indexeddb');

const dom = new JSDOM('', { url: 'https://storage.test/', runScripts: 'outside-only' });
const win = dom.window;
win.indexedDB = new IDBFactory();
win.IDBKeyRange = IDBKeyRange;
for (const file of ['db.js', 'import-export.js']) win.eval(fs.readFileSync(path.join(__dirname, 'js', file), 'utf8'));
const DB = win.CWDB, IO = win.CWIO;
const copy = (value) => JSON.parse(JSON.stringify(value));
const snapshot = async () => copy(await DB.getDataset());
const time = 1700000000000;
const goal = { metric: 'count', cmp: 'gte', target: 2, period: 'day', since: time };
const topic = (id, name, msureid = 100) => ({ id, name, msureid, desc: '', type: 1 });
const event = (id, topicid, note = '', cost = 0) => ({ id, topicid, time, qant: 1, note, cost });
const basic = () => ({
  version: 4,
  topics: [topic(1, 'Water')],
  events: [event(1, 1)],
  _countwhen: {
    topicKinds: { 1: 'amount' },
    topicMeta: { 1: { emoji: 'W', color: '#123456' } },
    topicGoals: { 1: goal },
    topicPrefs: { 1: { quickAmount: 3, aggregation: 'mean', trackingStart: time } },
    topicRoles: { 1: { role: 'focus', dir: 'up', timing: false } },
    topicOrder: [1], quickBar: [1], favorites: [{ topicid: 1, added: time }],
    dayChecks: { '2024-02-29': 'complete', '2024-03-01': 'none', '2024-03-02': 'incomplete' },
    insightSettings: { cutoffHour: 4, alertsEnabled: false, lastAlertAt: time },
    futureSetting: { x: 1 },
    activeTimers: { 1: time }, driveClientId: 'remote-device', syncCounter: 999,
  },
  _wdapp: { oldExtension: ['retained'], futureSetting: { y: 2 } },
  futureTop: { nested: [1, 'two', null] },
});

async function run() {
  await DB.setMeta('driveClientId', 'local-device');
  await DB.setMeta('driveEnabled', false);
  await DB.setMeta('drivePendingSnapshot', { savedAt: time, snapshot: 'local-recovery' });
  await DB.setMeta('syncCounter', 8);
  await DB.setMeta('dataRevision', 42);
  await DB.setMeta('activeTimers', { 9: time });
  await DB.setMeta('staleDatasetSetting', 'remove');
  await IO.importReplace(basic());
  assert.equal(await DB.getMeta('driveClientId'), 'local-device');
  assert.equal(await DB.getMeta('driveEnabled'), false);
  assert.equal(await DB.getMeta('syncCounter'), 8);
  assert.equal(await DB.getMeta('dataRevision'), 42);
  assert.equal(await DB.getMeta('activeTimers'), null);
  assert.equal(await DB.getMeta('staleDatasetSetting'), null);
  assert.equal((await DB.getMeta('drivePendingSnapshot')).snapshot, 'local-recovery');
  let exported = copy(await IO.buildExportObject());
  assert.deepEqual(copy(IO.validateBackup(exported)), []);
  assert.deepEqual(exported._plotline.topicGoals, { 1: goal });
  assert.deepEqual(exported._plotline.topicPrefs, basic()._countwhen.topicPrefs);
  assert.deepEqual(exported._plotline.dayChecks, basic()._countwhen.dayChecks);
  assert.deepEqual(exported._plotline.futureSetting, { x: 1, y: 2 });
  assert.deepEqual(exported._plotline.oldExtension, ['retained']);
  assert.deepEqual(exported.futureTop, basic().futureTop);
  assert.equal(exported._plotline.backupSchemaVersion, IO.BACKUP_SCHEMA_VERSION);
  for (const key of ['activeTimers', 'driveClientId', 'syncCounter', 'dataRevision']) assert.equal(exported._plotline[key], undefined);
  assert.equal(exported._plotline.insightSettings.lastAlertAt, undefined);
  await IO.importReplace(exported);
  assert.deepEqual(copy((await IO.buildExportObject())._plotline), exported._plotline);
  const future = copy(exported);
  future._plotline.backupSchemaVersion = 9;
  future._plotline.futureSetting.newOption = { values: [true, 'future'] };
  future._plotline.topicPrefs[1].futureOption = 'preserved';
  future._plotline.topicGoals[1] = { ...goal, effectiveFrom: time + 2000,
    history: [{ metric: 'count', cmp: 'gte', target: 1, period: 'day', effectiveFrom: time }],
    pauses: [{ from: time + 1000, to: time + 1500 }, { from: time + 3000, to: null }] };
  await IO.importReplace(future);
  assert.deepEqual(copy((await IO.buildExportObject())._plotline), future._plotline);
  await IO.importReplace(exported);

  for (const namespace of ['_plotline', '_countwhen', '_wdapp']) {
    const legacy = copy(exported);
    const app = legacy._plotline;
    delete legacy._plotline;
    app.insightSettings = { ...app.insightSettings, alertOn: 'flare',
      alertsEnabled: false, futureAlertOption: { enabled: true } };
    legacy[namespace] = app;
    const original = copy(legacy);
    assert.deepEqual(copy(IO.validateBackup(legacy)), []);
    for (const method of ['importReplace', 'importMerge', 'applyBackup']) {
      await IO.importReplace(exported);
      await IO[method](legacy);
      const settings = await DB.getMeta('insightSettings');
      assert.equal(settings.alertOn, 'alert', `${method} should migrate ${namespace}`);
      assert.equal(settings.alertsEnabled, false);
      assert.deepEqual(copy(settings.futureAlertOption), { enabled: true });
      const roundtrip = copy(await IO.buildExportObject());
      assert.equal(roundtrip._plotline.insightSettings.alertOn, 'alert');
      assert.deepEqual(roundtrip.events, exported.events);
      assert.deepEqual(roundtrip._plotline.topicGoals, exported._plotline.topicGoals);
      assert.deepEqual(legacy, original, 'migration must not mutate the source backup');
    }
  }
  await DB.setMeta('insightSettings', { alertOn: 'flare', alertsEnabled: false, cutoffHour: 4 });
  assert.equal((await DB.getInsightSettings()).alertOn, 'alert');
  assert.equal((await IO.buildExportObject())._plotline.insightSettings.alertOn, 'alert');
  assert.equal((await DB.setInsightSettings({ windowDays: 14 })).alertOn, 'alert');
  assert.equal((await DB.getMeta('insightSettings')).alertOn, 'alert');
  for (const alertOn of ['watch', 'alert']) {
    assert.equal((await DB.setInsightSettings({ alertOn })).alertOn, alertOn);
  }
  await IO.importReplace(exported);
  console.log('PASS legacy alert thresholds migrate without changing logs, goals or unknown settings');

  const malformed = [
    null, [], { topics: null, events: [] }, { topics: [], events: [null] },
    { topics: [null], events: [] }, { topics: [], events: {}, measurements: {} },
    { topics: [topic(1, 'a'), topic(1, 'b')], events: [] },
    { topics: [topic(1, 'a')], events: [event(1, 1), event(1, 1)] },
    { topics: [topic(Number.MAX_SAFE_INTEGER + 1, 'a')], events: [] },
    { topics: [topic(1, 'a')], events: [event(2, 99)] },
    { topics: [topic(1, 'a')], events: [{ ...event(2, 1), time: 8640000000000001 }] },
    { topics: [topic(1, 'a')], events: [{ ...event(2, 1), qant: NaN }] },
    { topics: [topic(1, 'a')], events: [{ ...event(2, 1), qant: '2' }] },
    { topics: [topic(1, 'a')], events: [{ ...event(2, 1), cost: Infinity }] },
    { topics: [topic(1, 'a')], events: [], measurements: [] },
    { topics: [topic(1, 'a')], events: [], _plotline: null },
    { topics: [topic(1, 'a')], events: [], _plotline: { topicPrefs: { 1: null }, dayChecks: { '2023-02-29': 'none' } } },
    { topics: [topic(1, 'a')], events: [], _plotline: { topicPrefs: { 1: { aggregation: 'total' } } } },
    { topics: [topic(1, 'a')], events: [], _plotline: { topicGoals: { 1: { ...goal, target: '2' } } } },
    { topics: [topic(1, 'a')], events: [], _plotline: { topicGoals: { 1: { ...goal, history: [null] } } } },
    { topics: [topic(1, 'a')], events: [], _plotline: { topicGoals: { 1: { ...goal, pauses: [{ from: time, to: time - 1 }] } } } },
    { topics: [topic(1, 'a')], events: [], _plotline: { topicGoals: { 1: { ...goal, effectiveFrom: 8640000000000001 } } } },
    { topics: [topic(1, 'a')], events: [], _plotline: { favorites: [null] } },
    { topics: [topic(1, 'a')], events: [], measurements: [null] },
    { topics: [topic(1, 'a')], events: [], appdata: [null], pendtimes: [null] },
    ...['bogus', '', 'FLARE', null, true, 1, {}, []].map((alertOn) => ({
      topics: [topic(1, 'a')], events: [],
      _plotline: { insightSettings: { alertOn, alertsEnabled: false } },
    })),
  ];
  const before = await snapshot();
  for (const bad of malformed) {
    assert.ok(IO.validateBackup(bad).length, 'malformed backup accepted');
    for (const method of ['importReplace', 'importMerge', 'applyBackup']) {
      await assert.rejects(IO[method](bad), /Invalid backup/);
      assert.deepEqual(await snapshot(), before, `${method} mutated data on validation failure`);
    }
  }
  const invalidDataset = copy(before);
  invalidDataset.events.push(invalidDataset.events[0]);
  await assert.rejects(DB.replaceDataset(invalidDataset));
  assert.deepEqual(await snapshot(), before, 'failed insert must roll back preceding clears');
  const uncloneable = copy(before);
  uncloneable.topics[0].bad = () => {};
  await assert.rejects(DB.replaceDataset(uncloneable));
  assert.deepEqual(await snapshot(), before, 'synchronous clone failure must roll back');
  await assert.rejects(DB.updateDataset(() => { throw new Error('preparation failed'); }), /preparation failed/);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(copy(IO.validateBackup({
    topics: [topic(1, 'Legacy roles')], events: [{ id: 1, topicid: 1, time, note: null }],
    _wdapp: { topicRoles: { 1: 'bathroom' } },
  })), []);
  console.log('PASS roundtrip, schema validation, atomic failure and device preservation');

  const durationBackup = {
    topics: [topic(1, 'Running timer', 10)], events: [],
    _plotline: { topicKinds: { 1: 'duration' } },
  };
  await IO.importReplace(durationBackup);
  await DB.startTimer(1, time);
  const duration = copy(await IO.buildExportObject());
  const timerOptions = { preserveActiveTimers: true, topicIdMap: { 1: 1 },
    measurementIdMap: Object.fromEntries(duration.measurements.map((m) => [m.id, m.id])) };
  const remoteMetadata = copy(duration);
  remoteMetadata._plotline.topicMeta = { 1: { color: '#123456' } };
  remoteMetadata.events.push(event(5, 1));
  await IO.checkTimerReplacement(remoteMetadata, timerOptions);
  await IO.importReplace(remoteMetadata, timerOptions);
  assert.deepEqual(copy(await DB.getMeta('activeTimers')), { 1: time });
  assert.equal((await DB.getAll('events')).length, 1);
  assert.equal((await DB.getMeta('topicMeta'))[1].color, '#123456');
  assert.equal((await IO.buildExportObject())._plotline.activeTimers, undefined);
  const timerBeforeConflict = await snapshot();
  const incompatible = [
    (b) => { b._plotline.topicKinds[1] = 'amount'; },
    (b) => { b.topics[0].msureid = 8; },
    (b) => { b.measurements.find((m) => m.id === 10).type = 0; },
    (b) => { b.measurements.find((m) => m.id === 10).format = 7; },
    (b) => { b.topics = []; b.events = []; b._plotline = {}; },
  ];
  for (const change of incompatible) {
    const bad = copy(remoteMetadata); change(bad);
    await assert.rejects(IO.checkTimerReplacement(bad, timerOptions), /TIMER_CONFLICT/);
    await assert.rejects(IO.importReplace(bad, timerOptions), /TIMER_CONFLICT/);
    assert.deepEqual(await snapshot(), timerBeforeConflict, 'timer conflicts roll back every store');
  }
  await assert.rejects(IO.importReplace(remoteMetadata, { preserveActiveTimers: true }), /TIMER_CONFLICT/);
  const moved = copy(duration);
  moved.topics[0].id = 50;
  moved.topics[0].msureid = 60;
  moved.measurements.find((m) => m.id === 10).id = 60;
  moved.topics.push(topic(1, 'Different remote duration', 8));
  moved.measurements.push({ id: 10, name: 'Different remote unit', type: 0, format: 0 });
  moved._plotline.topicKinds = { 50: 'duration', 1: 'duration' };
  const moveOptions = { preserveActiveTimers: true, topicIdMap: { 1: 50 },
    measurementIdMap: { ...timerOptions.measurementIdMap, 10: 60 } };
  const brokenMoved = copy(moved);
  brokenMoved.events = [event(6, 50), event(6, 50)];
  const preparedBroken = {
    ...timerBeforeConflict, topics: moved.topics, measurements: moved.measurements,
    events: brokenMoved.events,
    meta: [{ key: 'topicKinds', value: moved._plotline.topicKinds }],
  };
  await assert.rejects(DB.replaceDataset(preparedBroken, moveOptions));
  assert.deepEqual(await snapshot(), timerBeforeConflict, 'failed replacement also rolls back timer remapping');
  await IO.importReplace(moved, moveOptions);
  assert.deepEqual(copy(await DB.getMeta('activeTimers')), { 50: time });
  const timerEvent = await DB.finishTimer(50, time + 5000);
  assert.equal(timerEvent.topicid, 50);
  assert.equal(timerEvent.qant, 5);
  await DB.startTimer(50, time);
  await IO.importReplace(moved);
  assert.equal(await DB.getMeta('activeTimers'), null, 'manual replace clears even matching local timers');
  await DB.startTimer(50, time);
  await DB.replaceDataset(await DB.getDataset());
  assert.equal(await DB.getMeta('activeTimers'), null, 'raw dataset replacement also clears timers by default');
  await IO.importReplace(exported);
  console.log('PASS sync-only timer preservation, ID/unit remapping, atomic conflicts and explicit replacement');

  const incoming = {
    topics: [topic(2, 'Sleep'), topic(1, 'Walk')],
    events: [event(1, 2, 'sleep'), event(2, 1, 'walk')],
    _plotline: {
      topicKinds: { 2: 'duration', 1: 'amount' },
      topicMeta: { 2: { emoji: 'S' }, 1: { emoji: 'K' } },
      topicRoles: { 2: 'influence', 1: 'marker' },
      topicGoals: { 2: { ...goal, target: 8 }, 1: { ...goal, target: 5 } },
      topicPrefs: { 2: { quickAmount: 8 }, 1: { quickAmount: 5 } },
      topicOrder: [2, 1], quickBar: [2, 1], favorites: [{ topicid: 2 }, { topicid: 1 }],
      dayChecks: { '2024-02-29': 'none', '2024-03-03': 'complete' },
      futureSetting: { x: 99, z: 3 },
    },
    futureTop: { another: true },
  };
  await IO.importMerge(incoming);
  const topics = await DB.getAll('topics');
  const sleep = topics.find((t) => t.name === 'Sleep'), walk = topics.find((t) => t.name === 'Walk');
  assert.ok(sleep.id !== 1 && sleep.id !== 2 && walk.id !== 1 && walk.id !== 2 && sleep.id !== walk.id);
  for (const [key, field, water, sleepValue, walkValue] of [
    ['topicMeta', 'emoji', 'W', 'S', 'K'],
    ['topicGoals', 'target', 2, 8, 5],
    ['topicPrefs', 'quickAmount', 3, 8, 5],
  ]) {
    const map = await DB.getMeta(key);
    assert.equal(map[1][field], water);
    assert.equal(map[sleep.id][field], sleepValue);
    assert.equal(map[walk.id][field], walkValue);
  }
  assert.equal((await DB.getMeta('topicKinds'))[sleep.id], 'duration');
  assert.equal((await DB.getMeta('topicRoles'))[walk.id], 'marker');
  assert.deepEqual(copy(await DB.getMeta('topicOrder')), [1, sleep.id, walk.id]);
  assert.deepEqual(copy(await DB.getMeta('quickBar')), [1, sleep.id, walk.id]);
  assert.deepEqual((await DB.getAll('favorites')).map((f) => f.topicid).sort(), [1, sleep.id, walk.id].sort());
  assert.equal((await DB.getAll('events')).find((e) => e.note === 'sleep').topicid, sleep.id);
  assert.equal((await DB.getAll('events')).find((e) => e.note === 'walk').topicid, walk.id);
  assert.equal((await DB.getMeta('dayChecks'))['2024-02-29'], 'complete');
  assert.deepEqual(copy(await DB.getMeta('extraAppMeta')).futureSetting, { x: 1, y: 2, z: 3 });
  const count = (await DB.getAll('events')).length;
  await IO.importMerge(incoming);
  assert.equal((await DB.getAll('events')).length, count, 'repeated import must dedupe');
  assert.equal((await DB.getAll('topics')).length, 3);
  await Promise.all([
    IO.importMerge({ topics: [topic(7, 'Concurrent')], events: [event(7, 7, 'concurrent')] }),
    IO.importMerge({ topics: [topic(7, 'Concurrent')], events: [event(7, 7, 'concurrent')] }),
  ]);
  assert.equal((await DB.getAll('topics')).filter((t) => t.name === 'Concurrent').length, 1);
  assert.equal((await DB.getAll('events')).filter((e) => e.note === 'concurrent').length, 1);

  const sameName = { topics: [topic(90, 'water')], events: [
    event(99, 90), event(100, 90, 'different note'), event(101, 90, '', 3),
  ], _plotline: { topicKinds: { 90: 'amount' }, topicPrefs: { 90: { quickAmount: 99 } }, quickBar: [90] } };
  await IO.importMerge(sameName);
  await IO.importMerge(sameName);
  assert.equal((await DB.getAll('events')).length, count + 3, 'notes and severity distinguish simultaneous events');
  assert.equal((await DB.getMeta('topicPrefs'))[1].quickAmount, 3, 'matched topic settings must win');
  console.log('PASS collision remaps, settings precedence, stable event dedupe');

  const measurement = { id: 100, name: 'Custom unit', symbol: 'custom', type: 0, format: 0 };
  await IO.importMerge({ topics: [topic(1, 'Custom')], events: [{ ...event(1, 1), msureid: 100 }], measurements: [measurement] });
  const custom = (await DB.getAll('topics')).find((t) => t.name === 'Custom');
  assert.notEqual(custom.msureid, 100);
  assert.equal((await DB.get('measurements', custom.msureid)).symbol, 'custom');
  assert.equal((await DB.getEventsByTopic(custom.id))[0].msureid, custom.msureid);
  const safe = await snapshot();
  await assert.rejects(IO.importMerge({ topics: [topic(1, 'Water')], events: [], measurements: [measurement] }), /measurement or tracking type differs/);
  await assert.rejects(IO.importMerge({ topics: [topic(1, 'Water')], events: [], _plotline: { topicKinds: { 1: 'timeonly' } } }), /tracking type differs/);
  assert.deepEqual(await snapshot(), safe);

  const created = await Promise.all(Array.from({ length: 100 }, (_, i) => DB.create('events', { ...event(1, 1), note: `parallel ${i}` })));
  assert.equal(new Set(created.map((r) => r.id)).size, 100);
  assert.ok(created.every((r) => Number.isSafeInteger(r.id) && r.id > 0));
  assert.equal((await DB.getAll('events')).length, safe.events.length + 100);
  // Force one crypto collision to exercise add's ConstraintError retry.
  const originalRandom = win.crypto.getRandomValues.bind(win.crypto);
  let calls = 0;
  win.crypto.getRandomValues = (words) => {
    if (calls++ === 0) { words[0] = 0; words[1] = 1; return words; }
    return originalRandom(words);
  };
  const retried = await DB.create('events', event(1, 1, 'retry'));
  win.crypto.getRandomValues = originalRandom;
  assert.notEqual(retried.id, 1);
  assert.equal((await DB.get('events', 1)).note, '');
  const candidate = await DB.nextId('events');
  assert.equal(await DB.get('events', candidate), undefined);
  win.crypto.getRandomValues = undefined;
  await assert.rejects(DB.create('topics', { name: 'No insecure fallback' }), /Secure random/);
  win.crypto.getRandomValues = originalRandom;
  console.log('PASS measurement semantics, concurrent insert-only IDs, crypto retry');

  await DB.setMeta('activeTimers', { 1: time, [sleep.id]: time + 1 });
  const beforeDelete = await snapshot();
  const originalDelete = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function (key) {
    const req = originalDelete.call(this, key);
    if (this.name === 'topics') req.addEventListener('success', () => this.transaction.abort(), { once: true });
    return req;
  };
  try { await assert.rejects(DB.deleteTopic(1)); }
  finally { IDBObjectStore.prototype.delete = originalDelete; }
  assert.deepEqual(await snapshot(), beforeDelete, 'aborted topic cascade must roll back every store');
  const deleted = await DB.deleteTopic(1);
  assert.deepEqual(copy(deleted), { topicid: 1, eventsDeleted: beforeDelete.events.filter((e) => e.topicid === 1).length });
  const afterDelete = await snapshot();
  assert.deepEqual(afterDelete.topics, beforeDelete.topics.filter((t) => t.id !== 1));
  assert.deepEqual(afterDelete.events, beforeDelete.events.filter((e) => e.topicid !== 1));
  assert.deepEqual(afterDelete.favorites, beforeDelete.favorites.filter((f) => f.topicid !== 1));
  for (const key of ['topicKinds', 'topicMeta', 'topicRoles', 'topicGoals', 'topicPrefs', 'activeTimers']) {
    const previous = copy(beforeDelete.meta.find((r) => r.key === key).value);
    delete previous[1];
    assert.deepEqual(copy(await DB.getMeta(key)), previous, `${key} cleanup`);
  }
  for (const key of ['topicOrder', 'quickBar']) {
    assert.deepEqual(copy(await DB.getMeta(key)), beforeDelete.meta.find((r) => r.key === key).value.filter((id) => id !== 1));
  }
  assert.deepEqual(afterDelete.meta.filter((r) => DB.DEVICE_META_KEYS.includes(r.key)), beforeDelete.meta.filter((r) => DB.DEVICE_META_KEYS.includes(r.key)));
  assert.deepEqual(copy(await DB.getMeta('dayChecks')), beforeDelete.meta.find((r) => r.key === 'dayChecks').value);
  await assert.rejects(DB.deleteTopic('1'), /safe integer/);
  assert.deepEqual(await snapshot(), afterDelete);
  assert.equal((await DB.deleteTopic(1)).eventsDeleted, 0, 'deletion is idempotent');
  assert.deepEqual(copy(IO.validateBackup(await IO.buildExportObject())), []);

  let downloads = 0;
  win.URL.createObjectURL = () => { downloads++; return 'blob:synthetic'; };
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = () => {};
  await IO.importReplace({ topics: [topic(1, 'No events')], events: [], _plotline: { topicGoals: { 1: goal } } });
  await IO.safetyBackup();
  assert.equal(downloads, 1, 'topic-only dataset must get a safety backup');
  await IO.importReplace({ topics: [], events: [], _plotline: { dayChecks: { '2024-03-01': 'none' } } });
  await IO.safetyBackup();
  assert.equal(downloads, 2, 'settings-only dataset must get a safety backup');
  console.log('PASS atomic topic cascade and safety backups without events');

  // Legacy optional note/cost/quantity and default measurement lookup remain valid.
  await IO.applyBackup({ topics: [topic(1, 'Legacy')], events: [{ id: 1, topicid: 1, time }] });
  assert.equal((await DB.getAll('measurements')).length, win.CWDB_DEFAULT_MEASUREMENTS.length);
  assert.equal(await DB.getMeta('topicGoals'), null, 'replace removes stale dataset settings');
  const otherTimerTopic = await DB.create('topics', { name: 'Parallel timer', msureid: 10 });
  const beforeStart = await snapshot();
  await assert.rejects(DB.startTimer(-123456, time), /missing topic/);
  await assert.rejects(DB.startTimer(1, Infinity), /timestamp/);
  assert.deepEqual(await snapshot(), beforeStart);
  const starts = await Promise.all([
    DB.startTimer(1, time),
    DB.startTimer(1, time + 1000),
    DB.startTimer(otherTimerTopic.id, time + 2000),
  ]);
  assert.deepEqual(starts, [time, null, time + 2000]);
  assert.deepEqual(copy(await DB.getMeta('activeTimers')), { 1: time, [otherTimerTopic.id]: time + 2000 },
    'concurrent starts retain both topics and never reset a running timer');
  assert.equal(await DB.startTimer(1, time + 3000), null);
  assert.equal((await DB.getMeta('activeTimers'))[1], time);
  await DB.setMeta('activeTimers', { 1: time, 2: time + 1 });
  const beforeTimer = await snapshot();
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, ...args) {
    if (this.name === 'meta' && value.key === 'activeTimers') throw new Error('synthetic timer cleanup failure');
    return originalPut.call(this, value, ...args);
  };
  try { await assert.rejects(DB.finishTimer(1, time + 5000), /synthetic timer cleanup failure/); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  assert.deepEqual(await snapshot(), beforeTimer, 'timer cleanup failure rolls back inserted event');
  const stopped = await DB.finishTimer(1, time + 5000);
  assert.equal(stopped.time, time);
  assert.equal(stopped.qant, 5);
  assert.equal(stopped.topicid, 1);
  assert.notEqual(stopped.id, 1);
  assert.deepEqual(copy(await DB.getMeta('activeTimers')), { 2: time + 1 });
  assert.equal((await DB.getAll('events')).length, beforeTimer.events.length + 1);
  assert.equal(await DB.finishTimer(1, time + 10000), null, 'retry after commit is a no-op');
  assert.equal((await DB.getAll('events')).length, beforeTimer.events.length + 1);
  await assert.rejects(DB.finishTimer(2, time + 5000), /missing topic/);
  await DB.setMeta('activeTimers', { 1: time + 1000 });
  await assert.rejects(DB.finishTimer(1, time), /timer start/);
  await DB.setMeta('activeTimers', { 1: time });
  const finishes = await Promise.all([DB.finishTimer(1, time + 6000), DB.finishTimer(1, time + 6000)]);
  assert.equal(finishes.filter(Boolean).length, 1, 'concurrent stops create one event');
  assert.equal((await DB.getAll('events')).length, beforeTimer.events.length + 2);
  assert.deepEqual(copy(await DB.getMeta('activeTimers')), {});
  console.log('PASS atomic timer start/finish, cleanup rollback, retry and concurrent operations');

  await DB.clearAll();
  const cleared = await snapshot();
  for (const [key, rows] of Object.entries(cleared)) if (key !== 'meta') assert.deepEqual(rows, []);
  assert.ok(cleared.meta.every((r) => DB.DEVICE_META_KEYS.includes(r.key)));
  assert.equal(await DB.getMeta('driveClientId'), 'local-device');
  await DB.clearAll({ keepDeviceMeta: false });
  for (const rows of Object.values(await snapshot())) assert.deepEqual(rows, []);
  console.log('PASS legacy defaults, complete atomic reset; all storage smoke tests passed');
}

run().then(() => dom.window.close()).catch((error) => {
  console.error(error);
  dom.window.close();
  process.exitCode = 1;
});
