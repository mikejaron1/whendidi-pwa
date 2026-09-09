/* Plotline - IndexedDB wrapper
 * Stores topics, events, measurements, pendtimes, appdata, meta.
 * All data lives on-device; no network required.
 */

/* NOTE: DB_NAME is deliberately still 'whendidi'. It predates both rebrands
 * (WhenDidI -> CountWhen -> Plotline) and is the physical IndexedDB name on
 * every existing install — renaming it would orphan all local data. Do not
 * change it. */
const DB_NAME = 'whendidi';
const DB_VERSION = 1;

const STORES = {
  topics: 'id',
  events: 'id',
  measurements: 'id',
  pendtimes: 'id',
  appdata: 'name',
  meta: 'key',
  favorites: 'topicid',
};

const DEFAULT_MEASUREMENTS = [
  { id: 10, name: 'Duration',       symbol: 'hh:mm',    type: 3, format: 5 },
  { id: 11, name: 'Duration Short', symbol: 'mm:ss',    type: 3, format: 7 },
  { id: 12, name: 'Elapsed',        symbol: 'hh:mm:ss', type: 3, format: 6 },
  { id: 2,  name: 'gallons',        symbol: 'gal',      type: 0, format: 0 },
  { id: 9,  name: 'hours',          symbol: 'hrs',      type: 3, format: 4 },
  { id: 4,  name: 'kilograms',      symbol: 'kg',       type: 0, format: 0 },
  { id: 5,  name: 'kilometres',     symbol: 'km',       type: 0, format: 0 },
  { id: 1,  name: 'litres',         symbol: 'l',        type: 0, format: 0 },
  { id: 6,  name: 'metres',         symbol: 'm',        type: 0, format: 0 },
  { id: 3,  name: 'miles',          symbol: 'm',        type: 0, format: 0 },
  { id: 8,  name: 'minutes',        symbol: 'mins',     type: 3, format: 3 },
  { id: 7,  name: 'seconds',        symbol: 's',        type: 3, format: 2 },
  { id: 100, name: 'count',         symbol: '',         type: 0, format: 0 },
  { id: 101, name: 'ounces',        symbol: 'oz',       type: 0, format: 0 },
  { id: 102, name: 'pounds',        symbol: 'lb',       type: 0, format: 0 },
  { id: 103, name: 'grams',         symbol: 'g',        type: 0, format: 0 },
];

