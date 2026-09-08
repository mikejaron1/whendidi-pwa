/* Plotline - views and application workflows. */

const { openModal, closeModal, openDrawer, closeDrawer, openConfirm, handlePopState,
  snack, escapeHtml, bindAction, reportError } = window.CWUI;

const VIEWS = ['categories', 'recent', 'day', 'stats', 'insights'];
const state = {
  view: 'categories',
  topics: [],
  events: [],
  measurements: [],
  favorites: new Set(),
  topicOrder: [],
  topicKinds: {}, // topicId -> 'timeonly' | 'duration' | 'amount'
  topicMeta: {},  // topicId -> { emoji, color }
  quickBar: [],   // fixed, user-curated ordered list of topic ids for the quick-access bar
  topicRoles: {}, // topicId -> { role: 'focus'|'marker'|'influence', dir, timing }
  topicGoals: {}, // topicId -> { metric, cmp, target, period, since }
  topicPrefs: {},
  dayChecks: {},
  activeTimers: {},
  eventsByTopic: new Map(),
  latestByTopic: new Map(),
  backup: {},
  insightSettings: null,
  insights: null,           // cached result of CWINSIGHTS.analyze()
  insightsDirty: true,      // recompute on next Insights render
  insightOutcome: null,
  insightLag: 0,
  statsTopicId: null,
  statsPeriod: 'daily',
  chart: null,
  // Per-view UI state
  recentFilter: { topic: '', from: '', to: '', q: '', tag: '' },
  dayDate: null,            // ms epoch (start of day)
  detailTopicId: null,      // currently-open detail view (in Stats)
  charts: {},               // multiple chart instances on Stats page
  // Undo queue
  lastUndo: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ======== UTILITIES ======== */

function pad(n) { return String(n).padStart(2, '0'); }

function fmtDateShort(ts) {
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  const wk = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return `${wk[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function fmtDateLong(ts) {
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = pad(d.getMinutes());
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function fmtTimeInput(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function parseDateTimeInput(dateStr, timeStr) {
  // dateStr: YYYY-MM-DD, timeStr: HH:MM
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

function relativeFromNow(ts) {
  const now = Date.now();
  const delta = Math.max(0, now - ts);
  const sec = Math.floor(delta / 1000);
  const min = Math.floor(sec / 60);
  const hr  = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (sec < 60) return { big: `${sec}`, small: 'secs ago' };
  if (min < 60) return { big: `${min}`, small: 'mins ago' };
  if (hr < 24) {
    const m = min % 60;
    return { big: `${hr}:${pad(m)}`, small: 'hh:mm ago' };
  }
  if (day < 60) return { big: `${day}`, small: 'days ago' };
  const mth = Math.floor(day / 30);
  const days = day - mth * 30;
  return { big: `${mth} - ${days}`, small: 'mths - days ago' };
}

/* Format an event's qant for display based on its topic's measurement. */
function fmtQant(qant, topic) {
  const kind = state.topicKinds?.[topic?.id] || inferKind(topic);
  if (kind === 'timeonly') return ''; // don't show "1m" for timestamps
  const m = state.measurements.find((m) => m.id === topic?.msureid);
  if (!m) return String(qant ?? '');
  // type 3 = time-based; qant is in seconds (per observed data)
  if (m.type === 3) {
    const secs = Number(qant || 0);
    const h = Math.floor(secs / 3600);
    const mn = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (m.format === 7) {
      // mm:ss
      const totalMin = Math.floor(secs / 60);
      return `${pad(totalMin)}:${pad(s)}`;
    }
    if (m.format === 6) {
      // hh:mm:ss
      return `${h}:${pad(mn)}:${pad(s)}`;
    }
    if (m.format === 4) {
      // hours
      return `${(secs/3600).toFixed(1)} ${m.symbol}`;
    }
    if (m.format === 3) {
      // minutes
      return `${Math.round(secs/60)} ${m.symbol}`;
    }
    if (m.format === 2) {
      // seconds
      return `${secs} ${m.symbol}`;
    }
    // default Duration hh:mm: if seconds == 60 just show "1m"
    if (h === 0 && mn < 1) return `${mn}m`;
    if (h === 0) return `${mn}m`;
    return `${h}:${pad(mn)}`;
  }
  // unit-based: raw number + symbol
  const sym = m.symbol || '';
  return `${qant}${sym ? ' ' + sym : ''}`;
}

/* Infer a topic kind from its measurement when no explicit kind set. */
function inferKind(topic) {
  if (!topic) return 'amount';
  const m = state.measurements.find((mm) => mm.id === topic.msureid);
  if (!m) return 'amount';
  if (m.type === 3) return 'duration';  // imported duration topics
  return 'amount';
}

function topicKind(topic) {
  return state.topicKinds?.[topic?.id] || inferKind(topic);
}

/* ======== DATA LOADING ======== */

async function reload() {
  const [topics, events, measurements, favIds, topicKinds, topicMeta,
         topicRoles, insightSettings, topicGoals, topicPrefs, dayChecks,
         activeTimers, lastExport, lastDriveSync, lastLocalChangeAt, driveEnabled,
         reorderHintHidden] = await Promise.all([
    CWDB.getAll('topics'),
    CWDB.getAll('events'),
    CWDB.getAll('measurements'),
    CWDB.getFavoriteTopicIds(),
    CWDB.getAllTopicKinds(),
    CWDB.getAllTopicMeta(),
    CWDB.getTopicRoles(),
    CWDB.getInsightSettings(),
    CWDB.getTopicGoals(),
    CWDB.getMeta('topicPrefs', {}),
    CWDB.getMeta('dayChecks', {}),
    CWDB.getMeta('activeTimers', {}),
    CWDB.getMeta('lastExport', 0),
    CWDB.getMeta('lastDriveSync', 0),
    CWDB.getMeta('lastLocalChangeAt', 0),
    CWDB.getMeta('driveEnabled'),
    CWDB.getMeta('reorderHintHidden', false),
  ]);
  const savedOrder = (await CWDB.getMeta('topicOrder')) || [];
  const knownIds = new Set(topics.map((t) => t.id));
  const orderedKnown = [...new Set(savedOrder.filter((id) => knownIds.has(id)))];
  const orderedSet = new Set(orderedKnown);
  const rest = topics
    .filter((t) => !orderedSet.has(t.id))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map((t) => t.id);
  const finalOrder = [...orderedKnown, ...rest];
  state.topicOrder = finalOrder;
  const byId = new Map(topics.map((t) => [t.id, t]));
  state.topics = finalOrder.map((id) => byId.get(id)).filter(Boolean);
  state.events = events;
  state.eventsByTopic = new Map();
  state.latestByTopic = new Map();
  for (const event of events) {
    if (!state.eventsByTopic.has(event.topicid)) state.eventsByTopic.set(event.topicid, []);
    state.eventsByTopic.get(event.topicid).push(event);
    const previous = state.latestByTopic.get(event.topicid);
    if (!previous || previous.time < event.time) state.latestByTopic.set(event.topicid, event);
  }
  state.measurements = measurements;
  state.favorites = new Set(favIds);
  state.topicKinds = { ...(topicKinds || {}) };
  for (const topic of state.topics) {
    if (!state.topicKinds[topic.id]) state.topicKinds[topic.id] = inferKind(topic);
  }
  state.topicMeta = topicMeta || {};
  state.topicRoles = topicRoles || {};
  state.topicGoals = topicGoals || {};
  state.topicPrefs = topicPrefs || {};
  state.dayChecks = dayChecks || {};
  state.activeTimers = activeTimers || {};
  state.backup = { lastExport, lastDriveSync, lastLocalChangeAt,
    driveEnabled: driveEnabled ?? !!lastDriveSync };
  state.reorderHintHidden = reorderHintHidden;
  state.insightSettings = insightSettings;
  state.insightsDirty = true;
  // Quick-access bar: keep only ids that still map to existing, non-archived topics.
  const savedQuick = (await CWDB.getMeta('quickBar')) || [];
  const validQuick = Array.isArray(savedQuick)
    ? savedQuick.filter((id) => {
        const t = byId.get(id);
        return t && !t.archived;
      })
    : [];
  state.quickBar = validQuick;
  if (state.statsTopicId == null && state.topics.length) {
    state.statsTopicId = state.topics[0].id;
  }
}

async function saveTopicOrder(orderIds) {
  state.topicOrder = orderIds.slice();
  await CWDB.setMeta('topicOrder', state.topicOrder);
  // re-sort in-memory state.topics to match
  const byId = new Map(state.topics.map((t) => [t.id, t]));
  state.topics = orderIds.map((id) => byId.get(id)).filter(Boolean);
  // any topics not in orderIds (shouldn't happen but defensive)
  for (const t of byId.values()) {
    if (!orderIds.includes(t.id)) state.topics.push(t);
  }
  queueAutoSync();
}

/* The per-topic event index is rebuilt after each committed mutation. */
function goalFor(topic) {
  const goal = topic && state.topicGoals?.[topic.id];
  if (!goal) return null;
  return CWGOALS.evaluate({
    events: state.eventsByTopic.get(topic.id) || [],
    goal,
    kind: topicKind(topic),
    cutoffHour: insightsSettings().cutoffHour,
    topicPrefs: state.topicPrefs,
    topicId: topic.id,
    dayChecks: state.dayChecks,
  });
}

function topicMeasurement(topic) {
  return state.measurements.find((m) => m.id === topic?.msureid) || null;
}

function lastEventForTopic(topicid) {
  return state.latestByTopic.get(topicid) || null;
}

function logicalDay(ts = Date.now()) {
  return CWINSIGHTS.dayKey(ts, insightsSettings().cutoffHour);
}

function dayBounds(key) {
  const cutoff = insightsSettings().cutoffHour;
  return [CWSTATS.dayBoundary(key, cutoff), CWSTATS.dayBoundary(CWSTATS.addDays(key, 1), cutoff)];
}

function topicPrefs(topic) {
  return state.topicPrefs[topic.id] || {};
}

function measurementsByTopic() {
  const byId = new Map(state.measurements.map((measurement) => [measurement.id, measurement]));
  return Object.fromEntries(state.topics.map((topic) => [topic.id, byId.get(topic.msureid) || {}]));
}

function measuredValue(events, topic) {
  if (!events.length) return null;
  const aggregation = topicKind(topic) === 'amount' ? topicPrefs(topic).aggregation || 'sum' : 'sum';
  if (aggregation === 'latest') {
    return Number(events.reduce((latest, event) => event.time >= latest.time ? event : latest).qant || 0);
  }
  const total = events.reduce((sum, event) => sum + Number(event.qant || 0), 0);
  return total / (aggregation === 'mean' ? events.length : 1);
}

function backupHealthHtml() {
  const backup = state.backup;
  const latest = Math.max(backup.lastExport || 0, backup.lastDriveSync || 0);
  const pending = latest && backup.lastLocalChangeAt > latest;
  const text = !latest ? 'Not backed up yet'
    : pending ? 'Changes waiting for backup'
    : `Last ${backup.lastDriveSync >= backup.lastExport ? 'synced' : 'exported'} ${fmtDateLong(latest)}`;
  return `<div class="backup-health"><span>${escapeHtml(text)}</span>
    <button class="btn secondary small" id="backupHealthAction">${backup.driveEnabled ? 'Sync now' : 'Back up'}</button></div>`;
}

function bindBackupHealth() {
  bindAction($('#backupHealthAction'), async () => {
    if (state.backup.driveEnabled) {
      const result = await CWDRIVE.syncNow({ interactive: true });
      await CWDRIVE.afterSync(result);
      await reload(); renderCurrent();
    } else openDrive();
  });
}

function dayCheckHtml(key) {
  const date = fmtDateInput(key);
  const current = state.dayChecks[date] || '';
  return `<div class="today-checkin">
    <label for="dayCheck">Logging for ${escapeHtml(fmtDateLong(key))}</label>
    <select id="dayCheck">
      <option value="" ${!current ? 'selected' : ''}>Not confirmed</option>
      <option value="complete" ${current === 'complete' ? 'selected' : ''}>Logged everything</option>
      <option value="none" ${current === 'none' ? 'selected' : ''}>Nothing happened</option>
      <option value="incomplete" ${current === 'incomplete' ? 'selected' : ''}>Incomplete / missed logging</option>
    </select>
    <p class="muted-small">Missing logs are not proof that nothing happened. This check-in covers all topics.</p>
  </div>`;
}

function bindDayCheck(key) {
  bindAction($('#dayCheck'), async (event) => {
    const value = event.target.value;
    const [start, end] = dayBounds(key);
    if (value === 'none' && state.events.some((e) => e.time >= start && e.time < end)) {
      throw new Error('This day has entries. Choose "Logged everything" or "Incomplete" instead.');
    }
    const checks = { ...state.dayChecks };
    const date = fmtDateInput(key);
    if (value) checks[date] = value;
    else delete checks[date];
    await CWDB.setMeta('dayChecks', checks);
  }, { event: 'change', mutation: true });
}

function timerHtml(topic) {
  const started = state.activeTimers[topic.id];
  if (!started) return '';
  return `<div class="timer-panel"><span data-timer-start="${started}">${escapeHtml(CWSTATS.fmtIntervalShort(Date.now() - started))} running</span>
    <button type="button" class="btn secondary small" data-stop-timer="${topic.id}">Stop &amp; save</button></div>`;
}

async function startTimer(topic) {
  const started = Date.now();
  await CWMODEL.mutate(() => CWDB.startTimer(topic.id, started));
  snack(`Timer started for ${topic.name}`);
}

async function stopTimer(topic) {
  const stopped = Date.now();
  await CWMODEL.mutate(async () => {
    const event = await CWDB.finishTimer(topic.id, stopped);
    snack(`Saved ${topic.name} timer`, { undo: () => CWMODEL.mutate(() => CWDB.delete('events', event.id)) });
  });
}

function refreshLiveLabels() {
  $$('[data-elapsed]').forEach((element) => {
    const rel = relativeFromNow(Number(element.dataset.elapsed));
    element.innerHTML = `<div class="big">${rel.big}</div><div class="small">${rel.small}</div>`;
  });
  $$('[data-timer-start]').forEach((element) => {
    element.textContent = `${CWSTATS.fmtIntervalShort(Date.now() - Number(element.dataset.timerStart))} running`;
  });
}

/* ======== VIEW: CATEGORIES (default home) ======== */

function welcomeBannerHtml() {
  return `
    <div class="banner">
      <span>👋 Welcome! Import an existing JSON backup to load your data, or start fresh by adding topics.</span>
      <button class="btn" id="welcomeImport">Import…</button>
    </div>
  `;
}

function bindWelcomeBanner() {
  const btn = $('#welcomeImport');
  if (btn) btn.addEventListener('click', () => triggerImport());
}

/* ======== VIEW: CATEGORIES ======== */

function frequentTopicsLast30Days() {
  const cutoff = Date.now() - 30 * 86400000;
  const counts = new Map();
  for (const e of state.events) {
    if (e.time < cutoff) continue;
    counts.set(e.topicid, (counts.get(e.topicid) || 0) + 1);
  }
  const ranked = Array.from(counts.entries())
    .map(([id, c]) => ({ id, c, topic: state.topics.find((t) => t.id === id) }))
    .filter((r) => r.topic && !r.topic.archived)
    .sort((a, b) => b.c - a.c)
    .slice(0, 5);
  return ranked;
}

/* Topics to show in the quick-access bar, in fixed order.
 * Returns the user-curated list when configured; otherwise null to signal
 * that the auto "frequent topics" fallback should be used. */
function quickBarList() {
  const ids = state.quickBar || [];
  if (!ids.length) return null;
  const byId = new Map(state.topics.map((t) => [t.id, t]));
  return ids
    .map((id) => byId.get(id))
    .filter((t) => t && !t.archived)
    .map((t) => ({ id: t.id, topic: t }));
}

function renderCategories() {
  const main = $('#main');
  const topics = state.topics.filter((t) => !t.archived);
  if (!topics.length) {
    main.innerHTML = `
      ${backupHealthHtml()}
      ${welcomeBannerHtml()}
      <div class="empty">
        <p>${state.topics.length ? 'All topics are archived. Your history is still saved.' : 'No topics yet.'}</p>
        <button class="btn" id="emptyAddTopic">Add a topic</button>
        ${state.topics.length ? '<button class="btn secondary" id="emptyManage">Manage topics</button>' : ''}
      </div>`;
    bindBackupHealth();
    bindWelcomeBanner();
    $('#emptyAddTopic')?.addEventListener('click', () => openTopicEdit(null));
    $('#emptyManage')?.addEventListener('click', openTopicsManager);
    return;
  }

  const manual = quickBarList();
  const frequent = manual !== null ? manual : frequentTopicsLast30Days();
  const quickBar = frequent.length ? `
    <div class="quick-bar">
      ${frequent.map((f) => {
        const emoji = topicEmoji(f.topic);
        const color = topicColor(f.topic);
        return `<button class="quick-chip" data-quick="${f.id}" style="--accent:${color}">
          ${emoji ? `<span class="qc-emoji">${escapeHtml(emoji)}</span>` : ''}
          <span class="qc-name">${escapeHtml(quickLabel(f.topic))}</span>
        </button>`;
      }).join('')}
    </div>` : '';

  const html = topics.map((t) => {
    const last = lastEventForTopic(t.id);
    const rel = last ? relativeFromNow(last.time) : null;
    const emoji = topicEmoji(t);
    const color = topicColor(t);
    const lastLine = last
      ? `${fmtDateShort(last.time)} <strong>${escapeHtml(fmtQant(last.qant, t))}</strong>`
      : '<em>no entries yet</em>';
    return `
      <div class="card" data-topic="${t.id}" style="--accent:${color}">
        <div class="delta" ${last ? `data-elapsed="${last.time}"` : ''}>
          ${rel ? `<div class="big">${rel.big}</div><div class="small">${rel.small}</div>` : `<div class="small">—</div>`}
        </div>
        <div>
          <div class="name">${emoji ? `<span class="card-emoji">${escapeHtml(emoji)}</span>` : ''}${escapeHtml(t.name)}</div>
          ${t.desc ? `<div class="desc">${escapeHtml(t.desc)}</div>` : ''}
          <div class="last">${lastLine}</div>
          ${goalChipHtml(t)}
          ${timerHtml(t)}
        </div>
        <div class="actions">
          <button class="add-btn" data-add="${t.id}" aria-label="Log ${escapeHtml(t.name)}">Log…</button>
        </div>
      </div>
    `;
  }).join('');

  main.innerHTML = `
    ${backupHealthHtml()}
    ${quickBar}
    ${state.reorderHintHidden ? '' : '<div class="reorder-hint">Log an entry, or long-press a card to reorder. Edit topics in Menu → Manage topics. <button class="btn secondary small" id="hideReorderHint">Got it</button></div>'}
    ${dayCheckHtml(logicalDay())}
    <div id="categoriesList">${html}</div>
    <button class="new-topic-tile" id="addTopicBtn">+ New topic</button>
  `;
  bindBackupHealth();
  bindDayCheck(logicalDay());
  bindAction($('#hideReorderHint'), async () => {
    await CWDB.setMeta('reorderHintHidden', true);
    state.reorderHintHidden = true;
    renderCategories();
  });
  $$('[data-stop-timer]').forEach((button) => bindAction(button, () =>
    stopTimer(state.topics.find((topic) => topic.id === Number(button.dataset.stopTimer)))));

  // Quick-bar one-tap log
  $$('[data-quick]').forEach((btn) => {
    bindAction(btn, (e) => {
      const id = Number(e.currentTarget.dataset.quick);
      const topic = state.topics.find((t) => t.id === id);
      if (topic) return logNow(topic);
    });
  });

  $$('[data-add]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(e.currentTarget.dataset.add);
      const topic = state.topics.find((t) => t.id === id);
      openAddEvent(topic);
    });
  });

  $$('[data-goal]').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(e.currentTarget.dataset.goal);
      const topic = state.topics.find((t) => t.id === id);
      if (topic) openGoalEdit(topic);
    });
  });

  attachReorder($('#categoriesList'), (newOrderIds) => {
    CWMODEL.mutate(() => saveTopicOrder(newOrderIds)).catch(reportError);
  });

  $('#addTopicBtn').addEventListener('click', () => openTopicEdit(null));
}

/* Compact streak chip shown under a topic on the home screen. This is the
 * habit-tracking payoff, so it has to read at a glance: the streak number,
 * and whether today is already safe, still open, or blown. */
function goalChipHtml(topic) {
  const res = goalFor(topic);
  if (!res) return '';
  const g = res.activeGoal || res.goal;
  const m = topicMeasurement(topic);
  const unit = CWGOALS.PERIODS.find((p) => p.key === g.period);
  const noun = res.current === 1 ? unit.label : unit.plural;

  let cls, icon, text;
  const currentPeriod = res.periods[res.periods.length - 1];
  if (currentPeriod?.paused || currentPeriod?.status === 'paused') {
    cls = 'open'; icon = '⏸';
    text = 'This period is paused';
  } else if (currentPeriod?.partial || currentPeriod?.status === 'partial') {
    cls = 'open'; icon = '○';
    text = 'Partial period — not rated';
  } else if (currentPeriod?.status === 'unknown') {
    cls = 'open'; icon = '○';
    text = 'Confirm logging to assess this period';
  } else if (g.cmp === 'lte' && !res.met) {
    cls = 'miss'; icon = '⚠️';
    text = `Over limit — ${escapeHtml(CWGOALS.fmtValue(res.value, g, m))} (max ${escapeHtml(CWGOALS.fmtValue(g.target, g, m))})`;
  } else if (res.pending) {
    cls = 'open'; icon = '⭕';
    const left = CWGOALS.fmtValue(res.remaining, g, m);
    text = res.current
      ? `${res.current} ${noun} · ${escapeHtml(left)} to go`
      : `${escapeHtml(left)} to go ${g.period === 'day' ? 'today' : 'this week'}`;
  } else {
    cls = res.current >= 3 ? 'hot' : 'ok';
    icon = res.current >= 3 ? '🔥' : '✅';
    text = res.current
      ? `${res.current} ${res.excludedPeriods ? 'observed ' : ''}${noun}${g.cmp === 'lte' ? ' within limit' : res.excludedPeriods ? ' meeting goal' : ' in a row'}`
      : 'Goal met';
  }
  return `<button class="goal-chip ${cls}" data-goal="${topic.id}"><span>${icon}</span>${text}</button>`;
}

/* Long-press to drag, pointermove to reorder live. */
function attachReorder(listEl, onCommit) {
  let drag = null;
  let pressTimer = null;
  let startX = 0, startY = 0;
  let pressedCard = null;
  let pointerId = null;

  const clearHighlight = () => {
    $$('.card.drag-target-above', listEl).forEach((el) => el.classList.remove('drag-target-above'));
    $$('.card.drag-target-below', listEl).forEach((el) => el.classList.remove('drag-target-below'));
  };

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const card = e.target.closest('.card');
    if (!card || !listEl.contains(card)) return;
    // Don't initiate reorder if the user is touching an interactive child
    if (e.target.closest('button')) return;
    pressedCard = card;
    startX = e.clientX; startY = e.clientY;
    pointerId = e.pointerId;
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      startDrag(card);
    }, 380);
  };

  const startDrag = (card) => {
    drag = { card };
    card.classList.add('dragging');
    // Lock touch handling so the page can't scroll out from under us
    document.body.classList.add('drag-active');
    try { card.setPointerCapture(pointerId); } catch (_) {}
    if (navigator.vibrate) navigator.vibrate(25);
  };

  const onPointerMove = (e) => {
    if (pressTimer) {
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (dx > 10 || dy > 10) {
        clearTimeout(pressTimer); pressTimer = null;
      }
    }
    if (!drag) return;
    e.preventDefault();
    // Find which card is under the pointer (excluding the dragging one)
    const els = document.elementsFromPoint(e.clientX, e.clientY);
    const target = els.find((el) => el.classList?.contains('card') && el !== drag.card && listEl.contains(el));
    clearHighlight();
    if (target) {
      const rect = target.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      target.classList.add(above ? 'drag-target-above' : 'drag-target-below');
      if (above) listEl.insertBefore(drag.card, target);
      else listEl.insertBefore(drag.card, target.nextElementSibling);
    }
  };

  const onPointerUp = (e) => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (!drag) { pressedCard = null; return; }
    drag.card.classList.remove('dragging');
    document.body.classList.remove('drag-active');
    clearHighlight();
    drag.card.dataset.justDragged = '1';
    const newOrder = Array.from(listEl.children).map((c) => Number(c.dataset.topic));
    drag = null;
    onCommit(newOrder);
  };

  const onPointerCancel = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (drag) {
      drag.card.classList.remove('dragging');
      document.body.classList.remove('drag-active');
      clearHighlight();
      drag = null;
    }
  };

  listEl.addEventListener('pointerdown', onPointerDown);
  listEl.addEventListener('pointermove', onPointerMove);
  listEl.addEventListener('pointerup', onPointerUp);
  listEl.addEventListener('pointercancel', onPointerCancel);
}

/* ======== VIEW: RECENT ======== */

function renderRecent() {
  const main = $('#main');
  if (!state.events.length) {
    main.innerHTML = `${welcomeBannerHtml()}<div class="empty">No events logged yet.</div>`;
    bindWelcomeBanner();
    return;
  }
  const f = state.recentFilter;
  const topicById = new Map(state.topics.map((t) => [t.id, t]));
  // Filter
  let filtered = state.events;
  if (f.topic) filtered = filtered.filter((e) => e.topicid === Number(f.topic));
  if (f.from) {
    const fromMs = dayBounds(new Date(f.from + 'T00:00:00').getTime())[0];
    filtered = filtered.filter((e) => e.time >= fromMs);
  }
  if (f.to) {
    const toMs = dayBounds(new Date(f.to + 'T00:00:00').getTime())[1];
    filtered = filtered.filter((e) => e.time < toMs);
  }
  if (f.q) {
    const q = f.q.toLowerCase();
    filtered = filtered.filter((e) => {
      const topic = topicById.get(e.topicid);
      const tname = topic ? topic.name.toLowerCase() : '';
      const note = (e.note || '').toLowerCase();
      return note.includes(q) || tname.includes(q);
    });
  }
  if (f.tag) {
    const tag = f.tag.toLowerCase();
    filtered = filtered.filter((e) => CWSTATS.tagSet(e.note || '').has(tag));
  }
  const sorted = filtered.slice().sort((a, b) => b.time - a.time);

  // Build the filter bar
  const topicOpts = `<option value="">All topics</option>` +
    state.topics.map((t) => `<option value="${t.id}" ${String(t.id)===f.topic?'selected':''}>${escapeHtml(t.name)}</option>`).join('');
  const tags = CWSTATS.allTagsFromEvents(state.events).slice(0, 12);
  const tagBar = tags.length ? `
    <div class="recent-tag-row">
      <button class="tag-filter-chip ${!f.tag?'active':''}" data-tag-filter="">all</button>
      ${tags.map((t) => `<button class="tag-filter-chip ${f.tag===t.tag?'active':''}" data-tag-filter="${escapeHtml(t.tag)}">#${escapeHtml(t.tag)} <small>(${t.count})</small></button>`).join('')}
    </div>` : '';

  let shown = Math.min(200, sorted.length);
  const renderList = () => {
    const rows = sorted.slice(0, shown).map((e) => {
      const t = topicById.get(e.topicid);
      const name = t ? t.name : `(topic ${e.topicid})`;
      const qant = t ? fmtQant(e.qant, t) : e.qant;
      const emoji = t ? topicEmoji(t) : '';
      return `
        <div class="recent-row" data-event="${e.id}" role="button" tabindex="0" aria-label="Edit ${escapeHtml(name)}, ${escapeHtml(fmtDateLong(e.time))}">
          <div>
            <div class="r-name">${emoji ? `<span class="card-emoji">${escapeHtml(emoji)}</span>` : ''}${escapeHtml(name)} ${severityBadge(e)}</div>
            <div class="r-when">${fmtDateLong(e.time)} <small>${fmtTime(e.time)}</small></div>
            ${e.note ? `<div class="r-note">${renderNoteWithTags(e.note)}</div>` : ''}
          </div>
          <div class="r-qant">${escapeHtml(qant)}</div>
        </div>
      `;
    }).join('');
    const more = (shown < sorted.length)
      ? `<div style="text-align:center;padding:14px;"><button class="btn secondary" id="loadMore">Load ${Math.min(200, sorted.length - shown)} more (${sorted.length - shown} remaining)</button></div>`
      : (sorted.length ? `<div class="empty">— end of ${sorted.length.toLocaleString()} matching events —</div>` : `<div class="empty">No events match the filters.</div>`);
    main.innerHTML = `
      <div class="recent-filter">
        <div class="row-2">
          <div class="field"><label>Topic</label><select id="rfTopic">${topicOpts}</select></div>
          <div class="field"><label>Search</label><input id="rfQuery" type="text" placeholder="text in note or topic" value="${escapeHtml(f.q)}"></div>
        </div>
        <div class="row-2">
          <div class="field"><label>From</label><input id="rfFrom" type="date" value="${escapeHtml(f.from)}"></div>
          <div class="field"><label>To</label><input id="rfTo" type="date" value="${escapeHtml(f.to)}"></div>
        </div>
        ${tagBar}
        <div class="recent-filter-actions">
          <button class="btn secondary" id="rfClear">Clear</button>
          <button class="btn" id="rfApply">Apply</button>
        </div>
      </div>
      <div class="sticky-header">${sorted.length.toLocaleString()} matching · showing ${Math.min(shown, sorted.length).toLocaleString()}</div>
      ${rows}
      ${more}
    `;
    $('#loadMore')?.addEventListener('click', () => {
      shown = Math.min(shown + 200, sorted.length);
      renderList();
    });
    $$('.recent-row').forEach((row) => {
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); }
      });
      row.addEventListener('click', () => {
        const id = Number(row.dataset.event);
        const e = state.events.find((x) => x.id === id);
        const t = topicById.get(e?.topicid);
        if (t && e) openAddEvent(t, e);
      });
    });
    $('#rfApply')?.addEventListener('click', () => {
      state.recentFilter = {
        topic: $('#rfTopic').value,
        q: $('#rfQuery').value.trim(),
        from: $('#rfFrom').value,
        to: $('#rfTo').value,
        tag: state.recentFilter.tag,
      };
      renderRecent();
    });
    $('#rfClear')?.addEventListener('click', () => {
      state.recentFilter = { topic: '', q: '', from: '', to: '', tag: '' };
      renderRecent();
    });
    $$('[data-tag-filter]').forEach((b) => b.addEventListener('click', () => {
      state.recentFilter = { ...state.recentFilter, tag: b.dataset.tagFilter };
      renderRecent();
    }));
    CWUI.labelControls(main);
  };
  renderList();
}

/* ======== VIEW: DAY ======== */

function renderDay() {
  const main = $('#main');
  if (state.dayDate == null) state.dayDate = logicalDay();
  const day = state.dayDate;
  const [dayStart, nextDay] = dayBounds(day);
  const events = state.events
    .filter((e) => e.time >= dayStart && e.time < nextDay)
    .sort((a, b) => a.time - b.time);

  const topicById = new Map(state.topics.map((t) => [t.id, t]));

  // Per-topic summary
  const groupMap = new Map();
  for (const e of events) {
    if (!groupMap.has(e.topicid)) groupMap.set(e.topicid, []);
    groupMap.get(e.topicid).push(e);
  }
  const groups = Array.from(groupMap.entries())
    .map(([tid, evs]) => ({ topic: topicById.get(tid), evs }))
    .filter((g) => g.topic)
    .sort((a, b) => b.evs.length - a.evs.length);

  const dateStr = fmtDateLong(day);
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(day).getDay()];
  const isToday = day === logicalDay();
  const todayLabel = isToday ? 'Today' : (day === CWINSIGHTS.addDays(logicalDay(), -1) ? 'Yesterday' : '');

  // Chronological list
  const chronoHtml = events.map((e) => {
    const t = topicById.get(e.topicid);
    const name = t ? t.name : `(${e.topicid})`;
    const emoji = t ? topicEmoji(t) : '';
    const q = t ? fmtQant(e.qant, t) : e.qant;
    return `
      <div class="day-event" data-event="${e.id}" role="button" tabindex="0" aria-label="Edit ${escapeHtml(name)} at ${escapeHtml(fmtTime(e.time))}">
        <div class="day-time">${fmtTime(e.time)}</div>
        <div class="day-info">
          <div class="day-name">${emoji ? `<span class="card-emoji">${escapeHtml(emoji)}</span>` : ''}${escapeHtml(name)} ${severityBadge(e)}</div>
          ${e.note ? `<div class="day-note">${renderNoteWithTags(e.note)}</div>` : ''}
        </div>
        <div class="day-qant">${escapeHtml(q)}</div>
      </div>`;
  }).join('') || '<div class="empty">No events on this day.</div>';

  // Per-topic summary cards
  const summaryHtml = groups.map((g) => {
    const t = g.topic;
    const emoji = topicEmoji(t);
    const color = topicColor(t);
    const kind = topicKind(t);
    let qantSummary = '';
    if (kind === 'amount' || kind === 'duration') {
      const label = kind === 'amount' ? topicPrefs(t).aggregation || 'sum' : 'sum';
      qantSummary = ` · ${label} ${escapeHtml(fmtQant(measuredValue(g.evs, t), t))}`;
    }
    const times = g.evs.map((e) => fmtTime(e.time)).join(', ');
    return `
      <div class="day-summary-row" style="--accent:${color}">
        <div class="dsr-head">
          <span class="dsr-name">${emoji ? `<span class="card-emoji">${escapeHtml(emoji)}</span>` : ''}${escapeHtml(t.name)}</span>
          <span class="dsr-count">${g.evs.length}×${qantSummary}</span>
        </div>
        <div class="dsr-times">${escapeHtml(times)}</div>
      </div>`;
  }).join('');

  main.innerHTML = `
    <div class="day-nav">
      <button class="icon-btn day-prev" id="dayPrev" aria-label="Previous day">‹</button>
      <div class="day-title">
        <div class="dt-main">${dow}, ${dateStr}</div>
        ${todayLabel ? `<div class="dt-sub">${todayLabel}</div>` : ''}
      </div>
      <button class="icon-btn day-next" id="dayNext" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
      <input type="date" id="dayPick" aria-label="Choose day" max="${fmtDateInput(logicalDay())}" value="${fmtDateInput(day)}">
    </div>
    <p class="muted-small">Day runs from ${escapeHtml(CWINSIGHTS.fmtHour(insightsSettings().cutoffHour))} to the same time tomorrow.</p>
    ${dayCheckHtml(day)}
    <div class="day-stats-strip">
      <div><b>${events.length}</b><span>events</span></div>
      <div><b>${groups.length}</b><span>topics</span></div>
      <div><b>${events.filter((e) => Number(e.cost||0) >= 3).length}</b><span>severity 3+</span></div>
    </div>
    ${groups.length ? `<div class="day-section-h">Per topic</div>${summaryHtml}` : ''}
    <div class="day-section-h">Timeline</div>
    ${chronoHtml}
  `;
  bindDayCheck(day);

  $('#dayPrev').addEventListener('click', () => {
    state.dayDate = CWINSIGHTS.addDays(state.dayDate, -1);
    renderDay();
  });
  $('#dayNext').addEventListener('click', () => {
    state.dayDate = Math.min(CWINSIGHTS.addDays(state.dayDate, 1), logicalDay());
    renderDay();
  });
  $('#dayPick').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v) {
      const [y, mo, d] = v.split('-').map(Number);
      state.dayDate = Math.min(new Date(y, mo - 1, d).getTime(), logicalDay());
      renderDay();
    }
  });
  $$('.day-event').forEach((row) => {
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); }
    });
    row.addEventListener('click', () => {
    const id = Number(row.dataset.event);
    const ev = state.events.find((x) => x.id === id);
    const t = topicById.get(ev?.topicid);
    if (ev && t) openAddEvent(t, ev);
    });
  });
}

/* ======== VIEW: STATISTICS (per-topic detail) ======== */

function destroyCharts() {
  for (const c of Object.values(state.charts)) {
    try { c?.destroy(); } catch (_) {}
  }
  state.charts = {};
}

function renderStats() {
  destroyCharts();
  const main = $('#main');
  if (!state.topics.length) {
    main.innerHTML = `${welcomeBannerHtml()}<div class="empty">Import data or add a topic to see statistics.</div>`;
    bindWelcomeBanner();
    return;
  }
  const topics = state.topics.filter((t) => !t.archived);
  if (!topics.length) {
    main.innerHTML = '<div class="empty"><p>All your topics are archived. Your history is still saved.</p><button class="btn" id="manageArchived">Manage topics</button></div>';
    $('#manageArchived').addEventListener('click', openTopicsManager);
    return;
  }
  if (state.statsTopicId == null || !topics.find((t) => t.id === state.statsTopicId)) {
    state.statsTopicId = topics[0]?.id;
  }
  const topic = topics.find((t) => t.id === state.statsTopicId);
  const events = state.eventsByTopic.get(topic.id) || [];
  const measurement = state.measurements.find((m) => m.id === topic?.msureid);
  const kind = topicKind(topic);
  const isMeasurable = kind === 'amount' || kind === 'duration';
  const totalQant = measuredValue(events, topic);
  const totalQantStr = isMeasurable ? fmtQant(totalQant, topic) : '';

  // Build the top selector + period tabs
  const topOpts = topics.map((t) => `<option value="${t.id}" ${t.id===topic.id?'selected':''}>${escapeHtml(t.name)}</option>`).join('');

  // Interval stats
  const iv = CWSTATS.intervalStats(events);
  const intervalSummary = iv ? `
    <div class="stats-cards">
      <div><b>${events.length.toLocaleString()}</b><span>events</span></div>
      <div><b>${CWSTATS.fmtIntervalShort(iv.avg)}</b><span>avg interval</span></div>
      <div><b>${CWSTATS.fmtIntervalShort(iv.median)}</b><span>median</span></div>
      <div><b>${CWSTATS.fmtIntervalShort(iv.min)}</b><span>min</span></div>
      <div><b>${CWSTATS.fmtIntervalShort(iv.max)}</b><span>max</span></div>
      <div><b>${CWSTATS.fmtIntervalShort(iv.last)}</b><span>since last</span></div>
      ${isMeasurable ? `<div><b>${escapeHtml(totalQantStr)}</b><span>${escapeHtml(kind === 'amount' ? topicPrefs(topic).aggregation || 'sum' : 'total')}</span></div>` : ''}
    </div>` : `<div class="stats-cards"><div><b>${events.length}</b><span>events</span></div></div>`;

  // Cross-topic correlations
  const correlations = CWSTATS.correlations(state.events, topic.id, 24 * 3600 * 1000);
  const corrRows = correlations.slice(0, 8).map((c) => {
    const other = state.topics.find((t) => t.id === c.otherTopicId);
    if (!other) return '';
    const dir = c.avgOffsetMs < 0 ? 'before' : 'after';
    return `<div class="corr-row">
      <div><strong>${escapeHtml(other.name)}</strong></div>
      <div><span class="muted">avg</span> ${CWSTATS.fmtIntervalShort(Math.abs(c.avgOffsetMs))} <span class="muted">${dir}</span> (n=${c.sampleCount})</div>
    </div>`;
  }).join('');

  main.innerHTML = `
    ${renderGoalSection(topic)}
    <div class="period-tabs" id="periodTabs" role="tablist">
      <button class="tab" data-period="daily"   aria-selected="${state.statsPeriod==='daily'}">Daily</button>
      <button class="tab" data-period="weekly"  aria-selected="${state.statsPeriod==='weekly'}">Weekly</button>
      <button class="tab" data-period="monthly" aria-selected="${state.statsPeriod==='monthly'}">Monthly</button>
    </div>
    <div class="stats-bar">
      <label class="sr-only" for="statsTopic">Topic</label><select id="statsTopic">${topOpts}</select>
    </div>
    ${intervalSummary}

    <div class="stats-grid"><div class="stats-section">
      <h3>${kind === 'timeonly' ? 'Count' : escapeHtml(topicPrefs(topic).aggregation || 'sum')} over time</h3>
      <div class="chart-wrap"><canvas id="chartOverTime"></canvas></div>
    </div>

    <div class="stats-section">
      <h3>Calendar (last 26 weeks)</h3>
      <div id="heatmap" class="heatmap"></div>
    </div>

    <div class="stats-section">
      <h3>Time of day</h3>
      <div class="chart-wrap"><canvas id="chartTOD"></canvas></div>
    </div>

    <div class="stats-section">
      <h3>Day of week</h3>
      <div class="chart-wrap"><canvas id="chartDOW"></canvas></div>
    </div>

    ${corrRows ? `
      <div class="stats-section">
        <h3>Nearby topics (within 24h)</h3>
        <p class="muted-small">For each event of <em>${escapeHtml(topic.name)}</em>, the nearest event of another topic within 24 hours.</p>
        ${corrRows}
      </div>` : ''}</div>
  `;

  $$('#periodTabs .tab').forEach((tb) => {
    tb.addEventListener('click', () => {
      state.statsPeriod = tb.dataset.period;
      renderStats();
    });
  });
  $('#statsTopic').addEventListener('change', (e) => {
    state.statsTopicId = Number(e.target.value);
    renderStats();
  });
  $('#editGoal')?.addEventListener('click', () => openGoalEdit(topic));

  // Render charts
  drawOverTime(events, topic);
  drawTimeOfDay(events);
  drawDayOfWeek(events);
  drawHeatmap(events);
}

/* Full goal panel for the selected topic: the streak, how it compares to the
 * best run, and a dot per recent period so a pattern of misses is visible
 * without reading any numbers. */
function renderGoalSection(topic) {
  const res = goalFor(topic);
  const m = topicMeasurement(topic);
  if (!res) {
    return `<div class="stats-section goal-section">
      <h3>Goal</h3>
      <p class="muted-small">No goal set for <em>${escapeHtml(topic.name)}</em>.
      Set one to track a streak — “at least 1 per day” to build a habit, or
      “at most 0 per day” to break one.</p>
      <button class="btn secondary small" id="editGoal">Set a goal</button>
    </div>`;
  }
  const g = res.activeGoal || res.goal;
  const unit = CWGOALS.PERIODS.find((p) => p.key === g.period);
  const dots = res.periods.slice(-30).map((p) => {
    const cls = p.paused ? 'paused' : p.partial ? 'partial' : p.status === 'unknown' ? 'unknown'
      : p.pending ? 'pending' : p.met ? 'met' : 'miss';
    const when = p.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const label = `${when}: ${CWGOALS.fmtValue(p.value, g, m)} (${cls})`;
    return `<span class="goal-dot ${cls}" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"></span>`;
  }).join('');

  const rate = res.rate == null ? '—' : `${Math.round(res.rate * 100)}%`;
  const nounNow = res.current === 1 ? unit.label : unit.plural;
  const nounBest = res.best === 1 ? unit.label : unit.plural;

  return `<div class="stats-section goal-section">
    <h3>Goal</h3>
    <p class="goal-headline">${escapeHtml(CWGOALS.streakLine(res, m))}</p>
    <p class="muted-small">${escapeHtml(CWGOALS.describeGoal(g, m))} ·
      currently ${escapeHtml(CWGOALS.fmtValue(res.value, g, m))}
      ${g.period === 'day' ? 'today' : 'this week'}</p>
    ${['metric', 'target', 'cmp', 'period'].some((key) => g[key] !== res.goal[key])
      ? `<p class="muted-small">Next period: ${escapeHtml(CWGOALS.describeGoal(res.goal, m))}</p>` : ''}
    <div class="stats-cards goal-cards">
      <div><b>${res.current}</b><span>current ${nounNow}</span></div>
      <div><b>${res.best}</b><span>best ${nounBest}</span></div>
      <div><b>${rate}</b><span>last ${res.totalRecent} ${res.totalRecent === 1 ? unit.label : unit.plural}</span></div>
      <div><b>${res.metRecent}</b><span>met</span></div>
    </div>
    <div class="goal-dots">${dots}</div>
    <p class="muted-small">Paused, incomplete and partial periods are shown separately and excluded from the completion rate.</p>
    <button class="btn secondary small" id="editGoal">Edit goal</button>
  </div>`;
}

