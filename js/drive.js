/* Plotline - Google Drive sync (optional).
 *
 * Configuration lives in js/config.js — set window.CW_CONFIG.driveClientId
 * to your OAuth Client ID. Sync stays off until the user connects:
 *
 *   - Silent token request on startup for connected devices (after 2 min)
 *   - Debounced auto-sync after every save (configurable)
 *   - Skips sync when the device is on cellular if wifiOnly is true
 *
 * Scope is drive.file — the app can only see / modify files it creates.
 */

const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER_NAME = 'Plotline';
const DRIVE_FILE_NAME = 'plotline.json';
const SNAPSHOT_NAME = (i) => `plotline-${i}.json`;

/* Installs that synced under the app's previous name keep their backups under
 * the names below. Both the folder and the files are renamed in place rather
 * than recreated, so existing Drive file IDs — and the revision history
 * attached to them — survive the rebrand instead of being orphaned. These
 * three strings are load-bearing: removing them strands that data.
 *
 * Only the immediately preceding name is migrated. The app was renamed twice
 * (WhenDidI -> CountWhen -> Plotline), but the first rename shipped before any
 * public release, so no install can still be sitting on the WhenDidI names. */
const DRIVE_LEGACY_FOLDER_NAME = 'CountWhen';
const DRIVE_LEGACY_FILE_NAME = 'countwhen.json';
const LEGACY_SNAPSHOT_NAME = (i) => `countwhen-${i}.json`;

const DRIVE_MAX_VERSIONS = 5; // rotated snapshots

/* Minimum age of the newest snapshot before another one is cut.
 *
 * The five slots are only useful if they span time. Without a gap they hold
 * the last five *changed* states, which on a busy logging day is five copies
 * from the same hour — plenty of redundancy for a mistake caught immediately
 * (which Drive's own 30-day revision history on the primary file already
 * covers) and no help at all for a bad delete noticed next week. At 12h the
 * same five files reach back two and a half days at worst, and typically
 * much further. */
const DRIVE_MIN_SNAPSHOT_GAP_MS = 12 * 60 * 60 * 1000;

/* Top-level key carrying Plotline's own settings inside a backup, plus every
 * name it used before, oldest last. Backup files outlive installs, so all of
 * them stay readable; only the current key is ever written. */
const APP_META_KEY = '_plotline';
const LEGACY_APP_META_KEYS = ['_countwhen', '_wdapp'];

const CFG = () => window.CW_CONFIG || {};

let _gisLoaded = false;
let _tokenClient = null;
let _accessToken = null;
let _tokenExpiry = 0;
let _autoSyncTimer = null;
let _consecutiveSilentFailures = 0;
let _syncPendingForeground = false;
let _syncQueue = Promise.resolve();
let _dataQueue = Promise.resolve();
let _pendingOperations = 0;
let _connectionEpoch = 0;
let _cancelTokenRequest = null;
let _disconnecting = 0;
let _lastStatus = { status: '', message: '' };

/* Background sync gives up after this many consecutive silent failures.
 * An unauthorised or misconfigured token fails identically every time, so
 * retrying on every launch and every edit just burns requests and keeps the
 * status pill churning. Cleared by a successful token grant, by an explicit
 * interactive sync, or by a client ID change. */
const MAX_SILENT_AUTH_FAILURES = 2;

function autoSyncSuppressed() {
  return _consecutiveSilentFailures >= MAX_SILENT_AUTH_FAILURES;
}

/* ---------- helpers ---------- */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function ensureGis() {
  if (_gisLoaded) return;
  await loadScript('https://accounts.google.com/gsi/client');
  _gisLoaded = true;
}

function getClientId() {
  // A user-supplied ID (saved in IDB via the Drive dialog) always wins, so
  // anyone can route sync through their own Google project. config.js is the
  // built-in default for everyone else.
  return CWDB.getMeta('driveClientId').then((v) => {
    const own = (v || '').trim();
    return own || (CFG().driveClientId || '').trim();
  });
}

function isOnline() {
  return navigator.onLine !== false;
}

/* True when the app is actually on screen.
 *
 * Every GIS token request — including a "silent" prompt: 'none' one — opens
 * a real popup window, which on Android is a Custom Tab stacked over the
 * installed app. Fired while the app is backgrounded (a throttled auto-sync
 * timer, an `online` event, a Wi-Fi/cellular flip) the handshake with the
 * frozen opener never completes: the popup's /gsi/transform POST aborts and
 * the resulting "This site can't be reached" tab is still sitting on top of
 * the app when the user comes back to it. So: no token requests off-screen.
 */
function appVisible() {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

function isOnWifi() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return null;  // unknown
  if (conn.type) {
    // Known enum values: bluetooth | cellular | ethernet | mixed | none |
    //                    other | unknown | wifi | wimax
    if (conn.type === 'wifi' || conn.type === 'ethernet' || conn.type === 'wimax') return true;
    if (conn.type === 'cellular') return false;
    return null;
  }
  // No `type` field — can't tell.
  return null;
}

function wifiOk() {
  if (!CFG().wifiOnly) return true;
  const wifi = isOnWifi();
  if (wifi === null) return true;  // unknown — be permissive on desktops
  return wifi === true;
}

function setStatus(status, msg) {
  _lastStatus = { status, message: msg || '' };
  if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('plotline:sync-status', { detail: _lastStatus }));
  }
  // Update the small sync pill in the header if present
  const el = document.getElementById('syncPill');
  if (!el) return;
  el.classList.remove('ok', 'error');
  if (status === 'ok') el.classList.add('ok');
  if (status === 'error') el.classList.add('error');
  el.textContent = msg || '';
  el.style.display = msg ? '' : 'none';
}

/* ---------- token / OAuth ---------- */

async function getTokenInteractive() {
  return _requestToken(true);
}
async function getTokenSilent() {
  return _requestToken(false);
}

async function _requestToken(interactive) {
  const epoch = _connectionEpoch;
  if (_accessToken && Date.now() < _tokenExpiry - 30000) return _accessToken;
  // An interactive request always follows a tap, so the app is on screen by
  // definition. A background one must wait — see appVisible().
  if (!interactive && !appVisible()) throw new Error('BACKGROUNDED');
  const clientId = await getClientId();
  if (!clientId) throw new Error('NO_CLIENT_ID');
  await ensureGis();
  if (epoch !== _connectionEpoch) throw new Error('DISCONNECTED');
  if (!interactive && !appVisible()) throw new Error('BACKGROUNDED');
  return new Promise((resolve, reject) => {
    _cancelTokenRequest = () => reject(new Error('DISCONNECTED'));
    // Both callbacks must belong to this request. Reusing only `callback`
    // leaves error_callback rejecting an already-settled previous promise.
    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPES,
      callback: (resp) => {
        if (epoch !== _connectionEpoch) return reject(new Error('DISCONNECTED'));
        if (resp.error) return reject(new Error(resp.error));
        _accessToken = resp.access_token;
        _tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
        _consecutiveSilentFailures = 0;
        resolve(_accessToken);
      },
      error_callback: (err) => reject(new Error(err.type || 'oauth_error')),
    });
    _tokenClient._clientId = clientId;
    try {
      _tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
    } catch (e) { reject(e); }
  }).finally(() => { _cancelTokenRequest = null; });
}

