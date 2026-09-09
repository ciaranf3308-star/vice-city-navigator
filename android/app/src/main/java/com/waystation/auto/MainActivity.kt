package com.waystation.auto

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
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
    private var locationGranted = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        refreshLocationState()
        if (!locationGranted) {
            requestPermissions(
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION),
                REQ_LOCATION
            )
        }
        val wv = WebView(this)
        webView = wv
        configureWebView(wv)
        setContentView(wv)
        if (savedInstanceState != null) wv.restoreState(savedInstanceState)
        else wv.loadUrl(WEB_URL)
    }

    private fun refreshLocationState() {
        locationGranted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        if (requestCode == REQ_LOCATION) refreshLocationState()
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
                val granted = origin == CarWebViewRenderer.WAYSTATION_ORIGIN &&
                    locationGranted
                Log.i(TAG, "phone geolocation prompt for $origin -> $granted")
                callback.invoke(origin, granted, false)
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
        }
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
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "WayStationPhone"
        private const val WEB_URL =
            CarWebViewRenderer.WAYSTATION_ORIGIN + "/vice-city-navigator/"
        private const val REQ_LOCATION = 41
    }
}