/* Chart.js theming — follows the app's light/dark tokens so axis labels
 * and gridlines stay readable in both schemes. */
const CHART = {
  primary:  '#ff7a2f',
  violet:   '#6b5bd6',
  teal:     '#12b3a6',
  neutral:  '#94a3b8',
  baseline: '#17a673',
};
function applyChartTheme() {
  if (typeof Chart === 'undefined') return;
  CWCHARTS.theme();
}

function drawOverTime(events, topic) {
  const canvas = $('#chartOverTime');
  if (!canvas) return;
  const cutoffHour = insightsSettings().cutoffHour;
  let start = logicalDay();
  if (state.statsPeriod === 'daily') start = CWINSIGHTS.addDays(start, -29);
  if (state.statsPeriod === 'weekly') start = CWINSIGHTS.addDays(CWSTATS.startOfWeek(Date.now(), cutoffHour), -77);
  if (state.statsPeriod === 'monthly') {
    const month = new Date(CWSTATS.startOfMonth(Date.now(), cutoffHour));
    month.setMonth(month.getMonth() - 11);
    start = month.getTime();
  }
  const kind = topicKind(topic);
  const aggregation = kind === 'amount' ? topicPrefs(topic).aggregation || 'sum' : 'sum';
  const rows = CWSTATS.aggregate(events, state.statsPeriod, {
    cutoffHour, start: dayBounds(start)[0], end: Date.now(), fill: true, aggregation,
  });
  const slice = rows.slice().reverse();
  const labels = slice.map((r) => CWSTATS.labelFor(state.statsPeriod, r.bucket));
  const values = slice.map((row) => kind === 'timeonly' ? row.count
    : row.value == null ? null : row.value / (kind === 'duration' ? 60 : 1));
  const unit = kind === 'duration' ? 'min' : topicMeasurement(topic)?.symbol || '';
  const label = kind === 'timeonly' ? 'Count' : `${aggregation} ${unit}`.trim();
  state.charts.overTime = CWCHARTS.bar(canvas, { labels, values, label,
    color: CHART.primary, integer: kind === 'timeonly' });
}

