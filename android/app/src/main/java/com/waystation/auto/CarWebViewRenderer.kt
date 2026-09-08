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
import android.webkit.WebSettings
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
        private const val POLL_MS = 2000L
    }

    /** JS nav state → host NavigationManager (wired in WayStationScreen). */
    var onNavActive: ((Boolean) -> Unit)? = null

    /** JS Spotify auth state → show/hide the native Connect action. */
    var onSpotifyConnected: ((Boolean) -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())
    private val spotifyAuth = SpotifyAuthManager(carContext)

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
            configureWebView(wv)
            pres.setContentView(
                wv,
                android.view.ViewGroup.LayoutParams(
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                    android.view.ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
            Log.i(TAG, "pipeline up: ${w}x${h}@${dpi}")
            wv.loadUrl(DASH_URL)
        } catch (e: Exception) {
            Log.e(TAG, "attach failed", e)
            detach()
        }
    }

    /** Full teardown in reverse order. Idempotent. */
    fun detach() {
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
        wv.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = false
        }
        wv.webChromeClient = WebChromeClient()
        wv.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                handoffDone = false // new page → token handoff may run again
            }

            override fun onPageFinished(view: WebView, url: String) {
                forwardAreas()
                startPoll()
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
        handoffDone = true
        wv.evaluateJavascript(
            "window.WayStationCar&&WayStationCar.setSpotifyAuth(" +
                JSONObject.quote(tokenJson) + ")",
            null
        )
        Log.i(TAG, "Spotify token handed to car WebView")
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
}
