/* ============================================================================
   WayStation — car-mode adapter (?car=1).

   Loaded BEFORE app.js. Its only early job is to plant the car flag so
   initAppMode() forces dashboard mode for this session (without persisting
   it to localStorage — the phone/PWA experience is untouched).

   The full window.WayStationCar bridge (visible/stable-area forwarding,
   Spotify token handoff, state queries) is installed by app.js after boot,
   because it needs SpotifyCore / theme / nav state to exist first.

   There is currently no mobile-only install prompt in the app (no
   beforeinstallprompt handler), so there is nothing to suppress; if one
   is ever added, gate it on !window.__WAYSTATION_CAR.
   ========================================================================== */
(function () {
  'use strict';
  var isCar = false;
  try {
    isCar = new URLSearchParams(window.location.search).get('car') === '1';
  } catch (e) { /* non-car path: nothing to do */ }
  if (!isCar) return;
  try { window.__WAYSTATION_CAR = true; } catch (e) {}

  /* --------------------------------------------------------------------------
     Native <select> dropdowns crash the car WebView. Tapping one makes
     Chromium show its select popup, which needs a real window token — the
     head-unit WebView has none, so the popup throws and the app process
     dies on the head unit. In car mode every <select> is therefore swapped
     for an in-page button list that drives the original select's value +
     change event, so existing handlers (theme switch, voice mode) run
     unchanged. Phone/PWA/desktop are untouched.
     -------------------------------------------------------------------------- */
  function carifySelect(sel) {
    if (!sel || sel.dataset.carified) return;
    try { sel.dataset.carified = '1'; } catch (e) { return; }

    var wrap = document.createElement('div');
    wrap.className = 'car-select';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'car-select-btn';
    var list = document.createElement('div');
    list.className = 'car-select-list';
    list.hidden = true;

    function currentLabel() {
      try {
        var opt = sel.selectedOptions && sel.selectedOptions[0];
        return opt ? opt.textContent : '';
      } catch (e) { return ''; }
    }
    function syncBtn() { btn.textContent = currentLabel() || 'Select'; }

    // Rebuild the option buttons from the live <select> every time the
    // list opens — the select's options/value are rebuilt by app.js
    // (buildThemeSelector / syncThemeSelector / applyTheme), so reading
    // them fresh at open time can never go stale.
    function rebuild() {
      while (list.firstChild) list.removeChild(list.firstChild);
      var opts = [];
      try { opts = Array.prototype.slice.call(sel.options); } catch (e) {}
      opts.forEach(function (opt) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'car-select-opt' + (opt.selected ? ' active' : '');
        b.textContent = opt.textContent;
        b.setAttribute('data-value', opt.value);
        b.addEventListener('click', function () {
          try {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (e) {}
          list.hidden = true;
          syncBtn();
        });
        list.appendChild(b);
      });
      syncBtn();
    }

    btn.addEventListener('click', function () {
      rebuild();
      list.hidden = !list.hidden;
    });

    try { sel.style.display = 'none'; } catch (e) {}
    try {
      sel.parentNode.insertBefore(wrap, sel.nextSibling);
    } catch (e) { return; }
    wrap.appendChild(btn);
    wrap.appendChild(list);
    syncBtn();
  }

  function carifyAll() {
    var sels = [];
    try { sels = document.querySelectorAll('select:not([data-carified])'); }
    catch (e) { return; }
    Array.prototype.forEach.call(sels, carifySelect);
  }

  // app.js builds the selectors during init; catch them on load and any
  // added later. Idempotent via data-carified.
  if (document.readyState === 'complete') carifyAll();
  else window.addEventListener('load', carifyAll);
  try {
    new MutationObserver(carifyAll)
      .observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
})();