function drawTimeOfDay(events) {
  const canvas = $('#chartTOD');
  if (!canvas) return;
  const buckets = CWSTATS.timeOfDay(events);
  const labels = buckets.map((_, i) => `${i}`);
  state.charts.tod = CWCHARTS.bar(canvas, { labels, values: buckets, label: 'Count by hour',
    color: CHART.violet, xTitle: 'Hour' });
}

function drawDayOfWeek(events) {
  const canvas = $('#chartDOW');
  if (!canvas) return;
  const buckets = CWSTATS.dayOfWeek(events, insightsSettings().cutoffHour);
  const labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  state.charts.dow = CWCHARTS.bar(canvas, { labels, values: buckets,
    label: 'Count by day of week', color: CHART.teal });
}

function drawHeatmap(events) {
  const root = $('#heatmap');
  if (!root) return;
  const mat = CWSTATS.calendarMatrix(events, 26, insightsSettings().cutoffHour);
  const maxC = Math.max(1, mat.maxCount);
  const heatLevel = (c) => {
    if (c === 0) return 0;
    if (c <= maxC * 0.25) return 1;
    if (c <= maxC * 0.5) return 2;
    if (c <= maxC * 0.75) return 3;
    return 4;
  };
  let html = '<div class="heatmap-grid">';
  for (let w = 0; w < mat.weeks.length; w++) {
    html += '<div class="heatmap-col">';
    for (let d = 0; d < 7; d++) {
      const cell = mat.weeks[w][d];
      const lvl = heatLevel(cell.count);
      const date = new Date(cell.date);
      const label = `${date.toDateString()}: ${cell.count} event${cell.count === 1 ? '' : 's'}`;
      html += `<div class="heatmap-cell level-${lvl}" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"></div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  html += `<div class="heatmap-legend">Less <span class="heatmap-cell level-0"></span><span class="heatmap-cell level-1"></span><span class="heatmap-cell level-2"></span><span class="heatmap-cell level-3"></span><span class="heatmap-cell level-4"></span> More · ${mat.total} total in window</div>`;
  root.innerHTML = html;
}

/* ======== INSIGHTS VIEW ======== */

function insightsSettings() {
  return state.insightSettings || {
    cutoffHour: 4, windowDays: 7, insightWindow: 90,
    nightStart: 22, nightEnd: 6,
    alertsEnabled: false, alertOn: 'alert',
  };
}

/* Insights need at least one topic tagged as a focus or a marker before they
 * have anything to explain. */
function hasInsightRole() {
  const roles = CWINSIGHTS.normalizeRoles(state.topicRoles || {});
  return Object.values(roles).some((r) => r.role === 'focus' || r.role === 'marker');
}

function computeInsights(force = false) {
  if (!force && !state.insightsDirty && state.insights) return state.insights;
  const s = insightsSettings();
  state.insights = CWINSIGHTS.analyze({
    events: state.events,
    topics: state.topics,
    roles: state.topicRoles,
    kinds: state.topicKinds,
    topicPrefs: state.topicPrefs,
    dayChecks: state.dayChecks,
    measurements: measurementsByTopic(),
    cutoffHour: s.cutoffHour,
    windowDays: s.windowDays,
    insightWindow: s.insightWindow,
    nightStart: s.nightStart,
    nightEnd: s.nightEnd,
  });
  state.insightsDirty = false;
  return state.insights;
}

const STATUS_META = {
  alert:        { icon: '🔴', title: 'Well outside your usual range', cls: 'flare' },
  watch:        { icon: '🟠', title: 'Drifting from your usual — keep an eye on it', cls: 'watch' },
  ok:           { icon: '🟢', title: 'A typical stretch',          cls: 'ok' },
  better:       { icon: '🟢', title: 'Better than usual',          cls: 'ok' },
  insufficient: { icon: '⚪', title: 'Not enough history yet',     cls: 'none' },
  unknown:      { icon: '⚪', title: 'No baseline yet',            cls: 'none' },
};

function sigBadge(sig) {
  if (!sig) return '';
  const cls = sig.level === 'strong' ? 'sig-strong'
    : sig.level === 'weak' ? 'sig-weak' : 'sig-none';
  return `<span class="sig ${cls}">${escapeHtml(sig.label)}</span>`;
}

function renderInsights() {
  destroyCharts();
  const main = $('#main');
  const N = CWINSIGHTS;

  if (!state.topics.length) {
    main.innerHTML = `${welcomeBannerHtml()}<div class="empty">Import data or add a topic first.</div>`;
    bindWelcomeBanner();
    return;
  }
  if (!hasInsightRole()) {
    main.innerHTML = `
      <div class="setup-card">
        <h3>One-time setup</h3>
        <p>To answer questions like <em>“is this week unusual?”</em> or <em>“does a late
        dinner change tomorrow?”</em>, the app needs to know which of your topics
        is the one you actually want to understand.</p>
        <p>Pick a <strong>focus</strong> topic — the thing you want more or less of.
        Everything else you log is automatically tested against it.</p>
        <button class="btn" id="goSetupRoles">Set up insights</button>
      </div>`;
    $('#goSetupRoles').addEventListener('click', openRolesSetup);
    return;
  }

  const res = computeInsights();
  const { status, timing, narrative, table } = res;
  const s = insightsSettings();
  const meta = STATUS_META[status.level] || STATUS_META.unknown;

  const metricChips = status.metrics.map((m) => {
    const arrow = m.current > m.baseline ? '▲' : m.current < m.baseline ? '▼' : '—';
    const cls = m.elevated ? 'bad' : m.improved ? 'good' : '';
    const pct = Number.isFinite(m.pct) ? `${m.pct >= 0 ? '+' : ''}${Math.round(m.pct)}%`
      : m.baseline === 0 && m.current > 0 ? 'from none' : 'no percentage baseline';
    return `<div class="metric ${cls}">
      <b>${N.fmtNum(m.current, m.digits)}<small>${escapeHtml(m.unit)}</small></b>
      <span>${escapeHtml(m.label)}</span>
      <em>usual ${N.fmtNum(m.baseline, m.digits)} · ${arrow} ${pct}</em>
    </div>`;
  }).join('');

  const statusCard = `
    <div class="status-card ${meta.cls}">
      <div class="status-head"><span class="status-icon">${meta.icon}</span>
        <div>
          <h3>${escapeHtml(meta.title)}</h3>
          <p class="muted-small">Last ${status.windowDays} days vs your typical
          ${status.baselineDays ? `${status.baselineDays}-day` : ''} baseline</p>
        </div>
      </div>
      <ul class="status-reasons">${status.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      ${metricChips ? `<div class="metric-row">${metricChips}</div>` : ''}
      ${status.percentile != null ? `<p class="muted-small">This stretch ranks higher than
        <strong>${status.percentile}%</strong> of all ${status.windowDays}-day windows on
        record (${status.windowTotal} × ${escapeHtml(status.primaryLabel || '')}).</p>` : ''}
      <div class="status-actions">
        <button class="btn secondary small" id="insAlerts">${s.alertsEnabled ? '🔔 Alerts on' : '🔕 Turn on alerts'}</button>
        <button class="btn secondary small" id="insSetup">⚙️ Topics &amp; settings</button>
      </div>
    </div>`;

  const insightRow = (n) => `
    <li class="insight ${n.kind === 'test' ? 'is-test' : ''}">
      <span>${escapeHtml(n.text)}</span>
      ${n.test ? `<span class="muted-small">Based on ${n.test.n} paired days</span>` : ''}
      ${n.sig ? sigBadge(n.sig) : ''}
    </li>`;
  const insightItems = narrative.slice(0, 3).map(insightRow).join('');
  const otherInsights = narrative.slice(3, 12).map(insightRow).join('');
  const primary = primaryOutcome(res);

  main.innerHTML = `
    ${statusCard}

    <div class="stats-section">
      <h3>${escapeHtml(primary?.label || focusName(table))} (last 120 days)</h3>
      <div class="chart-wrap"><canvas id="chartInsTrend"></canvas></div>
    </div>

    <div class="stats-section">
      <h3>What stands out (last ${s.insightWindow} days)</h3>
      ${res.window ? `<p class="muted-small">${escapeHtml(fmtDateLong(res.window.from))} – ${escapeHtml(fmtDateLong(res.window.to - 1))}</p>` : ''}
      <p class="muted-small">Associations, not causes. Missing and incomplete days are excluded where observation is unknown.</p>
      ${insightItems
        ? `<ul class="insight-list">${insightItems}</ul>`
        : `<p class="muted-small">Not enough data yet — keep logging.</p>`}
      ${otherInsights ? `<details class="insight-details"><summary>More observations</summary><ul class="insight-list">${otherInsights}</ul></details>` : ''}
      <p class="muted-small">“Significant” means it survived a false-discovery
      correction across every combination tested, and passed both a parametric
      and a rank-based test. Correlation still isn’t causation.</p>
      ${res.dataQuality ? `<details class="analysis-details"><summary>Logging quality and assumptions</summary>
        <p class="muted-small">${res.dataQuality.unknownDays} unknown days and ${res.dataQuality.incompleteDays} incomplete days in the recorded history.</p>
        <p class="muted-small">${escapeHtml(res.dataQuality.assumption)}</p></details>` : ''}
    </div>

    ${renderTimingSection(timing, table)}

    <details class="stats-section analysis-details" id="explorerDetails" ${state.insExplorerOpen ? 'open' : ''}>
      <summary>Explore all associations and statistical details</summary>
      <div class="stats-bar ins-controls">
        <select id="insOutcome" aria-label="Outcome">${res.outcomes.map((o) =>
          `<option value="${o.key}" ${o.key === state.insightOutcome ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
        ).join('')}</select>
        <select id="insLag" aria-label="Association timing">
          <option value="0" ${state.insightLag === 0 ? 'selected' : ''}>same day</option>
          <option value="1" ${state.insightLag === 1 ? 'selected' : ''}>next day</option>
        </select>
      </details>
      ${renderExplorer(res)}
    </div>
  `;

  $('#insAlerts').addEventListener('click', openAlertsDialog);
  $('#insSetup').addEventListener('click', openRolesSetup);
  $('#insOutcome').addEventListener('change', (e) => {
    state.insightOutcome = e.target.value; renderInsights();
  });
  $('#insLag').addEventListener('change', (e) => {
    state.insightLag = Number(e.target.value); renderInsights();
  });
  $('#explorerDetails').addEventListener('toggle', (event) => { state.insExplorerOpen = event.target.open; });
  drawInsightsTrend(table, primary);
}

function primaryOutcome(result) {
  const id = result.table.focusIds[0];
  return result.outcomes.find((outcome) => outcome.topicId === id && outcome.primary)
    || result.outcomes.find((outcome) => outcome.topicId === id) || null;
}

/* Name of the primary focus topic, for headings. */
function focusName(table) {
  const tid = table.focusIds[0];
  const t = state.topics.find((x) => x.id === tid);
  return t ? t.name : 'Events';
}

function renderTimingSection(timing, table) {
  if (!table.timingIds.length) {
    return `<div class="stats-section">
      <h3>Timing</h3>
      <p class="muted-small">Tick <strong>“time of day matters”</strong> on a topic in
      ⚙️ Topics &amp; settings to explore whether doing it earlier or later is associated with
      your day — meals, bedtime, first coffee, last screen.</p></div>`;
  }
  if (!timing.length) {
    return `<div class="stats-section">
      <h3>Timing</h3>
      <p class="muted-small">Not enough days where both were logged yet.</p></div>`;
  }
  const N = CWINSIGHTS;
  const verdict = (q) => {
    if (Number.isFinite(q)) {
      if (q < 0.05) return { txt: 'Association', cls: 'sig-strong' };
      if (q < 0.15) return { txt: 'Suggestive', cls: 'sig-weak' };
      return { txt: 'No clear association', cls: 'sig-none' };
    }
    return { txt: 'Not enough data', cls: 'sig-none' };
  };
  const groups = {};
  for (const m of timing) {
    if (!isFinite(m.p)) continue;               // nothing testable
    if (m.earlyMean === 0 && m.lateMean === 0) continue;  // never happens
    (groups[m.predictor] = groups[m.predictor] || []).push(m);
  }
  const cards = Object.entries(groups).map(([pred, rows]) => {
    const body = rows.map((r) => {
      const v = verdict(r.q, r.p);
      const isBinary = r.outcomeKind === 'binary';
      const fmtV = (x) => (isBinary ? `${Math.round(x * 100)}% of days` : N.fmtNum(x, 1));
      const dir = r.delta > 0 ? 'more' : 'less';
      const pTxt = r.p < 0.0001 ? 'p&lt;0.0001' : `p=${N.fmtNum(r.p, 4)}`;
      const qTxt = !isFinite(r.q) ? '' : (r.q < 0.001 ? ' · q&lt;0.001' : ` · q=${N.fmtNum(r.q, 3)}`);
      return `<div class="meal-row">
        <div class="meal-q">
          <strong>${escapeHtml(r.outcome)}</strong>
          <span class="muted-small">${r.lag === 1 ? 'next day' : 'same day'} · n=${r.n}</span>
        </div>
        <div class="meal-v">
          <span class="sig ${v.cls}">${v.txt}</span>
          <span class="muted-small">${escapeHtml(r.lateLabel)}: ${fmtV(r.lateMean)}
          vs ${escapeHtml(r.earlyLabel)}: ${fmtV(r.earlyMean)}
          ${isFinite(r.pct) && Math.abs(r.pct) >= 1 ? `(${r.pct >= 0 ? '+' : ''}${Math.round(r.pct)}% ${dir})` : ''}</span>
          <span class="muted-small">${pTxt}${qTxt}</span>
        </div>
      </div>`;
    }).join('');
    return { supported: rows.some((row) => Number.isFinite(row.q) && row.q < 0.15),
      html: `<div class="meal-card"><h4>Later <em>${escapeHtml(pred.toLowerCase())}</em> and…</h4>${body}</div>` };
  });
  const supported = cards.filter((card) => card.supported).map((card) => card.html).join('');
  const remaining = cards.filter((card) => !card.supported).map((card) => card.html).join('');

  return `<div class="stats-section">
    <h3>Timing</h3>
    <p class="muted-small">Compares your latest third of days against your earliest
    third for each time-of-day, only on days that topic occurred. Each comparison has its own corrected result.</p>
    ${supported || '<p class="muted-small">No clear timing associations in this window.</p>'}
    ${remaining ? `<details class="analysis-details"><summary>Other timing comparisons</summary>${remaining}</details>` : ''}
  </div>`;
}

function renderExplorer(res) {
  const N = CWINSIGHTS;
  const outcomeKey = res.outcomes.find((o) => o.key === state.insightOutcome)
    ? state.insightOutcome
    : (res.outcomes[0]?.key || null);
  state.insightOutcome = outcomeKey;
  const rows = res.tests
    .filter((t) => t.outcomeKey === outcomeKey && t.lag === state.insightLag)
    .sort((a, b) => a.p - b.p)
    .slice(0, 15);
  if (!rows.length) {
    return `<p class="muted-small">No predictor had enough overlapping days
      (need ${20}+) for this combination.</p>`;
  }
  const body = rows.map((t) => {
    const sig = N.significanceLabel(t);
    const cls = sig.level === 'strong' ? 'sig-strong' : sig.level === 'weak' ? 'sig-weak' : 'sig-none';
    let effect;
    if (!t.groupMode) {
      effect = `r=${N.fmtNum(t.r, 2)}`;
    } else {
      const delta = t.meanA - t.meanB;
      const sign = delta > 0 ? '+' : '';
      // When the *predictor* is what differs between groups, show its unit.
      const unit = t.groupMode === 'outcome'
        ? (t.predictorType === 'time' ? ' min' : t.predictorType === 'hours' ? 'h' : '')
        : (t.outcomeUnit === ' min' ? ' min' : '');
      effect = `${sign}${N.fmtNum(delta, 1)}${unit}`;
    }
    return `<tr class="${cls}">
      <td>${escapeHtml(t.predictorLabel)}</td>
      <td class="num">${escapeHtml(effect)}</td>
      <td class="num">${t.n}</td>
      <td class="num">${t.p < 0.0001 ? '&lt;0.0001' : N.fmtNum(t.p, 4)}</td>
      <td class="num">${!isFinite(t.q) ? '—' : t.q < 0.001 ? '&lt;0.001' : N.fmtNum(t.q, 3)}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="ins-table">
    <thead><tr><th>Predictor</th><th class="num">Effect</th><th class="num">n</th>
    <th class="num">p</th><th class="num">q</th></tr></thead>
    <tbody>${body}</tbody></table></div>
    <p class="muted-small">Rows are green when they survive FDR correction (q&lt;0.05),
    amber when suggestive (q&lt;0.15). “Effect” is r for numeric predictors, or the
    difference in means for yes/no predictors.</p>`;
}

function drawInsightsTrend(table, outcome) {
  const canvas = $('#chartInsTrend');
  if (!canvas) return;
  const tid = table.focusIds[0];
  if (tid == null) return;
  const days = table.days.slice(-120);
  if (days.length < 5) return;
  const labels = days.map((r) => `${r.date.getMonth() + 1}/${r.date.getDate()}`);
  const counts = days.map((row) => outcome ? outcome.get(row) : row.counts[tid] ?? null);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${outcome?.label || 'Daily trend'}. ${labels.map((label, index) =>
    `${label}: ${counts[index] == null ? 'not observed' : counts[index]}`).join('; ')}`);
  const roll = CWINSIGHTS.rolling(counts, 7);
  const baseline = CWINSIGHTS.median(
    table.days.slice(-97, -7).map((row) => outcome ? outcome.get(row) : row.counts[tid] ?? null)
      .filter(Number.isFinite)
  );
  applyChartTheme();
  state.charts.insTrend = new Chart(canvas, {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: outcome?.label || 'per day', data: counts, backgroundColor: CHART.neutral, borderRadius: 3, order: 3 },
        { type: 'line', label: '7-day avg', data: roll, borderColor: CHART.primary,
          borderWidth: 2, pointRadius: 0, tension: 0.3, order: 1 },
        ...(isFinite(baseline) ? [{
          type: 'line', label: 'baseline', data: labels.map(() => baseline),
          borderColor: CHART.baseline, borderWidth: 1, borderDash: [5, 4],
          pointRadius: 0, order: 2,
        }] : []),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true, labels: { boxWidth: 10, font: { size: 10 } } } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, font: { size: 9 } } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
}

/* ---- role setup ---- */

function openRolesSetup() {
  const N = CWINSIGHTS;
  const originalRoles = JSON.stringify(state.topicRoles);
  const cur = N.normalizeRoles(state.topicRoles || {});
  const roleOpts = (r) =>
    ['<option value="">— not used —</option>']
      .concat(N.ROLES.map((x) =>
        `<option value="${x.key}" ${r && r.role === x.key ? 'selected' : ''}>${x.icon} ${escapeHtml(x.label)}</option>`))
      .join('');
  const topics = state.topics.filter((t) => !t.archived);
  const rows = topics.map((t) => {
    const r = cur[t.id];
    const isFocus = r && r.role === 'focus';
    return `
    <div class="role-row role-block" data-role-block="${t.id}">
      <div class="role-name">${escapeHtml(topicEmoji(t))} ${escapeHtml(t.name)}</div>
      <select data-role-topic="${t.id}">${roleOpts(r)}</select>
      <div class="role-extra" data-role-extra="${t.id}" ${r ? '' : 'hidden'}>
        <label class="role-dir" data-role-dir-wrap="${t.id}" ${isFocus ? '' : 'hidden'}>
          <span>Better when it goes</span>
          <select data-role-dir="${t.id}">
            <option value="down" ${!r || r.dir !== 'up' ? 'selected' : ''}>down — fewer is better</option>
            <option value="up" ${r && r.dir === 'up' ? 'selected' : ''}>up — more is better</option>
          </select>
        </label>
        <label class="role-timing">
          <input type="checkbox" data-role-timing="${t.id}" ${r && r.timing ? 'checked' : ''} />
          <span>Time of day matters (test earlier vs later)</span>
        </label>
      </div>
    </div>`;
  }).join('');
  const s = insightsSettings();
  const hourOpts = [0, 1, 2, 3, 4, 5, 6].map((h) =>
    `<option value="${h}" ${s.cutoffHour === h ? 'selected' : ''}>${h}:00</option>`).join('');
  const nightOpts = (sel) => Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}" ${sel === h ? 'selected' : ''}>${N.fmtHour(h)}</option>`).join('');

  openModal(`
    <header><button class="icon-btn" data-close>←</button><div class="title">Insights setup</div></header>
    <div class="body">
      <p class="muted-small">Pick the one topic you most want to understand — your
      <strong>focus</strong>. Everything else you log is tested against it
      automatically, so you don't have to tag it all.</p>
      ${rows}
      <div class="role-row" style="margin-top:14px;">
        <div class="role-name">Day starts at<br>
          <span class="muted-small">Something logged at 2am counts toward the night before.</span></div>
        <select id="insCutoff">${hourOpts}</select>
      </div>
      <div class="role-row">
        <div class="role-name">Overnight runs from</div>
        <select id="insNightStart">${nightOpts(s.nightStart ?? 22)}</select>
      </div>
      <div class="role-row">
        <div class="role-name">…until</div>
        <select id="insNightEnd">${nightOpts(s.nightEnd ?? 6)}</select>
      </div>
      <div class="field">
        <label for="insWindow">Association analysis window</label>
        <select id="insWindow">${[30, 90, 180, 365].map((days) =>
          `<option value="${days}" ${(s.insightWindow || 90) === days ? 'selected' : ''}>Last ${days} days</option>`).join('')}</select>
      </div>
    </div>
    <div class="actions">
      <button class="btn secondary" data-close>Cancel</button>
      <button class="btn" id="saveRoles">Save</button>
    </div>
  `);

  // Show the direction / timing controls only once a role is chosen, and the
  // direction picker only for a focus (it is meaningless for the others).
  $$('[data-role-topic]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const id = sel.dataset.roleTopic;
      const extra = $(`[data-role-extra="${id}"]`);
      const dirWrap = $(`[data-role-dir-wrap="${id}"]`);
      if (extra) extra.hidden = !sel.value;
      if (dirWrap) dirWrap.hidden = sel.value !== 'focus';
    });
  });

  bindAction($('#saveRoles'), async ({ form, origin }) => {
    if (JSON.stringify(state.topicRoles) !== originalRoles) {
      throw new Error('Insight roles changed elsewhere. Close and reopen this editor before saving.');
    }
    const $ = (selector) => form.querySelector(selector);
    const map = {};
    form.querySelectorAll('[data-role-topic]').forEach((sel) => {
      if (!sel.value) return;
      const id = Number(sel.dataset.roleTopic);
      const dir = $(`[data-role-dir="${id}"]`)?.value === 'up' ? 'up' : 'down';
      const timing = !!$(`[data-role-timing="${id}"]`)?.checked;
      map[id] = { role: sel.value, dir, timing };
    });
    await CWDB.setTopicRoles(map);
    state.topicRoles = map;
    state.insightSettings = await CWDB.setInsightSettings({
      cutoffHour: Number($('#insCutoff').value),
      nightStart: Number($('#insNightStart').value),
      nightEnd: Number($('#insNightEnd').value),
      insightWindow: Number($('#insWindow').value),
    });
    state.insightsDirty = true;
    closeModal({ origin });
    snack('Insights settings saved');
    setView('insights');
  }, { mutation: true });
}

/* ---- goal editor ---- */

function openGoalEdit(topic) {
  const kind = topicKind(topic);
  const m = topicMeasurement(topic);
  const existing = CWGOALS.normalizeGoal(state.topicGoals?.[topic.id], kind);
  const originalGoal = JSON.stringify(state.topicGoals?.[topic.id] ?? null);
  const ensureCurrentGoal = () => {
    if (JSON.stringify(state.topicGoals?.[topic.id] ?? null) !== originalGoal) {
      throw new Error('This goal changed elsewhere. Close and reopen it before saving.');
    }
  };
  const g = existing || CWGOALS.suggestGoal(kind);
  const unit = CWGOALS.unitLabel(g, m);
  const unitWord = unit === '×' ? 'times' : unit;
  const paused = !!existing?.pauses?.some((pause) => pause.to == null);

  openModal(`
    <header><button class="icon-btn" data-close>←</button>
      <div class="title">Goal · ${escapeHtml(topic.name)}</div></header>
    <div class="body">
      <p class="muted-small">A goal turns this topic into a streak. Use
      <strong>at least</strong> to build a habit, or <strong>at most</strong> to
      keep a lid on one — “at most 0 per day” is the classic quit-something
      counter.</p>
      <div class="goal-form">
        <select id="goalCmp">
          ${CWGOALS.CMPS.map((c) =>
            `<option value="${c.key}" ${g.cmp === c.key ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
        </select>
        <input id="goalTarget" type="number" inputmode="decimal" min="0" step="any"
               value="${g.target}" />
        <span class="goal-unit">${escapeHtml(unitWord)}</span>
        <span class="goal-per">per</span>
        <select id="goalPeriod">
          ${CWGOALS.PERIODS.map((p) =>
            `<option value="${p.key}" ${g.period === p.key ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
        </select>
      </div>
      <p class="muted-small" id="goalPreview"></p>
      ${existing ? `<p class="muted-small">Edits apply from the next period boundary; previous targets remain in your history. Paused periods do not add to or break a streak.</p>
      <button class="btn secondary" id="goalPause">${paused ? 'Resume goal' : 'Pause goal'}</button>` : ''}
    </div>
    <div class="actions">
      ${existing ? `<button class="btn danger" id="goalRemove">Remove</button>` : ''}
      <button class="btn secondary" data-close>Cancel</button>
      <button class="btn" id="goalSave">Save</button>
    </div>
  `);

  const read = (root = document) => ({
    metric: g.metric,
    cmp: root.querySelector('#goalCmp').value,
    target: Number(root.querySelector('#goalTarget').value),
    period: root.querySelector('#goalPeriod').value,
    since: existing ? existing.since : Date.now(),
  });

  const preview = () => {
    const draft = CWGOALS.normalizeGoal(CWGOALS.reviseGoal(existing, read()), kind);
    const el = $('#goalPreview');
    if (!draft) {
      el.textContent = '“At least 0” would always pass — enter a target above zero.';
      return;
    }
    const res = CWGOALS.evaluate({
      events: state.events.filter((e) => e.topicid === topic.id),
      goal: draft, kind, cutoffHour: insightsSettings().cutoffHour,
      dayChecks: state.dayChecks, topicPrefs: state.topicPrefs, topicId: topic.id,
    });
    el.textContent = `${CWGOALS.describeGoal(draft, m)} — on your history so far, `
      + `that's ${CWGOALS.streakLine(res, m).toLowerCase()}`;
  };

  ['#goalCmp', '#goalTarget', '#goalPeriod'].forEach((sel) => {
    $(sel).addEventListener('input', preview);
    $(sel).addEventListener('change', preview);
  });
  preview();

  bindAction($('#goalSave'), async ({ form, origin }) => {
    ensureCurrentGoal();
    const draft = CWGOALS.normalizeGoal(CWGOALS.reviseGoal(existing, read(form)), kind);
    if (!draft) { snack('Enter a target above zero'); return; }
    state.topicGoals = await CWDB.setTopicGoal(topic.id, draft);
    closeModal({ origin });
    snack('Goal saved');
    queueAutoSync('saveGoal');
    renderCurrent();
  }, { mutation: true });

  bindAction($('#goalRemove'), async ({ origin }) => {
    ensureCurrentGoal();
    state.topicGoals = await CWDB.setTopicGoal(topic.id, null);
    closeModal({ origin });
    snack('Goal removed');
    queueAutoSync('removeGoal');
    renderCurrent();
  }, { mutation: true });
  bindAction($('#goalPause'), async ({ origin }) => {
    ensureCurrentGoal();
    state.topicGoals = await CWDB.setTopicGoal(topic.id, CWGOALS.setPaused(existing, !paused));
    closeModal({ origin });
    snack(paused ? 'Goal resumed' : 'Goal paused');
  }, { mutation: true });
}

/* ---- alerts ---- */

function openAlertsDialog() {
  const s = insightsSettings();
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  openModal(`
    <header><button class="icon-btn" data-close>←</button><div class="title">Status alerts</div></header>
    <div class="body">
      <p>Get a notification when your recent stretch drifts away from your own
      baseline — your focus topic moving the wrong way, or a marker day showing up
      more often than usual.</p>
      <label class="row-toggle">
        <input type="checkbox" id="alertsOn" ${s.alertsEnabled ? 'checked' : ''} />
        <span>Enable status alerts</span>
      </label>
      <label class="row-toggle">
        <span>Alert me when status is</span>
        <select id="alertOn">
          <option value="alert" ${s.alertOn !== 'watch' ? 'selected' : ''}>alert only</option>
          <option value="watch" ${s.alertOn === 'watch' ? 'selected' : ''}>watch or worse</option>
        </select>
      </label>
      <p class="muted-small">Notification permission: <strong>${perm}</strong>.
      The check runs whenever you open the app (at most once every
      ${s.alertCooldownHours || 20} hours). A web app can’t reliably wake itself in
      the background, so this is a when-you-open-it nudge, not a background monitor.</p>
      ${s.lastAlertAt ? `<p class="muted-small">Last alert: ${fmtDateLong(s.lastAlertAt)} ${fmtTime(s.lastAlertAt)}</p>` : ''}
    </div>
    <div class="actions">
      <button class="btn secondary" id="alertTest">Test now</button>
      <button class="btn" id="alertSave">Save</button>
    </div>
  `);
  bindAction($('#alertSave'), async ({ form, origin }) => {
    const enabled = form.querySelector('#alertsOn').checked;
    const alertOn = form.querySelector('#alertOn').value;
    if (enabled && 'Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    await CWMODEL.mutate(() => CWDB.setInsightSettings({ alertsEnabled: enabled, alertOn }));
    closeModal({ origin });
    snack(enabled ? 'Status alerts on' : 'Status alerts off');
    if (state.view === 'insights') renderInsights();
  });
  bindAction($('#alertTest'), async () => {
    const res = computeInsights(true);
    await showStatusNotification(res.status, true);
    snack(`Current status: ${res.status.level}`);
  });
}

async function showStatusNotification(status, isTest = false) {
  const meta = STATUS_META[status.level] || STATUS_META.unknown;
  const body = status.reasons.slice(0, 3).join('\n');
  const title = isTest ? `Plotline: ${meta.title}` : meta.title;
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg?.showNotification) {
        await reg.showNotification(title, { body, tag: 'plotline-status', icon: '/icons/icon-192.png' });
      } else {
        new Notification(title, { body, tag: 'plotline-status' });
      }
      return true;
    }
  } catch (e) { console.warn('notification failed', e); }
  if (isTest) snack('Notifications not permitted — showing in-app only');
  return false;
}

/* Runs at startup: if the current window looks bad and we haven't nagged
 * recently, fire a notification + in-app snackbar. */
async function checkStatusAlert() {
  const s = insightsSettings();
  if (!s.alertsEnabled) return;
  if (!hasInsightRole()) return;
  const cooldown = (s.alertCooldownHours || 20) * 3600000;
  if (s.lastAlertAt && Date.now() - s.lastAlertAt < cooldown) return;
  let res;
  try { res = computeInsights(true); } catch (e) { console.warn(e); return; }
  const level = res.status.level;
  const trigger = s.alertOn === 'watch'
    ? (level === 'watch' || level === 'alert')
    : level === 'alert';
  if (!trigger) return;
  await showStatusNotification(res.status);
  snack(`${STATUS_META[level].icon} ${STATUS_META[level].title} — see Insights`);
  state.insightSettings = await CWDB.setInsightSettings({
    lastAlertAt: Date.now(), lastAlertLevel: level,
  });
}

/* ======== ADD / EDIT EVENT MODAL ======== */

async function logNow(topic) {
  const kind = topicKind(topic);
  const qant = kind === 'timeonly' ? 60 : topicPrefs(topic).quickAmount;
  const time = Date.now();
  if (kind !== 'timeonly' && qant == null) {
    openAddEvent(topic);
    return;
  }
  await CWMODEL.mutate(async () => {
    const current = state.topics.find((item) => item.id === topic.id && !item.archived);
    if (!current) {
      throw new Error('This topic is no longer available.');
    }
    if (current.msureid !== topic.msureid || topicKind(current) !== kind) {
      throw new Error('This topic changed while logging was queued. Please try again.');
    }
    const event = await CWDB.create('events', {
      cost: 0, qant, time, topicid: topic.id, note: '',
    });
    snack(`Logged ${topic.name}${topicKind(topic) === 'timeonly' ? '' : ': ' + fmtQant(qant, topic)}`, {
      undo: () => CWMODEL.mutate(() => CWDB.delete('events', event.id)),
    });
  });
}

function quickLabel(topic) {
  if (topicKind(topic) === 'timeonly') return `+ ${topic.name}`;
  const amount = topicPrefs(topic).quickAmount;
  return amount == null ? `${topic.name}…` : `+ ${fmtQant(amount, topic)} ${topic.name}`;
}

function openAddEvent(topic, existing = null) {
  const kind = topicKind(topic);
  const m = state.measurements.find((mm) => mm.id === topic.msureid);
  const isDuration = kind === 'duration';
  const isAmount = kind === 'amount';
  const isTimeOnly = kind === 'timeonly';
  const initTime = existing ? existing.time : Date.now();
  const defaultAmount = topicPrefs(topic).quickAmount;
  const initQantSec = existing ? Number(existing.qant || 0) : (defaultAmount ?? 0);
  const initQantUnit = existing ? Number(existing.qant || 0) : (defaultAmount ?? '');
  const initSeverity = existing ? Number(existing.cost || 0) : 0;

  const qantHhmm = (() => {
    if (!isDuration) return '';
    const s = initQantSec;
    const h = Math.floor(s / 3600);
    const mn = Math.floor((s % 3600) / 60);
    return `${pad(h)}:${pad(mn)}${s % 60 ? ':' + pad(s % 60) : ''}`;
  })();

  let qantField = '';
  if (isDuration) {
    qantField = `
      <div class="field">
        <label>Duration (hh:mm or hh:mm:ss)</label>
        <input id="qHhmm" type="text" inputmode="numeric" pattern="[0-9:]*" value="${qantHhmm}" placeholder="00:00">
      </div>${existing ? '' : `<button type="button" class="btn secondary" id="startTimer">${state.activeTimers[topic.id] ? 'Stop & save running timer' : 'Start a timer instead'}</button>`}`;
  } else if (isAmount) {
    qantField = `
      <div class="field">
        <label>Amount${m?.symbol ? ` (${escapeHtml(m.symbol)})` : ''}</label>
        <input id="qNum" type="number" step="any" value="${initQantUnit}">
      </div>`;
  }

  // Build a sorted list of tag suggestions from existing notes
  const tagSuggest = CWSTATS.allTagsFromEvents(state.events).slice(0, 12);
  const tagChipsHtml = tagSuggest.length ? `
    <div class="tag-suggest">
      ${tagSuggest.map((t) => `<button type="button" class="tag-suggest-chip" data-tag="${escapeHtml(t.tag)}">#${escapeHtml(t.tag)}</button>`).join('')}
    </div>` : '';

  openModal(`
    <header>
      <button class="icon-btn" data-close>←</button>
      <div class="title">${existing ? 'Edit Event' : 'Add Event'}</div>
      <button class="icon-btn" id="dialogSave" title="Save">✓</button>
    </header>
    <div class="body">
      <div class="topic-name">${escapeHtml(topicEmoji(topic))} ${escapeHtml(topic.name)}</div>
      ${qantField}
      <div class="row-2">
        <div class="field">
          <label>Date</label>
          <input id="evDate" type="date" value="${fmtDateInput(initTime)}">
        </div>
        <div class="field">
          <label>Time</label>
          <input id="evTime" type="time" value="${fmtTimeInput(initTime)}">
        </div>
      </div>
      <div class="time-chips">
        <button type="button" class="t-chip" data-mins="0">Now</button>
        <button type="button" class="t-chip" data-mins="5">5m ago</button>
        <button type="button" class="t-chip" data-mins="15">15m ago</button>
        <button type="button" class="t-chip" data-mins="30">30m ago</button>
        <button type="button" class="t-chip" data-mins="60">1h ago</button>
        <button type="button" class="t-chip" data-mins="120">2h ago</button>
        <button type="button" class="t-chip" data-mins="1440">Yesterday now</button>
      </div>
      <div class="field">
        <label>Severity (optional, 0–5)</label>
        <div class="sev-row">
          <input id="evSev" type="range" min="0" max="5" step="1" value="${initSeverity}">
          <span class="sev-val" id="sevVal">${initSeverity ? initSeverity : '—'}</span>
        </div>
      </div>
      <div class="field">
        <label>Note <span class="hint">(use #tags to categorize, e.g. #stressful #traveling)</span></label>
        <textarea id="evNote" placeholder="(optional)">${existing ? escapeHtml(existing.note || '') : ''}</textarea>
        ${tagChipsHtml}
      </div>
      ${existing ? `<button class="btn danger" id="dialogDelete" style="margin-top:8px;">Delete event</button>` : ''}
    </div>
  `);
  bindAction($('#startTimer'), async ({ origin }) => {
    if (state.activeTimers[topic.id]) await stopTimer(topic);
    else await startTimer(topic);
    closeModal({ origin });
  });

  // Severity slider live update
  const sevInput = $('#evSev');
  const sevVal = $('#sevVal');
  if (sevInput) sevInput.addEventListener('input', () => {
    sevVal.textContent = sevInput.value === '0' ? '—' : sevInput.value;
  });

  // Time chips
  $$('.t-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mins = Number(btn.dataset.mins);
      const t = Date.now() - mins * 60 * 1000;
      $('#evDate').value = fmtDateInput(t);
      $('#evTime').value = fmtTimeInput(t);
    });
  });

  // Tag suggestion chips: append to note
  $$('.tag-suggest-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      const ta = $('#evNote');
      const current = ta.value.trim();
      // toggle: if already contains the tag, remove it
      const re = new RegExp(`(^|\\s)#${tag}(\\b)`, 'i');
      if (re.test(current)) {
        ta.value = current.replace(re, '$1$2').replace(/\s+/g, ' ').trim();
        btn.classList.remove('active');
      } else {
        ta.value = (current ? current + ' ' : '') + '#' + tag;
        btn.classList.add('active');
      }
    });
    // initialize active state
    const ta = $('#evNote');
    const re = new RegExp(`(^|\\s)#${btn.dataset.tag}(\\b)`, 'i');
    if (re.test(ta.value)) btn.classList.add('active');
  });

  bindAction($('#dialogSave'), async ({ form, origin }) => {
    const $ = (selector) => form.querySelector(selector);
    const dateStr = $('#evDate').value;
    const timeStr = $('#evTime').value;
    if (!dateStr || !timeStr) { snack('Date and time are required'); return; }
    let qant = 0;
    if (isDuration) {
      const raw = $('#qHhmm').value.trim();
      if (!/^\d+:[0-5]\d(?::[0-5]\d)?$/.test(raw)) throw new Error('Enter duration as hh:mm or hh:mm:ss.');
      const [h, mn, seconds = 0] = raw.split(':').map(Number);
      qant = h * 3600 + mn * 60 + seconds;
      if (!Number.isFinite(qant)) throw new Error('Enter a finite duration.');
    } else if (isAmount) {
      if (!$('#qNum').value.trim()) throw new Error('Enter an amount.');
      const raw = Number($('#qNum').value);
      if (!Number.isFinite(raw)) throw new Error('Enter a finite amount.');
      qant = raw;
    } else {
      qant = existing ? Number(existing.qant || 60) : 60;
    }
    const time = parseDateTimeInput(dateStr, timeStr);
    if (!Number.isFinite(time)) throw new Error('Enter a valid date and time.');
    const note = $('#evNote').value.trim();
    const severity = Number($('#evSev').value || 0);

    if (existing) {
      const current = await CWDB.get('events', existing.id);
      if (JSON.stringify(current) !== JSON.stringify(existing)) {
        throw new Error('This entry changed elsewhere. Close and reopen it before saving.');
      }
      const prev = { ...existing };
      const updated = { ...existing, qant, cost: severity, time, note };
      await CWDB.put('events', updated);
      const idx = state.events.findIndex((e) => e.id === existing.id);
      if (idx >= 0) state.events[idx] = updated;
      closeModal({ origin });
      snack('Event updated', {
        undo: () => CWMODEL.mutate(async () => {
          await CWDB.put('events', prev);
          const j = state.events.findIndex((e) => e.id === prev.id);
          if (j >= 0) state.events[j] = prev;
          queueAutoSync('undoEdit');
          renderCurrent();
          snack('Undone');
        }),
      });
    } else {
      const ev = await CWDB.create('events', { cost: severity, qant, time, topicid: topic.id, note });
      state.events.push(ev);
      closeModal({ origin });
      snack(`Logged ${topic.name}`, {
        undo: () => CWMODEL.mutate(async () => {
          await CWDB.delete('events', ev.id);
          state.events = state.events.filter((e) => e.id !== ev.id);
          queueAutoSync('undoLog');
          renderCurrent();
          snack('Undone');
        }),
      });
    }
    queueAutoSync('saveEvent');
    renderCurrent();
  }, { mutation: true });

  if (existing) {
    $('#dialogDelete').addEventListener('click', () => {
      openConfirm('Delete this event?', 'You can undo this deletion using the Undo message.', ({ origin }) => CWMODEL.mutate(async () => {
        const current = await CWDB.get('events', existing.id);
        if (JSON.stringify(current) !== JSON.stringify(existing)) {
          throw new Error('This entry changed elsewhere. Close and reopen it before deleting.');
        }
        const removed = { ...existing };
        await CWDB.delete('events', existing.id);
        state.events = state.events.filter((e) => e.id !== existing.id);
        closeModal({ origin });
        snack('Event deleted', {
          undo: () => CWMODEL.mutate(async () => {
            await CWDB.put('events', removed);
            state.events.push(removed);
            queueAutoSync('undoDelete');
            renderCurrent();
            snack('Undone');
          }),
        });
        queueAutoSync('deleteEvent');
        renderCurrent();
      }));
    });
  }
}

/* ======== TOPIC EDIT ======== */

const AMOUNT_UNITS = [
  // ordered for the picker, friendly names
  { id: 101, label: 'Ounces (oz)' },
  { id: 102, label: 'Pounds (lb)' },
  { id: 4,   label: 'Kilograms (kg)' },
  { id: 103, label: 'Grams (g)' },
  { id: 1,   label: 'Litres (l)' },
  { id: 2,   label: 'Gallons (gal)' },
  { id: 3,   label: 'Miles (mi)' },
  { id: 5,   label: 'Kilometres (km)' },
  { id: 6,   label: 'Metres (m)' },
  { id: 100, label: 'Count (no unit)' },
];

function openTopicEdit(existing) {
  const existingKind = existing ? topicKind(existing) : 'timeonly';
  const prefs = existing ? topicPrefs(existing) : {};
  const hasHistory = !!existing && ((state.eventsByTopic.get(existing.id) || []).length > 0
    || !!state.activeTimers[existing.id]);
  const firstTime = existing ? (state.eventsByTopic.get(existing.id) || [])
    .reduce((earliest, event) => Math.min(earliest, event.time), Date.now()) : Date.now();
  const initialUnit = existing && existingKind === 'amount'
    ? existing.msureid
    : 101;
  const meta = existing ? topicMeta(existing) : {};
  const initEmoji = meta.emoji || '';
  const initColor = meta.color || DEFAULT_TOPIC_COLOR;

  openModal(`
    <header>
      <button class="icon-btn" data-close>←</button>
      <div class="title">${existing ? 'Edit Topic' : 'New Topic'}</div>
      <button class="icon-btn" id="topicSave" title="Save">✓</button>
    </header>
    <div class="body">
      <div class="field">
        <label>Name</label>
        <input id="topicName" type="text" value="${existing ? escapeHtml(existing.name) : ''}" placeholder="e.g. coffee, headache, workout" autocomplete="off">
      </div>
      <div class="field">
        <label>Description (optional)</label>
        <input id="topicDesc" type="text" value="${existing ? escapeHtml(existing.desc || '') : ''}" autocomplete="off">
      </div>
      <div class="row-2">
        <div class="field">
          <label>Emoji (optional)</label>
          <input id="topicEmoji" type="text" maxlength="4" value="${escapeHtml(initEmoji)}" placeholder="💧 🥖 💤 …" autocomplete="off">
        </div>
        <div class="field">
          <label>Color</label>
          <div class="color-swatches" id="colorSwatches">
            ${COLOR_SWATCHES.map((c) => `<button type="button" class="swatch ${c===initColor?'on':''}" style="background:${c}" data-color="${c}" aria-label="Color ${c}"></button>`).join('')}
          </div>
        </div>
      </div>
      <div class="field">
        <label>Topic type</label>
        <div class="kind-picker" id="kindPicker">
          <label class="kind-opt"><input type="radio" name="kind" value="timeonly" ${existingKind==='timeonly'?'checked':''}> <strong>Time only</strong><br><span>Just record when it happened (e.g. "woke up", "first meal", "headache").</span></label>
          <label class="kind-opt"><input type="radio" name="kind" value="duration" ${existingKind==='duration'?'checked':''}> <strong>Duration</strong><br><span>Record how long something lasted in hh:mm (e.g. "workout", "nap").</span></label>
          <label class="kind-opt"><input type="radio" name="kind" value="amount"   ${existingKind==='amount'?'checked':''}> <strong>Amount</strong><br><span>Record a quantity with a unit (e.g. "water 12 oz", "weight 175 lb").</span></label>
        </div>
      </div>
      <div class="field" id="unitField" style="display:${existingKind==='amount'?'block':'none'};">
        <label>Unit</label>
        <select id="topicUnit">
          ${existing && existingKind === 'amount' && !AMOUNT_UNITS.some((unit) => unit.id === initialUnit)
            ? `<option value="${initialUnit}" selected>${escapeHtml(topicMeasurement(existing)?.name || 'Imported unit')} (keep existing)</option>` : ''}
          ${AMOUNT_UNITS.map((u) => `<option value="${u.id}" ${u.id===initialUnit?'selected':''}>${escapeHtml(u.label)}</option>`).join('')}
        </select>
      </div>
      ${hasHistory ? '<p class="muted-small">Type and unit are locked because this topic has entries or a running timer. Create a new topic for a different unit so old values keep their meaning.</p>' : ''}
      <div class="tracking-settings">
        <div class="field" id="quickAmountField" ${existingKind === 'timeonly' ? 'hidden' : ''}>
          <label for="quickAmount">Quick-log default <span id="quickUnitHint">${existingKind === 'duration' ? '(minutes)' : '(topic units)'}</span></label>
          <input id="quickAmount" type="number" step="any" value="${prefs.quickAmount == null ? '' : prefs.quickAmount / (existingKind === 'duration' ? 60 : 1)}" placeholder="Ask each time">
          <p class="hint">Leave blank to enter a value each time.</p>
        </div>
        <div class="field" id="aggregationField" ${existingKind !== 'amount' ? 'hidden' : ''}>
          <label for="topicAggregation">Measured value over a day</label>
          <select id="topicAggregation">
            <option value="sum" ${(prefs.aggregation || 'sum') === 'sum' ? 'selected' : ''}>Total (water, distance, counts)</option>
            <option value="mean" ${prefs.aggregation === 'mean' ? 'selected' : ''}>Average (repeated observations)</option>
            <option value="latest" ${prefs.aggregation === 'latest' ? 'selected' : ''}>Latest (weight, a single reading)</option>
          </select>
        </div>
        <div class="field">
          <label for="trackingStart">Started tracking on</label>
          <input id="trackingStart" type="date" max="${fmtDateInput(Date.now())}" value="${fmtDateInput(prefs.trackingStart ?? logicalDay(firstTime))}">
          <p class="hint">Earlier dates are not assumed to be zero-event days.</p>
        </div>
      </div>
      ${existing ? `
        <div class="field">
          <label>Goal &amp; streak</label>
          <button class="btn secondary" id="topicGoalBtn" style="width:100%;">
            🎯 ${escapeHtml(CWGOALS.describeGoal(state.topicGoals?.[existing.id], topicMeasurement(existing)) || 'Set a goal')}
          </button>
          <p class="muted-small" style="padding:6px 0 0;">Track a streak — “at least 1 per day”
          to build a habit, “at most 0 per day” to break one.</p>
        </div>
        <div class="field">
          <label>
            <input type="checkbox" id="topicArchived" ${existing.archived?'checked':''}> Archived (hides from Topics without deleting events)
          </label>
        </div>
        <hr style="border:0;border-top:1px solid var(--rule);margin:24px 0 16px;">
        <p style="font-size:12px;color:var(--ink-soft);margin:0 0 8px;">Danger zone</p>
        <button class="btn danger" id="topicDelete" style="width:100%;">Delete topic and all its events</button>
      ` : ''}
    </div>
  `);
  if (hasHistory) {
    $$('input[name="kind"]').forEach((input) => { input.disabled = true; });
    $('#topicUnit').disabled = true;
  }

  let selectedColor = initColor;
  $$('#colorSwatches .swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      selectedColor = sw.dataset.color;
      $$('#colorSwatches .swatch').forEach((s) => s.classList.remove('on'));
      sw.classList.add('on');
    });
  });

  $$('input[name="kind"]', $('#modalRoot')).forEach((r) => {
    r.addEventListener('change', () => {
      const k = r.value;
      $('#unitField').style.display = (k === 'amount') ? 'block' : 'none';
      $('#quickAmountField').hidden = k === 'timeonly';
      $('#aggregationField').hidden = k !== 'amount';
      $('#quickUnitHint').textContent = k === 'duration' ? '(minutes)' : '(topic units)';
      $('#quickAmount').value = '';
    });
  });

  bindAction($('#topicSave'), async ({ form, origin }) => {
    const $ = (selector) => form.querySelector(selector);
    const name = $('#topicName').value.trim();
    if (!name) { snack('Name required'); return; }
    const desc = $('#topicDesc').value.trim();
    const emoji = $('#topicEmoji').value.trim();
    const kindEl = $('input[name="kind"]:checked');
    const kind = kindEl ? kindEl.value : 'timeonly';
    let msureid;
    if (kind === 'amount') {
      msureid = Number($('#topicUnit').value);
    } else {
      msureid = existing && kind === existingKind ? existing.msureid : 10;
    }
    if (existing && ((state.eventsByTopic.get(existing.id) || []).length || state.activeTimers[existing.id])
      && (kind !== existingKind || msureid !== existing.msureid)) {
      throw new Error('Create a new topic to change the type or unit of existing history.');
    }
    const quickRaw = $('#quickAmount').value.trim();
    const quickAmount = quickRaw === '' || kind === 'timeonly' ? null
      : Number(quickRaw) * (kind === 'duration' ? 60 : 1);
    if (quickAmount != null && (!Number.isFinite(quickAmount) || (kind === 'duration' && quickAmount < 0))) {
      throw new Error('Enter a valid quick-log amount.');
    }
    const trackingDate = $('#trackingStart').value;
    const trackingStart = dayBounds(parseDateTimeInput(trackingDate, '00:00'))[0];
    if (!trackingDate || !Number.isFinite(trackingStart) || trackingStart > Date.now()) {
      throw new Error('Choose a valid tracking start date, no later than today.');
    }

    let savedTopicId;
    if (existing) {
      const current = await CWDB.get('topics', existing.id);
      if (JSON.stringify(current) !== JSON.stringify(existing)
        || JSON.stringify(state.topicPrefs[existing.id] || {}) !== JSON.stringify(prefs)
        || JSON.stringify(state.topicMeta[existing.id] || {}) !== JSON.stringify(meta)) {
        throw new Error('This topic changed elsewhere. Close and reopen the editor.');
      }
      const updated = {
        ...existing,
        name, desc, msureid,
        archived: $('#topicArchived')?.checked || false,
      };
      await CWDB.put('topics', updated);
      await CWDB.setTopicKind(existing.id, kind);
      savedTopicId = existing.id;
    } else {
      const t = await CWDB.create('topics', { name, desc, msureid, optype: 1, type: 1, archived: false });
      const id = t.id;
      const order = (await CWDB.getMeta('topicOrder')) || [];
      order.push(id);
      await CWDB.setMeta('topicOrder', order);
      await CWDB.setTopicKind(id, kind);
      savedTopicId = id;
    }
    await CWDB.setTopicMeta(savedTopicId, { emoji, color: $('#colorSwatches .swatch.on')?.dataset.color || initColor });
    const allPrefs = await CWDB.getMeta('topicPrefs', {});
    allPrefs[savedTopicId] = { ...prefs, aggregation: $('#topicAggregation').value, trackingStart };
    if (quickAmount != null) allPrefs[savedTopicId].quickAmount = quickAmount;
    else delete allPrefs[savedTopicId].quickAmount;
    await CWDB.setMeta('topicPrefs', allPrefs);
    closeModal({ origin });
    await reload();
    snack('Saved');
    queueAutoSync('saveTopic');
    renderCurrent();
  }, { mutation: true });

  if (existing) {
    $('#topicGoalBtn').addEventListener('click', () => {
      closeModal();
      openGoalEdit(existing);
    });
    $('#topicDelete').addEventListener('click', () => {
      const evCount = state.events.filter((e) => e.topicid === existing.id).length;
      openConfirm(
        `Delete "${existing.name}"?`,
        `This will permanently delete the topic AND all ${evCount.toLocaleString()} of its event${evCount === 1 ? '' : 's'}. This cannot be undone. Consider Archive instead if you just want to hide it.`,
        ({ origin }) => CWMODEL.mutate(async () => {
          const count = (state.eventsByTopic.get(existing.id) || []).length;
          await CWDB.deleteTopic(existing.id);
          closeModal({ origin });
          await reload();
          snack(`Deleted "${existing.name}" and ${count.toLocaleString()} event${count === 1 ? '' : 's'}`);
          queueAutoSync('deleteTopic');
          renderCurrent();
        }),
        'Delete forever'
      );
    });
  }
}

