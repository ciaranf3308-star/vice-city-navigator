package com.waystation.auto

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.View
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.ContextCompat
import android.app.Activity

/**
 * WayStation phone launcher: the same app the car uses, with a home-screen
 * icon. A plain fullscreen WebView over the production site in normal phone
 * mode (no ?car=1, no forced dashboard) — search, plan and drive from the
 * phone; plug into the car and the CarAppService takes the same app to the
 * head unit. One APK, one install, one app.
 */
class MainActivity : Activity() {

    private var webView: WebView? = null
    private val spotifyAuth by lazy { SpotifyAuthManager(this) }
    // Android permission model: coarse (approximate) and fine (precise) are
    // independent grants. A user with "Location allowed, precise OFF" has
    // COARSE granted and FINE denied — that is a VALID granted state and
    // must unlock WebView geolocation. Never collapse this to one boolean.
    private var coarseLocationGranted = false
    private var fineLocationGranted = false
    private var anyLocationGranted = false
    private var retryCount = 0
    private var retryRunnable: Runnable? = null
    private var loadFailed = false

    /**
     * Web → native bridge (injected as `window.WayStationCarNative`).
     * Lets the page push Spotify auth into native storage so it carries
     * over to the car WebView without re-auth.
     */
    inner class PhoneBridge {
        @JavascriptInterface
        fun onSpotifyAuthChanged(authJson: String) {
            try {
                if (authJson.isBlank()) return
                val obj = org.json.JSONObject(authJson)
                if (!obj.has("refresh_token")) return
                spotifyAuth.storeTokenJson(authJson)
                Log.i(TAG, "Spotify auth mirrored to native storage from phone WebView")
            } catch (e: Exception) {
                Log.w(TAG, "onSpotifyAuthChanged failed", e)
            }
        }
    }
    // Pending WebView geolocation callbacks. While the Android runtime
    // permission request is still in flight, the page may already ask for
    // geolocation. Answering "no" at that moment poisons the WebView's
    // origin permission state — the later grant never takes effect and the
    // page keeps reporting PERMISSION_DENIED forever. So we HOLD the
    // callback and answer it once the real permission result is known.
    private val pendingGeoCallbacks =
        mutableListOf<Pair<String, GeolocationPermissions.Callback>>()
    private var locationRequestInFlight = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        refreshLocationState()
        // Nuke any stale geolocation denial cached for our origin by a
        // previous run — a fresh process must never inherit a "no".
        try {
            GeolocationPermissions.getInstance()
                .clear(CarWebViewRenderer.WAYSTATION_ORIGIN)
        } catch (e: Exception) {
            Log.w(TAG, "clear geolocation state failed", e)
        }
        // Fresh launch only (not rotation): if location isn't granted, push
        // for it — every single time, until it's fixed.
        if (savedInstanceState == null) ensureLocationPermission()
        val wv = WebView(this)
        webView = wv
        configureWebView(wv)
        setContentView(wv)
        if (savedInstanceState != null) wv.restoreState(savedInstanceState)
        else wv.loadUrl(WEB_URL)
    }

    /**
     * Every cold start while no location at all is granted: force the issue.
     * Requests COARSE and FINE together — never fine by itself. If coarse is
     * already granted we have usable location: do NOT get stuck re-prompting
     * for precise, just offer the non-blocking accuracy note once.
     * Android permanently blocks the system permission dialog after two
     * denials, so in that state we show our own prompt with a one-tap jump
     * to Settings instead — the closest the OS allows to "ask every time".
     */
    private fun ensureLocationPermission() {
        if (anyLocationGranted) {
            if (coarseLocationGranted && !fineLocationGranted) {
                maybeSuggestPreciseLocation()
            }
            return
        }
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val asked = prefs.getBoolean(KEY_LOCATION_ASKED, false)
        if (!asked ||
            shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION) ||
            shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_COARSE_LOCATION)
        ) {
            prefs.edit().putBoolean(KEY_LOCATION_ASKED, true).apply()
            // The system dialog is now in flight: any WebView geolocation
            // prompt that fires before the result must be HELD, not denied.
            locationRequestInFlight = true
            requestPermissions(
                arrayOf(
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                    Manifest.permission.ACCESS_FINE_LOCATION
                ),
                REQ_LOCATION
            )
        } else {
            showLocationSettingsPrompt()
        }
    }

    /**
     * Non-blocking, once-per-install: precise location improves driving
     * accuracy, but coarse is a valid granted state — never present this
     * as "Location blocked" and never force Settings for it.
     */
    private fun maybeSuggestPreciseLocation() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        if (prefs.getBoolean(KEY_PRECISE_SUGGESTED, false)) return
        prefs.edit().putBoolean(KEY_PRECISE_SUGGESTED, true).apply()
        android.widget.Toast.makeText(
            this,
            "Precise location improves driving accuracy",
            android.widget.Toast.LENGTH_LONG
        ).show()
    }

    private fun showLocationSettingsPrompt() {
        AlertDialog.Builder(this)
            .setTitle("Location is off")
            .setMessage(
                "WayStation needs location for the blue dot, the ◎ button " +
                "and nearby places. Android won't show the permission popup " +
                "again, but you can switch it on in Settings."
            )
            .setPositiveButton("Open Settings") { _, _ ->
                startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:$packageName")
                    )
                )
            }
            .setNegativeButton("Not now", null)
            .show()
    }

    private fun refreshLocationState() {
        fineLocationGranted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        coarseLocationGranted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        anyLocationGranted = fineLocationGranted || coarseLocationGranted
    }

    override fun onResume() {
        super.onResume()
        // The user may have granted location via Settings while we were
        // backgrounded — re-check every time we come forward, otherwise the
        // WebView keeps denying geolocation until the app is killed.
        val was = anyLocationGranted
        refreshLocationState()
        if (anyLocationGranted && !was) {
            Log.i(TAG, "location granted via Settings " +
                "(coarse=$coarseLocationGranted fine=$fineLocationGranted); " +
                "reloading for clean geolocation")
            flushPendingGeoCallbacks()
            webView?.reload()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        if (requestCode == REQ_LOCATION) {
            locationRequestInFlight = false
            refreshLocationState()
            // Answer any WebView geolocation prompt we held while the
            // system dialog was up — with the REAL result, not a stale "no".
            flushPendingGeoCallbacks()
            if (anyLocationGranted) {
                // Reload for a clean page state: covers the case where the
                // page's request timed out while the dialog was open.
                webView?.reload()
                if (coarseLocationGranted && !fineLocationGranted) {
                    maybeSuggestPreciseLocation()
                }
            }
        }
    }

    /**
     * Answer every held WebView geolocation callback with the current live
     * permission state. Called as soon as the permission result is known.
     */
    private fun flushPendingGeoCallbacks() {
        if (pendingGeoCallbacks.isEmpty()) return
        refreshLocationState()
        val allow = anyLocationGranted
        val pending = pendingGeoCallbacks.toList()
        pendingGeoCallbacks.clear()
        for ((origin, cb) in pending) {
            try {
                if (allow) {
                    try {
                        GeolocationPermissions.getInstance().clear(origin)
                    } catch (e: Exception) { /* best effort */
                    }
                }
                cb.invoke(origin, allow, false)
            } catch (e: Exception) {
                Log.w(TAG, "flushPendingGeoCallbacks failed", e)
            }
        }
        Log.i(TAG, "flushed ${pending.size} pending geolocation callbacks allow=$allow")
    }

    /** Our origin, tolerant of trivial formatting differences. */
    private fun isWaystationOrigin(origin: String): Boolean {
        if (origin == CarWebViewRenderer.WAYSTATION_ORIGIN) return true
        return try {
            val uri = Uri.parse(origin)
            uri.scheme == "https" && uri.host == "ciaranf3308-star.github.io"
        } catch (e: Exception) {
            false
        }
    }

    private fun configureWebView(wv: WebView) {
        if (BuildConfig.WEBVIEW_DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        // Web → native bridge: lets the page push Spotify auth into native
        // storage so it carries over to the car WebView without re-auth.
        wv.addJavascriptInterface(PhoneBridge(), "WayStationCarNative")
        wv.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // NOTE: property syntax does not resolve under this toolchain;
            // the explicit setter is the documented API.
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = false
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback
            ) {
                // Foreign origins never get location.
                if (!isWaystationOrigin(origin)) {
                    Log.w(TAG, "geolocation prompt for foreign origin=$origin denied")
                    callback.invoke(origin, false, false)
                    return
                }
                // Live read — the cached field may predate the user's
                // answer on the system dialog.
                refreshLocationState()
                if (anyLocationGranted) {
                    // Approximate location is sufficient to initialise the
                    // map and obtain a position — never deny just because
                    // precise location is off.
                    try {
                        GeolocationPermissions.getInstance().clear(origin)
                    } catch (e: Exception) { /* best effort */
                    }
                    Log.i(TAG, "phone geolocation prompt origin=$origin " +
                        "coarse=$coarseLocationGranted fine=$fineLocationGranted " +
                        "allow=true")
                    callback.invoke(origin, true, false)
                    return
                }
                if (locationRequestInFlight) {
                    // The system permission dialog is still up — the user
                    // hasn't answered yet. HOLD the callback; answering
                    // "no" now would poison the origin state and the later
                    // grant would never take effect.
                    Log.i(TAG, "phone geolocation prompt origin=$origin " +
                        "queued until permission resolves")
                    pendingGeoCallbacks.add(origin to callback)
                    return
                }
                Log.i(TAG, "phone geolocation prompt origin=$origin " +
                    "coarse=$coarseLocationGranted fine=$fineLocationGranted " +
                    "allow=false")
                callback.invoke(origin, false, false)
            }
        }
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView, url: String
            ): Boolean {
                // Keep the WayStation origin in-app; anything else (auth
                // callbacks etc.) also stays in the WebView so the web
                // PKCE flow completes without leaving the app.
                return false
            }

            // Same dead-page trap as the car renderer: one failed load must
            // not strand the user on the error page — retry with backoff.
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                loadFailed = false
            }

            override fun onPageFinished(view: WebView, url: String) {
                // onPageFinished also fires for the error page itself.
                if (loadFailed) return
                retryCount = 0
                retryRunnable?.let { view.removeCallbacks(it) }
                retryRunnable = null
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    loadFailed = true
                    schedulePhoneRetry(view)
                }
            }
        }
    }

    private fun schedulePhoneRetry(view: WebView) {
        retryRunnable?.let { view.removeCallbacks(it) }
        val delayMs = when {
            retryCount < 4 -> longArrayOf(2_000L, 4_000L, 8_000L, 16_000L)[retryCount]
            else -> 60_000L
        }
        retryCount++
        Log.i(TAG, "phone page load failed; retry $retryCount in ${delayMs}ms")
        val r = Runnable {
            retryRunnable = null
            try { view.reload() } catch (e: Exception) { schedulePhoneRetry(view) }
        }
        retryRunnable = r
        view.postDelayed(r, delayMs)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.saveState(outState)
    }

    override fun onBackPressed() {
        val wv = webView
        if (wv != null && wv.canGoBack()) wv.goBack()
        else super.onBackPressed()
    }

    override fun onDestroy() {
        retryRunnable?.let { webView?.removeCallbacks(it) }
        retryRunnable = null
        pendingGeoCallbacks.clear()
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "WayStationPhone"
        private const val WEB_URL =
            CarWebViewRenderer.WAYSTATION_ORIGIN + "/vice-city-navigator/"
        private const val REQ_LOCATION = 41
        private const val PREFS = "waystation_prefs"
        private const val KEY_LOCATION_ASKED = "location_permission_asked"
        private const val KEY_PRECISE_SUGGESTED = "precise_location_suggested"
    }
}
