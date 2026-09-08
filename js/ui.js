/* Shared overlays and actions. Views supply content; this module owns focus,
 * history, busy states and error reporting. */
(function () {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  let returnFocus = null;
  let historyActive = false;
  let expectingBack = false;
  let modalDismissible = true;
  let snackTimer = null;
  let snackUndo = null;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function activeOverlay() {
    return $('#modalRoot .dialog') || $('#drawer.open .panel');
  }

  function focusables(root) {
    return [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
      .filter((el) => !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden], [inert]')
        && el.getClientRects().length > 0);
  }

  function syncOverlayState() {
    const overlay = activeOverlay();
    const shell = $('.app-shell');
    if (shell) shell.inert = !!overlay;
    const drawer = $('#drawer');
    if (drawer) {
      drawer.setAttribute('aria-hidden', String(!drawer.classList.contains('open')));
      drawer.inert = !!$('#modalRoot .dialog');
    }
    document.body.classList.toggle('overlay-open', !!overlay);
    if (!overlay && returnFocus) {
      const target = returnFocus.isConnected ? returnFocus : $('#menuBtn');
      target?.focus({ preventScroll: true });
      returnFocus = null;
    }
  }

  function enterOverlay() {
    if (!historyActive) {
      returnFocus = document.activeElement;
      history.pushState({ plotlineOverlay: true }, '');
      historyActive = true;
    }
    syncOverlayState();
  }

  function leaveOverlay(fromHistory) {
    syncOverlayState();
    if (fromHistory) { historyActive = false; return; }
    // Replacing a drawer with a dialog in the same action reuses the entry.
    queueMicrotask(() => {
      if (!activeOverlay() && historyActive && !expectingBack) {
        expectingBack = true;
        history.back();
      }
    });
  }

  function labelControls(root) {
    root.querySelectorAll('input, select, textarea').forEach((el, index) => {
      if (!el.id) el.id = `dialog-control-${index}`;
      if (el.labels?.length || el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return;
      const label = el.closest('.field')?.querySelector('label');
      if (label && !label.htmlFor) {
        label.htmlFor = el.id;
        return;
      }
      const rowName = el.closest('.role-row')?.querySelector('.role-name')?.textContent.trim();
      const fallback = el.id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
      el.setAttribute('aria-label', rowName || fallback);
    });
    root.querySelectorAll('button.icon-btn').forEach((el) => {
      if (el.hasAttribute('aria-label')) return;
      const text = el.textContent.trim();
      el.setAttribute('aria-label', el.title || ({ '←': 'Back', '✓': 'Save', '＋': 'Add' })[text] || text);
    });
  }

  function openModal(html, { dismissible = true } = {}) {
    const root = $('#modalRoot');
    modalDismissible = dismissible;
    root.innerHTML = `<div class="scrim"><section class="dialog" role="dialog" aria-modal="true" tabindex="-1">${html}</section></div>`;
    const dialog = $('.dialog', root);
    const title = $('.title', dialog);
    if (title) {
      title.id = 'dialog-title';
      dialog.setAttribute('aria-labelledby', title.id);
    } else dialog.setAttribute('aria-label', 'Plotline dialog');
    labelControls(dialog);
    root.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => closeModal()));
    $('.scrim', root).addEventListener('click', (event) => {
      if (modalDismissible && event.target === event.currentTarget) closeModal();
    });
    enterOverlay();
    (focusables(dialog)[0] || dialog).focus({ preventScroll: true });
  }

  function closeModal({ fromHistory = false, origin = null } = {}) {
    if (origin && $('#modalRoot .dialog') !== origin) return;
    $('#modalRoot').replaceChildren();
    leaveOverlay(fromHistory);
  }

  function openDrawer() {
    const drawer = $('#drawer');
    const panel = $('.panel', drawer);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Menu');
    panel.tabIndex = -1;
    drawer.classList.add('open');
    $('#menuBtn')?.setAttribute('aria-expanded', 'true');
    enterOverlay();
    (focusables(panel)[0] || panel).focus();
  }

  function closeDrawer({ fromHistory = false } = {}) {
    $('#drawer').classList.remove('open');
    $('#menuBtn')?.setAttribute('aria-expanded', 'false');
    leaveOverlay(fromHistory);
  }

  function handlePopState() {
    if (expectingBack) {
      expectingBack = false;
      historyActive = false;
      if (activeOverlay()) enterOverlay();
      return;
    }
    if ($('#modalRoot .dialog')) closeModal({ fromHistory: true });
    if ($('#drawer.open')) closeDrawer({ fromHistory: true });
    historyActive = false;
  }

  function snack(message, { undo = null } = {}) {
    const bar = $('#snackbar');
    snackUndo = undo;
    bar.innerHTML = `<span class="snack-msg">${escapeHtml(message)}</span>${undo
      ? '<button type="button" class="snack-action" id="snackUndoBtn">Undo</button>' : ''}`;
    $('#snackUndoBtn')?.addEventListener('click', async () => {
      if (!snackUndo) return;
      const callback = snackUndo;
      snackUndo = null;
      bar.classList.remove('show');
      try { await callback(); } catch (error) { reportError(error); }
    });
    bar.classList.add('show');
    clearTimeout(snackTimer);
    snackTimer = setTimeout(() => {
      bar.classList.remove('show');
      snackUndo = null;
    }, undo ? 10000 : 5000);
  }

  function reportError(error, origin = null) {
    console.error(error);
    const message = error?.message || String(error);
    const body = !origin || $('#modalRoot .dialog') === origin ? $('#modalRoot .body') : null;
    if (body) {
      let notice = $('.field-error', body);
      if (!notice) {
        notice = document.createElement('p');
        notice.className = 'field-error';
        notice.setAttribute('role', 'alert');
        body.prepend(notice);
      }
      notice.textContent = message;
    }
    snack(message);
  }

  function bindAction(element, handler, { event = 'click', mutation = false } = {}) {
    if (!element) return;
    let busy = false;
    element.addEventListener(event, async (e) => {
      if (busy) return;
      busy = true;
      const wasDisabled = element.disabled;
      if ('disabled' in element) element.disabled = true;
      element.setAttribute('aria-busy', 'true');
      const origin = element.closest('.dialog');
      const form = origin?.cloneNode(true) || null;
      if (form) {
        const sources = [...origin.querySelectorAll('input, select, textarea')];
        form.querySelectorAll('input, select, textarea').forEach((input, index) => {
          input.value = sources[index].value;
          if ('checked' in input) input.checked = sources[index].checked;
        });
      }
      const actionEvent = {
        target: e.target, currentTarget: element,
        form, origin,
        preventDefault: () => e.preventDefault(),
        stopPropagation: () => e.stopPropagation(),
      };
      try {
        if (mutation) await window.CWAPP.mutate(() => handler(actionEvent));
        else await handler(actionEvent);
      } catch (error) {
        reportError(error, origin);
      } finally {
        busy = false;
        if ('disabled' in element) element.disabled = wasDisabled;
        element.removeAttribute('aria-busy');
      }
    });
  }

  function openConfirm(title, body, onYes, yesLabel = 'Confirm') {
    openModal(`
      <header><button class="icon-btn" data-close aria-label="Back">←</button><div class="title">${escapeHtml(title)}</div></header>
      <div class="body confirm"><p>${escapeHtml(body)}</p></div>
      <div class="actions"><button class="btn secondary" data-close>Cancel</button>
        <button class="btn danger" id="confirmYes">${escapeHtml(yesLabel)}</button></div>`);
    bindAction($('#confirmYes'), onYes);
  }

  document.addEventListener('keydown', (event) => {
    const overlay = activeOverlay();
    if (!overlay) return;
    if (event.key === 'Escape') {
      if ($('#modalRoot .dialog') && modalDismissible) closeModal();
      else if (!$('#modalRoot .dialog')) closeDrawer();
      event.preventDefault();
    } else if (event.key === 'Tab') {
      const items = focusables(overlay);
      const first = items[0] || overlay;
      const last = items[items.length - 1] || overlay;
      if (!overlay.contains(document.activeElement)) {
        event.preventDefault(); first.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === overlay)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === overlay)) {
        event.preventDefault(); first.focus();
      }
    }
  });

  window.CWUI = { openModal, closeModal, openDrawer, closeDrawer, openConfirm,
    handlePopState, snack, escapeHtml, bindAction, reportError, labelControls };
})();
