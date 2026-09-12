package com.waystation.auto

import android.app.Presentation
import android.content.Context
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.car.app.CarContext
import androidx.car.app.SurfaceContainer
import com.waystation.auto.BuildConfig
import org.json.JSONObject

/**
 * Renders the REAL WayStation dashboard onto the Android Auto Surface.
 *
 * Pipeline: host Surface → [VirtualDisplay] (exact width/height/DPI from
 * the SurfaceContainer) → [Presentation] → hardware-accelerated [WebView]
 * loading the car dashboard URL. No native map, no native UI rewrite.
 *
 * Touch from [androidx.car.app.SurfaceCallback] is forwarded as synthetic
 * [MotionEvent]s into the WebView:
 * - onClick → ACTION_DOWN + ACTION_UP at the surface coordinates
 * - onScroll → short drag (map pan)
 * - onScale → two-pointer pinch (map zoom)
 * - onFling → short fast drag
 *
 * Coordinate mapping: the WebView is laid out at exactly the surface's
 * pixel size, so surface coordinates map 1:1 to view coordinates.
 *
 * If synthetic events ever prove unreliable on a head unit, the documented
 * fallback is JS injection: document.elementFromPoint(x, y) + .click().
 * See android/README.md ("touch fallback").
 */
class CarWebViewRenderer(private val carContext: CarContext) {

    companion object {
        private const val TAG = "WayStationCar"
        const val DASH_URL =
            "https://ciaranf3308-star.github.io/vice-city-navigator/?dashboard=1&car=1"

        /** Only this origin is ever granted WebView geolocation. */
        const val WAYSTATION_ORIGIN = "https://ciaranf3308-star.github.io"
        private const val POLL_MS = 2000L

        /** Retry backoff after a failed dashboard load (ms), then every 60s. */
        private val BACKOFF_MS = longArrayOf(2_000L, 4_000L, 8_000L, 16_000L)

        /** Custom-scheme hook for the offline page's Retry button. */
        private const val RETRY_URL = "waystation://retry"
    }

    /** JS nav state → host NavigationManager (wired in WayStationScreen). */
    var onNavActive: ((Boolean) -> Unit)? = null

    /** JS Spotify auth state → show/hide the native Connect action. */
    var onSpotifyConnected: ((Boolean) -> Unit)? = null

    /** Page load state → the screen shows a native Reload action while the
     *  dashboard has failed to load (true = loaded OK). */
    var onPageLoadState: ((Boolean) -> Unit)? = null

    /** Native location permission state (wired in WayStationScreen). */
    var locationPermissionGranted: (() -> Boolean)? = null

    /** Called when the page needs geolocation but permission isn't granted yet —
     *  the screen should trigger a permission request. */
    var onLocationPermissionNeeded: (() -> Unit)? = null

    /** Pending WebView geolocation callbacks. While the Android runtime
     *  permission request is still in flight, the page may already ask for
     *  geolocation. Answering "no" at that moment poisons the WebView's
     *  origin permission state — the later grant never takes effect and the
     *  page keeps reporting PERMISSION_DENIED forever. So we HOLD the
     *  callback and answer it once the real permission result is known. */
    private val pendingGeoCallbacks =
        mutableListOf<Pair<String, GeolocationPermissions.Callback>>()
    private var locationRequestInFlight = false
    /** True once we've asked the user; a denial must not re-prompt in a loop. */
    private var locationPermissionAsked = false

    private val main = Handler(Looper.getMainLooper())
    private val spotifyAuth = SpotifyAuthManager(carContext)

    // ---------------- load-failure retry ----------------
    // The dashboard URL is loaded exactly once per surface attach. If that
    // single load races a network handoff (the usual case: the phone's data
    // path flaps for a few seconds right as Android Auto connects), the
    // WebView lands on the dead "Web page not available" page and never
    // recovers — the head unit sits on a white/error surface forever.
    // onReceivedError/onReceivedHttpError therefore schedule reload retries
    // with backoff (2s → 4s → 8s → 16s → every 60s) until a page finishes.
    private var retryCount = 0
    private var retryRunnable: Runnable? = null
    // Set by onReceivedError/onReceivedHttpError for the main frame; cleared
    // by onPageStarted. Guards onPageFinished, which also fires for the
    // built-in error page itself — without this the error page's finish
    // would cancel the retry we just scheduled.
    private var loadFailed = false
    // True while our branded offline page is up (instead of the WebView's
    // raw "Web page not available"). Reset whenever a real dashboard load
    // is attempted.
    private var errorPageShown = false