/* ---------- Drive REST ---------- */

async function driveFetch(path, opts = {}) {
  const token = _accessToken;
  const headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
  const resp = await fetch(`https://www.googleapis.com${path}`, { ...opts, headers });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Drive ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return resp;
}

async function findOrCreateFolder() {
  const findByName = async (name) => {
    const q = encodeURIComponent(
      `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`
    );
    const resp = await driveFetch(`/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`);
    const data = await resp.json();
    return (data.files && data.files[0]) || null;
  };

  const current = await findByName(DRIVE_FOLDER_NAME);
  if (current) return current.id;

  // Pre-rebrand folder: rename in place so the existing backup and its
  // version history carry over instead of being orphaned.
  const legacy = await findByName(DRIVE_LEGACY_FOLDER_NAME);
  if (legacy) {
    try {
      await driveFetch(`/drive/v3/files/${legacy.id}?fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: DRIVE_FOLDER_NAME }),
      });
    } catch (e) {
      console.warn('Could not rename legacy Drive folder; using it as-is.', e);
    }
    return legacy.id;
  }

  const createResp = await driveFetch('/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  return (await createResp.json()).id;
}

async function findFileInFolder(folderId, name) {
  const q = encodeURIComponent(
    `name='${name}' and '${folderId}' in parents and trashed=false`
  );
  const resp = await driveFetch(
    `/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime,md5Checksum)&spaces=drive`);
  const data = await resp.json();
  return (data.files && data.files[0]) || null;
}

async function copyDriveFile(srcId, newName, parents) {
  const resp = await driveFetch(`/drive/v3/files/${srcId}/copy?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName, parents }),
  });
  return (await resp.json()).id;
}

async function deleteDriveFile(id) {
  await driveFetch(`/drive/v3/files/${id}`, { method: 'DELETE' });
}

/* Recoverable removal, used for legacy leftovers so a mistake is undoable
 * from the Drive trash. Rotation overflow still hard-deletes. */
