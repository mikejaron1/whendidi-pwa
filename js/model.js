/* Serialized local changes use the same origin-wide lock as Drive sync. */
(function () {
  'use strict';
  let pending = Promise.resolve();
  let channel = null;
  let acceptingChanges = true;

  async function lock(action) {
    if (window.CWDRIVE?.withDataLock) return CWDRIVE.withDataLock(action);
    if (navigator.locks?.request) return navigator.locks.request('plotline-data', action);
    return action();
  }

  function mutate(action) {
    if (!acceptingChanges) return Promise.reject(new Error('An update is being prepared. Please wait for the app to reload.'));
    const run = pending.then(() => lock(async () => {
      await window.CWAPP.reload();
      const result = await action();
      const checks = await CWDB.getMeta('dayChecks', {});
      const settings = await CWDB.getInsightSettings();
      const events = await CWDB.getAll('events');
      let changedChecks = false;
      for (const event of events) {
        const key = CWSTATS.logicalDate(event.time, settings.cutoffHour);
        if (checks[key] === 'none') { checks[key] = 'incomplete'; changedChecks = true; }
      }
      if (changedChecks) await CWDB.setMeta('dayChecks', checks);
      await CWDB.setMeta('lastLocalChangeAt', Date.now());
      await window.CWAPP.reload();
      window.CWAPP.renderCurrent();
      await window.CWDRIVE?.queueAutoSync('marked-change');
      channel?.postMessage('changed');
      return result;
    }));
    // A failed action must not poison the queue; the caller still receives it.
    pending = run.catch(() => {});
    return run;
  }

  async function prepareUpdate() {
    acceptingChanges = false;
    await pending;
  }

  function start() {
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('plotline-changes');
      channel.addEventListener('message', async () => {
        if (document.querySelector('#modalRoot .dialog')) {
          window.CWUI.snack('Data changed in another tab. Close this editor to refresh.');
          return;
        }
        try {
          await window.CWAPP.reload();
          window.CWAPP.renderCurrent();
        } catch (error) { window.CWUI.reportError(error); }
      });
    }
  }

  window.CWMODEL = { mutate, start, whenIdle: () => pending, prepareUpdate,
    cancelUpdate: () => { acceptingChanges = true; } };
})();
