/* UI smoke test.
 *
 * Loads the real app/index.html + app scripts in jsdom against a fake IndexedDB,
 * so a runtime error in rendering fails loudly here instead of on the phone.
 * Covers first-launch onboarding, every tab, the insights analysis, and the
 * role editor round-trip.
 *
 *   npm install && node ui-smoke.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const FDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');

const ROOT = __dirname;
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail?.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const APP_HTML = path.join(ROOT, 'app', 'index.html');

const html = fs.readFileSync(APP_HTML, 'utf8')
  .replace(/<script[^>]*src="https?:[^"]*"[^>]*><\/script>/g, '');  // drop the CDN Chart.js

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'https://example.com/',
  virtualConsole: vc,
  pretendToBeVisual: true,
});
const w = dom.window;
w.indexedDB = new FDBFactory();
w.IDBKeyRange = FDBKeyRange;
w.Chart = class { constructor() {} destroy() {} };
w.Chart.defaults = { color: '', font: {}, plugins: { legend: {} }, scale: { grid: {} } };
w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
w.scrollTo = () => {};
try { delete w.navigator.serviceWorker; } catch (_) {}

const load = (rel) => {
  try {
    w.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch (e) {
    errors.push(`load ${rel}: ${e.stack}`);
  }
};

/* Take the script list straight from the app document, in order, so adding a
 * module to the app can never silently leave it untested. The app lives at
 * /app/ but loads its assets from the site root, so strip either prefix. */
