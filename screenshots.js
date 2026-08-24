/* Generates Play Store screenshots from deterministic demo data.
 *
 * Runs the real app in Chrome against a temporary local server, seeds a
 * synthetic 100-day dataset through the app's own CWDB API, then captures
 * each view at 1080x1920 (Play's recommended phone size). Play requires every
 * side to fall in 320..3840px with the long side at most 2x the short one, so
 * a native capture from a tall modern phone (20:9) would be rejected on ratio.
 *
 * Captured assets are checked against those rules before this script exits;
 * otherwise a violation only surfaces as an upload error in the Console.
 *
 * Your own data is never touched: Chrome runs in a throwaway profile with
 * its own IndexedDB.
 *
 *   npm run screenshots      -> writes store/screenshots/*.png
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'store', 'screenshots');
const PORT = 8791;

/* Play's recommended phone screenshot size, and comfortably inside its
 * 320..3840px per-side bounds. Every emitted asset lands on exactly this. */
const SHOT_W = 1080;
const SHOT_H = 1920;
const SHOT_SCALE = 3;

/* ---------- deterministic RNG so re-runs produce identical images ------- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- demo dataset ------------------------------------------------ */
const DAYS = 100;

const TOPICS = [
  { id: 1, name: 'Water',      emoji: '💧', color: '#3b82f6', kind: 'amount',   msureid: 101 },
  { id: 2, name: 'Coffee',     emoji: '☕', color: '#ff7a2f', kind: 'timeonly', msureid: 10 },
  { id: 3, name: 'Workout',    emoji: '🏃', color: '#17a673', kind: 'duration', msureid: 10 },
  { id: 4, name: 'Sleep',      emoji: '😴', color: '#6b5bd6', kind: 'duration', msureid: 10 },
  { id: 5, name: 'Headache',   emoji: '🤕', color: '#e5484d', kind: 'timeonly', msureid: 10 },
  { id: 6, name: 'Meditation', emoji: '🧘', color: '#12b3a6', kind: 'timeonly', msureid: 10 },
  { id: 7, name: 'Reading',    emoji: '📖', color: '#b8860b', kind: 'duration', msureid: 10 },
];

const ROLES = {
  5: { role: 'focus', dir: 'down' },
  2: { role: 'influence', timing: true },
  4: { role: 'influence', timing: true },
  1: { role: 'influence' },
  3: { role: 'influence' },
  6: { role: 'influence' },
  7: { role: 'influence' },
};

function buildDemoData() {
  const rnd = mulberry32(20260817);
  const pick = (lo, hi) => lo + rnd() * (hi - lo);
  const chance = (p) => rnd() < p;

  const events = [];
  let id = 1;
  /* Anchor "today" at 21:30 so the seeded day has a full evening of activity.
   * Whatever part of that day is still ahead of the real clock is dropped
   * below, so the capture always shows a partial today with fresh entries
   * rather than events dated into the future. */
  const now = new Date();
  now.setHours(21, 30, 0, 0);

  const at = (dayOffset, hour, min) => {
    const d = new Date(now);
    d.setDate(d.getDate() - dayOffset);
    d.setHours(hour, min, 0, 0);
    return d.getTime();
  };
  const push = (time, topicid, qant, cost = 0, note = '') =>
    events.push({ id: id++, time, topicid, qant, cost, note });

  for (let d = DAYS - 1; d >= 0; d--) {
    // Sleep: logged each morning, 5.5-8.5h. Weekends run longer.
    const weekend = [0, 6].includes(new Date(at(d, 12, 0)).getDay());
    const sleepH = weekend ? pick(7.2, 8.6) : pick(5.6, 8.0);
    push(at(d, 7, Math.floor(pick(0, 50))), 4, Math.round(sleepH * 3600));

    // Coffee: 1-4 cups, occasionally a late one.
    const cups = 1 + Math.floor(pick(0, weekend ? 2.4 : 3.6));
    for (let c = 0; c < cups; c++) {
      const hour = c === 0 ? 7 + Math.floor(pick(0, 2)) : 10 + Math.floor(pick(0, 8));
      push(at(d, hour, Math.floor(pick(0, 59))), 2, 60);
    }
    const lateCoffee = cups >= 3 && chance(0.45);
    if (lateCoffee) push(at(d, 17 + Math.floor(pick(0, 3)), 20), 2, 60);

    // Water: 4-9 servings.
    const servings = 4 + Math.floor(pick(0, 6));
    for (let s = 0; s < servings; s++) {
      push(at(d, 8 + Math.floor((s / servings) * 13), Math.floor(pick(0, 59))),
        1, [8, 12, 16][Math.floor(pick(0, 3))]);
    }

    // Workout: ~4x/week.
    if (chance(0.55)) {
      push(at(d, weekend ? 10 : 18, Math.floor(pick(0, 40))), 3,
        Math.round(pick(28, 72) * 60));
    }

    // Meditation: most days.
    if (chance(0.72)) push(at(d, 22, Math.floor(pick(0, 30))), 6, 60);

    // Reading: about half.
    if (chance(0.5)) push(at(d, 21, Math.floor(pick(0, 30))), 7, Math.round(pick(15, 45) * 60));

    // Headache: driven by short sleep and heavy/late caffeine, so the
    // insights engine has a genuine signal to find in the demo data.
    let p = 0.06;
    if (sleepH < 6.6) p += 0.30;
    if (cups >= 4) p += 0.18;
    if (lateCoffee) p += 0.16;
    if (chance(p)) {
      push(at(d, 14 + Math.floor(pick(0, 6)), Math.floor(pick(0, 59))), 5, 60,
        Math.floor(pick(1, 5)));
    }
  }

  const since = at(DAYS - 1, 0, 0);
  const goals = {
    1: { metric: 'amount',  cmp: 'gte', target: 64, period: 'day',  since },
    3: { metric: 'count',   cmp: 'gte', target: 4,  period: 'week', since },
    5: { metric: 'count',   cmp: 'lte', target: 1,  period: 'week', since },
    6: { metric: 'count',   cmp: 'gte', target: 1,  period: 'day',  since },
  };

  /* Drop anything the 21:30 anchor pushed past the real clock, so the newest
   * card always reads a sensible "N mins ago" instead of a negative value. */
  const cutoff = Date.now();
  return { events: events.filter((e) => e.time <= cutoff), goals };
}