const DEFAULT_PENDTIMES = [
  { id: 5, title: 'Early Morning', endtime: 900 },
  { id: 6, title: 'Lunch Time',    endtime: 1200 },
  { id: 7, title: 'Evening',       endtime: 1800 },
  { id: 8, title: 'Night',         endtime: 2200 },
];

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath });
          if (name === 'events') {
            store.createIndex('topicid', 'topicid', { unique: false });
            store.createIndex('time', 'time', { unique: false });
          }
          if (name === 'topics') {
            store.createIndex('name', 'name', { unique: false });
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(storeNames, mode = 'readonly') {
  return openDB().then((db) => {
    const t = db.transaction(storeNames, mode);
    const stores = Array.isArray(storeNames)
      ? Object.fromEntries(storeNames.map((n) => [n, t.objectStore(n)]))
      : t.objectStore(storeNames);
    return { t, stores };
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* Meta keys that belong to *this device*, not to the data set. They survive
 * a replace-import so a Drive restore doesn't disconnect Drive. */
const DEVICE_META_KEYS = [
  'driveClientId', 'driveSyncBase', 'driveRemoteMeta',
  'driveLegacyCleanupAt', 'driveLegacyCleanupDone',
  'lastDriveSync', 'lastLocalChangeAt', 'lastFlareAlert', 'onboarded',
  'driveEnabled', 'deviceId', 'syncDeviceId', 'syncCounter',
  'driveFolderId', 'drivePendingSnapshot', 'dataRevision',
];

function normalizeInsightSettings(settings) {
  // v6 used "flare" for the alert-only threshold; the meaning is unchanged.
  return { ...settings, ...(settings.alertOn === 'flare' ? { alertOn: 'alert' } : {}) };
}

function randomId() {
  if (!window.crypto?.getRandomValues) throw new Error('Secure random IDs require crypto.getRandomValues.');
  const words = new Uint32Array(2);
  let id;
  do {
    window.crypto.getRandomValues(words);
    id = (words[0] & 0x1fffff) * 0x100000000 + words[1];
  } while (!id);
  return id;
}

function transactionDone(t, value) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(typeof value === 'function' ? value() : value);
    t.onerror = () => reject(t.error || new Error('Database transaction failed.'));
    t.onabort = () => reject(t.error || new Error('Database transaction aborted.'));
  });
}

/* Sync supplies provenance from its merge, never IDs guessed from the new
 * dataset. Check again inside replacement's transaction, before any clears. */
function timersForReplacement(current, replacement, { topicIdMap, measurementIdMap } = {}) {
  const row = current.meta.find((r) => r.key === 'activeTimers');
  if (!row) return null;
  const conflict = (detail) => {
    throw new Error(`TIMER_CONFLICT: ${detail} Finish or cancel the local timer before syncing.`);
  };
  if (!row.value || typeof row.value !== 'object' || Array.isArray(row.value)) conflict('Invalid active timer metadata.');
  const oldTopics = new Map(current.topics.map((r) => [r.id, r]));
  const newTopics = new Map(replacement.topics.map((r) => [r.id, r]));
  const oldUnits = new Map(current.measurements.map((r) => [r.id, r]));
  const newUnits = new Map(replacement.measurements.map((r) => [r.id, r]));
  const oldKinds = current.meta.find((r) => r.key === 'topicKinds')?.value || {};
  const newKinds = replacement.meta.find((r) => r.key === 'topicKinds')?.value || {};
  const mapped = (map, id) => map && Object.hasOwn(map, id) ? map[id] : undefined;
  const timers = {};
  for (const [key, start] of Object.entries(row.value)) {
    const id = Number(key), nextId = mapped(topicIdMap, id);
    const oldTopic = oldTopics.get(id), newTopic = newTopics.get(nextId);
    if (!Number.isSafeInteger(id) || String(id) !== key ||
        !Number.isSafeInteger(start) || Math.abs(start) > 8640000000000000) conflict('Invalid timer start or topic ID.');
    if (!oldTopic || !Number.isSafeInteger(nextId) || !newTopic || Object.hasOwn(timers, nextId)) {
      conflict(`The topic for timer ${key} was deleted or its identity is uncertain.`);
    }
    const oldUnit = oldUnits.get(oldTopic.msureid), newUnit = newUnits.get(newTopic.msureid);
    const oldKind = oldKinds[id] || (oldUnit?.type === 3 ? 'duration' : 'amount');
    const newKind = newKinds[nextId] || (newUnit?.type === 3 ? 'duration' : 'amount');
    if (oldKind !== 'duration' || newKind !== 'duration' ||
        oldUnit?.type !== 3 || newUnit?.type !== 3 ||
        mapped(measurementIdMap, oldTopic.msureid) !== newTopic.msureid ||
        oldUnit.format !== newUnit.format || oldTopic.type !== newTopic.type) {
      conflict(`The type or unit of "${oldTopic.name}" changed incompatibly.`);
    }
    timers[nextId] = start;
  }
  return { ...row, value: timers };
}

/* The builder is synchronous: it receives a consistent snapshot under the
 * write lock and returns ALL stores. No writes happen until preparation ends.
 * Never await inside the builder. Any exception/failed add rolls back all stores. */
async function datasetTransaction(builder, { keepDeviceMeta = true, readonly = false } = {}) {
  const connection = await openDB();
  return new Promise((resolve, reject) => {
    const names = Object.keys(STORES);
    const t = connection.transaction(names, readonly ? 'readonly' : 'readwrite');
    const snapshot = {};
    let pending = names.length, result, failure;
    t.oncomplete = () => resolve(result);
    t.onerror = () => { failure = failure || t.error; };
    t.onabort = () => reject(failure || t.error || new Error('Dataset transaction aborted.'));
    for (const name of names) {
      const req = t.objectStore(name).getAll();
      req.onsuccess = () => {
        snapshot[name] = req.result;
        if (--pending) return;
        try {
          if (readonly) { result = snapshot; return; }
          const device = keepDeviceMeta ? snapshot.meta.filter((r) => DEVICE_META_KEYS.includes(r.key)) : [];
          result = builder(snapshot);
          if (!result || typeof result.then === 'function') throw new Error('Dataset builder must return synchronously.');
          for (const key of names) {
            if (!Array.isArray(result[key])) throw new Error(`Missing dataset store: ${key}`);
          }
          result.meta = result.meta.filter((r) => !DEVICE_META_KEYS.includes(r.key)).concat(device);
          for (const key of names) {
            const store = t.objectStore(key);
            store.clear();
            for (const record of result[key]) store.add(record);
          }
        } catch (error) {
          failure = error;
          t.abort();
        }
      };
    }
  });
}

const db = {
  DEVICE_META_KEYS,
  randomId,
  getDataset() { return datasetTransaction(null, { readonly: true }); },
  updateDataset: datasetTransaction,
  replaceDataset(dataset, options = {}) {
    return datasetTransaction((current) => {
      const timer = options.preserveActiveTimers ? timersForReplacement(current, dataset, options) : null;
      const replacement = { ...dataset, meta: dataset.meta.filter((r) => r.key !== 'activeTimers') };
      if (timer) replacement.meta.push(timer);
      return replacement;
    }, options);
  },
  async checkTimerReplacement(dataset, options) {
    timersForReplacement(await this.getDataset(), dataset, options);
  },

  /* Insert-only allocation. Unlike nextId + put, concurrent writers can
   * never replace an existing record. Returns the committed record. */
  async create(store, fields) {
    if (STORES[store] !== 'id') throw new Error('create requires an id-keyed store.');
    const { t, stores } = await tx(store, 'readwrite');
    let record;
    const done = transactionDone(t, () => record);
    const attempt = () => {
      record = { ...fields, id: randomId() };
      const req = stores.add(record);
      req.onerror = (event) => {
        if (req.error?.name !== 'ConstraintError') return;
        event.preventDefault();
        event.stopPropagation();
        attempt();
      };
    };
    try { attempt(); } catch (error) { t.abort(); await done.catch(() => {}); throw error; }
    return done;
  },

  async getAll(store) {
    const { stores } = await tx(store);
    return reqToPromise(stores.getAll());
  },

  async get(store, key) {
    const { stores } = await tx(store);
    return reqToPromise(stores.get(key));
  },

  async put(store, value) {
    const { t, stores } = await tx(store, 'readwrite');
    const done = transactionDone(t, value);
    try { stores.put(value); } catch (error) { t.abort(); await done.catch(() => {}); throw error; }
    return done;
  },

  async putMany(store, values) {
    if (!values.length) return 0;
    const { t, stores } = await tx(store, 'readwrite');
    const done = transactionDone(t, values.length);
    try { for (const v of values) stores.put(v); } catch (error) { t.abort(); await done.catch(() => {}); throw error; }
    return done;
  },

  async delete(store, key) {
    const { t, stores } = await tx(store, 'readwrite');
    stores.delete(key);
    return transactionDone(t);
  },

  /* Deletes topic history and every known topic-keyed setting atomically.
   * Leaves unrelated topics, day-level checks and device/sync state untouched.
   * Returns { topicid, eventsDeleted } only after commit. Caller owns revisions. */
  async deleteTopic(topicid) {
    if (!Number.isSafeInteger(topicid)) throw new Error('deleteTopic requires a safe integer topic ID.');
    const { t, stores } = await tx(['topics', 'events', 'favorites', 'meta'], 'readwrite');
    const result = { topicid, eventsDeleted: 0 };
    const done = transactionDone(t, result);
    try {
      stores.topics.delete(topicid);
      stores.favorites.delete(topicid);
      const events = stores.events.index('topicid').openCursor(IDBKeyRange.only(topicid));
      events.onsuccess = () => {
        const cursor = events.result;
        if (!cursor) return;
        cursor.delete();
        result.eventsDeleted++;
        cursor.continue();
      };
      const maps = ['topicKinds', 'topicMeta', 'topicRoles', 'topicGoals', 'topicPrefs', 'activeTimers'];
      for (const key of [...maps, 'topicOrder', 'quickBar']) {
        const req = stores.meta.get(key);
        req.onsuccess = () => {
          const row = req.result;
          if (!row) return;
          if (maps.includes(key)) {
            if (!row.value || typeof row.value !== 'object' || Array.isArray(row.value)) return;
            const value = { ...row.value };
            delete value[topicid];
            stores.meta.put({ ...row, value });
          } else if (Array.isArray(row.value)) {
            stores.meta.put({ ...row, value: row.value.filter((id) => id !== topicid) });
          }
        };
      }
    } catch (error) {
      t.abort();
      await done.catch(() => {});
      throw error;
    }
    return done;
  },

  /* Start without replacing another tab's timer or losing other topics'
   * starts. Returns the committed start timestamp, or null if already running.
   * Like finishTimer, callers own revisions and any shared Web Lock. */
  async startTimer(topicid, now = Date.now()) {
    if (!Number.isSafeInteger(topicid) || !Number.isSafeInteger(now) || Math.abs(now) > 8640000000000000) {
      throw new Error('startTimer requires a safe topic ID and timestamp.');
    }
    const { t, stores } = await tx(['topics', 'meta'], 'readwrite');
    let started = null, failure, pending = 2;
    const done = transactionDone(t, () => started);
    const topicReq = stores.topics.get(topicid);
    const timerReq = stores.meta.get('activeTimers');
    const ready = () => {
      if (--pending) return;
      try {
        if (!topicReq.result) throw new Error('Cannot start a timer for a missing topic.');
        const row = timerReq.result;
        const timers = row ? row.value : {};
        if (!timers || typeof timers !== 'object' || Array.isArray(timers)) throw new Error('Invalid active timer metadata.');
        if (Object.hasOwn(timers, topicid)) return;
        stores.meta.put({ key: 'activeTimers', value: { ...timers, [topicid]: now } });
        started = now;
      } catch (error) {
        failure = error;
        t.abort();
      }
    };
    topicReq.onsuccess = ready;
    timerReq.onsuccess = ready;
    return done.catch((error) => { throw failure || error; });
  },

  /* Finish a timer exactly once: event insertion and timer removal commit
   * together. Returns the event, or null when already stopped/not running.
   * Caller owns the data lock and revision; this method takes no Web Lock. */
  async finishTimer(topicid, now = Date.now()) {
    const validTime = (value) => Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000;
    if (!Number.isSafeInteger(topicid) || !validTime(now)) throw new Error('finishTimer requires a safe topic ID and timestamp.');
    const { t, stores } = await tx(['topics', 'events', 'meta'], 'readwrite');
    let created = null, failure, pending = 2;
    const done = transactionDone(t, () => created);
    const abort = (error) => { failure = error; t.abort(); };
    const topicReq = stores.topics.get(topicid);
    const timerReq = stores.meta.get('activeTimers');
    const ready = () => {
      if (--pending) return;
      try {
        const row = timerReq.result;
        if (!row) return;
        if (!row.value || typeof row.value !== 'object' || Array.isArray(row.value)) throw new Error('Invalid active timer metadata.');
        if (!Object.hasOwn(row.value, topicid)) return;
        if (!topicReq.result) throw new Error('Cannot finish a timer for a missing topic.');
        const start = row.value[topicid];
        if (!validTime(start) || start > now) throw new Error('Invalid timer start; check the device clock.');
        const timers = { ...row.value };
        delete timers[topicid];
        const attempt = () => {
          try {
            created = {
              id: randomId(), topicid, time: start,
              qant: Math.max(1, Math.round((now - start) / 1000)), cost: 0, note: '',
            };
            const request = stores.events.add(created);
            request.onerror = (event) => {
              if (request.error?.name !== 'ConstraintError') return;
              event.preventDefault();
              event.stopPropagation();
              attempt();
            };
            request.onsuccess = () => {
              try { stores.meta.put({ ...row, value: timers }); }
              catch (error) { abort(error); }
            };
          } catch (error) { abort(error); }
        };
        attempt();
      } catch (error) { abort(error); }
    };
    topicReq.onsuccess = ready;
    timerReq.onsuccess = ready;
    return done.catch((error) => { throw failure || error; });
  },

  async clear(store) {
    const { t, stores } = await tx(store, 'readwrite');
    stores.clear();
    return transactionDone(t);
  },

  /**
   * Wipe every store, ready for a replace-style import.
   *
   * Device-local meta (which Drive account we talk to, where we are in the
   * sync conversation) is read and preserved in the SAME transaction.
   * activeTimers are intentionally cleared, not restored across datasets.
   */
  async clearAll({ keepDeviceMeta = true } = {}) {
    return this.replaceDataset(Object.fromEntries(Object.keys(STORES).map((name) => [name, []])), { keepDeviceMeta });
  },

  async getEventsByTopic(topicid) {
    const { stores } = await tx('events');
    const idx = stores.index('topicid');
    return reqToPromise(idx.getAll(topicid));
  },

  async getEventsBetween(start, end) {
    const { stores } = await tx('events');
    const idx = stores.index('time');
    const range = IDBKeyRange.bound(start, end);
    return reqToPromise(idx.getAll(range));
  },

  async getEventsSorted({ desc = true, limit = null } = {}) {
    const { stores } = await tx('events');
    const idx = stores.index('time');
    return new Promise((resolve, reject) => {
      const results = [];
      const cursorReq = idx.openCursor(null, desc ? 'prev' : 'next');
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return resolve(results);
        results.push(cursor.value);
        if (limit && results.length >= limit) return resolve(results);
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  },

  async getLastEventForTopic(topicid) {
    const events = await this.getEventsByTopic(topicid);
    if (!events.length) return null;
    let best = events[0];
    for (const e of events) if (e.time > best.time) best = e;
    return best;
  },

  async nextId(store) {
    if (STORES[store] !== 'id') throw new Error('nextId requires an id-keyed store.');
    let id;
    do { id = randomId(); } while (await this.get(store, id));
    return id; // Legacy candidate only; new callers must use create().
  },

  async getMeta(key, fallback = null) {
    const r = await this.get('meta', key);
    return r ? r.value : fallback;
  },

  async setMeta(key, value) {
    return this.put('meta', { key, value });
  },

  async isFavorite(topicid) {
    return !!(await this.get('favorites', topicid));
  },

  async setFavorite(topicid, on) {
    if (on) await this.put('favorites', { topicid, added: Date.now() });
    else await this.delete('favorites', topicid);
  },

  async getFavoriteTopicIds() {
    const all = await this.getAll('favorites');
    return all.map((f) => f.topicid);
  },

  /* Topic kinds: portable metadata under the backup's _plotline namespace.
   *   'timeonly' — log a timestamp; qant defaults to 60, no input shown
   *   'duration' — log a hh:mm duration (msureid 10/11/12)
   *   'amount'   — log a numeric amount in the topic's measurement unit
   */
  async getTopicKind(topicId) {
    const map = (await this.getMeta('topicKinds')) || {};
    return map[topicId] || null;
  },

  async setTopicKind(topicId, kind) {
    const map = (await this.getMeta('topicKinds')) || {};
    if (kind == null) delete map[topicId];
    else map[topicId] = kind;
    await this.setMeta('topicKinds', map);
  },

  async getAllTopicKinds() {
    return (await this.getMeta('topicKinds')) || {};
  },

  /* Portable topic visual metadata (emoji + color). */
  async getTopicMeta(topicId) {
    const map = (await this.getMeta('topicMeta')) || {};
    return map[topicId] || null;
  },

  async setTopicMeta(topicId, meta) {
    const map = (await this.getMeta('topicMeta')) || {};
    if (meta == null) delete map[topicId];
    else map[topicId] = meta;
    await this.setMeta('topicMeta', map);
  },

  async getAllTopicMeta() {
    return (await this.getMeta('topicMeta')) || {};
  },

  /* Quick-access bar: a fixed, user-curated, ordered list of topic ids
   * shown as one-tap chips at the top of the Categories view. When empty,
   * the app falls back to auto-showing the most frequent recent topics. */
  async getQuickBar() {
    const ids = await this.getMeta('quickBar');
    return Array.isArray(ids) ? ids : [];
  },

  async setQuickBar(ids) {
    await this.setMeta('quickBar', Array.isArray(ids) ? ids : []);
  },

  /* Insight topic roles: maps a topic id to { role, dir, timing } where role
   * is focus / marker / influence. Legacy installs may still hold plain role
   * strings; insights.js migrates those on read. Included in backups. */
  async getTopicRoles() {
    return (await this.getMeta('topicRoles')) || {};
  },

  async setTopicRole(topicId, role) {
    const map = (await this.getMeta('topicRoles')) || {};
    if (role == null || role === '') delete map[topicId];
    else map[topicId] = role;
    await this.setMeta('topicRoles', map);
    return map;
  },

  async setTopicRoles(map) {
    await this.setMeta('topicRoles', map || {});
  },

  /* Per-topic goals: maps a topic id to { metric, cmp, target, period, since }.
   * Drives the streak display. Malformed records are filtered out on read by
   * goals.js. Included in backups. */
  async getTopicGoals() {
    return (await this.getMeta('topicGoals')) || {};
  },

  async setTopicGoal(topicId, goal) {
    const map = (await this.getMeta('topicGoals')) || {};
    if (goal == null) delete map[topicId];
    else map[topicId] = goal;
    await this.setMeta('topicGoals', map);
    return map;
  },

  async setTopicGoals(map) {
    await this.setMeta('topicGoals', map || {});
  },

  /* Insight / alert settings. */
  normalizeInsightSettings,

  async getInsightSettings() {
    const s = (await this.getMeta('insightSettings')) || {};
    return normalizeInsightSettings({
      cutoffHour: 4,          // logical day rolls over at 4am
      windowDays: 7,          // "current" window for status detection
      insightWindow: 90,      // lookback for narrative insights
      alertsEnabled: false,
      alertOn: 'alert',       // 'alert' | 'watch'
      nightStart: 22,         // overnight window start hour
      nightEnd: 6,            // overnight window end hour
      alertCooldownHours: 20,
      lastAlertAt: 0,
      lastAlertLevel: '',
      ...s,
    });
  },

  async setInsightSettings(patch) {
    const cur = await this.getInsightSettings();
    const next = normalizeInsightSettings({ ...cur, ...patch });
    await this.setMeta('insightSettings', next);
    return next;
  },

  async seedDefaults() {
    // Pendtimes: seed if empty
    const pt = await this.getAll('pendtimes');
    if (!pt.length) await this.putMany('pendtimes', DEFAULT_PENDTIMES);
    // Measurements: ADD any that aren't already present (so existing
    // installs gain newly-added ones like pounds/grams on upgrade).
    const existing = await this.getAll('measurements');
    const haveIds = new Set(existing.map((m) => m.id));
    const missing = DEFAULT_MEASUREMENTS.filter((m) => !haveIds.has(m.id));
    if (missing.length) await this.putMany('measurements', missing);
  },
};

window.CWDB = db;
window.CWDB_DEFAULT_MEASUREMENTS = DEFAULT_MEASUREMENTS;
window.CWDB_DEFAULT_PENDTIMES = DEFAULT_PENDTIMES;
