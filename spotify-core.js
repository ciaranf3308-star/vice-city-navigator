/* ============================================================
   WayStation — Spotify core (THEME-INDEPENDENT).
   ------------------------------------------------------------
   Shared Spotify / player state and Web API access. No theme
   assumptions: no colours, no artwork, no layout. Themes
   provide their own skin and call this module.

   Auth: Authorization Code Flow with PKCE (no client secret,
   no implicit grant). Controls the user's EXISTING active
   Spotify device — this module never becomes a playback
   device itself (no Web Playback SDK, no `streaming` scope).

   Exposes window.SpotifyCore.
   ============================================================ */
'use strict';

(function () {
  const AUTH_KEY = 'vcn.spotify.auth';    // localStorage: tokens
  const OAUTH_KEY = 'vcn.spotify.oauth';  // sessionStorage: PKCE verifier+state
  const POLL_MS = 5000;                  // playback-state poll cadence
  const REFRESH_SKEW_MS = 60000;         // refresh 60 s before expiry

  const ACCOUNTS = 'https://accounts.spotify.com';
  const API = 'https://api.spotify.com/v1';

  let cfg = { clientId: '', redirectUri: '', scopes: [] };
  let auth = null;            // { access_token, refresh_token, expires_at }
  let lastState = null;       // last /v1/me/player payload (null = nothing)
  let lastStateSig = '';
  let lastStateAt = 0;
  let pollTimer = null;
  let listeners = { state: [], auth: [], error: [] };
  let beforeRedirectHook = null;

  /* ---------------- events ---------------- */
  function emit(name, data) {
    (listeners[name] || []).forEach(fn => { try { fn(data); } catch (e) { /* skin bug */ } });
  }

  /* ---------------- storage ---------------- */
  function loadAuth() {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (raw) auth = JSON.parse(raw);
    } catch (e) { auth = null; }
  }
  function saveAuth() {
    try {
      if (auth) localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      else localStorage.removeItem(AUTH_KEY);
    } catch (e) {}
    // Mirror to native storage so the car WebView picks it up without
    // re-auth (phone ↔ car share the app's native prefs, not localStorage).
    try {
      if (window.WayStationCarNative && window.WayStationCarNative.onSpotifyAuthChanged) {
        window.WayStationCarNative.onSpotifyAuthChanged(
          auth ? JSON.stringify(auth) : ''
        );
      }
    } catch (e) {}
  }

  /* ---------------- PKCE helpers ---------------- */
  function randString(len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const buf = new Uint8Array(len);
    crypto.getRandomValues(buf);
    let s = '';
    for (let i = 0; i < len; i++) s += chars[buf[i] % chars.length];
    return s;
  }
  function b64url(bytes) {
    let s = '';
    bytes.forEach(b => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function challenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return b64url(new Uint8Array(digest));
  }

  /* ---------------- auth flow ---------------- */
  function isConnected() { return !!(auth && auth.refresh_token); }

  async function connect() {
    if (beforeRedirectHook) { try { beforeRedirectHook(); } catch (e) {} }
    const verifier = randString(64);
    const state = randString(16);
    try {
      sessionStorage.setItem(OAUTH_KEY, JSON.stringify({ verifier, state }));
    } catch (e) {}
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      scope: cfg.scopes.join(' '),
      code_challenge_method: 'S256',
      code_challenge: await challenge(verifier),
      redirect_uri: cfg.redirectUri,
      state,
    });
    location.assign(ACCOUNTS + '/authorize?' + params.toString());
  }

  // Returns true when this page load carried an OAuth callback (?code=).
  // Exchanges the code, cleans the URL (no reload), emits 'auth'.
  async function handleRedirectCallback() {
    const q = new URLSearchParams(location.search);
    const code = q.get('code');
    const state = q.get('state');
    const err = q.get('error');
    if (!code && !err) return false;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(OAUTH_KEY) || 'null'); } catch (e) {}
    sessionStorage.removeItem(OAUTH_KEY);
    // Clean the URL without reloading so map state survives.
    history.replaceState(null, '', location.pathname + location.hash);
    if (err) {
      emit('error', { where: 'authorize', message: err });
      emit('auth', false);
      return true;
    }
    if (!saved || saved.state !== state) {
      emit('error', { where: 'authorize', message: 'state mismatch' });
      emit('auth', false);
      return true;
    }
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
        client_id: cfg.clientId,
        code_verifier: saved.verifier,
      });
      const res = await fetch(ACCOUNTS + '/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!res.ok) throw new Error('token exchange ' + res.status);
      const t = await res.json();
      auth = {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: Date.now() + t.expires_in * 1000,
      };
      saveAuth();
      emit('auth', true);
      refreshNow();
    } catch (e) {
      emit('error', { where: 'token', message: String(e && e.message || e) });
      emit('auth', false);
    }
    return true;
  }

  async function refreshAccessToken() {
    if (!auth || !auth.refresh_token) throw new Error('no refresh token');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refresh_token,
      client_id: cfg.clientId,
    });
    const res = await fetch(ACCOUNTS + '/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error('refresh ' + res.status);
    const t = await res.json();
    auth.access_token = t.access_token;
    if (t.refresh_token) auth.refresh_token = t.refresh_token;
    auth.expires_at = Date.now() + t.expires_in * 1000;
    saveAuth();
  }

  async function accessToken() {
    if (!auth) throw new Error('not connected');
    if (Date.now() > auth.expires_at - REFRESH_SKEW_MS) {
      try {
        await refreshAccessToken();
      } catch (e) {
        // Refresh token dead (revoked/expired) — fail gracefully to
        // the disconnected state instead of breaking the app.
        disconnect();
        throw new Error('session expired');
      }
    }
    return auth.access_token;
  }

  function disconnect() {
    auth = null;
    saveAuth();
    lastState = null;
    lastStateSig = '';
    stopPolling();
    emit('auth', false);
    emit('state', null);
  }

  /* ---------------- web api ---------------- */
  async function api(path, opts) {
    opts = opts || {};
    let url = API + path;
    if (opts.query) url += '?' + new URLSearchParams(opts.query).toString();
    const doFetch = async token => fetch(url, {
      method: opts.method || 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + token },
        opts.body ? { 'Content-Type': 'application/json' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let res = await doFetch(await accessToken());
    if (res.status === 401) {
      // Token rejected — refresh once and retry.
      try { await refreshAccessToken(); }
      catch (e) { disconnect(); throw new Error('session expired'); }
      res = await doFetch(auth.access_token);
    }
    if (res.status === 401 || res.status === 403) {
      throw { status: res.status, message: 'spotify denied the request' };
    }
    if (res.status === 404) throw { status: 404, message: 'no active device' };
    if (res.status === 204) return null;
    if (!res.ok) throw { status: res.status, message: 'spotify error ' + res.status };
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /* ---------------- player ---------------- */
  function stateSignature(s) {
    if (!s) return 'none';
    const id = (s.item && s.item.id) || 'ad';
    return id + '|' + (s.is_playing ? '1' : '0') + '|' +
      ((s.device && s.device.id) || 'nodev') + '|' +
      (s.item ? s.item.duration_ms : 0);
  }

  async function poll() {
    if (!isConnected()) return;
    try {
      const s = await api('/me/player');
      lastState = s;
      lastStateAt = Date.now();
      const sig = stateSignature(s);
      if (sig !== lastStateSig) {
        lastStateSig = sig;
        emit('state', s);
      }
    } catch (e) {
      // 404 (no active device) is normal — surface as a null-ish state
      // only if it changes, otherwise stay quiet.
      if (e && e.status === 404) {
        if (lastStateSig !== 'nodevice') {
          lastStateSig = 'nodevice';
          lastState = null;
          emit('state', null);
        }
      } else {
        emit('error', { where: 'poll', message: String((e && e.message) || e) });
      }
    }
  }

  function refreshNow() { poll(); }

  // Interpolated position: poll every 5 s, animate locally between.
  function getPosition() {
    if (!lastState || !lastState.item) return 0;
    if (!lastState.is_playing) return lastState.progress_ms || 0;
    const p = (lastState.progress_ms || 0) + (Date.now() - lastStateAt);
    return Math.min(p, lastState.item.duration_ms || p);
  }

  function getState() { return lastState; }

  async function guarded(fn, optimistic) {
    try {
      if (optimistic) optimistic();
      await fn();
      setTimeout(poll, 600); // let Spotify settle, then re-sync
    } catch (e) {
      emit('error', { where: 'control', message: String((e && e.message) || e), status: e && e.status });
      poll();
      throw e;
    }
  }

  function play() {
    return guarded(() => api('/me/player/play', { method: 'PUT' }), () => {
      if (lastState) { lastState.is_playing = true; lastStateAt = Date.now(); emit('state', lastState); }
    });
  }
  function pause() {
    return guarded(() => api('/me/player/pause', { method: 'PUT' }), () => {
      if (lastState) {
        lastState.progress_ms = getPosition();
        lastState.is_playing = false;
        lastStateSig = stateSignature(lastState);
        emit('state', lastState);
      }
    });
  }
  function next() { return guarded(() => api('/me/player/next', { method: 'POST' })); }
  function previous() { return guarded(() => api('/me/player/previous', { method: 'POST' })); }
  function seek(ms) {
    const target = Math.max(0, Math.round(ms));
    return guarded(() => api('/me/player/seek', { method: 'PUT', query: { position_ms: target } }), () => {
      if (lastState && lastState.item) {
        lastState.progress_ms = Math.min(target, lastState.item.duration_ms || target);
        lastStateAt = Date.now();
      }
    });
  }

  function startPolling() {
    stopPolling();
    if (!isConnected()) return;
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* ---------------- car-mode token handoff ----------------
     The Android Auto shell performs Spotify PKCE natively (Custom Tab on
     the phone) and hands the resulting auth JSON here via
     window.WayStationCar.setSpotifyAuth(). Same storage key and shape as
     the web flow — no second Spotify implementation. */
  function reloadAuth() {
    const was = isConnected();
    loadAuth();
    const now = isConnected();
    if (now) { startPolling(); refreshNow(); }
    else if (was) { stopPolling(); }
    emit('auth', now);
  }

  /* ---------------- init ---------------- */
  function init(options) {
    cfg = {
      clientId: options.clientId || '',
      redirectUri: options.redirectUri || '',
      scopes: options.scopes || [],
    };
    beforeRedirectHook = options.beforeRedirect || null;
    loadAuth();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && isConnected()) poll(); // re-sync on resume
    });
    if (isConnected()) startPolling();
    return handleRedirectCallback();
  }

  function setShuffle(state) {
    return guarded(() => api('/me/player/shuffle', { method: 'PUT', query: { state: state ? 'true' : 'false' } }));
  }
  function setRepeat(state) {
    /* state: 'track', 'context', or 'off' */
    return guarded(() => api('/me/player/repeat', { method: 'PUT', query: { state } }));
  }

  window.SpotifyCore = {
    init, isConnected, connect, disconnect,
    handleRedirectCallback, reloadAuth,
    getState, getPosition, refreshNow,
    play, pause, next, previous, seek, setShuffle, setRepeat,
    startPolling, stopPolling,
    onBeforeRedirect(fn) { beforeRedirectHook = fn; },
    on(name, fn) {
      if (listeners[name]) listeners[name].push(fn);
      return () => {
        listeners[name] = listeners[name].filter(f => f !== fn);
      };
    },
  };
})();