/* ---------- tiny static server ----------------------------------------- */
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, () => resolve(server));
  });
}

/* ---------- capture ----------------------------------------------------- */
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({
    viewport: { width: SHOT_W / SHOT_SCALE, height: SHOT_H / SHOT_SCALE },
    deviceScaleFactor: SHOT_SCALE,   // 360x640 @3 => 1080x1920 exactly
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
    colorScheme: 'light',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('  page error:', e.message));

  await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.CWDB);

  const data = buildDemoData();
  await page.evaluate(async ({ topics, roles, data }) => {
    await CWDB.seedDefaults();
    for (const s of ['events', 'topics']) {
      for (const row of await CWDB.getAll(s)) await CWDB.delete(s, row.id);
    }
    await CWDB.putMany('topics', topics.map((t) => ({
      id: t.id, name: t.name, desc: '', msureid: t.msureid,
      optype: 1, type: 1, archived: false,
    })));
    await CWDB.putMany('events', data.events);
    await CWDB.setMeta('topicOrder', topics.map((t) => t.id));
    await CWDB.setMeta('topicKinds',
      Object.fromEntries(topics.map((t) => [t.id, t.kind])));
    await CWDB.setMeta('topicMeta',
      Object.fromEntries(topics.map((t) => [t.id, { emoji: t.emoji, color: t.color }])));
    await CWDB.setMeta('topicRoles', roles);
    await CWDB.setMeta('topicGoals', data.goals);
    await CWDB.setMeta('quickBar', [1, 2, 3, 6]);
    await CWDB.setMeta('onboarded', true);
  }, { topics: TOPICS, roles: ROLES, data });

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.CWDB && document.querySelector('#main'));
  await page.waitForTimeout(1200);

  // The repo ships a Drive client ID in config.js, so a fresh profile tries to
  // auto-sync, fails (no token), and parks a "tap to fix" pill in the header.
  // Clearing it once is not enough: any later failed sync calls setStatus and
  // puts it straight back. A style rule wins permanently, including for
  // elements re-created after this point.
  await page.evaluate(() => { window.CW_CONFIG.driveClientId = ''; });
  await page.addStyleTag({ content: '#syncPill{display:none !important}' });

  const shots = [
    ['01-categories', 'categories'],
    ['02-statistics', 'stats'],
    ['03-insights', 'insights'],
    ['05-day', 'day'],
    ['06-recent', 'recent'],
  ];

  for (const [name, view] of shots) {
    await page.evaluate((v) => setView(v), view);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`  ${name}.png`);
  }

  // The statistical findings are below the fold on the Insights tab, and
  // they are the most compelling part, so give them their own frame.
  await page.evaluate(() => setView('insights'));
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('#main *'))
      .find((e) => !e.children.length &&
        e.textContent.trim().toLowerCase().startsWith('what stands out'));
    if (el) el.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '04-findings.png') });
  console.log('  04-findings.png');

  await frameShots(browser);

  await browser.close();
  server.close();

  verifyPlayAssets();
}