    /** Branded offline page: dark, gold accents, one big Retry target.
     *  Shown instead of the WebView's raw error page so a dead connection
     *  never strands the driver on a broken surface. Auto-retry keeps
     *  running underneath; the button just hurries it along. */
    private fun errorPageHtml() = """
        <!DOCTYPE html><html><head><meta name="viewport"
        content="width=device-width,initial-scale=1">
        <style>
        *{box-sizing:border-box;margin:0}
        body{background:#0d0b09;color:#f5d9a8;font-family:sans-serif;
          display:flex;align-items:center;justify-content:center;
          min-height:100vh;text-align:center;padding:24px}
        .mark{font-size:52px;color:#e8a33d;margin-bottom:18px}
        h1{font-size:30px;letter-spacing:1px;margin-bottom:12px;color:#fff}
        p{font-size:17px;line-height:1.5;color:rgba(245,217,168,.75);
          margin-bottom:28px}
        .btn{display:inline-block;background:#e8a33d;color:#1a1206;
          font-size:20px;font-weight:700;letter-spacing:.5px;
          padding:16px 54px;border-radius:999px;text-decoration:none}
        .note{margin-top:22px;font-size:14px;color:rgba(245,217,168,.45)}
        </style></head><body><div>
        <div class="mark">&#9672;</div>
        <h1>No connection</h1>
        <p>WayStation couldn't reach the dashboard.<br>
        Check the phone's internet &mdash; retrying automatically.</p>
        <a class="btn" href="$RETRY_URL">Retry now</a>
        <div class="note">WayStation</div>
        </div></body></html>
    """.trimIndent()

    private fun showErrorPage() {
        if (errorPageShown) return
        errorPageShown = true
        try {
            // base URL null -> page URL is about:blank, so onPageFinished's
            // origin guard never mistakes it for a successful dashboard load.
            webView?.loadDataWithBaseURL(null, errorPageHtml(), "text/html", "utf-8", null)
        } catch (e: Exception) {
            Log.w(TAG, "error page load threw", e)
        }
    }

    private fun scheduleRetry() {
        cancelRetry()
        val delayMs = when {
            retryCount < BACKOFF_MS.size -> BACKOFF_MS[retryCount]
            else -> 60_000L
        }
        retryCount++
        Log.i(TAG, "page load failed; retry $retryCount in ${delayMs}ms")
        val r = Runnable {
            retryRunnable = null
            try {
                // loadUrl, not reload(): the WebView may be sitting on our
                // offline page, and reload() would just re-show that.
                errorPageShown = false
                webView?.loadUrl(DASH_URL)
            } catch (e: Exception) {
                Log.w(TAG, "retry load threw", e)
                scheduleRetry()
            }
        }
        retryRunnable = r
        main.postDelayed(r, delayMs)
    }

    private fun cancelRetry() {
        retryRunnable?.let { main.removeCallbacks(it) }
        retryRunnable = null
    }

    private fun notePageLoaded() {
        cancelRetry()
        retryCount = 0
        errorPageShown = false // real page is up; a later failure may show the offline page again
        onPageLoadState?.invoke(true)
    }

    private fun notePageFailed(reason: String) {
        Log.w(TAG, "dashboard page failed: $reason")
        loadFailed = true
        onPageLoadState?.invoke(false)
        showErrorPage()
        scheduleRetry()
    }

    /** Manual escape hatch (native Reload action) and the offline page's
     *  Retry button: reset backoff, load the dashboard fresh right now. */
    fun reloadNow() {
        cancelRetry()
        retryCount = 0
        errorPageShown = false
        onPageLoadState?.invoke(false)
        try {
            webView?.loadUrl(DASH_URL)
        } catch (e: Exception) {
            Log.w(TAG, "manual reload threw", e)
            scheduleRetry()
        }
    }

