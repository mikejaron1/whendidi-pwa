/* Plotline - Import / Export
 * Round-trips the shared JSON backup schema byte-compatibly, so backups
 * written by older trackers using the same schema import without loss.
 */

const REQUIRED_KEYS = ['topics', 'events'];

/* Top-level key holding Plotline's own settings, plus every name it used
 * before, oldest last. Backup files outlive installs, so all of them stay
 * readable; only the current key is ever written. */
const APP_META_TOP_KEY = '_plotline';
const LEGACY_APP_META_TOP_KEYS = ['_countwhen', '_wdapp'];

const readAppMeta = (obj) => {
  const app = [APP_META_TOP_KEY, ...LEGACY_APP_META_TOP_KEYS].reduce((app, key) => existingWins(app, obj?.[key] || {}), {});
  if (app.insightSettings != null) app.insightSettings = CWDB.normalizeInsightSettings(app.insightSettings);
  return app;
};

const KNOWN_TOP_KEYS = new Set([
  'version', 'saveddatelong', 'saveddate', 'eventcount', 'topiccount',
  'measurements', 'pendtimes', 'topics', 'events', 'appdata',
  APP_META_TOP_KEY, ...LEGACY_APP_META_TOP_KEYS,
]);

/* In-app settings that live in the `meta` store rather than in the shared
 * backup schema. They ride along in a single extra top-level key so a Drive
 * round-trip (or a manual export/import) keeps topic colors, kinds, roles and
 * the quick-access bar. Readers that don't know the key ignore it. */
const APP_META_KEYS = [
  'topicKinds', 'topicMeta', 'topicOrder', 'quickBar',
  'topicRoles', 'insightSettings', 'topicGoals', 'topicPrefs', 'dayChecks',
];

/* Schema 1 adds portable goals, topicPrefs {quickAmount, aggregation:
 * sum|mean|latest, trackingStart: epoch ms}, and dayChecks
 * {YYYY-MM-DD: complete|none|incomplete}. Unknown JSON fields and newer
 * positive schema versions survive; known fields still require safe shapes.
 * Runtime/device metadata never travels, even inside legacy namespaces. */
const BACKUP_SCHEMA_VERSION = 1;
const TOPIC_MAP_KEYS = ['topicKinds', 'topicMeta', 'topicRoles', 'topicGoals', 'topicPrefs'];
const LOCAL_META_KEYS = new Set([
  ...CWDB.DEVICE_META_KEYS, 'activeTimers', 'lastImport', 'lastExport',
  'lastAlertAt', 'lastAlertLevel', 'originalVersion', 'extraTopKeys', 'extraAppMeta',
  'identity', 'counters', 'syncState', 'localState', 'deviceIdentity',
  'deviceCounter', 'changeCounter', 'syncMetadata', 'syncTombstones',
  'accessToken', 'refreshToken', 'idToken',
]);
const isLocalKey = (key) => LOCAL_META_KEYS.has(key);
const portable = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([key]) => !isLocalKey(key)));

async function buildAppMeta(dataset) {
  const records = dataset ? dataset.meta : await CWDB.getAll('meta');
  const meta = Object.fromEntries(records.map((r) => [r.key, r.value]));
  const out = { ...portable(meta.extraAppMeta), backupSchemaVersion: meta.backupSchemaVersion ?? BACKUP_SCHEMA_VERSION };
  for (const k of APP_META_KEYS) {
    const v = meta[k];
    if (v != null) out[k] = k === 'insightSettings' ? portable(CWDB.normalizeInsightSettings(v)) : v;
  }
  const favs = dataset ? dataset.favorites : await CWDB.getAll('favorites');
  if (favs.length) out.favorites = favs;
  return out;
}