/* ---------- Play asset compliance --------------------------------------- */
/* Play rejects screenshots outside its bounds, and the failure surfaces only
 * at upload time. Reading the PNG header here turns that into a build error.
 * Requirements (support.google.com/googleplay/android-developer/answer/9866151):
 * 24-bit PNG with no alpha, every side 320..3840, long side <= 2x short side. */
function pngHeader(file) {
  const d = fs.readFileSync(file);
  return {
    width: d.readUInt32BE(16),
    height: d.readUInt32BE(20),
    colorType: d.readUInt8(25),
  };
}

function verifyPlayAssets() {
  const shots = [
    ...fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).map((f) => path.join(OUT, f)),
    ...fs.readdirSync(path.join(OUT, 'framed')).map((f) => path.join(OUT, 'framed', f)),
  ];
  const bad = [];
  for (const file of shots) {
    const { width, height, colorType } = pngHeader(file);
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    const rel = path.relative(OUT, file);
    if (colorType !== 2) bad.push(`${rel}: needs 24-bit RGB with no alpha (colorType=${colorType})`);
    if (short < 320) bad.push(`${rel}: ${short}px side is under Play's 320px minimum`);
    if (long > 3840) bad.push(`${rel}: ${long}px side exceeds Play's 3840px maximum`);
    if (long > short * 2) bad.push(`${rel}: ${long}x${short} is more than 2:1`);
  }
  if (bad.length) {
    console.error('\nPlay would reject these assets:');
    bad.forEach((b) => console.error('  ' + b));
    process.exit(1);
  }
  console.log(`\n  ${shots.length} screenshots pass Play's size rules`);
}

/* ---------- captioned store frames -------------------------------------- */
/* Raw captures show the app but not the pitch. These wrap each one in a
 * branded card with a headline, and let the screenshot bleed off the bottom
 * edge so the frame reads as a poster rather than a phone dump. */
const BRAND = '#ff7a2f';
const INK_BOT = '#0d1120';

const FRAMES = [
  ['03-insights',   'Most trackers count.\nPlotline explains.',
                    'Real statistics over your own log — not just a prettier chart.'],
  ['04-findings',   'Findings in plain\nEnglish.',
                    'Corrected for false discoveries, so you are not chasing noise.'],
  ['01-categories', 'One tap to log.',
                    'Counts, amounts, durations, severity — whatever the thing needs.'],
  ['02-statistics', 'See the shape\nof a habit.',
                    'Totals, trends, and time since last on every topic.'],
  ['06-recent',     'Goals that hold\nyou to it.',
                    'Set a target, keep the streak, beat your own record.'],
  ['05-day',        'Nothing leaves\nyour phone.',
                    'No account, no server, no ads. Works fully offline.'],
];

/* The frame markup is authored in 1080x1920 CSS pixels, so it needs its own
 * context at deviceScaleFactor 1. Reusing the capture page would inherit that
 * context's scale factor of 3 and emit 3240x5760 - past Play's 3840px cap. */
async function frameShots(browser) {
  const outDir = path.join(OUT, 'framed');
  fs.mkdirSync(outDir, { recursive: true });

  const ctx = await browser.newContext({
    viewport: { width: SHOT_W, height: SHOT_H },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    colorScheme: 'light',
  });
  const page = await ctx.newPage();

  for (const [src, headline, sub] of FRAMES) {
    const b64 = fs.readFileSync(path.join(OUT, `${src}.png`)).toString('base64');
    const html = `<!doctype html><meta charset="utf-8"><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{width:${SHOT_W}px;height:${SHOT_H}px;overflow:hidden;color:#fff;
        background:radial-gradient(120% 130% at 10% 6%, #2b3459 0%, ${INK_BOT} 60%);
        font-family:-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif}
      .copy{padding:104px 84px 0}
      h1{font-size:76px;font-weight:700;letter-spacing:-2.4px;line-height:1.06;
        white-space:pre-line}
      p{margin-top:26px;font-size:33px;line-height:1.4;color:#aeb8d8;
        letter-spacing:-.2px;max-width:900px}
      .rule{width:104px;height:9px;border-radius:5px;background:${BRAND};margin-top:38px}
      .device{position:absolute;left:50%;transform:translateX(-50%);top:566px;
        width:930px;height:1354px;overflow:hidden;border-radius:46px;
        border:11px solid rgba(255,255,255,.10);
        box-shadow:0 40px 90px rgba(0,0,0,.55)}
      .device img{display:block;width:100%}
    </style>
    <div class="copy"><h1>${headline}</h1><p>${sub}</p><div class="rule"></div></div>
    <div class="device"><img src="data:image/png;base64,${b64}"></div>`;

    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForTimeout(250);
    const name = `f${FRAMES.findIndex((f) => f[0] === src) + 1}-${src.slice(3)}.png`;
    await page.screenshot({ path: path.join(outDir, name) });
    console.log(`  framed/${name}`);
  }
  await ctx.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