function openTopicsManager() {
  const buildRow = (t, i, total) => {
    const count = state.events.filter((e) => e.topicid === t.id).length;
    const kind = topicKind(t);
    const m = state.measurements.find((mm) => mm.id === t.msureid);
    const subline = kind === 'amount'
      ? `${count.toLocaleString()} events · Amount (${m?.symbol || m?.name || '?'})`
      : kind === 'duration'
      ? `${count.toLocaleString()} events · Duration`
      : `${count.toLocaleString()} events · Time only`;
    return `
      <div class="topic-row ${t.archived?'archived':''}" data-topic="${t.id}">
        <div class="mgr-arrows">
          <button class="arrow-btn" data-up="${t.id}" ${i===0?'disabled':''} aria-label="Move up">▲</button>
          <button class="arrow-btn" data-down="${t.id}" ${i===total-1?'disabled':''} aria-label="Move down">▼</button>
        </div>
        <div>
          <div class="t-name">${escapeHtml(t.name)}</div>
          <div class="t-sub">${subline}</div>
        </div>
        <button class="btn secondary" data-edit="${t.id}">Edit</button>
      </div>
    `;
  };
  const topics = state.topics;
  const html = topics.map((t, i) => buildRow(t, i, topics.length)).join('');
  openModal(`
    <header>
      <button class="icon-btn" data-close>←</button>
      <div class="title">Manage Topics</div>
      <button class="icon-btn" id="newTopic" title="New topic">＋</button>
    </header>
    <div class="body" style="padding:0;">
      <div class="mgr-hint">▲▼ to reorder · Edit to rename or change type</div>
      ${html || '<div class="empty">No topics yet.</div>'}
    </div>
  `);
  const wire = () => {
    $('#newTopic').addEventListener('click', () => { closeModal(); openTopicEdit(null); });
    $$('[data-edit]').forEach((b) => b.addEventListener('click', (e) => {
      const id = Number(e.currentTarget.dataset.edit);
      const t = state.topics.find((x) => x.id === id);
      closeModal();
      openTopicEdit(t);
    }));
    $$('[data-up]').forEach((b) => bindAction(b, async (e) => {
      const id = Number(e.currentTarget.dataset.up);
      await moveTopic(id, -1);
      if ($('#modalRoot .dialog') === e.origin) openTopicsManager();
    }, { mutation: true }));
    $$('[data-down]').forEach((b) => bindAction(b, async (e) => {
      const id = Number(e.currentTarget.dataset.down);
      await moveTopic(id, +1);
      if ($('#modalRoot .dialog') === e.origin) openTopicsManager();
    }, { mutation: true }));
  };
  wire();
}