const scripts = [...fs.readFileSync(APP_HTML, 'utf8')
  .matchAll(/<script[^>]*src="(?!https?:)([^"]+)"/g)]
  .map((m) => m[1].replace(/^\.?\//, ''))
  .filter((f) => !f.startsWith('vendor/'));   // Chart.js is stubbed; jsdom has no canvas
if (!scripts.includes('js/app.js')) throw new Error('no app scripts found in app/index.html');
scripts.forEach(load);

(async () => {
  const D = w.CWDB;
  const N = w.CWINSIGHTS;

  // 1. Fresh install: onboarding is offered.
  await D.seedDefaults();
  const fresh = await w.eval('needsOnboarding()');
  assert(fresh === true, 'fresh install should need onboarding');
  await w.eval('openOnboarding()');
  const cards = w.document.querySelectorAll('[data-preset]');
  assert(cards.length === 4, `expected 4 preset cards, got ${cards.length}`);

  // 2. Tapping a preset card creates topics with roles.
  const card = w.document.querySelector('[data-preset="symptoms"]');
  card.dispatchEvent(new w.Event('click'));
  await waitFor(async () => (await D.getAll('topics')).length === 5 && !w.document.querySelector('.dialog'));
  const topics = await D.getAll('topics');
  assert(topics.length === 5, `preset seeded ${topics.length} topics, expected 5`);
  ok('symptom preset seeds 5 topics');
  const roles = await D.getTopicRoles();
  const norm = N.normalizeRoles(roles);
  assert(Object.values(norm).some((r) => r.role === 'focus'), 'preset must define a focus');
  assert(await w.eval('needsOnboarding()') === false, 'onboarding should not repeat');

  // 3. Seed ~200 days of events with a planted effect, then render.
  //    Every event is anchored to a fixed hour of its *logical* day (the app
  //    rolls days over at 4am) so the run is identical whatever time of day
  //    the suite happens to be executed at.
  const byName = Object.fromEntries(topics.map((t) => [t.name, t.id]));
  let eid = 1;
  const evs = [];
  const at = (daysAgo, hour) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    return d.getTime();
  };
  for (let d = 200; d >= 0; d--) {
    const lateMeal = d % 3 === 0;
    evs.push({ id: eid++, topicid: byName['Meal'], time: at(d, lateMeal ? 21 : 9), qant: 0, cost: 0 });
    const n = lateMeal ? 4 : 1;
    for (let i = 0; i < n; i++) {
      evs.push({ id: eid++, topicid: byName['Symptom'], time: at(d, 12) + i * 1800000, qant: 0, cost: 0 });
    }
    evs.push({ id: eid++, topicid: byName['Sleep'], time: at(d, 22), qant: 25200, cost: 0 });
    if (d % 17 === 0) evs.push({ id: eid++, topicid: byName['Bad day'], time: at(d, 13), qant: 0, cost: 0 });
  }
  await D.putMany('events', evs);
  await D.setMeta('topicPrefs', Object.fromEntries(topics.map((topic) =>
    [topic.id, { trackingStart: at(200, 4), aggregation: 'sum' }])));
  await D.setTopicGoal(byName['Sleep'], {
    metric: 'minutes', cmp: 'gte', target: 30, period: 'day', since: at(200, 4),
  });
  await w.eval('reload()');

  for (const view of ['categories', 'recent', 'day', 'stats', 'insights']) {
    w.eval(`setView('${view}')`);
    const out = w.document.querySelector('#main').innerHTML;
    assert(out && out.length > 50, `${view} rendered empty`);
    ok(`${view} view renders (${out.length} chars)`);
  }

  // 4. The insights view specifically must show the real analysis, not setup.
  w.eval(`setView('insights')`);
  const ins = w.document.querySelector('#main').innerHTML;
  assert(!/One-time setup/.test(ins), 'insights still showing the setup card');
  assert(/Symptom per day/.test(ins), 'trend heading should use the focus topic name');
  assert(/Timing/.test(ins), 'timing section missing');
  assert(!/bathroom|trips|flare-up|poop/i.test(ins), 'domain vocabulary leaked into the UI');
  ok('insights renders the full analysis with the user\'s own vocabulary');

  // 5. Goals: the streak chip appears on the home screen and the editor
  //    round-trips. The symptom preset ships an "at most 0 per day" goal.
  const goals = await D.getTopicGoals();
  assert(Object.keys(goals).length >= 1, 'preset should seed at least one goal');
  w.eval(`setView('categories')`);
  const home = w.document.querySelector('#main').innerHTML;
  assert(/goal-chip/.test(home), 'no streak chip rendered on the home screen');
  ok('preset goals render a streak chip on the home screen');

  w.eval(`setView('stats')`);
  const symptomId = byName['Symptom'];
  const topicSel = w.document.querySelector('#statsTopic');
  topicSel.value = String(symptomId);
  topicSel.dispatchEvent(new w.Event('change'));
  const statsHtml = w.document.querySelector('#main').innerHTML;
  assert(/goal-section/.test(statsHtml), 'stats is missing the goal panel');
  assert(/goal-dot/.test(statsHtml), 'stats is missing the period dots');
  ok('stats renders the goal panel');

  // The Symptom topic is logged every day, so an "at most 0/day" goal is blown.
  const symptomGoal = w.eval(`JSON.stringify(goalFor({ id: ${symptomId} }))`);
  const parsed = JSON.parse(symptomGoal);
  assert(parsed && parsed.current === 0, 'a daily-logged topic cannot hold an "at most 0" streak');
  ok('streak math reflects the seeded history');

  // 6. The goal editor round-trips through the DB and moves the streak.
  //    Sleep is logged every single day, so "at least 1 per day" must show a
  //    long streak the moment the goal is saved.
  w.eval(`setView('stats')`);
  const sleepSel = w.document.querySelector('#statsTopic');
  sleepSel.value = String(byName['Sleep']);
  sleepSel.dispatchEvent(new w.Event('change'));
  w.document.querySelector('#editGoal').dispatchEvent(new w.Event('click'));
  w.document.querySelector('#goalCmp').value = 'gte';
  w.document.querySelector('#goalTarget').value = '1';
  w.document.querySelector('#goalPeriod').value = 'day';
  w.document.querySelector('#goalSave').dispatchEvent(new w.Event('click'));
  await waitFor(() => !w.document.querySelector('.dialog'));
  const savedGoal = (await D.getTopicGoals())[byName['Sleep']];
  assert(savedGoal && savedGoal.cmp === 'gte' && savedGoal.target === 1,
    'goal editor did not persist: ' + JSON.stringify(savedGoal));
  assert(savedGoal.metric === 'minutes', 'a duration topic should measure minutes');
  const sleepRes = JSON.parse(w.eval(`JSON.stringify(goalFor({ id: ${byName['Sleep']} }))`));
  assert(sleepRes.current > 100, `expected a long streak, got ${sleepRes.current}`);
  ok('goal editor saves and the streak updates immediately');

  // 7. The dialogs all open without throwing.
  for (const fn of ['openRolesSetup()', 'openAlertsDialog()']) {
    w.eval(fn);
    assert(w.document.querySelector('#modalRoot .dialog'), `${fn} did not open`);
    w.CWUI.closeModal();
    ok(`${fn} opens`);
  }

  // 8. Saving roles round-trips the new dir/timing fields.
  w.eval('openRolesSetup()');
  const sel = w.document.querySelector(`[data-role-topic="${byName['Symptom']}"]`);
  sel.value = 'focus';
  w.document.querySelector(`[data-role-dir="${byName['Symptom']}"]`).value = 'up';
  w.document.querySelector(`[data-role-timing="${byName['Symptom']}"]`).checked = true;
  w.document.querySelector('#saveRoles').dispatchEvent(new w.Event('click'));
  await waitFor(() => !w.document.querySelector('.dialog'));
  const saved = N.normalizeRoles(await D.getTopicRoles())[byName['Symptom']];
  assert(saved.role === 'focus' && saved.dir === 'up' && saved.timing === true,
    'role editor lost dir/timing: ' + JSON.stringify(saved));
  ok('role editor saves direction and timing');
  await w.CWMODEL.whenIdle();

  if (errors.length) {
    console.error('\nruntime errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('\nall passing');
  w.close();
})().catch((e) => {
  console.error(e.stack || e);
  if (errors.length) console.error('\nruntime errors:\n' + errors.join('\n'));
  process.exit(1);
});

function assert(c, m) { if (!c) throw new Error(m); }
function ok(m) { console.log('  ok  ' + m); }
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the UI action');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