async function applyAppMeta(app) {
  return CWDB.updateDataset((dataset) => {
    assertValid({ topics: dataset.topics, events: dataset.events, measurements: dataset.measurements, [APP_META_TOP_KEY]: app });
    const meta = new Map(dataset.meta.map((r) => [r.key, r.value]));
    if (app.backupSchemaVersion != null) meta.set('backupSchemaVersion', Math.max(meta.get('backupSchemaVersion') || BACKUP_SCHEMA_VERSION, app.backupSchemaVersion));
    for (const k of APP_META_KEYS) if (app[k] != null) meta.set(k, k === 'insightSettings' ? portable(CWDB.normalizeInsightSettings(app[k])) : app[k]);
    meta.set('extraAppMeta', { ...meta.get('extraAppMeta'), ...unknownAppFields(app) });
    dataset.meta = Array.from(meta, ([key, value]) => ({ key, value }));
    if (app.favorites) dataset.favorites = app.favorites;
    return dataset;
  });
}

function formatSavedDate(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function validateBackup(obj) {
  const errors = [];
  const fail = (path, message) => { if (errors.length < 100) errors.push(`${path}: ${message}`); };
  const record = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.toString.call(v) === '[object Object]';
  const id = Number.isSafeInteger;
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const epoch = (v) => id(v) && Math.abs(v) <= 8640000000000000;
  const dateKey = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  if (!record(obj)) return ['File is not a JSON object.'];
  // Bound nesting, individual strings and total work without limiting years.
  let nodes = 0;
  const ancestors = new Set();
  const json = (value, depth = 0) => {
    if (++nodes > 20000000 || depth > 32) throw new Error('Backup exceeds size/nesting limits.');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number' && finite(value)) return;
    if (typeof value === 'string' && value.length <= 1000000) return;
    if (typeof value !== 'object' || (!Array.isArray(value) && !record(value)) || ancestors.has(value)) throw new Error('Backup must contain finite, acyclic JSON values (strings up to 1 MB).');
    ancestors.add(value);
    for (const child of Object.values(value)) json(child, depth + 1);
    ancestors.delete(value);
  };
  try { json(obj); } catch (error) { return [error.message]; }
  if (Object.hasOwn(obj, 'version') && !((id(obj.version) && obj.version >= 0) || (typeof obj.version === 'string' && obj.version.length > 0))) fail('version', 'must be a version number or string');
  if (Object.hasOwn(obj, 'saveddatelong') && !epoch(obj.saveddatelong)) fail('saveddatelong', 'invalid timestamp');
  if (Object.hasOwn(obj, 'saveddate') && typeof obj.saveddate !== 'string') fail('saveddate', 'must be a string');
  for (const key of ['eventcount', 'topiccount']) {
    if (Object.hasOwn(obj, key) && (!id(obj[key]) || obj[key] < 0)) fail(key, 'must be a nonnegative safe integer');
  }
  const tables = {};
  for (const name of ['topics', 'events', 'measurements', 'pendtimes', 'appdata']) {
    if (!Object.hasOwn(obj, name) && !REQUIRED_KEYS.includes(name)) continue;
    const rows = obj[name];
    if (!Array.isArray(rows)) { fail(name, 'must be an array'); continue; }
    if (rows.length > (name === 'events' ? 1000000 : 100000)) { fail(name, 'too many records'); continue; }
    const seen = new Set();
    tables[name] = seen;
    rows.forEach((row, i) => {
      const path = `${name}[${i}]`;
      if (!record(row)) { fail(path, 'must be an object'); return; }
      const key = name === 'appdata' ? 'name' : 'id';
      if (key === 'name' ? typeof row[key] !== 'string' : !id(row[key])) fail(`${path}.${key}`, 'invalid key');
      if (seen.has(row[key])) fail(`${path}.${key}`, 'duplicate key');
      seen.add(row[key]);
      for (const field of ['name', 'desc', 'symbol', 'title', 'note']) {
        if (Object.hasOwn(row, field) && row[field] !== null && typeof row[field] !== 'string') fail(`${path}.${field}`, 'must be a string or null');
      }
      if (name === 'topics' || name === 'measurements') {
        if (typeof row.name !== 'string') fail(`${path}.name`, 'must be a string');
      }
      for (const field of ['qant', 'cost', 'type', 'format', 'optype', 'endtime']) {
        if (Object.hasOwn(row, field) && !finite(row[field])) fail(`${path}.${field}`, 'must be finite numeric data');
      }
      if (name === 'events') {
        if (!epoch(row.time)) fail(`${path}.time`, 'must be safe integer milliseconds within Date range');
        if (!id(row.topicid)) fail(`${path}.topicid`, 'must be a safe integer');
      }
      if (name === 'topics' && !id(row.msureid)) fail(`${path}.msureid`, 'must be a safe integer');
      if (name === 'topics' && Object.hasOwn(row, 'archived') && typeof row.archived !== 'boolean') fail(`${path}.archived`, 'must be boolean');
    });
  }
  const topics = tables.topics || new Set();
  const measurements = tables.measurements || new Set(window.CWDB_DEFAULT_MEASUREMENTS.map((m) => m.id));
  for (const [i, row] of (Array.isArray(obj.topics) ? obj.topics : []).entries()) {
    if (record(row) && !measurements.has(row.msureid)) fail(`topics[${i}].msureid`, 'unknown measurement');
  }
  for (const [i, row] of (Array.isArray(obj.events) ? obj.events : []).entries()) {
    if (!record(row)) continue;
    if (!topics.has(row.topicid)) fail(`events[${i}].topicid`, 'unknown topic');
    if (Object.hasOwn(row, 'msureid') && (!id(row.msureid) || !measurements.has(row.msureid))) fail(`events[${i}].msureid`, 'unknown measurement');
  }
  for (const namespace of [APP_META_TOP_KEY, ...LEGACY_APP_META_TOP_KEYS]) {
    if (!Object.hasOwn(obj, namespace)) continue;
    const app = obj[namespace];
    if (!record(app)) { fail(namespace, 'must be an object'); continue; }
    if (Object.hasOwn(app, 'backupSchemaVersion') && (!id(app.backupSchemaVersion) || app.backupSchemaVersion < 1)) fail(namespace, 'backupSchemaVersion must be a positive safe integer');
    for (const key of TOPIC_MAP_KEYS) {
      if (!Object.hasOwn(app, key)) continue;
      if (!record(app[key])) { fail(`${namespace}.${key}`, 'must be a topic-id map'); continue; }
      for (const [tid, value] of Object.entries(app[key])) {
        const path = `${namespace}.${key}.${tid}`;
        if (!id(Number(tid)) || String(Number(tid)) !== tid || !topics.has(Number(tid))) fail(path, 'unknown topic id');
        if (value === null) continue; // explicit legacy "unset"
        if (key === 'topicKinds') {
          if (!['timeonly', 'duration', 'amount'].includes(value)) fail(path, 'invalid topic kind');
          continue;
        }
        if (key === 'topicRoles' && typeof value === 'string') {
          if (!['focus', 'marker', 'influence', 'bathroom', 'blood', 'accident', 'meal', 'sleep', 'med', 'trigger'].includes(value)) fail(path, 'invalid role');
          continue;
        }
        if (!record(value)) { fail(path, 'must be an object or null'); continue; }
        const optional = (field, check) => { if (Object.hasOwn(value, field) && !check(value[field])) fail(`${path}.${field}`, 'invalid value'); };
        if (key === 'topicPrefs') {
          optional('quickAmount', finite);
          optional('aggregation', (v) => ['sum', 'mean', 'latest'].includes(v));
          optional('trackingStart', epoch);
        } else if (key === 'topicGoals') {
          if (!finite(value.target) || value.target < 0) fail(path, 'invalid goal target');
          optional('metric', (v) => ['count', 'minutes', 'amount'].includes(v));
          optional('cmp', (v) => ['gte', 'lte'].includes(v));
          optional('period', (v) => ['day', 'week'].includes(v));
          optional('since', epoch);
          optional('effectiveFrom', epoch);
          optional('paused', (v) => typeof v === 'boolean');
          optional('history', (history) => Array.isArray(history) && history.every((entry) =>
            record(entry) && epoch(entry.effectiveFrom) && finite(entry.target) && entry.target >= 0 &&
            (!Object.hasOwn(entry, 'metric') || ['count', 'minutes', 'amount'].includes(entry.metric)) &&
            (!Object.hasOwn(entry, 'cmp') || ['gte', 'lte'].includes(entry.cmp)) &&
            (!Object.hasOwn(entry, 'period') || ['day', 'week'].includes(entry.period))));
          optional('pauses', (pauses) => Array.isArray(pauses) && pauses.every((entry) =>
            record(entry) && epoch(entry.from) && (entry.to == null || (epoch(entry.to) && entry.to > entry.from))));
        } else if (key === 'topicRoles') {
          if (!['focus', 'marker', 'influence'].includes(value.role)) fail(path, 'invalid role');
          optional('dir', (v) => ['up', 'down'].includes(v));
          optional('timing', (v) => typeof v === 'boolean');
        } else {
          optional('emoji', (v) => typeof v === 'string');
          optional('color', (v) => typeof v === 'string');
        }
      }
    }
    for (const key of ['topicOrder', 'quickBar', 'favorites']) {
      if (!Object.hasOwn(app, key)) continue;
      if (!Array.isArray(app[key])) { fail(`${namespace}.${key}`, 'must be an array'); continue; }
      const seen = new Set();
      for (const value of app[key]) {
        const tid = key === 'favorites' ? value?.topicid : value;
        if (!id(tid) || !topics.has(tid) || seen.has(tid)) fail(`${namespace}.${key}`, 'invalid, unknown or duplicate topic id');
        if (key === 'favorites' && (!record(value) || (Object.hasOwn(value, 'added') && !epoch(value.added)))) fail(`${namespace}.${key}`, 'invalid favorite');
        seen.add(tid);
      }
    }
    if (Object.hasOwn(app, 'dayChecks')) {
      if (!record(app.dayChecks)) fail(`${namespace}.dayChecks`, 'must be a date map');
      else for (const [key, value] of Object.entries(app.dayChecks)) {
        if (!dateKey(key) || !['complete', 'none', 'incomplete'].includes(value)) fail(`${namespace}.dayChecks.${key}`, 'invalid date/status');
      }
    }
    if (Object.hasOwn(app, 'insightSettings')) {
      const settings = app.insightSettings;
      if (!record(settings)) fail(`${namespace}.insightSettings`, 'must be an object');
      else for (const [key, value] of Object.entries(CWDB.normalizeInsightSettings(settings))) {
        if (['cutoffHour', 'nightStart', 'nightEnd'].includes(key) && (!finite(value) || value < 0 || value >= 24)) fail(key, 'invalid hour');
        if (['windowDays', 'insightWindow', 'alertCooldownHours'].includes(key) && (!finite(value) || value <= 0)) fail(key, 'must be positive');
        if (key === 'alertsEnabled' && typeof value !== 'boolean') fail(key, 'must be boolean');
        if (key === 'alertOn' && !['alert', 'watch'].includes(value)) fail(key, 'invalid alert level');
      }
    }
  }
  return errors;
}

function assertValid(obj) {
  const errors = validateBackup(obj);
  if (errors.length) throw new Error(`Invalid backup:\n${errors.join('\n')}`);
}

function unknownAppFields(app) {
  return Object.fromEntries(Object.entries(portable(app)).filter(([key]) => !APP_META_KEYS.includes(key) && !['favorites', 'backupSchemaVersion'].includes(key)));
}

function prepareBackup(obj) {
  assertValid(obj);
  const app = readAppMeta(obj);
  const meta = APP_META_KEYS.filter((k) => app[k] != null).map((key) => ({ key, value: key === 'insightSettings' ? portable(app[key]) : app[key] }));
  meta.push(
    { key: 'extraAppMeta', value: unknownAppFields(app) },
    { key: 'extraTopKeys', value: Object.fromEntries(Object.entries(obj).filter(([k]) => !KNOWN_TOP_KEYS.has(k) && !isLocalKey(k))) },
    { key: 'lastImport', value: Date.now() },
    { key: 'originalVersion', value: obj.version ?? 4 },
    { key: 'backupSchemaVersion', value: app.backupSchemaVersion ?? BACKUP_SCHEMA_VERSION },
  );
  // Detach from the caller before any asynchronous work can mutate its data.
  return JSON.parse(JSON.stringify({
    topics: obj.topics, events: obj.events,
    measurements: obj.measurements ?? window.CWDB_DEFAULT_MEASUREMENTS,
    pendtimes: obj.pendtimes ?? window.CWDB_DEFAULT_PENDTIMES,
    appdata: (obj.appdata ?? []).filter((row) => !isLocalKey(row.name)), favorites: app.favorites ?? [], meta,
  }));
}

function summarize(obj) {
  const events = obj.events || [];
  let minT = Infinity, maxT = -Infinity;
  for (const e of events) {
    if (e.time < minT) minT = e.time;
    if (e.time > maxT) maxT = e.time;
  }
  return {
    version: obj.version ?? '(unknown)',
    topics: (obj.topics || []).length,
    events: events.length,
    measurements: (obj.measurements || []).length,
    minTime: events.length ? new Date(minT) : null,
    maxTime: events.length ? new Date(maxT) : null,
    saveddate: obj.saveddate || '(not set)',
  };
}

/**
 * Replace local DB with the contents of `obj`.
 * Preserves unknown top-level keys in meta.extraKeys.
 */
/* Ordinary sync alone opts into timer preservation with complete local ->
 * merged topic/measurement ID maps. Manual imports/restores clear timers.
 * The caller owns plotline-data; neither method acquires a Web Lock. */
async function importReplace(obj, options = {}) {
  const dataset = prepareBackup(obj);
  return CWDB.replaceDataset(dataset, options);
}

async function checkTimerReplacement(obj, options) {
  return CWDB.checkTimerReplacement(prepareBackup(obj), options);
}

/**
 * Atomic merge under one write lock. Incoming IDs are NEVER allocated as
 * final IDs. Semantic duplicates reuse local records; new records use random
 * IDs. Same-name unit/kind conflicts reject the whole merge, without conversion.
 */
async function importMerge(obj) {
  const incoming = prepareBackup(obj);
  return CWDB.updateDataset((current) => {
    const meta = Object.fromEntries(current.meta.map((r) => [r.key, r.value]));
    if (meta.insightSettings != null) meta.insightSettings = CWDB.normalizeInsightSettings(meta.insightSettings);
    const incomingMeta = Object.fromEntries(incoming.meta.map((r) => [r.key, r.value]));
    const allocate = (name) => {
      const used = new Set([...current[name], ...incoming[name]].map((r) => r.id));
      return () => {
        let id;
        do { id = CWDB.randomId(); } while (used.has(id));
        used.add(id);
        return id;
      };
    };
    const mergeIdentified = (name) => {
      const next = allocate(name);
      const byContent = new Map(current[name].map((r) => [recordKey(r), r.id]));
      const map = new Map();
      for (const row of incoming[name]) {
        const key = recordKey(row);
        let id = byContent.get(key);
        if (id === undefined) {
          id = next();
          current[name].push({ ...row, id });
          byContent.set(key, id);
        }
        map.set(row.id, id);
      }
      return map;
    };
    const measurementMap = mergeIdentified('measurements');
    const pendtimeMap = mergeIdentified('pendtimes');
    const nextTopic = allocate('topics');
    const byName = new Map(current.topics.map((t) => [t.name.toLowerCase(), t]));
    const topicMap = new Map(), newTopics = new Set();
    const resolvedKinds = { ...meta.topicKinds };
    for (const topic of incoming.topics) {
      const name = topic.name.toLowerCase();
      const existing = byName.get(name);
      const msureid = measurementMap.get(topic.msureid);
      const kind = incomingMeta.topicKinds?.[topic.id];
      if (existing) {
        if (existing.msureid !== msureid || (kind && resolvedKinds[existing.id] && kind !== resolvedKinds[existing.id])) {
          throw new Error(`Cannot merge "${topic.name}": its measurement or tracking type differs. Rename the incoming topic or create a separate topic; amounts were not converted.`);
        }
        topicMap.set(topic.id, existing.id);
      } else {
        const id = nextTopic();
        const row = { ...topic, id, msureid };
        if (Object.hasOwn(row, 'pendtimeid')) row.pendtimeid = pendtimeMap.get(row.pendtimeid) ?? row.pendtimeid;
        current.topics.push(row);
        byName.set(name, row);
        topicMap.set(topic.id, id);
        newTopics.add(id);
        resolvedKinds[id] = kind;
      }
    }
    const nextEvent = allocate('events');
    const eventKeys = new Set(current.events.map(eventKey));
    for (const event of incoming.events) {
      const row = { ...event, topicid: topicMap.get(event.topicid) };
      if (Object.hasOwn(row, 'msureid')) row.msureid = measurementMap.get(row.msureid);
      const key = eventKey(row);
      if (eventKeys.has(key)) continue;
      current.events.push({ ...row, id: nextEvent() });
      eventKeys.add(key);
    }
    const appNames = new Set(current.appdata.map((r) => r.name));
    for (const row of incoming.appdata) if (!appNames.has(row.name) && !isLocalKey(row.name)) {
      current.appdata.push(row);
      appNames.add(row.name);
    }
    // Remap from the ORIGINAL map once; never mutate numeric keys in place.
    for (const key of TOPIC_MAP_KEYS) {
      const result = { ...meta[key] };
      for (const [tid, value] of Object.entries(incomingMeta[key] || {})) {
        const mapped = topicMap.get(Number(tid));
        if (newTopics.has(mapped) && !Object.hasOwn(result, mapped)) result[mapped] = value;
      }
      if (meta[key] !== undefined || incomingMeta[key] !== undefined) meta[key] = result;
    }
    for (const key of ['topicOrder', 'quickBar']) {
      if (meta[key] === undefined && incomingMeta[key] === undefined) continue;
      const result = [...(meta[key] || [])], have = new Set(result);
      for (const id of incomingMeta[key] || []) {
        const mapped = topicMap.get(id);
        if (newTopics.has(mapped) && !have.has(mapped)) { result.push(mapped); have.add(mapped); }
      }
      meta[key] = result;
    }
    const favorites = new Set(current.favorites.map((f) => f.topicid));
    for (const favorite of incoming.favorites) {
      const topicid = topicMap.get(favorite.topicid);
      if (newTopics.has(topicid) && !favorites.has(topicid)) {
        current.favorites.push({ ...favorite, topicid });
        favorites.add(topicid);
      }
    }
    for (const key of ['dayChecks', 'insightSettings', 'extraAppMeta', 'extraTopKeys']) {
      if (meta[key] !== undefined || incomingMeta[key] !== undefined) meta[key] = existingWins(meta[key], incomingMeta[key]);
    }
    meta.lastImport = incomingMeta.lastImport;
    meta.backupSchemaVersion = Math.max(meta.backupSchemaVersion || BACKUP_SCHEMA_VERSION, incomingMeta.backupSchemaVersion);
    if (meta.originalVersion === undefined) meta.originalVersion = incomingMeta.originalVersion;
    current.meta = Object.entries(meta).map(([key, value]) => ({ key, value }));
    return current;
  });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function recordKey(row) {
  return canonical(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id')));
}

function eventKey(row) {
  return recordKey({ ...row, qant: row.qant ?? 0, cost: row.cost ?? 0, note: row.note ?? '' });
}

function existingWins(existing, incoming) {
  if (existing === undefined) return incoming;
  if (existing && incoming && typeof existing === 'object' && typeof incoming === 'object' && !Array.isArray(existing) && !Array.isArray(incoming)) {
    return Object.fromEntries([...new Set([...Object.keys(incoming), ...Object.keys(existing)])].map((key) => [
      key, existingWins(Object.hasOwn(existing, key) ? existing[key] : undefined, Object.hasOwn(incoming, key) ? incoming[key] : undefined),
    ]));
  }
  return existing;
}

// Historical entry point is now safe on its own; callers must NOT clear first.
async function applyBackup(obj) { return importReplace(obj); }

async function buildExportObject() {
  const now = new Date();
  const dataset = await CWDB.getDataset();
  const { measurements, pendtimes, topics, events } = dataset;
  const appdata = dataset.appdata.filter((row) => !isLocalKey(row.name));
  const meta = Object.fromEntries(dataset.meta.map((r) => [r.key, r.value]));

  // sort topics by name to match the original layout
  topics.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  // events: keep stable order; the original groups by topicid then desc time
  events.sort((a, b) => (a.topicid - b.topicid) || (b.time - a.time));
  measurements.sort((a, b) => {
    // duration measurements (type 3) listed first by id
    if (a.type !== b.type) return b.type - a.type;
    return a.id - b.id;
  });
  pendtimes.sort((a, b) => a.id - b.id);

  const version = meta.originalVersion ?? 4;
  const appMeta = await buildAppMeta(dataset);
  const out = {
    version,
    saveddatelong: now.getTime(),
    saveddate: formatSavedDate(now),
    eventcount: events.length,
    topiccount: topics.length,
    measurements,
    pendtimes,
    topics,
    events,
    appdata,
    [APP_META_TOP_KEY]: appMeta,
  };

  const extras = portable(meta.extraTopKeys);
  for (const [k, v] of Object.entries(extras)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

function downloadJSON(filename, obj) {
  const json = JSON.stringify(obj, null, 0); // compact like original
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportToFile(filename) {
  const obj = await buildExportObject();
  const name = filename || `plotline-backup.json`;
  downloadJSON(name, obj);
  await CWDB.setMeta('lastExport', Date.now());
}

function csvEscape(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

async function exportToCsv(filename) {
  const [topics, events, measurements] = await Promise.all([
    CWDB.getAll('topics'),
    CWDB.getAll('events'),
    CWDB.getAll('measurements'),
  ]);
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const measById = new Map(measurements.map((m) => [m.id, m]));

  // Re-implement a tiny formatter so we don't depend on app.js here.
  const fmtQant = (qant, topic) => {
    if (!topic) return String(qant ?? '');
    const m = measById.get(topic.msureid);
    if (!m) return String(qant ?? '');
    if (m.type === 3) {
      const secs = Number(qant || 0);
      const h = Math.floor(secs / 3600);
      const mn = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      if (m.format === 7) return `${String(Math.floor(secs/60)).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      if (m.format === 6) return `${h}:${String(mn).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      if (m.format === 4) return `${(secs/3600).toFixed(1)} ${m.symbol}`;
      if (m.format === 3) return `${Math.round(secs/60)} ${m.symbol}`;
      if (m.format === 2) return `${secs} ${m.symbol}`;
      if (h === 0) return `${mn}m`;
      return `${h}:${String(mn).padStart(2,'0')}`;
    }
    return `${qant}${m.symbol || ''}`;
  };

  const TAG_RE = /#([A-Za-z0-9_][A-Za-z0-9_-]{0,30})/g;
  const extractTags = (note) => {
    if (!note) return '';
    const out = [];
    let m;
    while ((m = TAG_RE.exec(note)) !== null) out.push(m[1].toLowerCase());
    return out.join(' ');
  };

  const header = ['id','time_iso','time_ms','topicid','topic_name','qant_raw','qant_formatted','measurement','cost_severity','tags','note'];
  const lines = [header.map(csvEscape).join(',')];
  const sorted = events.slice().sort((a, b) => a.time - b.time);
  for (const e of sorted) {
    const t = topicById.get(e.topicid);
    const m = t ? measById.get(t.msureid) : null;
    lines.push([
      e.id,
      new Date(e.time).toISOString(),
      e.time,
      e.topicid,
      t ? t.name : '',
      e.qant ?? 0,
      t ? fmtQant(e.qant, t) : (e.qant ?? ''),
      m ? m.name : '',
      e.cost ?? 0,
      extractTags(e.note),
      e.note || '',
    ].map(csvEscape).join(','));
  }
  const csv = lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'plotline-events.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function safetyBackup() {
  // Topics, goals, preferences and custom units are valuable without events.
  // Even an apparently empty dataset gets a recoverable pre-mutation snapshot.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-` +
                `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  await exportToFile(`plotline-backup-${stamp}.json`);
}

window.CWIO = {
  APP_META_KEYS,
  BACKUP_SCHEMA_VERSION,
  buildAppMeta,
  applyAppMeta,
  applyBackup,
  validateBackup,
  summarize,
  importReplace,
  checkTimerReplacement,
  importMerge,
  buildExportObject,
  exportToFile,
  exportToCsv,
  safetyBackup,
  downloadJSON,
};