async function moveTopic(id, delta) {
  const order = state.topicOrder.slice();
  const i = order.indexOf(id);
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  await saveTopicOrder(order);
  renderCurrent();
}

/* ======== QUICK-ACCESS BAR MANAGER ======== */

async function saveQuickBar(ids) {
  state.quickBar = ids.slice();
  await CWDB.setQuickBar(state.quickBar);
  queueAutoSync();
  renderCurrent();
}

function openQuickBarManager() {
  const byId = new Map(state.topics.map((t) => [t.id, t]));
  const pinnedIds = (state.quickBar || []).filter((id) => {
    const t = byId.get(id);
    return t && !t.archived;
  });
  const pinnedSet = new Set(pinnedIds);
  const available = state.topics.filter((t) => !t.archived && !pinnedSet.has(t.id));

  const chipLabel = (t) => {
    const emoji = topicEmoji(t);
    return `${emoji ? `<span class="qc-emoji">${escapeHtml(emoji)}</span>` : ''}<span class="t-name">${escapeHtml(t.name)}</span>`;
  };

  const pinnedRows = pinnedIds.map((id, i) => {
    const t = byId.get(id);
    return `
      <div class="topic-row" data-topic="${id}" style="--accent:${topicColor(t)}">
        <div class="mgr-arrows">
          <button class="arrow-btn" data-qup="${id}" ${i===0?'disabled':''} aria-label="Move up">▲</button>
          <button class="arrow-btn" data-qdown="${id}" ${i===pinnedIds.length-1?'disabled':''} aria-label="Move down">▼</button>
        </div>
        <div>${chipLabel(t)}</div>
        <button class="btn secondary" data-qremove="${id}">Remove</button>
      </div>`;
  }).join('');

  const availableRows = available.map((t) => `
      <div class="topic-row" data-topic="${t.id}" style="--accent:${topicColor(t)}">
        <div></div>
        <div>${chipLabel(t)}</div>
        <button class="btn secondary" data-qadd="${t.id}">＋ Add</button>
      </div>`).join('');

  const pinnedSection = pinnedIds.length
    ? pinnedRows
    : `<div class="mgr-hint">No quick-access topics pinned yet. The bar currently shows your most frequent recent topics automatically. Add topics below to pin a fixed set in a fixed order.</div>`;

  openModal(`
    <header>
      <button class="icon-btn" data-close>←</button>
      <div class="title">Quick-access bar</div>
    </header>
    <div class="body" style="padding:0;">
      <div class="mgr-hint">These chips appear at the top of Topics. Measured values use your explicit quick-log default, or ask each time. ▲▼ to reorder.</div>
      <div class="sticky-header">Pinned</div>
      ${pinnedSection}
      <div class="sticky-header">Available topics</div>
      ${availableRows || '<div class="mgr-hint">All topics are already pinned.</div>'}
    </div>
  `);

  const reopen = (event) => { if ($('#modalRoot .dialog') === event.origin) openQuickBarManager(); };
  $$('[data-qadd]').forEach((b) => bindAction(b, async (e) => {
    const id = Number(e.currentTarget.dataset.qadd);
    if (!pinnedSet.has(id)) await saveQuickBar([...pinnedIds, id]);
    reopen(e);
  }, { mutation: true }));
  $$('[data-qremove]').forEach((b) => bindAction(b, async (e) => {
    const id = Number(e.currentTarget.dataset.qremove);
    await saveQuickBar(pinnedIds.filter((x) => x !== id));
    reopen(e);
  }, { mutation: true }));
  $$('[data-qup]').forEach((b) => bindAction(b, async (e) => {
    const id = Number(e.currentTarget.dataset.qup);
    await saveQuickBar(swap(pinnedIds, id, -1));
    reopen(e);
  }, { mutation: true }));
  $$('[data-qdown]').forEach((b) => bindAction(b, async (e) => {
    const id = Number(e.currentTarget.dataset.qdown);
    await saveQuickBar(swap(pinnedIds, id, +1));
    reopen(e);
  }, { mutation: true }));
}