async function trashDriveFile(id) {
  await driveFetch(`/drive/v3/files/${id}?fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

/* Keep up to DRIVE_MAX_VERSIONS historical snapshots alongside the primary
 * file, WITHOUT touching the primary file's id. The primary file is updated in
 * place so its Drive `modifiedTime` can be used for conflict detection.
 * Snapshots left over from the previous name are picked up by the legacy
 * lookup and rotate into the current naming scheme.
 *
 * Rotation is skipped when the primary file's contents are byte-identical to
 * the newest snapshot (Drive's md5Checksum), and when that snapshot is younger
 * than DRIVE_MIN_SNAPSHOT_GAP_MS: auto-sync fires after every save, so without
 * both checks a single busy afternoon would push five near-identical copies
 * through the ring and discard the older history that is actually worth
 * keeping.
 *
 * Best-effort: any failure here is non-fatal.
 */
async function rotateVersions(folderId, currentFileId, currentMd5 = null) {
  try {
    if (!currentFileId) return;
    const existing = [];
    for (let i = 1; i <= DRIVE_MAX_VERSIONS + 2; i++) {
      const f = (await findFileInFolder(folderId, SNAPSHOT_NAME(i)))
             || (await findFileInFolder(folderId, LEGACY_SNAPSHOT_NAME(i)));
      if (f) existing.push({ idx: i, file: f });
    }
    existing.sort((a, b) => a.idx - b.idx);

    const newest = existing.length && existing[0].idx === 1 ? existing[0].file : null;
    if (newest) {
      if (currentMd5 && newest.md5Checksum === currentMd5) return;
      const age = Date.now() - (Date.parse(newest.modifiedTime) || 0);
      if (age < DRIVE_MIN_SNAPSHOT_GAP_MS) return;
    }

    // Shift from the highest index down so we never collide with a name.
    for (let i = existing.length - 1; i >= 0; i--) {
      const slot = existing[i];
      const newIdx = slot.idx + 1;
      if (newIdx > DRIVE_MAX_VERSIONS) {
        await deleteDriveFile(slot.file.id);
      } else {
        await renameDriveFile(slot.file.id, SNAPSHOT_NAME(newIdx));
      }
    }
    // Snapshot the current contents as -1 (a copy, so the id stays stable).
    await copyDriveFile(currentFileId, SNAPSHOT_NAME(1), [folderId]);
  } catch (e) {
    console.warn('drive version rotation failed:', e?.message || e);
  }
}

/* Sweep up pre-rebrand artifacts the in-place renames can't reach.
 *
 * `statSyncFile` / `rotateVersions` only rename a legacy file when the
 * equivalent current-name file is absent; when both exist (two devices
 * upgrading at different times) the legacy copy is skipped forever and shows
 * up as a duplicate. Same for the legacy folder, which `findOrCreateFolder`
 * leaves untouched if a Plotline folder already exists.
 *
 * Duplicates are trashed (recoverable), orphans are renamed into the current
 * scheme, and the legacy folder is only trashed once it holds nothing this app
 * can see. Best-effort: any failure here is non-fatal.
 */
async function cleanupLegacyArtifacts(folderId) {
  let found = 0;
  try {
    const pairs = [[DRIVE_LEGACY_FILE_NAME, DRIVE_FILE_NAME]];
    for (let i = 1; i <= DRIVE_MAX_VERSIONS; i++) {
      pairs.push([LEGACY_SNAPSHOT_NAME(i), SNAPSHOT_NAME(i)]);
    }
    for (const [legacyName, currentName] of pairs) {
      const legacy = await findFileInFolder(folderId, legacyName);
      if (!legacy) continue;
      found++;
      const current = await findFileInFolder(folderId, currentName);
      if (current) await trashDriveFile(legacy.id);
      else await renameDriveFile(legacy.id, currentName);
    }

    // Legacy snapshots past the current retention window have no counterpart
    // to rotate into, so drop them outright.
    for (let i = DRIVE_MAX_VERSIONS + 1; i <= DRIVE_MAX_VERSIONS + 5; i++) {
      const stale = await findFileInFolder(folderId, LEGACY_SNAPSHOT_NAME(i));
      if (stale) { found++; await trashDriveFile(stale.id); }
    }

    const folderQ = encodeURIComponent(
      `mimeType='application/vnd.google-apps.folder' and ` +
      `name='${DRIVE_LEGACY_FOLDER_NAME}' and trashed=false`
    );
    const folderResp = await driveFetch(
      `/drive/v3/files?q=${folderQ}&fields=files(id)&spaces=drive`);
    const legacyFolders = (await folderResp.json()).files || [];
    for (const f of legacyFolders) {
      if (f.id === folderId) continue;
      found++;
      const childQ = encodeURIComponent(`'${f.id}' in parents and trashed=false`);
      const childResp = await driveFetch(
        `/drive/v3/files?q=${childQ}&fields=files(id)&pageSize=1&spaces=drive`);
      const children = (await childResp.json()).files || [];
      // Anything still inside is data we'd rather strand than destroy.
      if (!children.length) await trashDriveFile(f.id);
    }
    return { found, complete: true };
  } catch (e) {
    console.warn('drive legacy cleanup failed:', e?.message || e);
    return { found, complete: false };
  }
}

/* The sweep costs a handful of requests and only ever has work to do on an
 * install carried over from the old name, so run it at most once a day and
 * stop entirely after a clean pass finds nothing left to migrate. */
async function maybeCleanupLegacyArtifacts(folderId) {
  try {
    if (await CWDB.getMeta('driveLegacyCleanupDone')) return;
    const last = Number(await CWDB.getMeta('driveLegacyCleanupAt')) || 0;
    if (Date.now() - last < 24 * 60 * 60 * 1000) return;
    await CWDB.setMeta('driveLegacyCleanupAt', Date.now());
    const { found, complete } = await cleanupLegacyArtifacts(folderId);
    if (complete && !found) await CWDB.setMeta('driveLegacyCleanupDone', true);
  } catch (e) {
    console.warn('drive legacy cleanup skipped:', e?.message || e);
  }
}

const FILE_FIELDS = 'id,name,modifiedTime,md5Checksum,size,version';

async function createSyncFile(folderId, obj) {
  const json = JSON.stringify(obj);
  const boundary = '-------plotline-boundary-' + Math.random().toString(36).slice(2);
  const metadata = { name: DRIVE_FILE_NAME, parents: [folderId], mimeType: 'application/json' };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    json + `\r\n` +
    `--${boundary}--`;
  const resp = await driveFetch(
    `/upload/drive/v3/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  return await resp.json();
}

/* Overwrite the primary file's contents, keeping its id. */
async function updateSyncFile(fileId, obj) {
  const resp = await driveFetch(
    `/upload/drive/v3/files/${fileId}?uploadType=media&fields=${FILE_FIELDS}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    });
  return await resp.json();
}

async function readSyncFile(fileId) {
  const resp = await driveFetch(`/drive/v3/files/${fileId}?alt=media`);
  return await resp.json();
}

async function renameDriveFile(fileId, name) {
  await driveFetch(`/drive/v3/files/${fileId}?fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

async function statSyncFile(folderId) {
  const lookup = async (name) => {
    const q = encodeURIComponent(
      `name='${name}' and '${folderId}' in parents and trashed=false`
    );
    const resp = await driveFetch(
      `/drive/v3/files?q=${q}&fields=files(${FILE_FIELDS})&spaces=drive`);
    const data = await resp.json();
    return (data.files && data.files[0]) || null;
  };

  const current = await lookup(DRIVE_FILE_NAME);
  if (current) return current;

  // Pre-rebrand sync file: rename in place so its id and revision history
  // carry over. If the rename fails we still sync against the legacy file.
  const legacy = await lookup(DRIVE_LEGACY_FILE_NAME);
  if (legacy) {
    try {
      await renameDriveFile(legacy.id, DRIVE_FILE_NAME);
      legacy.name = DRIVE_FILE_NAME;
    } catch (e) {
      console.warn('Could not rename legacy Drive sync file; using it as-is.', e);
    }
    return legacy;
  }
  return null;
}

async function downloadSyncFile() {
  const folderId = await findOrCreateFolder();
  const file = await statSyncFile(folderId);
  if (!file) return null;
  return await readSyncFile(file.id);
}

/* ---------- three-way merge ---------- */

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function sameRecord(a, b) {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return stableStringify(a) === stableStringify(b);
}

function readApp(o) {
  if (!o) return undefined;
  return o[APP_META_KEY] || LEGACY_APP_META_KEYS.map((k) => o[k]).find(Boolean);
}

/* Ignore presentation timestamps/counts when deciding whether to replace local
 * data. Include portable settings and unknown preserved backup fields. */
function comparableBackup(obj) {
  const out = { ...obj, [APP_META_KEY]: readApp(obj) || {} };
  for (const k of [...LEGACY_APP_META_KEYS, 'saveddate', 'saveddatelong', 'eventcount', 'topiccount']) delete out[k];
  for (const key of ['topics', 'events', 'measurements', 'pendtimes', 'appdata']) {
    out[key] = [...(out[key] || [])].sort((a, b) => key === 'appdata'
      ? a.name.localeCompare(b.name) : a.id - b.id);
  }
  return out;
}

function mergeValue(b, l, r, preferRemote, stats, key = '') {
  if (sameRecord(l, r)) return l;
  if (sameRecord(b, l)) { stats.fromRemote++; return r; }
  if (sameRecord(b, r)) { stats.fromLocal++; return l; }
  if (Array.isArray(l) && Array.isArray(r) && (b == null || Array.isArray(b)) && ['history', 'pauses'].includes(key)) {
    const id = key === 'history' ? 'effectiveFrom' : 'from';
    if ([...(b || []), ...l, ...r].every((row) => row && Number.isFinite(row[id]))) {
      return mergeCollection(b, l, r, id, preferRemote, stats).sort((a, c) => a[id] - c[id]);
    }
  }
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (object(l) && object(r) && (b === undefined || object(b))) {
    const out = Object.create(null);
    for (const k of new Set([...Object.keys(b || {}), ...Object.keys(l), ...Object.keys(r)])) {
      const value = mergeValue(b?.[k], l[k], r[k], preferRemote, stats, k);
      if (value !== undefined) out[k] = value;
    }
    return out;
  }
  stats.conflicts++;
  stats[preferRemote ? 'resolvedRemote' : 'resolvedLocal']++;
  return preferRemote ? r : l;
}

/* A legacy auto-increment ID is not an identity across devices. Retain the
 * remote ID and deterministically move the distinct local addition, including
 * all its topic references. Determinism makes bounded retries idempotent. */
function remapConcurrentAdds(base, local, remote, stats, localIdMaps) {
  local = JSON.parse(JSON.stringify(local));
  const app = readApp(local);
  for (const collection of ['measurements', 'pendtimes', 'topics', 'events']) {
    const b = new Set((base[collection] || []).map((v) => v.id));
    const r = new Map((remote[collection] || []).map((v) => [v.id, v]));
    const used = new Set([...(local[collection] || []).map((v) => v.id), ...r.keys(), ...b]);
    for (const record of (local[collection] || [])) {
      if (b.has(record.id) || !r.has(record.id) || sameRecord(record, r.get(record.id))) continue;
      const old = record.id;
      const text = collection + stableStringify(record);
      let hash = 14695981039346656037n;
      for (let i = 0; i < text.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 1099511628211n);
      let id = Number(hash & 0x1fffffffffffffn) || 1;
      while (used.has(id)) id = id === Number.MAX_SAFE_INTEGER ? 1 : id + 1;
      used.add(id);
      record.id = id;
      if (localIdMaps[collection]) localIdMaps[collection][old] = id;
      stats.remapped++;
      if (collection === 'topics') {
        for (const key of ['events', 'pendtimes']) {
          for (const row of local[key] || []) if (row.topicid === old) row.topicid = id;
        }
        if (app) {
          for (const key of ['topicKinds', 'topicMeta', 'topicRoles', 'topicGoals', 'topicPrefs']) {
            if (app[key] && Object.hasOwn(app[key], old)) {
              app[key][id] = app[key][old]; delete app[key][old];
            }
          }
          for (const key of ['topicOrder', 'quickBar']) {
            if (Array.isArray(app[key])) app[key] = app[key].map((v) => v === old ? id : v);
          }
          for (const row of app.favorites || []) if (row.topicid === old) row.topicid = id;
        }
      }
      if (collection === 'measurements' || collection === 'pendtimes') {
        const ref = collection === 'measurements' ? 'msureid' : 'pendtimeid';
        for (const key of ['topics', 'events']) {
          for (const row of local[key] || []) if (row[ref] === old) row[ref] = id;
        }
      }
    }
  }
  return local;
}

/* Merge one id-keyed collection. `preferRemote` breaks true conflicts
 * (both sides changed the same record differently since the last sync). */
function mergeCollection(baseArr, localArr, remoteArr, keyName, preferRemote, stats) {
  const index = (arr) => {
    const m = new Map();
    for (const it of (arr || [])) if (it && it[keyName] != null) m.set(it[keyName], it);
    return m;
  };
  const base = index(baseArr), local = index(localArr), remote = index(remoteArr);
  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  const out = [];
  for (const id of ids) {
    const b = base.get(id), l = local.get(id), r = remote.get(id);
    if (sameRecord(l, r)) {                      // both sides agree
      if (l !== undefined) out.push(l);
      continue;
    }
    if (l === undefined) {
      // Deleted locally. Honour the delete only if the remote didn't change
      // it since the base; otherwise keep the remote edit (never lose data).
      if (b !== undefined && sameRecord(b, r)) { stats.deleted++; continue; }
      if (b !== undefined) { stats.conflicts++; stats.resolvedRemote++; }
      out.push(r); stats.fromRemote++; continue;
    }
    if (r === undefined) {
      if (b !== undefined && sameRecord(b, l)) { stats.deleted++; continue; }
      if (b !== undefined) { stats.conflicts++; stats.resolvedLocal++; }
      out.push(l); stats.fromLocal++; continue;
    }
    if (sameRecord(b, l)) { out.push(r); stats.fromRemote++; continue; }  // only remote changed
    if (sameRecord(b, r)) { out.push(l); stats.fromLocal++; continue; }   // only local changed
    stats.conflicts++;                                                    // both changed
    stats[preferRemote ? 'resolvedRemote' : 'resolvedLocal']++;
    out.push(preferRemote ? r : l);
  }
  return out;
}

/**
 * Three-way merge of two backup objects against the snapshot taken at
 * the last successful sync. Additive by nature (events have unique ids), so
 * in practice this is "union everything, and respect real deletions".
 */
function mergeBackups(base, local, remote, { preferRemote = false } = {}) {
  const b = base || {};
  const stats = { fromLocal: 0, fromRemote: 0, deleted: 0, conflicts: 0,
    resolvedLocal: 0, resolvedRemote: 0, remapped: 0 };
  const localIdMaps = identityMaps(local);
  local = remapConcurrentAdds(b, local, remote, stats, localIdMaps);
  const out = {
    ...local,
    topics:       mergeCollection(b.topics, local.topics, remote.topics, 'id', preferRemote, stats),
    events:       mergeCollection(b.events, local.events, remote.events, 'id', preferRemote, stats),
    measurements: mergeCollection(b.measurements, local.measurements, remote.measurements, 'id', preferRemote, stats),
    pendtimes:    mergeCollection(b.pendtimes, local.pendtimes, remote.pendtimes, 'id', preferRemote, stats),
    appdata:      mergeCollection(b.appdata, local.appdata, remote.appdata, 'name', preferRemote, stats),
  };
  const localApp = readApp(local), remoteApp = readApp(remote);
  for (const k of LEGACY_APP_META_KEYS) delete out[k];
  if (localApp || remoteApp) {
    const baseApp = readApp(b);
    const ordinary = (app) => Object.fromEntries(Object.entries(app || {})
      .filter(([k]) => !['favorites', 'topicOrder', 'quickBar'].includes(k)));
    out[APP_META_KEY] = JSON.parse(JSON.stringify(
      mergeValue(ordinary(baseApp), ordinary(localApp), ordinary(remoteApp), preferRemote, stats)));
    for (const key of ['topicOrder', 'quickBar']) {
      if (![baseApp, localApp, remoteApp].some((app) => Array.isArray(app?.[key]))) continue;
      const baseline = baseApp?.[key] || [];
      const l = localApp?.[key] || [], r = remoteApp?.[key] || [];
      out[APP_META_KEY][key] = [...new Set(preferRemote ? [...r, ...l] : [...l, ...r])]
        .filter((id) => !baseline.includes(id) || (l.includes(id) && r.includes(id)));
    }
    if (localApp?.favorites || remoteApp?.favorites || readApp(b)?.favorites) {
      out[APP_META_KEY].favorites = mergeCollection(readApp(b)?.favorites, localApp?.favorites,
        remoteApp?.favorites, 'topicid', preferRemote, stats);
    }
  }
  // A topic deleted on one device may still be needed by an event newly added
  // on the other. Keep that parent rather than dropping the event or emitting
  // an invalid backup; ordinary deletions still remove stale UI references.
  const retainReferenced = (collection, references) => {
    const ids = new Set(out[collection].map((row) => row.id));
    for (const id of references) {
      if (id == null || ids.has(id)) continue;
      const row = [local, remote, b].flatMap((obj) => obj[collection] || []).find((v) => v.id === id);
      if (row) {
        out[collection].push(row); ids.add(id);
        stats.conflicts++;
        stats.retainedReferences = (stats.retainedReferences || 0) + 1;
      }
    }
  };
  retainReferenced('topics', out.events.map((row) => row.topicid));
  retainReferenced('measurements', [...out.topics, ...out.events].map((row) => row.msureid));
  retainReferenced('pendtimes', [...out.topics, ...out.events].map((row) => row.pendtimeid));
  const topicIds = new Set(out.topics.map((row) => row.id));
  const app = out[APP_META_KEY];
  if (app) {
    for (const key of ['topicKinds', 'topicMeta', 'topicRoles', 'topicGoals', 'topicPrefs']) {
      if (app[key]) app[key] = Object.fromEntries(Object.entries(app[key]).filter(([id]) => topicIds.has(Number(id))));
    }
    for (const key of ['topicOrder', 'quickBar']) {
      if (Array.isArray(app[key])) app[key] = app[key].filter((id) => topicIds.has(id));
    }
    if (Array.isArray(app.favorites)) app.favorites = app.favorites.filter((row) => topicIds.has(row.topicid));
  }
  out.events.sort((a, c) => (a.topicid - c.topicid) || (c.time - a.time));
  out.topics.sort((a, c) => (a.name || '').localeCompare(c.name || ''));
  out.eventcount = out.events.length;
  out.topiccount = out.topics.length;
  out.version = local.version ?? remote.version ?? 4;
  for (const [collection, map] of Object.entries(localIdMaps)) {
    const ids = new Set(out[collection].map((row) => row.id));
    for (const id of Object.keys(map)) if (!ids.has(map[id])) map[id] = null;
  }
  return { merged: out, stats, localIdMaps };
}

function identityMaps(backup) {
  return Object.fromEntries(['topics', 'measurements']
    .map((key) => [key, Object.fromEntries((backup[key] || []).map((row) => [row.id, row.id]))]));
}

function composeIdMaps(previous, next) {
  return Object.fromEntries(Object.entries(previous).map(([key, map]) => [key,
    Object.fromEntries(Object.entries(map).map(([id, target]) =>
      [id, target == null ? null : next[key]?.[target] ?? null]))]));
}

/* A failed sync's candidate may already contain a moved local topic alongside
 * the remote topic at its old ID. The saved provenance, not that old ID, owns
 * the timer. If the source has since changed ambiguously, fail closed. */
function recoveryIdMaps(local, pending, mergedMaps) {
  for (const key of ['topics', 'measurements']) {
    const previous = new Map((pending.localSnapshot?.[key] || []).map((row) => [row.id, row]));
    const recovered = new Map((pending.snapshot[key] || []).map((row) => [row.id, row]));
    for (const row of local[key] || []) {
      const map = pending.localIdMaps?.[key];
      if (map && Object.hasOwn(map, row.id)) {
        const target = map[row.id];
        if (target === row.id) continue;
        if (sameRecord(row, previous.get(row.id))) mergedMaps[key][row.id] = target;
        else if (!sameRecord(row, recovered.get(row.id))) mergedMaps[key][row.id] = null;
      } else if (previous.has(row.id) && !sameRecord(previous.get(row.id), recovered.get(row.id))) {
        // Older recovery journals lack collision provenance.
        mergedMaps[key][row.id] = null;
      }
    }
  }
  return mergedMaps;
}

/* ---------- public sync ops ---------- */

/**
 * Two-way sync.
 *
 *   - No remote file            -> create it from local data.
 *   - Remote unchanged since we
 *     last synced                -> straight upload (fast-forward).
 *   - Remote changed             -> download it, three-way merge against the
 *                                   snapshot we stored at the last sync,
 *                                   apply the merge locally, upload the result.
 *
 * True conflicts (the same record edited differently on both devices since
 * the last sync) are resolved in favour of whichever side was touched most
 * recently, and reported back to the caller so the UI can mention it.
 */
async function isEnabled() {
  const enabled = await CWDB.getMeta('driveEnabled');
  return enabled == null ? !!(await CWDB.getMeta('lastDriveSync')) : enabled === true;
}

async function getConnectionState() {
  const recovery = await CWDB.getMeta('drivePendingSnapshot');
  return {
    enabled: await isEnabled(),
    lastSync: await CWDB.getMeta('lastDriveSync', 0),
    lastChange: await CWDB.getMeta('lastLocalChangeAt', 0),
    pending: _pendingOperations > 0,
    recoveryPending: !!recovery?.snapshot && recovery.status !== 'confirmed',
    recoveryAvailable: !!recovery?.snapshot,
    ..._lastStatus,
  };
}

function withDataLock(fn) {
  if (navigator.locks?.request) return navigator.locks.request('plotline-data', { mode: 'exclusive' }, fn);
  const result = _dataQueue.then(fn);
  _dataQueue = result.catch(() => {});
  return result;
}

/* Serialize OAuth clients too (GIS has one mutable callback), but never hold
 * the data lock while an account picker is waiting for its user. */
function runSync(interactive, operation) {
  if (_disconnecting) return Promise.reject(new Error('DISCONNECTED'));
  const epoch = _connectionEpoch;
  const authenticate = async () => {
    if (epoch !== _connectionEpoch) throw new Error('DISCONNECTED');
    if (interactive) {
      _consecutiveSilentFailures = 0;
      await CWDB.setMeta('driveEnabled', true);
    } else if (!(await isEnabled())) throw new Error('DISCONNECTED');
    if (!isOnline()) throw new Error('OFFLINE');
    if (!interactive && !wifiOk()) throw new Error('CELLULAR_BLOCKED');
    await (interactive ? getTokenInteractive() : getTokenSilent());
    return withDataLock(async () => {
      if (epoch !== _connectionEpoch || !(await isEnabled())) throw new Error('DISCONNECTED');
      return operation(() => {
        if (epoch !== _connectionEpoch) throw new Error('DISCONNECTED');
      });
    });
  };
  const wasPending = _pendingOperations++ > 0;
  // Start immediately when idle rather than waiting for a Web Lock before OAuth.
  const result = wasPending ? _syncQueue.then(authenticate) : authenticate();
  _syncQueue = result.catch(() => {}).finally(() => {
    _pendingOperations--;
    setStatus(_lastStatus.status, _lastStatus.message);
  });
  setStatus('', '☁ syncing…');
  return result.catch((e) => {
    setStatus('error', e.message === 'DISCONNECTED' ? '☁ disconnected' : '☁ sync failed');
    throw e;
  });
}

function sameRemote(a, b) {
  return a == null || b == null ? a == null && b == null :
    a.id === b.id && a.version === b.version &&
    a.modifiedTime === b.modifiedTime && a.md5Checksum === b.md5Checksum;
}

async function validatedRemote(id) {
  const obj = await readSyncFile(id);
  const errors = CWIO.validateBackup(obj);
  if (errors.length) throw new Error('INVALID_REMOTE: ' + errors[0]);
  return obj;
}

/* Keep a bounded local journal, including confirmed uploads: readback success
 * does not rule out a later concurrent overwrite. Entries are detached copies,
 * never edited in place. This is recovery, not a server-side write guarantee. */
async function saveRecovery(snapshot, localSnapshot, status = 'pending', localIdMaps) {
  const previous = await CWDB.getMeta('drivePendingSnapshot');
  const history = [...(previous?.history || (previous?.snapshot
    ? [{ savedAt: previous.savedAt, snapshot: previous.snapshot }] : []))];
  const append = (obj) => {
    if (!history.some((entry) => sameRecord(comparableBackup(entry.snapshot), comparableBackup(obj)))) {
      history.push({ savedAt: Date.now(), snapshot: JSON.parse(JSON.stringify(obj)) });
    }
  };
  append(localSnapshot);
  append(snapshot);
  await CWDB.setMeta('drivePendingSnapshot', {
    savedAt: Date.now(), status, snapshot, localSnapshot, localIdMaps, history: history.slice(-DRIVE_MAX_VERSIONS),
  });
}

function syncNow({ interactive = false, allowMerge = true } = {}) {
  return runSync(interactive, async (checkConnected) => {
    const folderId = await findOrCreateFolder();
    await CWDB.setMeta('driveFolderId', folderId);
    const local = await CWIO.buildExportObject();
    const base = await CWDB.getMeta('driveSyncBase');
    const lastLocalChange = await CWDB.getMeta('lastLocalChangeAt', 0);
    const pending = await CWDB.getMeta('drivePendingSnapshot');
    let candidate = local, localIdMaps = identityMaps(local);
    if (pending?.snapshot && pending.status !== 'confirmed' &&
        !sameRecord(comparableBackup(local), comparableBackup(pending.snapshot))) {
      const result = mergeBackups(pending.localSnapshot || base, local, pending.snapshot);
      candidate = result.merged;
      localIdMaps = recoveryIdMaps(local, pending, result.localIdMaps);
    }
    let retryBase = base;
    let resultStats = null;
    let hadRemote = false;
    await saveRecovery(candidate, local, 'pending', localIdMaps);
    for (let attempt = 0; attempt < 3; attempt++) {
      checkConnected();
      const stat = await statSyncFile(folderId);
      if (stat) {
        hadRemote = true;
        const remote = await validatedRemote(stat.id);
        if (!sameRemote(stat, await statSyncFile(folderId))) continue;
        if (!allowMerge && !sameRecord(comparableBackup(remote), comparableBackup(base || {}))) {
          throw new Error('REMOTE_CHANGED');
        }
        const result = mergeBackups(retryBase, candidate, remote, {
          preferRemote: (Date.parse(stat.modifiedTime) || 0) > lastLocalChange,
        });
        candidate = result.merged;
        localIdMaps = composeIdMaps(localIdMaps, result.localIdMaps);
        resultStats = result.stats;
        resultStats.hadBase = !!base;
        // Carry the remote state just observed forward on a retry, so records
        // already merged aren't mistaken for fresh ID collisions/deletions.
        retryBase = remote;
        await rotateVersions(folderId, stat.id, stat.md5Checksum);
      }
      const errors = CWIO.validateBackup(candidate);
      if (errors.length) throw new Error('INVALID_MERGE: ' + errors[0]);
      await saveRecovery(candidate, local, 'pending', localIdMaps);
      const timerOptions = { preserveActiveTimers: true,
        topicIdMap: localIdMaps.topics, measurementIdMap: localIdMaps.measurements };
      await CWIO.checkTimerReplacement(candidate, timerOptions);
      // Drive v3 does not document a browser-usable update precondition. These
      // checks detect races, not eliminate the final check-to-write window.
      // Never claim success until the uploaded content is read back unchanged.
      if (!sameRemote(stat, await statSyncFile(folderId))) continue;
      checkConnected();
      const written = stat ? await updateSyncFile(stat.id, candidate) :
        await createSyncFile(folderId, candidate);
      const verified = await statSyncFile(folderId);
      if (!sameRemote(written, verified)) continue;
      const contents = await validatedRemote(written.id);
      if (!sameRecord(contents, candidate) ||
          !sameRemote(verified, await statSyncFile(folderId))) continue;
      checkConnected();
      const changedLocally = !sameRecord(comparableBackup(local), comparableBackup(candidate));
      if (changedLocally) {
        await CWIO.safetyBackup();
        await CWIO.importReplace(candidate, timerOptions);
      }
      await rememberSyncPoint(verified, candidate);
      await saveRecovery(candidate, local, 'confirmed', localIdMaps);
      await maybeCleanupLegacyArtifacts(folderId);
      setStatus('ok', changedLocally ? '☁ merged' : '☁ synced');
      return { action: hadRemote ? 'merged' : 'created', stats: resultStats, changedLocally };
    }
    throw new Error('REMOTE_CONFLICT: Drive kept changing. Local data is unchanged; a pending recovery copy is saved. Retry sync.');
  });
}

/* Record what we just wrote so the next sync can detect remote edits. */
async function rememberSyncPoint(fileMeta, obj) {
  await CWDB.setMeta('driveRemoteMeta', {
    fileId: fileMeta.id,
    modifiedTime: fileMeta.modifiedTime,
    md5Checksum: fileMeta.md5Checksum || null,
    version: fileMeta.version || null,
  });
  await CWDB.setMeta('driveSyncBase', obj);
  await CWDB.setMeta('lastDriveSync', Date.now());
}

/* Upload-only (kept for the "Sync Now" button and older call sites). */
async function syncUp(opts = {}) {
  return syncNow(opts);
}

/* Explicit "throw away local, take what's on Drive". */
function syncDown({ interactive = true } = {}) {
  return runSync(interactive, async (checkConnected) => {
    const folderId = await findOrCreateFolder();
    for (let attempt = 0; attempt < 3; attempt++) {
      const stat = await statSyncFile(folderId);
      if (!stat) throw new Error('NO_REMOTE_FILE');
      const obj = await validatedRemote(stat.id);
      if (!sameRemote(stat, await statSyncFile(folderId))) continue;
      checkConnected();
      const local = await CWIO.buildExportObject();
      await saveRecovery(obj, local);
      await CWIO.safetyBackup();
      await CWIO.importReplace(obj);
      await rememberSyncPoint(stat, obj);
      await saveRecovery(obj, local, 'confirmed');
      setStatus('ok', '☁ restored');
      return obj;
    }
    throw new Error('REMOTE_CONFLICT: Drive changed during restore. Nothing replaced; retry.');
  });
}

/* ---------- auto-sync ---------- */

async function markLocalChange() {
  await CWDB.setMeta('lastLocalChangeAt', Date.now());
}

async function queueAutoSync(reason = 'change') {
  const epoch = _connectionEpoch;
  // Always stamp the local change, even if auto-sync is off — the timestamp
  // is what breaks conflict ties on the next manual sync.
  if (!['online', 'connection', 'startup', 'visibility', 'retry', 'marked-change'].includes(reason)) {
    await markLocalChange();
  }
  if (!(await isEnabled())) return;
  if (_disconnecting || epoch !== _connectionEpoch) return;
  if (!CFG().autoSyncOnChange) return;
  if (autoSyncSuppressed()) return;
  const debounce = Math.max(1000, Number(CFG().autoSyncDebounceMs) || 5000);
  if (_autoSyncTimer) clearTimeout(_autoSyncTimer);
  setStatus('', '☁ queued…');
  _autoSyncTimer = setTimeout(async () => {
    _autoSyncTimer = null;
    if (_disconnecting || epoch !== _connectionEpoch) return;
    // The timer may well have been throttled while the app sat in the
    // background and only fired now, still off-screen. Hold it over.
    if (!appVisible()) { _syncPendingForeground = true; return; }
    try {
      const res = await syncNow({ interactive: false });
      await afterSync(res);
    } catch (e) {
      handleAutoSyncFailure(e);
    }
  }, debounce);
}

/* A merge can rewrite local data (events pulled in from the other device),
 * so refresh the UI when that happens. */
async function afterSync(res) {
  if (!res || res.action !== 'merged' || !res.changedLocally) return;
  try {
    await window.CWAPP?.reload?.();
    window.CWAPP?.renderCurrent?.();
    const s = res.stats || {};
    const bits = [];
    if (s.fromRemote) bits.push(`${s.fromRemote} pulled in`);
    if (s.conflicts) bits.push(`${s.conflicts} conflict${s.conflicts === 1 ? '' : 's'} auto-resolved`);
    window.CWAPP?.snack?.(`Merged with Drive${bits.length ? ': ' + bits.join(', ') : ''}`);
  } catch (e) { console.warn('post-merge refresh failed', e); }
}

function handleAutoSyncFailure(e) {
  const msg = String(e?.message || e);
  if (msg === 'NO_CLIENT_ID') { setStatus('', ''); return; }   // not configured
  if (msg === 'DISCONNECTED') { setStatus('', ''); return; }
  if (msg === 'CELLULAR_BLOCKED') { setStatus('error', '☁ off (cellular)'); return; }
  if (msg === 'OFFLINE') { setStatus('error', '☁ offline'); return; }
  // Not a failure at all — the app went off-screen before we could ask for a
  // token. Retry when it comes back; don't burn a silent-failure slot.
  if (msg === 'BACKGROUNDED') { _syncPendingForeground = true; return; }
  if (/^(REMOTE_|INVALID_|Drive |Failed to fetch|NetworkError)/.test(msg)) {
    setStatus('error', msg.startsWith('REMOTE_') ? '☁ conflict — retry sync' : '☁ sync failed — retry');
    return;
  }
  // Token / OAuth errors: silent prompt failed — needs user action.
  _consecutiveSilentFailures++;
  setStatus('error', '☁ tap to fix');
  // Once this reaches MAX_SILENT_AUTH_FAILURES, autoSyncSuppressed() stops
  // further background attempts until the user taps Sync now.
}

async function startupSync() {
  if (!CFG().autoSyncOnStartup) return;
  if (!(await isEnabled())) return;
  const clientId = await getClientId();
  if (!clientId) return;
  // Surface the pill even when suppressed, or a fresh launch would show no
  // sign at all that sync is broken.
  if (autoSyncSuppressed()) { setStatus('error', '☁ tap to fix'); return; }
  const last = await CWDB.getMeta('lastDriveSync', 0);
  const gap = Date.now() - (last || 0);
  // Short gap only: sync is two-way now, so opening the app is how we find
  // out about edits made on the other device.
  if (gap < 2 * 60 * 1000) return;
  if (!appVisible()) { _syncPendingForeground = true; return; }
  try {
    const res = await syncNow({ interactive: false });
    await afterSync(res);
  } catch (e) {
    handleAutoSyncFailure(e);
  }
}

async function disconnect() {
  _disconnecting++;
  _connectionEpoch++;
  _cancelTokenRequest?.();
  // An HTTP abort cannot undo a write already accepted by Drive. Drain the
  // operation instead, then allow a caller to reset local data under the lock.
  if (_autoSyncTimer) clearTimeout(_autoSyncTimer);
  _autoSyncTimer = null;
  _syncPendingForeground = false;
  try {
    await CWDB.setMeta('driveEnabled', false);
    await _syncQueue;
    resetTokenClient();
    setStatus('', '☁ disconnected');
  } finally { _disconnecting--; }
}

/* Drop any cached token/client so the next sync re-authorizes. Needed when
 * the client ID changes underneath us. */
function resetTokenClient() {
  _tokenClient = null;
  _accessToken = null;
  _tokenExpiry = 0;
  _consecutiveSilentFailures = 0;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- in-app dialog ---------- */

function openSetupDialog(ctx) {
  const { openModal, closeModal, snack, reload, renderCurrent } = ctx;
  (async () => {
    const cfgId = (CFG().driveClientId || '').trim();
    const idbId = await CWDB.getMeta('driveClientId', '');
    const activeId = (idbId || '').trim() || cfgId;
    const last = await CWDB.getMeta('lastDriveSync', 0);
    const connection = await getConnectionState();
    const recovery = await CWDB.getMeta('drivePendingSnapshot');
    const recoveryCopies = recovery?.history || (recovery?.snapshot ? [recovery] : []);
    const wifiState = isOnWifi();
    const wifiLabel = wifiState === true ? 'Wi-Fi' : wifiState === false ? 'Cellular' : 'Unknown';

    openModal(`
      <header><button class="icon-btn" data-close>←</button><div class="title">Google Drive sync</div></header>
      <div class="body">
        ${activeId ? `
          <p>Drive sync is <strong>${connection.enabled ? 'enabled on this device' : 'off until you connect'}</strong>${idbId ? ' (using the Client ID saved on this device)' : ''}.
          Tap <strong>Sync now</strong> and pick your Google account.</p>
          <p class="muted">Sync is <strong>two-way</strong>: each sync
          checks whether the file on Drive changed since your last sync and merges both
          sides (a three-way merge against the last-synced snapshot). Deletions are
          respected; if the same entry was edited on two devices, the most recently
          touched device wins. Avoid syncing two devices at precisely the same time;
          detected concurrent changes are retried, but Drive writes are not atomic across devices.</p>
          <ul>
            <li>Auto-sync on change: ${CFG().autoSyncOnChange ? 'on' : 'off'}</li>
            <li>Auto-sync at startup: ${CFG().autoSyncOnStartup ? 'on' : 'off'}</li>
            <li>Wi-Fi only: ${CFG().wifiOnly ? 'on' : 'off'} (current network: ${wifiLabel})</li>
            <li>Last sync: ${last ? new Date(last).toLocaleString() : 'never'}</li>
            <li>Snapshots kept on Drive: ${DRIVE_MAX_VERSIONS}</li>
          </ul>
        ` : `
          <p>Drive sync is <strong>not configured</strong>.</p>
          <p class="muted">Add an OAuth Client ID below to enable it.
          Export / Import JSON works without any of this.</p>
        `}
        <details ${activeId ? '' : 'open'}>
          <summary class="muted">Advanced: use your own Google project</summary>
          <p class="muted">Backups always go to <em>your own</em> Google
          Drive${cfgId ? `, by default through this app's Google project` : ''}. If you would
          rather authorize through a Google Cloud project you control, paste its OAuth Client
          ID (Web application) here — the README has a walkthrough.
          ${cfgId ? 'Clear the field to go back to the default.' : ''}</p>
          <div class="field">
            <label for="driveClientIdInput">OAuth Client ID</label>
            <input id="driveClientIdInput" type="text" autocomplete="off"
              spellcheck="false" autocapitalize="off" autocorrect="off"
              inputmode="url"
              placeholder="${cfgId ? 'leave empty to use the default' : '1234567890-abc….apps.googleusercontent.com'}"
              value="${esc(idbId)}">
          </div>
        </details>
        <p class="muted">Restore from Drive <em>replaces</em> everything on
        this device with the Drive copy (a safety backup downloads first). Normal
        <strong>Sync now</strong> merges instead.</p>
        <p class="muted">Scope used: <code>drive.file</code> — this app
        can only see / modify files it created (folder
        <code>${DRIVE_FOLDER_NAME}/${DRIVE_FILE_NAME}</code> in your Drive).</p>
        ${connection.recoveryAvailable ? `<p class="muted">${connection.recoveryPending ? 'An unconfirmed sync recovery copy is saved on this device.' : 'Recent sync recovery copies remain on this device, even after successful upload.'}
          Up to ${DRIVE_MAX_VERSIONS} distinct snapshots are retained; this cannot guarantee recovery of every concurrent write. Export a copy before restoring if needed.</p>
          <label for="driveRecoveryVersion">Recovery copy</label>
          <select id="driveRecoveryVersion">${recoveryCopies.map((entry, index) =>
            `<option value="${index}" ${index === recoveryCopies.length - 1 ? 'selected' : ''}>${esc(new Date(entry.savedAt || 0).toLocaleString())} — ${entry.snapshot?.events?.length || 0} events</option>`).join('')}</select>` : ''}
        <p id="driveError" role="alert"></p>
      </div>
      <div class="actions">
        <button class="btn secondary" id="driveSaveId">Save ID</button>
        ${connection.enabled ? '<button class="btn secondary" id="driveDisconnect">Disconnect</button>' : ''}
        ${connection.recoveryAvailable ? '<button class="btn secondary" id="driveRecovery">Export recovery copy</button>' : ''}
        ${activeId ? `<button class="btn secondary" id="driveSyncDown">Restore from Drive</button>` : ''}
        ${activeId ? `<button class="btn" id="driveSyncUp">Sync now</button>` : '<button class="btn" data-close>OK</button>'}
      </div>
    `);
    const buttons = ['driveSaveId', 'driveSyncUp', 'driveSyncDown', 'driveDisconnect', 'driveRecovery'];
    const busy = (pending) => {
      for (const id of buttons) {
        const button = document.getElementById(id);
        if (button) button.disabled = pending;
      }
    };
    const failed = (message) => {
      const el = document.getElementById('driveError');
      if (el) el.textContent = message;
      snack(message);
    };
    busy(connection.pending);
    const refreshBusy = () => {
      if (!document.getElementById('driveSaveId')) {
        window.removeEventListener?.('plotline:sync-status', refreshBusy);
      } else busy(_pendingOperations > 0);
    };
    window.addEventListener('plotline:sync-status', refreshBusy);
    document.getElementById('driveDisconnect')?.addEventListener('click', async () => {
      busy(true);
      try { await disconnect(); closeModal(); snack('Drive disconnected. Your remote backup is unchanged.'); }
      catch (e) { failed(e.message); }
      finally { busy(false); }
    });
    document.getElementById('driveRecovery')?.addEventListener('click', async () => {
      try {
        const selected = Number(document.getElementById('driveRecoveryVersion')?.value ?? recoveryCopies.length - 1);
        const snapshot = recoveryCopies[selected]?.snapshot;
        if (!snapshot) throw new Error('No recovery copy remains');
        const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = 'plotline-sync-recovery.json'; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) { failed(e.message); }
    });
    const save = document.getElementById('driveSaveId');
    if (save) save.addEventListener('click', async () => {
      // Mobile keyboards love to add spaces and capitals. A Google client ID
      // is always lowercase with no whitespace, so normalize both away rather
      // than bounce the user for something they can't see.
      const raw = document.getElementById('driveClientIdInput').value || '';
      const val = raw.replace(/\s+/g, '').toLowerCase();
      if (val && !/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(val)) {
        snack('That does not look like a Client ID — it should end in .apps.googleusercontent.com');
        return;
      }
      await CWDB.setMeta('driveClientId', val || null);
      resetTokenClient();
      closeModal();
      snack(val ? 'Client ID saved — tap Sync now to connect'
        : (cfgId ? 'Using the built-in Client ID' : 'Drive sync disabled'));
    });
    const up = document.getElementById('driveSyncUp');
    if (up) up.addEventListener('click', async () => {
      busy(true);
      try {
        const res = await syncNow({ interactive: true });
        if (res.action === 'merged' && res.changedLocally) {
          await reload(); renderCurrent();
          const st = res.stats || {};
          closeModal();
          snack(`Merged with Drive: ${st.fromRemote || 0} pulled in` +
            (st.conflicts ? `, ${st.conflicts} conflict(s) auto-resolved` : ''));
        } else {
          closeModal();
          snack(res.action === 'merged' ? 'Drive already up to date' : 'Synced to Drive');
        }
      } catch (e) {
        failed('Sync failed: ' + e.message);
      } finally { busy(false); }
    });
    const dn = document.getElementById('driveSyncDown');
    const restore = async () => {
      busy(true);
      try {
        await syncDown({ interactive: true });
        await reload(); renderCurrent();
        closeModal(); snack('Restored from Drive');
      } catch (e) {
        failed('Restore failed: ' + e.message);
      } finally { busy(false); }
    };
    if (dn) dn.addEventListener('click', () => {
      const message = 'Replace all data on this device with the Drive backup? A local safety backup downloads first. Sync now merges instead.';
      if (ctx.openConfirm) ctx.openConfirm('Restore from Drive?', message, restore, 'Replace from Drive');
      else if (window.confirm(message)) restore();
    });
  })();
}

/* ---------- network change → retry queued sync ---------- */
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (_autoSyncTimer) return;
    queueAutoSync('online');
  });
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  conn?.addEventListener?.('change', () => {
    if (wifiOk() && !_autoSyncTimer) queueAutoSync('connection');
  });

  /* ---------- back on screen → run whatever we held over ---------- */
  document.addEventListener?.('visibilitychange', () => {
    if (!appVisible() || !_syncPendingForeground) return;
    _syncPendingForeground = false;
    if (autoSyncSuppressed()) return;
    // Straight through rather than via queueAutoSync(): this is a deferred
    // sync, not a fresh local edit, so it must not restamp lastLocalChangeAt
    // and hand every conflict tie to this device.
    (async () => {
      try {
        const res = await syncNow({ interactive: false });
        await afterSync(res);
      } catch (e) {
        handleAutoSyncFailure(e);
      }
    })();
  });
}

window.CWDRIVE = {
  syncNow, syncUp, syncDown, openSetupDialog, afterSync,
  mergeBackups, mergeCollection,
  queueAutoSync, startupSync,
  disconnect, getConnectionState, markLocalChange, withDataLock,
  isOnWifi, wifiOk,
  hasClientId: async () => !!(await getClientId()),
};
