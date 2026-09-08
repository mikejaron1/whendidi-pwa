/* Plotline - Statistics aggregation
 * Buckets events by day / week (Mon-start) / month for a single topic.
 * Plus intervals, time-of-day, day-of-week, calendar heatmap, and
 * cross-topic correlations.
 */

function startOfDay(ts, cutoffHour = 0) {
  const d = new Date(ts);
  if (d.getHours() + d.getMinutes() / 60 < cutoffHour) d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(key, n) {
  const d = new Date(key);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function logicalDate(ts, cutoffHour = 0) {
  const d = new Date(startOfDay(ts, cutoffHour));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayBoundary(key, cutoffHour = 0) {
  const d = new Date(key);
  d.setHours(Math.floor(cutoffHour), Math.round((cutoffHour % 1) * 60), 0, 0);
  return d.getTime();
}

function minutesFromDayStart(ts, cutoffHour = 0) {
  const d = new Date(ts);
  return ((d.getHours() * 60 + d.getMinutes() - cutoffHour * 60) % 1440 + 1440) % 1440;
}

function quantity(e) {
  const q = e.qant == null || e.qant === '' ? 0 : Number(e.qant);
  if (!Number.isFinite(q)) throw new Error(`Invalid quantity for event ${e.id ?? ''}`);
  return q;
}

function startOfWeek(ts, cutoffHour = 0) {
  const d = new Date(startOfDay(ts, cutoffHour));
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun
  const diff = (dow + 6) % 7; // Mon-start
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

function startOfMonth(ts, cutoffHour = 0) {
  const d = new Date(startOfDay(ts, cutoffHour));
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

const BUCKETERS = {
  daily: startOfDay,
  weekly: startOfWeek,
  monthly: startOfMonth,
};

function labelFor(period, ts) {
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  if (period === 'monthly') return `${months[d.getMonth()]} ${d.getFullYear()}`;
  if (period === 'weekly') {
    const end = new Date(d); end.setDate(end.getDate() + 6);
    return `${d.getDate()}/${d.getMonth()+1} – ${end.getDate()}/${end.getMonth()+1}`;
  }
  return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`;
}

function aggregate(events, period, opts = {}) {
  const bucket = BUCKETERS[period];
  if (!bucket) throw new Error(`unknown period ${period}`);
  const { cutoffHour = 0, start, end, fill = false, aggregation = 'sum' } = opts;
  if (!['sum', 'mean', 'latest', 'min', 'max'].includes(aggregation)) throw new Error('Unknown aggregation');
  if (fill && (!Number.isFinite(start) || !Number.isFinite(end))) throw new Error('Filling requires bounded start/end');
  const map = new Map();
  const empty = (k) => ({ bucket: k, count: 0, sumQant: 0, minTime: null, maxTime: null,
    min: null, max: null, latest: null, mean: null, value: 0 });
  if (fill) {
    for (let k = bucket(start, cutoffHour), n = 0; k <= bucket(end, cutoffHour); n++) {
      if (n >= 100000) throw new Error('Aggregation range too large');
      map.set(k, empty(k));
      if (period === 'monthly') {
        const d = new Date(k); d.setMonth(d.getMonth() + 1); k = d.getTime();
      } else k = addDays(k, period === 'weekly' ? 7 : 1);
    }
  }
  for (const e of events) {
    if ((start != null && e.time < start) || (end != null && e.time > end)) continue;
    const k = bucket(e.time, cutoffHour);
    if (!map.has(k)) {
      map.set(k, empty(k));
    }
    const b = map.get(k);
    const q = quantity(e);
    b.count++;
    b.sumQant += q;
    b.min = b.min == null ? q : Math.min(b.min, q);
    b.max = b.max == null ? q : Math.max(b.max, q);
    if (b.minTime == null || e.time < b.minTime) b.minTime = e.time;
    if (b.maxTime == null || e.time >= b.maxTime) { b.maxTime = e.time; b.latest = q; }
  }
  for (const b of map.values()) {
    b.sum = b.sumQant;
    b.mean = b.count ? b.sumQant / b.count : null;
    b.value = aggregation === 'sum' ? b.sumQant : b[aggregation];
  }
  return Array.from(map.values()).sort((a, b) => b.bucket - a.bucket);
}

/* Intervals between consecutive events of the same topic (ms). */
function intervals(events) {
  if (events.length < 2) return [];
  const sorted = events.slice().sort((a, b) => a.time - b.time);
  const out = [];
  for (let i = 1; i < sorted.length; i++) {
    out.push(sorted[i].time - sorted[i-1].time);
  }
  return out;
}

function intervalStats(events, now = Date.now()) {
  const ivs = intervals(events);
  if (!events.length) return null;
  const last = now - events.reduce((latest, e) => Math.max(latest, e.time), -Infinity);
  if (!ivs.length) return { count: 0, min: null, max: null, median: null, avg: null, last, lastInterval: null };
  const sorted = ivs.slice().sort((a, b) => a - b);
  const avg = ivs.reduce((s, x) => s + x, 0) / ivs.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    count: ivs.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median,
    avg,
    last,
    lastInterval: ivs[ivs.length - 1],
  };
}

/* 24 buckets, one per hour (local time). */
function timeOfDay(events) {
  const buckets = new Array(24).fill(0);
  for (const e of events) {
    const h = new Date(e.time).getHours();
    buckets[h]++;
  }
  return buckets;
}

/* 7 buckets, Mon..Sun. */
function dayOfWeek(events, cutoffHour = 0) {
  const buckets = new Array(7).fill(0);
  for (const e of events) {
    const dow = new Date(startOfDay(e.time, cutoffHour)).getDay(); // 0=Sun
    const idx = (dow + 6) % 7;             // Mon-start
    buckets[idx]++;
  }
  return buckets;
}

/* Calendar matrix for last N weeks (default 26 ≈ 6 months).
 * Returns: { weeks: [[{date, count, sum}, ...7], ...], maxCount, total }
 * Indexed Mon..Sun within each week. Oldest week first.
 */
function calendarMatrix(events, weeks = 26, cutoffHour = 0, now = Date.now()) {
  // Find start of week (Mon) for "today"
  const todayMonStart = startOfWeek(now, cutoffHour);
  const startMs = addDays(todayMonStart, -(weeks - 1) * 7);
  const counts = new Map();
  let maxCount = 0;
  let total = 0;
  for (const e of events) {
    if (e.time > now) continue;
    const d = startOfDay(e.time, cutoffHour);
    if (d < startMs) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
    total++;
  }
  for (const v of counts.values()) if (v > maxCount) maxCount = v;
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const weekStart = addDays(startMs, w * 7);
    const days = [];
    for (let d = 0; d < 7; d++) {
      const day = addDays(weekStart, d);
      days.push({ date: day, count: counts.get(day) || 0 });
    }
    out.push(days);
  }
  return { weeks: out, maxCount, total };
}

/* Cross-topic correlations:
 * For the focal topic's events, find the nearest event of each other
 * topic within a window (default 48h). Return per-other-topic the
 * average signed offset (negative = other happened BEFORE focal).
 *
 * Returns array of { otherTopicId, count, avgOffsetMs, beforeCount, afterCount }
 * sorted by descending |sample count|.
 */
function correlations(allEvents, focalTopicId, windowMs = 48 * 3600 * 1000) {
  const focal = allEvents.filter((e) => e.topicid === focalTopicId)
    .map((e) => e.time).sort((a, b) => a - b);
  if (!focal.length) return [];

  // Group other events by topic and sort
  const byTopic = new Map();
  for (const e of allEvents) {
    if (e.topicid === focalTopicId) continue;
    if (!byTopic.has(e.topicid)) byTopic.set(e.topicid, []);
    byTopic.get(e.topicid).push(e.time);
  }
  for (const arr of byTopic.values()) arr.sort((a, b) => a - b);

  const results = [];
  for (const [otherId, otherTimes] of byTopic.entries()) {
    let sampleCount = 0;
    let sumOffset = 0;
    let before = 0, after = 0;
    for (const ft of focal) {
      // Binary search for nearest in otherTimes
      let lo = 0, hi = otherTimes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (otherTimes[mid] < ft) lo = mid + 1;
        else hi = mid;
      }
      const candidates = [];
      if (lo > 0) candidates.push(otherTimes[lo - 1]);
      if (lo < otherTimes.length) candidates.push(otherTimes[lo]);
      let nearest = null;
      let bestAbs = Infinity;
      for (const c of candidates) {
        const d = Math.abs(c - ft);
        if (d < bestAbs) { bestAbs = d; nearest = c; }
      }
      if (nearest != null && bestAbs <= windowMs) {
        const offset = nearest - ft; // negative = other before focal
        sumOffset += offset;
        sampleCount++;
        if (offset < 0) before++; else after++;
      }
    }
    if (sampleCount === 0) continue;
    results.push({
      otherTopicId: otherId,
      sampleCount,
      avgOffsetMs: sumOffset / sampleCount,
      before, after,
    });
  }
  results.sort((a, b) => b.sampleCount - a.sampleCount);
  return results;
}

/* Parse #tags from a note string. Returns [{tag, start, end}, ...]. */
const TAG_RE = /#([A-Za-z0-9_][A-Za-z0-9_-]{0,30})/g;
function parseTags(note) {
  if (!note) return [];
  const out = [];
  let m;
  while ((m = TAG_RE.exec(note)) !== null) {
    out.push({ tag: m[1].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}
function tagSet(note) {
  return new Set(parseTags(note).map((t) => t.tag));
}
function allTagsFromEvents(events) {
  const counts = new Map();
  for (const e of events) {
    for (const t of tagSet(e.note || '')) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
}

function fmtIntervalShort(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  const sec = Math.round(abs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = abs / 3600000;
  if (hr < 48) return `${hr.toFixed(1)}h`;
  const days = abs / 86400000;
  if (days < 60) return `${days.toFixed(1)}d`;
  const mths = days / 30;
  return `${mths.toFixed(1)}mo`;
}

window.CWSTATS = {
  aggregate, labelFor,
  startOfDay, startOfWeek, startOfMonth,
  dayKey: startOfDay, addDays, logicalDate, dayBoundary, minutesFromDayStart, quantity,
  intervals, intervalStats,
  timeOfDay, dayOfWeek, calendarMatrix,
  correlations,
  parseTags, tagSet, allTagsFromEvents,
  fmtIntervalShort,
};