function swap(arr, id, delta) {
  const out = arr.slice();
  const i = out.indexOf(id);
  if (i < 0) return out;
  const j = i + delta;
  if (j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/* ======== IMPORT / EXPORT FLOW ======== */

function triggerImport() {
  const inp = $('#fileInput');
  inp.value = '';
  inp.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      const errs = CWIO.validateBackup(obj);
      if (errs.length) {
        openModal(`
          <header><button class="icon-btn" data-close>←</button><div class="title">Import errors</div></header>
          <div class="body">
            <p>The file doesn't look like a Plotline backup:</p>
            <ul>${errs.slice(0, 10).map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
            ${errs.length > 10 ? `<p>(+${errs.length-10} more)</p>` : ''}
          </div>
          <div class="actions"><button class="btn" data-close>OK</button></div>
        `);
        return;
      }
      const sum = CWIO.summarize(obj);
      const dateRange = sum.events
        ? `${sum.minTime ? fmtDateLong(sum.minTime) : '?'} → ${sum.maxTime ? fmtDateLong(sum.maxTime) : '?'}`
        : '(none)';
      openModal(`
        <header><button class="icon-btn" data-close>←</button><div class="title">Import preview</div></header>
        <div class="body">
          <p><strong>${escapeHtml(file.name)}</strong></p>
          <ul>
            <li>Version: ${escapeHtml(String(sum.version))}</li>
            <li>Topics: ${sum.topics.toLocaleString()}</li>
            <li>Events: ${sum.events.toLocaleString()}</li>
            <li>Date range: ${escapeHtml(dateRange)}</li>
            <li>Backup taken: ${escapeHtml(sum.saveddate)}</li>
          </ul>
          <p>Choose how to apply it:</p>
          <ul>
            <li><strong>Replace</strong> — wipe everything currently in this app and load the file as-is. A safety backup of your current data will be downloaded first.</li>
            <li><strong>Merge</strong> — add new topics/events from the file but keep what you already have. Duplicates skipped by event id.</li>
          </ul>
        </div>
        <div class="actions">
          <button class="btn secondary" data-close>Cancel</button>
          <button class="btn secondary" id="impMerge">Merge</button>
          <button class="btn" id="impReplace">Replace</button>
        </div>
      `);
      bindAction($('#impMerge'), async ({ origin }) => {
        await CWIO.importMerge(obj);
        closeModal({ origin });
        await reload();
        snack(`Merged ${sum.events.toLocaleString()} events`);
        queueAutoSync('import');
        renderCurrent();
      }, { mutation: true });
      bindAction($('#impReplace'), async ({ origin }) => {
        await CWIO.safetyBackup();
        await CWIO.importReplace(obj);
        closeModal({ origin });
        await reload();
        snack(`Loaded ${sum.events.toLocaleString()} events`);
        queueAutoSync('import');
        renderCurrent();
      }, { mutation: true });
    } catch (err) {
      snack('Import failed: ' + err.message);
    }
  };
  inp.click();
}

