/* WayStation arrival notifications (VCNNotify).
   Fires a system notification the moment navigation reaches the destination,
   mirroring the "You have arrived" voice cue. Permission is requested once at
   navigation start (inside the Start Drive gesture); the notification itself
   only ever fires after arrival, and only if permission was already granted.
   Everything browser-touching is guarded so this module loads anywhere. */
'use strict';
(function () {
  var TAG = 'ws-arrival';

  function supported() {
    return typeof window !== 'undefined' && 'Notification' in window;
  }
  function permission() {
    if (!supported()) return 'denied';
    try { return Notification.permission; } catch (e) { return 'denied'; }
  }
  /* Ask for notification permission. Call from a user gesture (Start Drive
     tap) — a request fired outside a gesture is silently dropped by the
     browser. Safe to call any time; no-ops unless permission is 'default'. */
  function ensurePermission() {
    if (!supported()) return Promise.resolve('denied');
    if (permission() !== 'default') return Promise.resolve(permission());
    try {
      var p = Notification.requestPermission();
      if (p && typeof p.then === 'function') return p;
      return Promise.resolve(permission());
    } catch (e) { return Promise.resolve('denied'); }
  }
  function show(title, body) {
    var opts = { body: body, tag: TAG, icon: 'icon-512.png', badge: 'icon-512.png', renotify: false };
    try {
      if (typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.ready) {
        return navigator.serviceWorker.ready.then(function (reg) {
          return reg.showNotification(title, opts);
        }).catch(function () {});
      }
    } catch (e) {}
    try { new Notification(title, opts); } catch (e) {}
    return Promise.resolve();
  }
  /* Fire the arrival notification. Safe to call any time — it no-ops unless
     permission was already granted. Resolves true when a notification went out. */
  function arrivalNotice(destLabel) {
    if (permission() !== 'granted') return Promise.resolve(false);
    try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) {}
    var label = (destLabel || '').trim();
    var body = label ? 'You have arrived at ' + label + '.' : 'You have arrived.';
    return Promise.resolve(show('WayStation', body)).then(function () { return true; });
  }
  window.VCNNotify = {
    supported: supported,
    permission: permission,
    ensurePermission: ensurePermission,
    arrivalNotice: arrivalNotice,
    TAG: TAG
  };
})();
