/* Service worker lifecycle regressions, using the existing Node runner. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function worker({ fail = null } = {}) {
  const handlers = {};
  const deleted = [];
  const requested = [];
  const cache = {
    async addAll(urls) { if (urls.includes(fail)) throw new Error('missing essential asset'); },
    async add(url) { if (url === fail) throw new Error('missing optional asset'); },
    async match(url) { return { cached: url }; },
  };
  const context = {
    URL, console: { warn() {} },
    importScripts() {},
    caches: {
      async open() { return cache; },
      async keys() { return ['v7.7.2', 'plotline-8.0.0', 'unrelated-cache']; },
      async delete(key) { deleted.push(key); },
    },
    async fetch(request) { requested.push(request); return {}; },
    self: {
      CW_RELEASE: '8.0.0',
      location: { origin: 'https://example.com' },
      addEventListener(name, callback) { handlers[name] = callback; },
      async skipWaiting() { context.activated = true; },
      clients: { async claim() {} },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('sw.js', 'utf8'), context);
  function dispatch(name, fields = {}) {
    let result;
    handlers[name]({ ...fields, waitUntil(promise) { result = promise; },
      respondWith(promise) { result = promise; } });
    return result;
  }
  return { dispatch, context, deleted, requested };
}

(async () => {
  const broken = worker({ fail: '/js/app.js' });
  await assert.rejects(broken.dispatch('install'), /essential/);
  assert.equal(broken.context.activated, undefined, 'failed install must not activate');
  assert.deepEqual(broken.deleted, [], 'old cache survives install failure');
  const good = worker({ fail: '/favicon.ico' });
  await good.dispatch('install');
  assert.equal(good.context.activated, undefined, 'updates wait for user consent');
  await good.dispatch('activate');
  assert.deepEqual(good.deleted, ['v7.7.2']);
  const hit = await good.dispatch('fetch', { request: { method: 'GET', url: 'https://example.com/js/app.js' } });
  assert.equal(hit.cached, '/js/app.js');
  assert.equal(good.requested.length, 0, 'offline shell does not wait on network');
  for (const url of ['https://example.com/personal-backup.json', 'https://google.com/token']) {
    assert.equal(good.dispatch('fetch', { request: { method: 'GET', url } }), undefined);
  }
  await good.dispatch('message', { data: { type: 'ACTIVATE_UPDATE' } });
  assert.equal(good.context.activated, true);
  const html = fs.readFileSync('app/index.html', 'utf8');
  for (const [, src] of html.matchAll(/<script[^>]*src="([^"]+)"/g)) {
    assert.ok(fs.readFileSync('sw.js', 'utf8').includes(`'${src}'`), `${src} must be in the offline shell`);
  }
  console.log('service worker lifecycle passing');
})().catch((error) => { console.error(error); process.exitCode = 1; });
