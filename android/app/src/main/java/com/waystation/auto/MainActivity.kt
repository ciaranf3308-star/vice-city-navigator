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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        refreshLocationState()
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
            webView?.reload()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        if (requestCode == REQ_LOCATION) {
            refreshLocationState()
            if (anyLocationGranted) {
                // The page may have requested geolocation while the system
                // dialog was still up and been denied — reload so it fires
                // cleanly now that permission exists.
                webView?.reload()
                if (coarseLocationGranted && !fineLocationGranted) {
                    maybeSuggestPreciseLocation()
                }
            }
        }
    }

    private fun configureWebView(wv: WebView) {
        if (BuildConfig.WEBVIEW_DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
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
                // Approximate location is sufficient to initialise the map
                // and obtain a position — never deny just because precise
                // location is off.
                val allow = origin == CarWebViewRenderer.WAYSTATION_ORIGIN &&
                    anyLocationGranted
                Log.i(TAG, "phone geolocation prompt origin=$origin " +
                    "coarse=$coarseLocationGranted fine=$fineLocationGranted " +
                    "allow=$allow")
                callback.invoke(origin, allow, false)
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