async function doExport() {
  await CWIO.exportToFile('plotline-backup.json');
  await reload(); renderCurrent();
  snack('Exported plotline-backup.json');
}

async function doExportCsv() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
  await CWIO.exportToCsv(`plotline-events-${stamp}.csv`);
  snack('Exported CSV');
}

async function doSafetyBackup() {
  await CWIO.safetyBackup();
  snack('Safety backup downloaded');
}

/* ======== MENU ACTIONS ======== */

function openDrive() {
  CWDRIVE.openSetupDialog({ openModal, closeModal, snack, reload, renderCurrent, openConfirm });
}

function openReportDialog() {
  const today = logicalDay();
  openModal(`
    <header><button class="icon-btn" data-close>←</button><div class="title">Export summary</div></header>
    <div class="body">
      <p>A readable HTML summary with values, notes, and associations. Open the downloaded file offline or print it to PDF.</p>
      <div class="row-2"><div class="field"><label for="reportFrom">From</label><input type="date" id="reportFrom" value="${fmtDateInput(CWINSIGHTS.addDays(today, -29))}"></div>
      <div class="field"><label for="reportTo">Through</label><input type="date" id="reportTo" value="${fmtDateInput(today)}"></div></div>
      <div class="field"><label for="reportTopic">Topic</label><select id="reportTopic"><option value="">All topics</option>
        ${state.topics.map((topic) => `<option value="${topic.id}">${escapeHtml(topic.name)}</option>`).join('')}</select></div>
      <p class="muted-small">Includes personal notes. Review the file before sharing. This is not a restorable backup.</p>
    </div>
    <div class="actions"><button class="btn secondary" data-close>Cancel</button><button class="btn" id="reportSave">Download summary</button></div>`);
  bindAction($('#reportSave'), async () => {
    const fromDate = $('#reportFrom').value;
    const toDate = $('#reportTo').value;
    if (!fromDate || !toDate || fromDate > toDate || toDate > fmtDateInput(logicalDay())) {
      throw new Error('Choose a valid date range ending no later than today.');
    }
    const from = dayBounds(new Date(fromDate + 'T00:00:00').getTime())[0];
    const to = dayBounds(new Date(toDate + 'T00:00:00').getTime())[1];
    const topicId = Number($('#reportTopic').value) || null;
    const topics = state.topics.filter((topic) => topicId == null || topic.id === topicId);
    const allowed = new Set(topics.map((topic) => topic.id));
    const events = state.events.filter((event) => allowed.has(event.topicid) && event.time >= from && event.time < to);
    let days = 0;
    for (let key = logicalDay(from); key < logicalDay(to); key = CWINSIGHTS.addDays(key, 1)) days++;
    const settings = insightsSettings();
    const analysis = CWINSIGHTS.analyze({
      events, topics, roles: state.topicRoles, kinds: state.topicKinds,
      topicPrefs: state.topicPrefs, dayChecks: state.dayChecks, measurements: measurementsByTopic(),
      cutoffHour: settings.cutoffHour, nightStart: settings.nightStart, nightEnd: settings.nightEnd,
      insightWindow: Math.min(400, days), now: Math.min(to - 1, Date.now()),
    });
    const findings = (analysis.narrative || []).filter((finding) => finding.test).slice(0, 10)
      .map((finding) => ({ text: `${finding.text} Based on ${finding.test.n} paired days; q=${finding.test.q.toFixed(3)}.`
        + (days > 400 ? ' Analysis is limited to the final 400 days of this range.' : '') }));
    const html = CWREPORT.build({ topics, events, measurements: state.measurements,
      kinds: state.topicKinds, prefs: state.topicPrefs, from, to, findings, cutoffHour: settings.cutoffHour });
    CWREPORT.download(html, `plotline-summary-${fromDate}-${toDate}.html`);
    closeModal();
    snack('Summary downloaded');
  });
}

function openAbout() {
  openModal(`
    <header><button class="icon-btn" data-close>←</button><div class="title">About</div></header>
    <div class="body">
      <p><strong>Plotline</strong> — log what happens, find what matters.</p>
      <p>An offline-first event tracker. Log a moment in one tap, then look back
      across days, weeks, and months to spot the patterns you'd otherwise miss.</p>
      <p>All data lives only on this device in IndexedDB. Use Export JSON or Google Drive sync
      to back it up. Imports and exports a plain JSON backup, so history
      from older trackers comes across intact.</p>
    </div>
    <div class="actions"><button class="btn" data-close>OK</button></div>
  `);
}

async function openStorageStatus() {
  let persisted = false;
  let quota = null;
  try {
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
    if (navigator.storage?.estimate) quota = await navigator.storage.estimate();
  } catch (e) {}
  const lastImport = await CWDB.getMeta('lastImport');
  const lastExport = await CWDB.getMeta('lastExport');
  const lastDrive = await CWDB.getMeta('lastDriveSync');

  openModal(`
    <header><button class="icon-btn" data-close>←</button><div class="title">Storage status</div></header>
    <div class="body">
      <p>Persistent storage: <strong>${persisted ? 'enabled' : 'not granted'}</strong></p>
      ${quota ? `<p>Used ${(quota.usage/1e6).toFixed(1)} MB of ${(quota.quota/1e6).toFixed(0)} MB quota</p>` : ''}
      <p>Topics: ${state.topics.length} · Events: ${state.events.length.toLocaleString()}</p>
      <p>Last import: ${lastImport ? fmtDateLong(lastImport) + ' ' + fmtTime(lastImport) : 'never'}</p>
      <p>Last export: ${lastExport ? fmtDateLong(lastExport) + ' ' + fmtTime(lastExport) : 'never'}</p>
      <p>Last Drive sync: ${lastDrive ? fmtDateLong(lastDrive) + ' ' + fmtTime(lastDrive) : 'never'}</p>
      ${!persisted ? `<p><button class="btn" id="persistBtn">Request persistent storage</button></p>` : ''}
    </div>
    <div class="actions"><button class="btn" data-close>Close</button></div>
  `);
  const pb = $('#persistBtn');
  if (pb) pb.addEventListener('click', async () => {
    if (navigator.storage?.persist) {
      const ok = await navigator.storage.persist();
      snack(ok ? 'Persistent storage granted' : 'Browser declined');
    }
  });
}

function openWipe() {
  openConfirm(
    'Reset this device?',
    `This removes ${state.events.length.toLocaleString()} events and ${state.topics.length} topics from this device only. Drive will be disconnected and your Drive backup will NOT be changed. A safety backup downloads first.`,
    async () => {
      await CWDRIVE.disconnect();
      await CWMODEL.mutate(async () => {
        await CWIO.safetyBackup();
        await CWDB.clearAll({ keepDeviceMeta: false });
        await CWDB.setMeta('driveEnabled', false);
        await CWDB.seedDefaults();
        closeModal();
      });
      snack('Device reset. Your Drive backup is unchanged.');
      openOnboarding();
    },
    'Reset this device'
  );
}

/* ======== ROUTING / TABS ======== */

function setView(view) {
  if (!VIEWS.includes(view)) return;
  state.view = view;
  $$('.app-tabs .tab').forEach((t) => {
    t.setAttribute('aria-selected', t.dataset.view === view);
    t.tabIndex = t.dataset.view === view ? 0 : -1;
    t.id = `tab-${t.dataset.view}`;
    t.setAttribute('aria-controls', 'main');
  });
  $('#main').setAttribute('aria-labelledby', `tab-${view}`);
  renderCurrent();
}

