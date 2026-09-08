#!/usr/bin/env node
/* Offline sync integration checks. No Google account or network is used. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const source = fs.readFileSync(require('path').join(__dirname, 'js/drive.js'), 'utf8');
const ioContext = { window: {}, CWDB: { DEVICE_META_KEYS: [] } };
vm.createContext(ioContext);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, 'js/import-export.js'), 'utf8'), ioContext);
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const backup = (overrides = {}) => ({
  version: 4, topics: [{ id: 1, name: 'Walk', msureid: 1 }], events: [], measurements: [{ id: 1, name: 'count' }],
  pendtimes: [], appdata: [], _plotline: {}, ...overrides,
});
const event = (id, amount = 1) => ({ id, topicid: 1, time: 1000, amount });

function harness(initial = backup(), remote = clone(initial)) {
  const meta = new Map([['driveEnabled', true], ['driveSyncBase', clone(initial)]]);
  const state = { local: clone(initial), remote: clone(remote), revision: 1,
    reads: 0, writes: 0, auth: 0, applies: 0, safety: 0, locks: [], statuses: [] };
  let lockQueue = Promise.resolve();
  const stat = () => state.remote ? {
    id: 'primary', version: String(state.revision), modifiedTime: '2026-01-01T00:00:00Z',
    md5Checksum: String(state.revision),
  } : null;
  const browser = {
    console, setTimeout, clearTimeout, URL, Blob,
    navigator: { onLine: true, locks: { request(name, opts, fn) {
      state.locks.push([name, opts.mode]);
      const result = lockQueue.then(fn); lockQueue = result.catch(() => {}); return result;
    } } },
    document: { visibilityState: 'visible', addEventListener() {}, getElementById() { return null; } },
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts.detail; } },
    window: { CW_CONFIG: { driveClientId: 'test', autoSyncOnChange: true, autoSyncOnStartup: true },
      addEventListener() {}, dispatchEvent(e) { state.statuses.push(e); } },
    CWDB: { async getMeta(key, fallback = null) { return meta.has(key) ? clone(meta.get(key)) : fallback; },
      async setMeta(key, value) { meta.set(key, clone(value)); } },
    CWIO: {
      async buildExportObject() { state.reads++; await state.onBuild?.(); return clone(state.local); },
      validateBackup: ioContext.window.CWIO.validateBackup,
      async safetyBackup() { state.safety++; },
      async checkTimerReplacement() {},
      async importReplace(o) { await state.onApply?.(); state.applies++; state.local = clone(o); },
    },
    hooks: {
      async auth() { state.auth++; await state.onAuth?.(); return 'fake'; },
      async stat() { await state.onStat?.(); return clone(stat()); },
      async read() { await state.onRead?.(); return clone(state.remote); },
      async write(id, obj) {
        state.writes++; state.remote = clone(obj); state.revision++;
        const result = stat();
        await state.onWrite?.();
        return result;
      },
    },
  };
  vm.createContext(browser);
  vm.runInContext(source + `
    window.originalTokenRequest = _requestToken;
    getTokenInteractive = hooks.auth;
    getTokenSilent = hooks.auth;
    findOrCreateFolder = async () => 'folder';
    statSyncFile = hooks.stat;
    readSyncFile = hooks.read;
    updateSyncFile = hooks.write;
    createSyncFile = async (folder, obj) => hooks.write(null, obj);
    rotateVersions = async () => {};
    maybeCleanupLegacyArtifacts = async () => {};
    window.compare = comparableBackup;
  `, browser);
  return { api: browser.window.CWDRIVE, state, meta, browser };
}

const storageWindows = [];
async function storageHarness() {
  const h = harness();
  const dom = new JSDOM('', { url: 'https://sync.test/', runScripts: 'outside-only' });
  storageWindows.push(dom.window);
  dom.window.indexedDB = new IDBFactory();
  dom.window.IDBKeyRange = IDBKeyRange;
  for (const file of ['db.js', 'import-export.js']) {
    dom.window.eval(fs.readFileSync(require('path').join(__dirname, 'js', file), 'utf8'));
  }
  const db = dom.window.CWDB, io = dom.window.CWIO;
  await io.importReplace({ topics: [{ id: 1, name: 'Local duration', msureid: 10, type: 1 }],
    events: [], _plotline: { topicKinds: { 1: 'duration' } } });
  const local = clone(await io.buildExportObject());
  await db.setMeta('driveEnabled', true);
  await db.setMeta('driveSyncBase', local);
  h.state.local = local; h.state.remote = clone(local);
  h.browser.CWDB = db;
  h.browser.CWIO = {
    ...io,
    async buildExportObject() { h.state.reads++; return io.buildExportObject(); },
    async safetyBackup() { h.state.safety++; },
    async importReplace(obj, options) {
      await h.state.onApply?.();
      await io.importReplace(obj, options);
      h.state.applies++;
      h.state.local = clone(await io.buildExportObject());
    },
  };
  return { ...h, db, io };
}

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.error('FAIL  ' + name + '\n' + e.stack); }
  finally { while (storageWindows.length) storageWindows.pop().close(); }
}

(async () => {
  await test('real storage: ordinary metadata/event sync preserves a running timer; restore clears it', async () => {
    const h = await storageHarness();
    await h.db.startTimer(1, 1000);
    h.state.remote._plotline.topicMeta = { 1: { color: '#123456' } };
    h.state.remote.events = [{ id: 2, topicid: 1, time: 2000, qant: 60 }];
    assert.equal((await h.api.syncNow()).changedLocally, true);
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { 1: 1000 });
    assert.equal((await h.db.getAll('events')).length, 1);
    assert.equal((await h.db.getMeta('topicMeta'))[1].color, '#123456');
    assert.equal(h.state.remote._plotline.activeTimers, undefined);
    await h.api.syncDown();
    assert.equal(await h.db.getMeta('activeTimers'), null);
    assert.deepEqual(h.state.locks, [['plotline-data', 'exclusive'], ['plotline-data', 'exclusive']]);
  });
  await test('real storage: colliding duration topics preserve the timer on the moved local topic', async () => {
    const h = await storageHarness();
    const base = clone(h.state.local); base.topics = []; base._plotline.topicKinds = {};
    await h.db.setMeta('driveSyncBase', base);
    await h.db.startTimer(1, 1000);
    h.state.remote.topics[0].name = 'Unrelated remote duration';
    let firstMovedId;
    h.state.onWrite = () => {
      if (h.state.writes === 1) {
        const moved = h.state.remote.topics.find((t) => t.name === 'Local duration');
        firstMovedId = moved.id;
        moved.name = 'Another concurrent remote duration';
        h.state.remote._plotline.dayChecks = { '2026-01-02': 'none' };
        h.state.revision++;
      }
    };
    await h.api.syncNow();
    const moved = (await h.db.getAll('topics')).find((t) => t.name === 'Local duration');
    assert.notEqual(moved.id, 1);
    assert.notEqual(moved.id, firstMovedId, 'successive collisions compose rather than resetting timer provenance');
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { [moved.id]: 1000 });
    assert.equal(h.state.writes, 2, 'identity survives upload verification retries');
    const event = await h.db.finishTimer(moved.id, 6000);
    assert.equal(event.topicid, moved.id);
    assert.equal(event.qant, 5);
  });
  await test('real storage: measurement collisions remap timer units without changing duration semantics', async () => {
    const h = await storageHarness();
    const base = clone(h.state.local);
    base.topics = []; base._plotline.topicKinds = {};
    base.measurements = base.measurements.filter((m) => m.id !== 10);
    await h.db.setMeta('driveSyncBase', base);
    await h.db.startTimer(1, 1000);
    const unit = h.state.remote.measurements.find((m) => m.id === 10);
    unit.name = 'Remote count'; unit.type = 0; unit.format = 0;
    h.state.remote.topics[0].name = 'Remote amount';
    h.state.remote._plotline.topicKinds[1] = 'amount';
    await h.api.syncNow();
    const moved = (await h.db.getAll('topics')).find((t) => t.name === 'Local duration');
    assert.notEqual(moved.id, 1);
    assert.notEqual(moved.msureid, 10);
    assert.equal((await h.db.get('measurements', moved.msureid)).type, 3);
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { [moved.id]: 1000 });
  });
  await test('real storage: collision provenance survives a failed upload and subsequent sync', async () => {
    const h = await storageHarness();
    const base = clone(h.state.local); base.topics = []; base._plotline.topicKinds = {};
    await h.db.setMeta('driveSyncBase', base);
    await h.db.startTimer(1, 1000);
    h.state.remote.topics[0].name = 'Remote duration';
    h.state.onWrite = () => { throw new Error('network interrupted'); };
    await assert.rejects(h.api.syncNow(), /network interrupted/);
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { 1: 1000 });
    h.state.onWrite = null;
    await h.api.syncNow();
    const moved = (await h.db.getAll('topics')).find((t) => t.name === 'Local duration');
    assert.notEqual(moved.id, 1);
    assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { [moved.id]: 1000 });
  });
  await test('real storage: incompatible remote timer kind, unit, format or deletion rejects without data loss', async () => {
    for (const change of [
      (b) => { b._plotline.topicKinds[1] = 'amount'; },
      (b) => { b.topics[0].msureid = 8; },
      (b) => { b.measurements.find((m) => m.id === 10).type = 0; },
      (b) => { b.measurements.find((m) => m.id === 10).format = 7; },
      (b) => { b.topics = []; b._plotline.topicKinds = {}; },
    ]) {
      const h = await storageHarness();
      await h.db.startTimer(1, 1000);
      const before = clone(await h.db.getDataset());
      const base = clone(await h.db.getMeta('driveSyncBase'));
      change(h.state.remote);
      await assert.rejects(h.api.syncNow(), /TIMER_CONFLICT/);
      assert.deepEqual(clone(await h.db.getMeta('activeTimers')), { 1: 1000 });
      assert.deepEqual(clone(await h.db.getAll('topics')), before.topics);
      assert.deepEqual(clone(await h.db.getAll('measurements')), before.measurements);
      assert.deepEqual(clone(await h.db.getMeta('driveSyncBase')), base);
      assert.equal(h.state.writes, 0);
      assert.equal(h.state.applies, 0);
      assert.equal((await h.db.getMeta('drivePendingSnapshot')).status, 'pending');
      assert.equal(h.state.statuses.at(-1).detail.status, 'error');
    }
  });
  await test('metadata-only remote changes are applied atomically', async () => {
    const h = harness();
    h.state.remote._plotline = { topicPrefs: { 1: { quickAmount: 4 } }, dayChecks: { '2026-01-02': 'none' } };
    const result = await h.api.syncNow();
    assert.equal(result.changedLocally, true);
    assert.equal(h.state.applies, 1);
    assert.equal(h.state.local._plotline.topicPrefs[1].quickAmount, 4);
    assert.equal(h.state.local._plotline.dayChecks['2026-01-02'], 'none');
  });
  await test('portable maps merge separate topics, days, and nested fields', async () => {
    const h = harness();
    const b = backup({ _plotline: { topicPrefs: { 1: { quickAmount: 1, aggregation: 'sum' } },
      topicGoals: { 1: { target: 3, paused: false } }, dayChecks: {} } });
    const l = clone(b), r = clone(b);
    l._plotline.topicPrefs[1].quickAmount = 5;
    r._plotline.topicPrefs[1].aggregation = 'mean';
    l._plotline.topicGoals[1].paused = true;
    r._plotline.topicGoals[1].target = 10;
    l._plotline.dayChecks['2026-01-01'] = 'complete';
    r._plotline.dayChecks['2026-01-02'] = 'none';
    const { merged, stats } = h.api.mergeBackups(b, l, r);
    assert.deepEqual(clone(merged._plotline.topicPrefs[1]), { quickAmount: 5, aggregation: 'mean' });
    assert.deepEqual(clone(merged._plotline.topicGoals[1]), { target: 10, paused: true });
    assert.equal(Object.keys(merged._plotline.dayChecks).length, 2);
    assert.equal(stats.conflicts, 0);
  });
  await test('metadata deletion versus unchanged remote is preserved', async () => {
    const h = harness();
    const b = backup({ _plotline: { topicPrefs: { 1: { quickAmount: 1 } } } });
    const l = clone(b); delete l._plotline.topicPrefs[1];
    const { merged } = h.api.mergeBackups(b, l, b);
    assert.equal(merged._plotline.topicPrefs[1], undefined);
  });
  await test('goal histories and pause intervals merge independent revisions', async () => {
    const h = harness();
    const b = backup({ _plotline: { topicGoals: { 1: { target: 3, history: [],
      pauses: [{ from: 1000, to: null }] } } } });
    const l = clone(b), r = clone(b);
    l._plotline.topicGoals[1].history.push({ effectiveFrom: 1000, target: 2 });
    r._plotline.topicGoals[1].history.push({ effectiveFrom: 2000, target: 4 });
    l._plotline.topicGoals[1].pauses[0].to = 1500;
    r._plotline.topicGoals[1].pauses.push({ from: 3000, to: 4000 });
    const { merged } = h.api.mergeBackups(b, l, r);
    assert.equal(merged._plotline.topicGoals[1].history.length, 2);
    assert.deepEqual(clone(merged._plotline.topicGoals[1].pauses),
      [{ from: 1000, to: 1500 }, { from: 3000, to: 4000 }]);
  });
  await test('same-length true remote record conflicts trigger local apply', async () => {
    const b = backup({ events: [event(1)] });
    const h = harness(b);
    h.state.local.events[0].amount = 2;
    h.state.remote.events[0].amount = 3;
    const result = await h.api.syncNow();
    assert.equal(result.stats.conflicts, 1);
    assert.equal(result.stats.resolvedRemote, 1);
    assert.equal(result.changedLocally, true);
    assert.equal(h.state.local.events[0].amount, 3);
  });
  await test('true local conflict wins when local change is newer', async () => {
    const b = backup({ events: [event(1)] });
    const h = harness(b);
    h.meta.set('lastLocalChangeAt', Date.parse('2026-02-01'));
    h.state.local.events[0].amount = 2; h.state.remote.events[0].amount = 3;
    const result = await h.api.syncNow();
    assert.equal(result.stats.resolvedLocal, 1);
    assert.equal(h.state.remote.events[0].amount, 2);
  });
  await test('distinct legacy event additions sharing an id survive', async () => {
    const h = harness();
    h.state.local.events = [event(1, 2)]; h.state.remote.events = [event(1, 3)];
    const result = await h.api.syncNow();
    assert.equal(result.stats.remapped, 1);
    assert.equal(h.state.local.events.length, 2);
    assert.equal(new Set(h.state.local.events.map((v) => v.id)).size, 2);
    assert.ok(h.state.local.events.every((v) => Number.isSafeInteger(v.id)));
    await h.api.syncNow();
    assert.equal(h.state.local.events.length, 2);
  });
  await test('colliding topics remap events, settings, order and favorites', async () => {
    const h = harness(backup({ topics: [] }));
    h.state.local = backup({ topics: [{ id: 1, name: 'Local', msureid: 1 }], events: [event(1)],
      _plotline: { topicPrefs: { 1: { quickAmount: 4 } }, topicGoals: { 1: { target: 5 } },
        topicOrder: [1], quickBar: [1], favorites: [{ topicid: 1 }] } });
    h.state.remote = backup({ topics: [{ id: 1, name: 'Remote', msureid: 1 }], events: [event(1)],
      _plotline: { topicPrefs: { 1: { quickAmount: 8 } }, topicOrder: [1], quickBar: [1] } });
    await h.api.syncNow();
    const localId = h.state.local.topics.find((v) => v.name === 'Local').id;
    assert.notEqual(localId, 1);
    assert.equal(h.state.local.events.length, 2);
    assert.ok(h.state.local.events.some((v) => v.topicid === localId));
    assert.equal(h.state.local._plotline.topicPrefs[localId].quickAmount, 4);
    assert.equal(h.state.local._plotline.topicPrefs[1].quickAmount, 8);
    assert.equal(h.state.local._plotline.topicGoals[localId].target, 5);
    assert.ok(h.state.local._plotline.topicOrder.includes(localId));
    assert.ok(h.state.local._plotline.topicOrder.includes(1));
    assert.ok(h.state.local._plotline.quickBar.includes(localId));
    assert.equal(h.state.local._plotline.favorites[0].topicid, localId);
  });
  await test('measurement and pendtime-only remote changes apply', async () => {
    const h = harness();
    h.state.remote.measurements = [{ id: 1, name: 'cups' }];
    h.state.remote.pendtimes = [{ id: 1, topicid: 1, time: 2000 }];
    const result = await h.api.syncNow();
    assert.equal(result.changedLocally, true);
    assert.equal(h.state.local.measurements.length, 1);
    assert.equal(h.state.local.pendtimes.length, 1);
  });
  await test('colliding measurement and pendtime IDs remap their real schema references', async () => {
    const h = harness(backup({ topics: [], measurements: [] }));
    h.state.local = backup({ topics: [{ id: 1, name: 'Local', msureid: 1, pendtimeid: 1 }],
      measurements: [{ id: 1, name: 'cups' }], pendtimes: [{ id: 1, name: 'local period' }],
      events: [{ ...event(1), msureid: 1 }] });
    h.state.remote = backup({ topics: [{ id: 1, name: 'Remote', msureid: 1, pendtimeid: 1 }],
      measurements: [{ id: 1, name: 'liters' }], pendtimes: [{ id: 1, name: 'remote period' }],
      events: [{ ...event(1), msureid: 1 }] });
    await h.api.syncNow();
    const cups = h.state.local.measurements.find((m) => m.name === 'cups').id;
    const period = h.state.local.pendtimes.find((m) => m.name === 'local period').id;
    const topic = h.state.local.topics.find((t) => t.name === 'Local');
    assert.notEqual(cups, 1); assert.notEqual(period, 1);
    assert.equal(topic.msureid, cups); assert.equal(topic.pendtimeid, period);
    assert.equal(h.state.local.events.find((e) => e.topicid === topic.id).msureid, cups);
  });
  await test('remote addition keeps its locally deleted topic parent', async () => {
    const h = harness();
    h.state.local.topics = [];
    h.state.remote.events = [event(2)];
    const result = await h.api.syncNow();
    assert.equal(h.state.local.events.length, 1);
    assert.equal(h.state.local.topics.length, 1);
    assert.equal(result.stats.retainedReferences, 1);
  });
  await test('topic deletion removes stale metadata references', async () => {
    const b = backup({ _plotline: { topicPrefs: { 1: { quickAmount: 2 } },
      topicOrder: [1], favorites: [{ topicid: 1 }] } });
    const h = harness(b);
    h.state.remote.topics = [];
    h.state.remote._plotline = {};
    await h.api.syncNow();
    assert.equal(h.state.local.topics.length, 0);
    assert.equal(h.state.local._plotline.topicPrefs?.[1], undefined);
    assert.equal(h.state.local._plotline.favorites?.length || 0, 0);
  });
  await test('saveddate changes alone never replace the local database', async () => {
    const h = harness(backup({ saveddate: 'Jan 1, 2026' }));
    h.state.remote.saveddate = 'Jan 2, 2026';
    h.state.remote.saveddatelong = 1500;
    assert.equal((await h.api.syncNow()).changedLocally, false);
    assert.equal(h.state.applies, 0);
  });
  await test('remote change before upload is re-read and merged', async () => {
    const h = harness();
    h.state.local.events = [event(2)];
    let stats = 0;
    h.state.onStat = () => {
      if (++stats === 3) { h.state.remote.events = [event(3)]; h.state.revision++; }
    };
    await h.api.syncNow();
    assert.deepEqual(h.state.remote.events.map((v) => v.id).sort(), [2, 3]);
    assert.equal(h.state.writes, 1);
  });
  await test('remote change after upload retries and verifies content', async () => {
    const h = harness();
    h.state.local.events = [event(2)];
    h.state.onWrite = () => {
      if (h.state.writes === 1) { h.state.remote.events.push(event(3)); h.state.revision++; }
    };
    await h.api.syncNow();
    assert.equal(h.state.writes, 2);
    assert.deepEqual(h.state.remote.events.map((v) => v.id).sort(), [2, 3]);
    assert.equal(h.meta.get('drivePendingSnapshot').status, 'confirmed');
    assert.equal((await h.api.getConnectionState()).recoveryPending, false);
  });
  await test('repeated remote races fail without advancing sync base or local data', async () => {
    const h = harness();
    h.state.local.events = [event(2)];
    h.state.onWrite = () => { h.state.remote.events.push(event(100 + h.state.writes)); h.state.revision++; };
    await assert.rejects(h.api.syncNow(), /REMOTE_CONFLICT/);
    assert.equal(h.state.writes, 3);
    assert.equal(h.state.applies, 0);
    assert.equal(h.meta.has('lastDriveSync'), false);
    assert.ok(h.meta.get('drivePendingSnapshot').snapshot);
  });
  await test('pending recovery retains merged data across a failed sync and later retry', async () => {
    const h = harness();
    h.state.remote.events = [event(3)];
    h.state.onWrite = () => { throw new Error('network interrupted'); };
    await assert.rejects(h.api.syncNow(), /network interrupted/);
    h.state.remote = backup(); h.state.revision++;
    h.state.local.events = [event(2)];
    h.state.onWrite = null;
    await h.api.syncNow();
    assert.deepEqual(h.state.local.events.map((e) => e.id).sort(), [2, 3]);
  });
  await test('confirmed recovery survives a later undetected concurrent overwrite', async () => {
    const h = harness();
    h.state.local.events = [event(2)];
    await h.api.syncNow();
    const originalRecovery = clone(h.meta.get('drivePendingSnapshot').history);
    assert.ok(originalRecovery.some((entry) => entry.snapshot.events.some((e) => e.id === 2)));
    // This arrives after successful readback, outside any client-side check.
    h.state.remote.events = []; h.state.revision++;
    await h.api.syncNow();
    const recovery = h.meta.get('drivePendingSnapshot');
    assert.ok(recovery.history.some((entry) => entry.snapshot.events.some((e) => e.id === 2)));
    assert.deepEqual(recovery.history.find((entry) => entry.snapshot.events.length === 1),
      originalRecovery.find((entry) => entry.snapshot.events.length === 1));
    assert.equal((await h.api.getConnectionState()).recoveryAvailable, true);
    assert.equal((await h.api.getConnectionState()).recoveryPending, false);
  });
  await test('a failed atomic local apply leaves a recovery snapshot and old sync base', async () => {
    const h = harness();
    h.state.remote.events = [event(3)];
    h.state.onApply = () => { throw new Error('transaction aborted'); };
    await assert.rejects(h.api.syncNow(), /transaction aborted/);
    assert.equal(h.state.local.events.length, 0);
    assert.equal(h.meta.get('driveSyncBase').events.length, 0);
    assert.ok(h.meta.get('drivePendingSnapshot'));
  });
  await test('syncNow and syncDown use one serial queue and shared exclusive lock', async () => {
    const h = harness();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    h.state.onBuild = () => gate;
    const a = h.api.syncNow(), b = h.api.syncDown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.state.auth, 1);
    assert.equal(h.state.reads, 1);
    assert.equal((await h.api.getConnectionState()).pending, true);
    release(); await Promise.all([a, b]);
    assert.deepEqual(h.state.locks, [['plotline-data', 'exclusive'], ['plotline-data', 'exclusive']]);
    assert.equal(h.state.auth, 2);
  });
  await test('queue fallback works without navigator.locks', async () => {
    const h = harness(); delete h.browser.navigator.locks;
    await Promise.all([h.api.syncNow(), h.api.syncNow()]);
    assert.equal(h.state.writes, 2);
  });
  await test('fallback data lock also serializes model mutations with sync snapshots', async () => {
    const h = harness(); delete h.browser.navigator.locks;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const edit = h.api.withDataLock(async () => {
      await gate;
      h.state.local.events.push(event(3));
    });
    const sync = h.api.syncNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.state.reads, 0);
    release(); await Promise.all([edit, sync]);
    assert.equal(h.state.remote.events[0].id, 3);
  });
  await test('OAuth happens before acquiring the data lock', async () => {
    const h = harness();
    h.state.onAuth = () => { assert.equal(h.state.locks.length, 0); };
    await h.api.syncNow({ interactive: true });
  });
  await test('fresh devices with bundled client ID do not authorize automatically', async () => {
    const h = harness(); h.meta.delete('driveEnabled');
    await h.api.startupSync(); await h.api.queueAutoSync('online');
    await assert.rejects(h.api.syncNow(), /DISCONNECTED/);
    assert.equal(h.state.auth, 0);
    assert.equal((await h.api.getConnectionState()).enabled, false);
    await h.api.syncNow({ interactive: true });
    assert.equal(h.meta.get('driveEnabled'), true);
  });
  await test('existing lastDriveSync enables migration but explicit false wins', async () => {
    const h = harness(); h.meta.delete('driveEnabled'); h.meta.set('lastDriveSync', 1);
    assert.equal((await h.api.getConnectionState()).enabled, true);
    h.meta.set('driveEnabled', false);
    assert.equal((await h.api.getConnectionState()).enabled, false);
  });
  await test('disconnect disables timers and auth without deleting remote or configuration', async () => {
    const h = harness(); h.meta.set('driveClientId', 'custom');
    await h.api.queueAutoSync(); await h.api.disconnect();
    await h.api.startupSync(); await h.api.queueAutoSync('connection');
    assert.equal(h.meta.get('driveClientId'), 'custom');
    assert.equal(h.meta.get('driveEnabled'), false);
    assert.equal(h.state.auth, 0);
    assert.equal(h.state.writes, 0);
  });
  await test('disconnect cancels an in-flight session before it can write', async () => {
    const h = harness();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    h.state.onAuth = () => gate;
    const sync = h.api.syncNow();
    const rejected = assert.rejects(sync, /DISCONNECTED/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const disconnect = h.api.disconnect();
    release(); await Promise.all([rejected, disconnect]);
    assert.equal(h.state.writes, 0);
    assert.equal((await h.api.getConnectionState()).enabled, false);
  });
  await test('disconnect drains accepted writes and rejects queued sync before local reset', async () => {
    const h = harness();
    h.state.local.events = [event(2)];
    let release, written;
    const gate = new Promise((resolve) => { release = resolve; });
    const writeStarted = new Promise((resolve) => { written = resolve; });
    h.state.onWrite = async () => { written(); await gate; };
    const active = assert.rejects(h.api.syncNow(), /DISCONNECTED/);
    const queued = assert.rejects(h.api.syncNow(), /DISCONNECTED/);
    await writeStarted;
    let drained = false;
    const disconnect = h.api.disconnect().then(() => { drained = true; });
    await assert.rejects(h.api.syncNow(), /DISCONNECTED/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(drained, false, 'disconnect returned while a write was still accepted/in flight');
    release();
    await Promise.all([active, queued, disconnect]);
    const writesBeforeReset = h.state.writes;
    await h.api.withDataLock(async () => {
      h.state.local = backup({ topics: [], events: [] });
      h.meta.clear();
      h.meta.set('driveEnabled', false);
    });
    await h.api.queueAutoSync('change');
    await h.api.queueAutoSync('online');
    await h.api.startupSync();
    await assert.rejects(h.api.syncNow(), /DISCONNECTED/);
    assert.equal(h.state.writes, writesBeforeReset);
    assert.equal(h.state.remote.events[0].id, 2);
  });
  await test('interactive onboarding restore works on an empty disconnected database', async () => {
    const h = harness(backup({ topics: [] }), backup({ events: [event(7)] }));
    h.meta.clear();
    await h.api.syncDown({ interactive: true });
    assert.equal(h.state.local.events[0].id, 7);
    assert.equal(h.state.writes, 0);
    assert.equal(h.meta.get('driveEnabled'), true);
  });
  await test('network retries do not change local conflict timestamps', async () => {
    const h = harness(); h.meta.set('driveEnabled', false);
    h.meta.set('lastLocalChangeAt', 1234);
    await h.api.queueAutoSync('online'); await h.api.queueAutoSync('connection');
    assert.equal(h.meta.get('lastLocalChangeAt'), 1234);
    await h.api.queueAutoSync('change');
    assert.ok(h.meta.get('lastLocalChangeAt') > 1234);
    h.meta.set('lastLocalChangeAt', 1234);
    await h.api.queueAutoSync('saveGoal');
    assert.ok(h.meta.get('lastLocalChangeAt') > 1234);
  });
  await test('background OAuth visibility guard remains intact', async () => {
    const h = harness(); h.browser.document.visibilityState = 'hidden';
    await assert.rejects(h.browser.window.originalTokenRequest(false), /BACKGROUNDED/);
    assert.equal(h.state.auth, 0);
  });
  await test('OAuth rechecks foreground visibility after loading GIS', async () => {
    const h = harness();
    vm.runInContext(`ensureGis = async () => { document.visibilityState = 'hidden'; };`, h.browser);
    await assert.rejects(h.browser.window.originalTokenRequest(false), /BACKGROUNDED/);
  });
  await test('every OAuth failure rejects its own request instead of hanging the queue', async () => {
    const h = harness();
    let initialized = 0;
    h.browser.google = { accounts: { oauth2: { initTokenClient(options) {
      initialized++;
      return { requestAccessToken() { options.error_callback({ type: 'popup_closed' }); } };
    } } } };
    vm.runInContext('ensureGis = async () => {};', h.browser);
    await assert.rejects(h.browser.window.originalTokenRequest(true), /popup_closed/);
    await assert.rejects(h.browser.window.originalTokenRequest(true), /popup_closed/);
    assert.equal(initialized, 2);
  });
  await test('status event dispatch does not require a header pill', async () => {
    const h = harness(); await h.api.syncNow();
    assert.ok(h.state.statuses.some((e) => e.type === 'plotline:sync-status' && e.detail.status === 'ok'));
  });
  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exitCode = failures ? 1 : 0;
})();