    private var virtualDisplay: VirtualDisplay? = null
    private var presentation: Presentation? = null
    private var webView: WebView? = null

    private var visibleArea: Rect? = null
    private var stableArea: Rect? = null
    private var handoffDone = false
    private var pollRunning = false

    // ---------------- surface lifecycle ----------------

    /** (Re)build the whole pipeline for the supplied surface. Safe to call
     *  repeatedly: resolution/DPI changes re-create everything cleanly. */
    fun attach(container: SurfaceContainer) {
        val surface = container.surface
        val w = container.width
        val h = container.height
        val dpi = container.dpi
        if (surface == null || !surface.isValid || w <= 0 || h <= 0) {
            Log.w(TAG, "attach: bad surface container, skipping")
            return
        }
        detach() // tear down any previous pipeline first (no leaks)
        try {
            val dm = carContext.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
            val vd = dm.createVirtualDisplay(
                "WayStationCar", w, h, dpi, surface,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION
            ) ?: return
            virtualDisplay = vd

            val pres = object : Presentation(carContext, vd.display) {}
            pres.show()
            presentation = pres

            val wv = WebView(pres.context)
            webView = wv
            // Nuke any stale geolocation denial cached for our origin by a
            // previous run — a fresh renderer must never inherit a "no".
            try {
                GeolocationPermissions.getInstance().clear(WAYSTATION_ORIGIN)
            } catch (e: Exception) {
                Log.w(TAG, "clear geolocation state failed", e)
            }
            configureWebView(wv)
            pres.setContentView(
                wv,
                android.view.ViewGroup.LayoutParams(
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
            Log.i(TAG, "pipeline up: ${w}x${h}@${dpi}")
            cancelRetry()
            retryCount = 0
            wv.loadUrl(DASH_URL)
        } catch (e: Exception) {
            Log.e(TAG, "attach failed", e)
            detach()
        }
    }

    /** Full teardown in reverse order. Idempotent. */
    fun detach() {
        cancelRetry()
        main.removeCallbacks(pollRunnable)
        pollRunning = false
        try { webView?.stopLoading() } catch (e: Exception) { }
        try { webView?.removeAllViews() } catch (e: Exception) { }
        try { webView?.destroy() } catch (e: Exception) { }
        webView = null
        try { presentation?.dismiss() } catch (e: Exception) { }
        presentation = null
        try { virtualDisplay?.release() } catch (e: Exception) { }
        virtualDisplay = null
        handoffDone = false
    }

    private fun configureWebView(wv: WebView) {
        if (BuildConfig.WEBVIEW_DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true) // chrome://inspect in DHU
        }
        // Web → native bridge: lets the page push Spotify auth (and future
        // state) into native storage so it survives across WebView instances
        // (phone ↔ car) without re-auth.
        wv.addJavascriptInterface(CarBridge(), "WayStationCarNative")
        wv.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // NOTE: property syntax (geolocationEnabled = true) does not
            // resolve under this toolchain; the explicit setter is the
            // documented API and compiles fine.
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = false
        }
        wv.webChromeClient = object : WebChromeClient() {
            /**
             * Geolocation is granted ONLY to the WayStation origin and ONLY
             * after the Android location permission is actually granted.
             * Unknown origins are always denied. While a permission request
             * is in flight (or not yet started), we HOLD the callback instead
             * of denying — a premature "no" poisons the WebView's origin
             * state and the page reports PERMISSION_DENIED forever.
             */
            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback
            ) {
                if (origin != WAYSTATION_ORIGIN) {
                    Log.i(TAG, "geolocation prompt for $origin -> denied (unknown origin)")
                    callback.invoke(origin, false, false)
                    return
                }
                if (locationPermissionGranted?.invoke() == true) {
                    try {
                        GeolocationPermissions.getInstance().clear(origin)
                    } catch (e: Exception) { /* best effort */ }
                    Log.i(TAG, "geolocation prompt for $origin -> granted")
                    callback.invoke(origin, true, false)
                    return
                }
                // Permission not yet granted: hold the callback and trigger
                // a permission request — but only once. If the user already
                // denied, answer "no" directly instead of spamming dialogs.
                if (locationPermissionAsked) {
                    Log.i(TAG, "geolocation prompt for $origin -> denied (already asked)")
                    callback.invoke(origin, false, false)
                    return
                }
                Log.i(TAG, "geolocation prompt for $origin -> holding (permission not yet granted)")
                pendingGeoCallbacks.add(origin to callback)
                if (!locationRequestInFlight) {
                    locationRequestInFlight = true
                    onLocationPermissionNeeded?.invoke()
                }
            }
        }
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                // Offline page's Retry button -> immediate fresh dashboard load.
                if (request.url.toString() == RETRY_URL) {
                    reloadNow()
                    return true
                }
                return false
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                handoffDone = false // new page → token handoff may run again
                loadFailed = false
            }

            override fun onPageFinished(view: WebView, url: String) {
                // onPageFinished also fires for our offline page (about:blank);
                // only a clean finish of the real dashboard counts as loaded,
                // otherwise the offline page would cancel its own retries.
                if (!loadFailed && url.startsWith(WAYSTATION_ORIGIN)) notePageLoaded()
                forwardAreas()
                startPoll()
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    notePageFailed("net error ${error.errorCode} on ${request.url}")
                }
            }

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: android.webkit.WebResourceResponse
            ) {
                if (request.isForMainFrame) {
                    notePageFailed("HTTP ${errorResponse.statusCode} on ${request.url}")
                }
            }
        }
    }

    // ---------------- visible / stable area ----------------

    fun setVisibleArea(r: Rect) {
        visibleArea = Rect(r)
        evalJs(
            "window.WayStationCar&&WayStationCar.setVisibleArea(" +
                "{left:${r.left},top:${r.top},right:${r.right},bottom:${r.bottom}})"
        )
    }

    fun setStableArea(r: Rect) {
        stableArea = Rect(r)
        evalJs(
            "window.WayStationCar&&WayStationCar.setStableArea(" +
                "{left:${r.left},top:${r.top},right:${r.right},bottom:${r.bottom}})"
        )
    }

    private fun forwardAreas() {
        visibleArea?.let { setVisibleArea(it) }
        stableArea?.let { setStableArea(it) }
    }

    // ---------------- touch forwarding ----------------

    /** Tap: down+up at the surface point. Drives every dashboard control
     *  (Spotify prev/play/next, radio toggle, recenter, tabs, search…). */
    fun click(x: Float, y: Float) {
        val wv = webView ?: return
        val now = SystemClock.uptimeMillis()
        wv.dispatchTouchEvent(MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0))
        wv.dispatchTouchEvent(MotionEvent.obtain(now, now, MotionEvent.ACTION_UP, x, y, 0))
    }

    /** Pan: the host reports per-event scroll distance; synthesize a short
     *  drag from the surface centre in the opposite direction. */
    fun scroll(distanceX: Float, distanceY: Float) {
        val wv = webView ?: return
        val cx = wv.width / 2f
        val cy = wv.height / 2f
        drag(cx, cy, cx - distanceX * 6f, cy - distanceY * 6f)
    }

    /** Pinch zoom around the gesture focus. */
    fun pinch(focusX: Float, focusY: Float, scaleFactor: Float) {
        val wv = webView ?: return
        val now = SystemClock.uptimeMillis()
        val spread = 160f
        val p0 = MotionEvent.PointerProperties().also {
            it.id = 0; it.toolType = MotionEvent.TOOL_TYPE_FINGER
        }
        val p1 = MotionEvent.PointerProperties().also {
            it.id = 1; it.toolType = MotionEvent.TOOL_TYPE_FINGER
        }
        fun coords(x: Float, y: Float) = MotionEvent.PointerCoords().also {
            it.x = x; it.y = y; it.pressure = 1f; it.size = 1f
        }
        val props = arrayOf(p0, p1)
        val start = arrayOf(coords(focusX - spread, focusY), coords(focusX + spread, focusY))
        val end = arrayOf(
            coords(focusX - spread * scaleFactor, focusY),
            coords(focusX + spread * scaleFactor, focusY)
        )
        val down = MotionEvent.obtain(
            now, now, MotionEvent.ACTION_DOWN, 1,
            arrayOf(p0), arrayOf(start[0]),
            0, 0, 1f, 1f, 0, 0, 0, 0
        )
        val pointerDown = MotionEvent.obtain(
            now, now,
            MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),
            2, props, start, 0, 0, 1f, 1f, 0, 0, 0, 0
        )
        val move = MotionEvent.obtain(
            now, now + 16, MotionEvent.ACTION_MOVE,
            2, props, end, 0, 0, 1f, 1f, 0, 0, 0, 0
        )
        val pointerUp = MotionEvent.obtain(
            now, now + 32,
            MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),
            2, props, end, 0, 0, 1f, 1f, 0, 0, 0, 0
        )
        val up = MotionEvent.obtain(
            now, now + 32, MotionEvent.ACTION_UP, 1,
            arrayOf(p0), arrayOf(end[0]),
            0, 0, 1f, 1f, 0, 0, 0, 0
        )
        wv.dispatchTouchEvent(down)
        wv.dispatchTouchEvent(pointerDown)
        wv.dispatchTouchEvent(move)
        wv.dispatchTouchEvent(pointerUp)
        wv.dispatchTouchEvent(up)
    }

    /** Fling: short fast drag along the fling vector. */
    fun fling(velocityX: Float, velocityY: Float) {
        val wv = webView ?: return
        val cx = wv.width / 2f
        val cy = wv.height / 2f
        drag(cx, cy, cx + velocityX * 0.12f, cy + velocityY * 0.12f)
    }

    private fun drag(fromX: Float, fromY: Float, toX: Float, toY: Float) {
        val wv = webView ?: return
        val now = SystemClock.uptimeMillis()
        wv.dispatchTouchEvent(
            MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, fromX, fromY, 0)
        )
        val steps = 4
        for (i in 1..steps) {
            val t = i / steps.toFloat()
            wv.dispatchTouchEvent(
                MotionEvent.obtain(
                    now, now + i * 8L, MotionEvent.ACTION_MOVE,
                    fromX + (toX - fromX) * t, fromY + (toY - fromY) * t, 0
                )
            )
        }
        wv.dispatchTouchEvent(
            MotionEvent.obtain(now, now + 48, MotionEvent.ACTION_UP, toX, toY, 0)
        )
    }

    // ---------------- JS state poll ----------------

    private val pollRunnable = object : Runnable {
        override fun run() {
            val wv = webView
            if (wv == null) {
                pollRunning = false
                return
            }
            wv.evaluateJavascript(
                "(function(){try{var b=window.WayStationCar;" +
                    "return b?JSON.stringify(b.getState()):'{}';}" +
                    "catch(e){return '{}';}})()"
            ) { raw ->
                handleState(raw)
                if (webView != null) main.postDelayed(this, POLL_MS)
                else pollRunning = false
            }
        }
    }

    private fun startPoll() {
        if (pollRunning) return
        pollRunning = true
        main.post(pollRunnable)
    }

    private fun handleState(raw: String?) {
        if (raw.isNullOrBlank() || raw == "null") return
        try {
            val o = JSONObject(unquoteJsString(raw))
            onNavActive?.invoke(o.optBoolean("navActive", false))
            val spot = o.optBoolean("spotify", false)
            onSpotifyConnected?.invoke(spot)
            if (!spot) trySpotifyHandoff()
        } catch (e: Exception) {
            // page not ready yet — next poll retries
        }
    }

    /** Thin Spotify handoff: if the phone holds a native PKCE token and the
     *  car WebView isn't connected, inject it into the page's own auth
     *  storage (same key/shape as the web flow) exactly once per page. */
    private fun trySpotifyHandoff() {
        if (handoffDone) return
        val tokenJson = spotifyAuth.storedTokenJson() ?: return
        val wv = webView ?: return
        // Only mark done if the page actually received it — if the bridge
        // isn't ready yet (page still loading), retry on the next poll.
        wv.evaluateJavascript(
            "(function(){try{return window.WayStationCar&&" +
                "WayStationCar.setSpotifyAuth(" +
                JSONObject.quote(tokenJson) + ");}catch(e){return false;}})()",
        ) { result ->
            if (result == "true") {
                handoffDone = true
                Log.i(TAG, "Spotify token handed to car WebView")
            } else {
                Log.i(TAG, "Spotify handoff deferred — page not ready, will retry")
            }
        }
    }

    /** Host asked to stop navigation: forward into the JS app so it stops
     *  the route, the voice and the driving state normally. */
    fun stopNavigation() {
        evalJs("window.WayStationCar&&WayStationCar.stopNavigation()")
    }

    /** Reload the dashboard page (used once after the location permission
     *  is granted so the page's geolocation watch re-prompts). */
    fun reloadPage() {
        try {
            webView?.reload()
        } catch (e: Exception) {
            Log.w(TAG, "reload failed", e)
        }
    }

    /**
     * Called by the screen when the Android location permission result is
     * known. Answers every held WebView geolocation callback with the real
     * result, then reloads the page for a clean state.
     */
    fun onLocationPermissionResult() {
        locationRequestInFlight = false
        locationPermissionAsked = true
        flushPendingGeoCallbacks()
        if (locationPermissionGranted?.invoke() == true) {
            reloadPage()
        }
    }

    /**
     * Answer every held WebView geolocation callback with the current live
     * permission state.
     */
    private fun flushPendingGeoCallbacks() {
        if (pendingGeoCallbacks.isEmpty()) return
        val allow = locationPermissionGranted?.invoke() == true
        val pending = pendingGeoCallbacks.toList()
        pendingGeoCallbacks.clear()
        for ((origin, cb) in pending) {
            try {
                if (allow) {
                    try {
                        GeolocationPermissions.getInstance().clear(origin)
                    } catch (e: Exception) { /* best effort */ }
                }
                cb.invoke(origin, allow, false)
            } catch (e: Exception) {
                Log.w(TAG, "flushPendingGeoCallbacks failed", e)
            }
        }
        Log.i(TAG, "flushed ${pending.size} pending geolocation callbacks allow=$allow")
    }

    /** Kick off the native Spotify PKCE login (Custom Tab on the phone).
     *  On success the token is stored and handed to the WebView on the
     *  next poll — no WebView password typing on the head unit. */
    fun startSpotifyAuth() {
        try {
            spotifyAuth.startAuth()
        } catch (e: Exception) {
            Log.e(TAG, "Spotify auth launch failed", e)
        }
    }

    // ---------------- helpers ----------------

    private fun evalJs(script: String) {
        try {
            webView?.evaluateJavascript(script, null)
        } catch (e: Exception) {
            Log.w(TAG, "evalJs failed", e)
        }
    }

    /** evaluateJavascript returns a JSON-encoded string; unwrap it. */
    private fun unquoteJsString(s: String): String {
        var t = s.trim()
        if (t.length >= 2 && t.startsWith("\"") && t.endsWith("\"")) {
            t = t.substring(1, t.length - 1)
            val sb = StringBuilder(t.length)
            var i = 0
            while (i < t.length) {
                val c = t[i]
                if (c == '\\' && i + 1 < t.length) {
                    val n = t[i + 1]
                    sb.append(
                        when (n) {
                            '"' -> '"'; '\\' -> '\\'; 'n' -> '\n'
                            't' -> '\t'; 'r' -> '\r'; else -> n
                        }
                    )
                    i += 2
                } else {
                    sb.append(c)
                    i++
                }
            }
            t = sb.toString()
        }
        return t
    }

    /**
     * Web → native bridge (injected as `window.WayStationCarNative`).
     * Lets the page push state into native storage so it carries across
     * WebView instances (phone ↔ car) without re-auth.
     */
    inner class CarBridge {
        /** Page saved/renewed Spotify auth: mirror it into native storage
         *  so the car WebView can pick it up via the existing handoff. */
        @JavascriptInterface
        fun onSpotifyAuthChanged(authJson: String) {
            try {
                if (authJson.isBlank()) return
                // Validate it's real auth JSON before storing.
                val obj = JSONObject(authJson)
                if (!obj.has("refresh_token")) return
                spotifyAuth.storeTokenJson(authJson)
                Log.i(TAG, "Spotify auth mirrored to native storage")
            } catch (e: Exception) {
                Log.w(TAG, "onSpotifyAuthChanged failed", e)
            }
        }
    }
}