function renderCurrent() {
  const active = document.activeElement;
  const hadFocus = $('#main').contains(active) && active !== $('#main');
  let focusSelector = active?.id && /^[A-Za-z][\w-]*$/.test(active.id) ? `#${active.id}` : null;
  if (!focusSelector && active?.dataset) {
    for (const key of ['add', 'quick', 'event', 'goal']) {
      if (active.dataset[key]) { focusSelector = `[data-${key}="${active.dataset[key]}"]`; break; }
    }
  }
  destroyCharts();
  if (state.view === 'categories') renderCategories();
  else if (state.view === 'recent') renderRecent();
  else if (state.view === 'day') renderDay();
  else if (state.view === 'stats') renderStats();
  else if (state.view === 'insights') renderInsights();
  CWUI.labelControls($('#main'));
  if (hadFocus && !$('#modalRoot .dialog')) ($(focusSelector || '#main') || $('#main')).focus({ preventScroll: true });
}

/* ======== TOPIC META (emoji + color) ======== */
const DEFAULT_TOPIC_COLOR = '#ff7a2f';
const COLOR_SWATCHES = [
  '#ff7a2f', // amber (default)
  '#12b3a6', // teal
  '#6b5bd6', // violet
  '#3b82f6', // blue
  '#17a673', // green
  '#f5a524', // gold
  '#e5484d', // red
  '#ec4899', // pink
  '#0ea5e9', // sky
  '#64748b', // slate
];

function topicMeta(topic) {
  return state.topicMeta?.[topic?.id] || {};
}
function topicEmoji(topic) {
  return (topicMeta(topic).emoji || '').trim();
}
function topicColor(topic) {
  return topicMeta(topic).color || DEFAULT_TOPIC_COLOR;
}

/* ======== TAG / SEVERITY / NOTE RENDERING ======== */
function renderNoteWithTags(note) {
  if (!note) return '';
  const tags = CWSTATS.parseTags(note);
  if (!tags.length) return escapeHtml(note);
  let out = '';
  let cursor = 0;
  for (const t of tags) {
    out += escapeHtml(note.slice(cursor, t.start));
    out += `<span class="tag-chip">${escapeHtml(note.slice(t.start, t.end))}</span>`;
    cursor = t.end;
  }
  out += escapeHtml(note.slice(cursor));
  return out;
}
function severityBadge(ev) {
  const s = Number(ev?.cost || 0);
  if (!s || s < 1) return '';
  const cls = s >= 4 ? 'sev-hi' : s >= 2 ? 'sev-med' : 'sev-lo';
  return `<span class="sev-badge ${cls}" title="Severity ${s}/5">●${s}</span>`;
}

/* ======== AUTO-SYNC (calls into drive.js if configured) ======== */
function queueAutoSync(reason = 'change') {
  state.insightsDirty = true;   // data changed -> recompute insights lazily
  if (window.CWDRIVE?.queueAutoSync) {
    window.CWDRIVE.queueAutoSync(reason).catch(reportError);
  }
}

/* ======== ADD BUTTON (header / FAB) — pick topic first ======== */

function openTopicPicker() {
  if (!state.topics.length) {
    openConfirm('No topics yet', 'Create a topic first or import existing data.', () => {
      closeModal();
      openTopicEdit(null);
    }, 'Create topic');
    return;
  }
  const topics = state.topics.filter((t) => !t.archived);
  if (!topics.length) {
    openConfirm('No active topics', 'Unarchive a topic or add a new one to log an entry.', openTopicsManager, 'Manage topics');
    return;
  }
  const rows = topics.map((t) => `
    <div class="topic-row" data-topic="${t.id}" role="button" tabindex="0" style="cursor:pointer;">
      <div><div class="t-name">${escapeHtml(t.name)}</div></div>
      <div></div>
      <div></div>
    </div>
  `).join('');
  openModal(`
    <header><button class="icon-btn" data-close>←</button><div class="title">Pick topic</div></header>
    <div class="body" style="padding:0;">${rows}</div>
  `);
  $$('[data-topic]', $('#modalRoot')).forEach((row) => {
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); }
    });
    row.addEventListener('click', () => {
      const id = Number(row.dataset.topic);
      const t = state.topics.find((x) => x.id === id);
      closeModal();
      openAddEvent(t);
    });
  });
}

/* ======== ONBOARDING PRESETS ======== */

/* Starter packs shown on a first launch. Each topic becomes a real topic with
 * a kind, emoji, colour and (optionally) an insights role, so a new install is
 * useful immediately instead of being an empty screen. */
const PRESETS = [
  {
    id: 'symptoms',
    icon: '🩺',
    name: 'Symptom Tracker',
    blurb: 'Track flare-ups, pain and triggers — and find out what sets them off.',
    topics: [
      { name: 'Symptom',   kind: 'timeonly', emoji: '🤒', color: '#e05252', role: 'focus', dir: 'down',
        goal: { cmp: 'lte', target: 0, period: 'day' } },
      { name: 'Bad day',   kind: 'timeonly', emoji: '🚩', color: '#c2410c', role: 'marker' },
      { name: 'Medication',kind: 'timeonly', emoji: '💊', color: '#7c5cff',
        goal: { cmp: 'gte', target: 1, period: 'day' } },
      { name: 'Meal',      kind: 'timeonly', emoji: '🍽️', color: '#f59e0b', role: 'influence', timing: true },
      { name: 'Sleep',     kind: 'duration', emoji: '😴', color: '#3b82f6', role: 'influence', timing: true },
    ],
  },
  {
    id: 'habits',
    icon: '🥤',
    name: 'Daily Habits',
    blurb: 'Coffee, water, screens, smokes — build streaks and see the pattern.',
    topics: [
      { name: 'Coffee',    kind: 'timeonly', emoji: '☕', color: '#a16207', role: 'focus', dir: 'down', timing: true,
        goal: { cmp: 'lte', target: 2, period: 'day' } },
      { name: 'Water',     kind: 'amount',   emoji: '💧', color: '#0ea5e9', unit: 'ounces',
        goal: { cmp: 'gte', target: 64, period: 'day' } },
      { name: 'Screen time', kind: 'duration', emoji: '📱', color: '#64748b', role: 'influence' },
      { name: 'Slipped up', kind: 'timeonly', emoji: '🚩', color: '#c2410c', role: 'marker',
        goal: { cmp: 'lte', target: 0, period: 'day' } },
      { name: 'Sleep',     kind: 'duration', emoji: '😴', color: '#3b82f6', role: 'influence', timing: true },
    ],
  },
  {
    id: 'fitness',
    icon: '🏋️',
    name: 'Fitness & Health',
    blurb: 'Workouts, weight and steps — see what actually moves the numbers.',
    topics: [
      { name: 'Workout',   kind: 'duration', emoji: '🏋️', color: '#16a34a', role: 'focus', dir: 'up',
        goal: { cmp: 'gte', target: 150, period: 'week' } },
      { name: 'Weight',    kind: 'amount',   emoji: '⚖️', color: '#7c5cff', unit: 'pounds' },
      { name: 'Walk',      kind: 'duration', emoji: '🚶', color: '#0ea5e9', role: 'influence',
        goal: { cmp: 'gte', target: 20, period: 'day' } },
      { name: 'Rest day',  kind: 'timeonly', emoji: '🛌', color: '#94a3b8', role: 'marker' },
      { name: 'Sleep',     kind: 'duration', emoji: '😴', color: '#3b82f6', role: 'influence', timing: true },
    ],
  },
  {
    id: 'blank',
    icon: '🛠️',
    name: 'Custom',
    blurb: 'Start from nothing and build your own topics.',
    topics: [],
  },
];

/* Time-only and duration topics use the generic duration measurement; an
 * amount topic needs a real unit, or its quantities would render as hh:mm. */
function presetMeasurementId(spec) {
  if (spec.kind !== 'amount') return 10;
  const byName = Object.fromEntries(
    (window.CWDB_DEFAULT_MEASUREMENTS || []).map((m) => [m.name, m.id])
  );
  return byName[spec.unit] ?? byName.count ?? 100;
}

async function applyPreset(preset) {
  const order = (await CWDB.getMeta('topicOrder')) || [];
  const roles = (await CWDB.getTopicRoles()) || {};
  const goals = (await CWDB.getTopicGoals()) || {};
  const prefs = (await CWDB.getMeta('topicPrefs')) || {};
  for (const spec of preset.topics) {
    const topic = await CWDB.create('topics', {
      name: spec.name, desc: '', msureid: presetMeasurementId(spec),
      optype: 1, type: 1, archived: false,
    });
    const id = topic.id;
    order.push(id);
    await CWDB.setTopicKind(id, spec.kind);
    await CWDB.setTopicMeta(id, { emoji: spec.emoji, color: spec.color });
    prefs[id] = { aggregation: spec.name === 'Weight' ? 'latest' : 'sum', trackingStart: Date.now() };
    if (spec.name === 'Water') prefs[id].quickAmount = 8;
    if (spec.role) {
      roles[id] = { role: spec.role, dir: spec.dir || 'down', timing: !!spec.timing };
    }
    if (spec.goal) {
      goals[id] = {
        ...spec.goal,
        metric: CWGOALS.defaultMetric(spec.kind),
        since: Date.now(),
      };
    }
  }
  await CWDB.setMeta('topicOrder', order);
  await CWDB.setTopicRoles(roles);
  await CWDB.setTopicGoals(goals);
  await CWDB.setMeta('topicPrefs', prefs);
  await CWDB.setMeta('onboarded', true);
}

/* True only for a genuinely fresh install: no topics and no events. Anyone
 * restoring a backup or upgrading skips this entirely. */
async function needsOnboarding() {
  if (await CWDB.getMeta('onboarded')) return false;
  const topics = await CWDB.getAll('topics');
  if (topics.length) { await CWDB.setMeta('onboarded', true); return false; }
  const events = await CWDB.getAll('events');
  if (events.length) { await CWDB.setMeta('onboarded', true); return false; }
  return true;
}

function openOnboarding() {
  const cards = PRESETS.map((p) => `
    <button class="preset-card" data-preset="${p.id}">
      <span class="preset-icon">${p.icon}</span>
      <span class="preset-text">
        <strong>${escapeHtml(p.name)}</strong>
        <span class="muted-small">${escapeHtml(p.blurb)}</span>
      </span>
    </button>`).join('');

  openModal(`
    <header><div class="title">What do you want to track?</div></header>
    <div class="body">
      <p class="muted-small">Pick a starting point. These are just topics — rename,
      delete or add to them any time. Already have data? Restore it below before
      choosing a preset.</p>
      ${cards}
    </div>
    <div class="actions">
      <button class="btn secondary" id="onboardImport">Import a backup…</button>
      <button class="btn secondary" id="onboardDrive">Restore from Drive…</button>
    </div>
  `, { dismissible: false });

  $$('[data-preset]').forEach((btn) => {
    bindAction(btn, async () => {
      const preset = PRESETS.find((p) => p.id === btn.dataset.preset);
      $$('[data-preset]').forEach((button) => { button.disabled = true; });
      await applyPreset(preset);
      closeModal();
      await reload();
      renderCurrent();
      if (preset.topics.length) snack(`${preset.name} topics added`);
    }, { mutation: true });
  });
  bindAction($('#onboardImport'), async () => {
    closeModal();
    triggerImport();
  });
  bindAction($('#onboardDrive'), async () => {
    const existingTopics = await CWDB.getAll('topics');
    const existingEvents = await CWDB.getAll('events');
    if (existingTopics.length || existingEvents.length) throw new Error('This device now has data. Use Drive setup to confirm a restore.');
    await CWDRIVE.syncDown({ interactive: true });
    await CWDB.setMeta('onboarded', true);
    closeModal();
    await reload();
    renderCurrent();
    snack('Restored from Drive');
  });
}

let waitingWorker = null;
let updatingApp = false;

function watchUpdates(registration) {
  const announce = () => {
    if (!registration.waiting) return;
    waitingWorker = registration.waiting;
    $('#updateNotice').hidden = false;
  };
  announce();
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed') announce();
    });
  });
}

/* ======== INIT ======== */

async function init() {
  try {
    await CWDB.seedDefaults();
  } catch (e) { console.error(e); }

  // request persistent storage early
  if (navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }

  await reload();

  // First launch: offer a starting point instead of an empty screen.
  try {
    if (await needsOnboarding()) openOnboarding();
  } catch (e) { console.warn('onboarding skipped', e); }

  // Tab clicks
  $$('.app-tabs .tab').forEach((tb) => {
    tb.addEventListener('click', () => setView(tb.dataset.view));
  });

  // Header buttons
  $('#menuBtn').addEventListener('click', openDrawer);
  $('#fab').addEventListener('click', openTopicPicker);
  bindAction($('#syncPill'), async (e) => {
    e.stopPropagation();
    if (!window.CWDRIVE) return;
    try {
      const res = await window.CWDRIVE.syncNow({ interactive: true });
      if (res?.action === 'merged' && res.changedLocally) {
        await reload(); renderCurrent();
        snack(`Merged with Drive: ${res.stats?.fromRemote || 0} pulled in`);
      } else {
        snack('Synced');
      }
    } catch (err) {
      snack('Sync failed: ' + err.message);
    }
  });

  // Drawer
  $('#drawer').querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', () => closeDrawer()));
  $('#navImport').addEventListener('click', () => { closeDrawer(); triggerImport(); });
  bindAction($('#navExport'), async () => { closeDrawer(); await doExport(); });
  bindAction($('#navExportCsv'), async () => { closeDrawer(); await doExportCsv(); });
  $('#navReport').addEventListener('click', () => { closeDrawer(); openReportDialog(); });
  bindAction($('#navBackup'), async () => { closeDrawer(); await doSafetyBackup(); });
  $('#navTopics').addEventListener('click', () => { closeDrawer(); openTopicsManager(); });
  $('#navQuickBar').addEventListener('click', () => { closeDrawer(); openQuickBarManager(); });
  $('#navRoles').addEventListener('click', () => { closeDrawer(); openRolesSetup(); });
  $('#navAlerts').addEventListener('click', () => { closeDrawer(); openAlertsDialog(); });
  $('#navDrive').addEventListener('click', () => { closeDrawer(); openDrive(); });
  $('#navAbout').addEventListener('click', () => { closeDrawer(); openAbout(); });
  bindAction($('#navStorage'), async () => { closeDrawer(); await openStorageStatus(); });
  $('#navWipe').addEventListener('click', () => { closeDrawer(); openWipe(); });
  const drawerVersionEl = $('#drawerVersion');
  if (drawerVersionEl) drawerVersionEl.textContent = window.CW_VERSION || '';

  // Back-gesture handler: close overlays instead of exiting the PWA
  window.addEventListener('popstate', handlePopState);
  $('#tabs').addEventListener('keydown', (event) => {
    const index = VIEWS.indexOf(state.view);
    let target = null;
    if (event.key === 'ArrowRight') target = (index + 1) % VIEWS.length;
    if (event.key === 'ArrowLeft') target = (index + VIEWS.length - 1) % VIEWS.length;
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = VIEWS.length - 1;
    if (target == null) return;
    event.preventDefault();
    setView(VIEWS[target]);
    $(`#tab-${VIEWS[target]}`).focus();
  });
  CWMODEL.start();
  setInterval(() => { if (document.visibilityState !== 'hidden') refreshLiveLabels(); }, 30000);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      await reload();
      if (!$('#modalRoot .dialog')) renderCurrent();
      refreshLiveLabels();
    } catch (error) { reportError(error); }
  });

  // Listen for service worker update prompts
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updatingApp) location.reload();
    });
  }
  bindAction($('#installUpdate'), async () => {
    if (!waitingWorker) throw new Error('The update is no longer waiting. Reopen the app to check again.');
    if ($('#modalRoot .dialog')) throw new Error('Finish or close the editor before updating.');
    await CWMODEL.prepareUpdate();
    try {
      if ($('#modalRoot .dialog')) throw new Error('Finish or close the editor before updating.');
      updatingApp = true;
      if (waitingWorker.state === 'activated') location.reload();
      else waitingWorker.postMessage({ type: 'ACTIVATE_UPDATE' });
    } catch (error) {
      updatingApp = false;
      CWMODEL.cancelUpdate();
      throw error;
    }
  });

  setView('categories');

  // Attempt a silent startup sync if Drive is configured.
  if (window.CWDRIVE?.startupSync) {
    try { await window.CWDRIVE.startupSync(); } catch (_) {}
  }

  // Status check (opt-in, throttled).
  try { await checkStatusAlert(); } catch (e) { console.warn(e); }
}

window.addEventListener('DOMContentLoaded', () => init().catch(reportError));
// Exposed for inline onclick in empty states + drive.js callbacks
window.openTopicEdit = openTopicEdit;
window.CWAPP = {
  reload,
  renderCurrent,
  snack,
  openModal,
  closeModal,
  $, $$,
  fmtDateLong, fmtTime,
  mutate: CWMODEL.mutate,
  watchUpdates,
};
