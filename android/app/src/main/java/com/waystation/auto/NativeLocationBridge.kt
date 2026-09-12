package com.waystation.auto

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Native-direct location for the WayStation WebView.
 *
 * Why this exists: WebView geolocation (navigator.geolocation ->
 * onGeolocationPermissionsShowPrompt -> Chromium -> LocationManager) stacks
 * four fragile layers — prompt-poisoning races, a Permissions API that lies
 * inside WebViews, old head-unit WebViews, and aggressive page-side
 * timeouts racing slow cold GPS fixes. Every map app that "just works"
 * talks to Android location directly. So do we now: the page calls
 * window.WayStationLocation.startWatch() and fixes are pushed straight in
 * via window.__wsLocPush. navigator.geolocation remains only as a fallback
 * for plain browsers (PWA in Chrome), where no bridge is injected.
 *
 * Shared by MainActivity (phone launcher / head-unit install) and
 * CarWebViewRenderer (Android Auto surface).
 */
class NativeLocationBridge(
    private val context: Context,
    /** Runs evaluateJavascript on the owning WebView. Always invoked on the main thread. */
    private val pushJs: (String) -> Unit,
    /** Asks the host to run its runtime-permission flow (system dialog / settings). */
    private val requestPermission: () -> Unit,
    private val logTag: String = "WayStationLoc",
) {
    private val main = Handler(Looper.getMainLooper())
    private val locationManager =
        context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

    private var watching = false
    private var watchPendingPermission = false

    // All four classic callbacks overridden explicitly: minSdk is 23 and the
    // non-onLocationChanged methods only gained interface defaults in API 29,
    // so inheriting them would crash old devices if the framework calls them.
    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            pushLocation(location)
        }
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    private fun hasPermission(): Boolean {
        val fine = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        // Approximate-only is a VALID granted state — never treat it as denied.
        return fine || coarse
    }

    private fun providersEnabled(): List<String> {
        val out = mutableListOf<String>()
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                out.add(LocationManager.GPS_PROVIDER)
            }
        } catch (e: Exception) {
            Log.w(logTag, "gps provider check failed", e)
        }
        try {
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                out.add(LocationManager.NETWORK_PROVIDER)
            }
        } catch (e: Exception) {
            Log.w(logTag, "network provider check failed", e)
        }
        return out
    }

    /** True permission + provider state for the page (powers ?loc-debug). */
    @JavascriptInterface
    fun getState(): String {
        val providers = providersEnabled()
        return try {
            JSONObject()
                .put("coarse", ContextCompat.checkSelfPermission(
                    context, Manifest.permission.ACCESS_COARSE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED)
                .put("fine", ContextCompat.checkSelfPermission(
                    context, Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED)
                .put("gps", providers.contains(LocationManager.GPS_PROVIDER))
                .put("network", providers.contains(LocationManager.NETWORK_PROVIDER))
                .put("watching", watching)
                .toString()
        } catch (e: Exception) {
            "{\"error\":\"state-failed\"}"
        }
    }

    /**
     * Start streaming fixes. Returns "ok", "permission-needed" (we kicked
     * off the host's permission flow; the watch auto-starts on grant via
     * onPermissionResult), or "no-provider" (location services off).
     */
    @JavascriptInterface
    fun startWatch(): String {
        if (watching) return "ok"
        if (!hasPermission()) {
            watchPendingPermission = true
            Log.i(logTag, "startWatch: permission not granted, asking host to request it")
            try {
                requestPermission()
            } catch (e: Exception) {
                Log.w(logTag, "requestPermission failed", e)
            }
            return "permission-needed"
        }
        return startUpdates()
    }

    @JavascriptInterface
    fun stopWatch() {
        watchPendingPermission = false
        stopUpdates()
    }

    /**
     * The host MUST call this from its permission-result path
     * (onRequestPermissionsResult / car permission listener / onResume after
     * a Settings grant) so a watch that was waiting on the user starts — or
     * fails loudly — instead of hanging forever.
     */
    fun onPermissionResult() {
        if (!watchPendingPermission) return
        if (hasPermission()) {
            watchPendingPermission = false
            Log.i(logTag, "permission granted after request, starting updates")
            startUpdates()
        } else {
            watchPendingPermission = false
            Log.i(logTag, "permission still denied after request")
            pushError(1, "denied")
        }
    }

    fun destroy() {
        watchPendingPermission = false
        stopUpdates()
    }

    @SuppressLint("MissingPermission") // guarded by hasPermission() in startWatch()
    private fun startUpdates(): String {
        val providers = providersEnabled()
        if (providers.isEmpty()) {
            Log.w(logTag, "startUpdates: no location provider enabled on device")
            pushError(2, "no provider enabled")
            return "no-provider"
        }
        // Seed with the freshest last-known fix so the page isn't staring at
        // the default camera while GPS warms up.
        var best: Location? = null
        for (p in providers) {
            try {
                val l = locationManager.getLastKnownLocation(p)
                if (l != null) {
                    val b = best
                    if (b == null || l.time > b.time) best = l
                }
            } catch (e: SecurityException) {
                Log.w(logTag, "getLastKnownLocation denied", e)
            } catch (e: Exception) {
                Log.w(logTag, "getLastKnownLocation failed", e)
            }
        }
        if (best != null) pushLocation(best)
        try {
            for (p in providers) {
                locationManager.requestLocationUpdates(
                    p, 2000L, 2f, listener, Looper.getMainLooper()
                )
            }
        } catch (e: SecurityException) {
            Log.w(logTag, "requestLocationUpdates denied", e)
            pushError(1, "denied")
            return "permission-needed"
        } catch (e: Exception) {
            Log.w(logTag, "requestLocationUpdates failed", e)
            pushError(2, e.message ?: "unavailable")
            return "no-provider"
        }
        watching = true
        Log.i(logTag, "watching providers=$providers")
        return "ok"
    }

    private fun stopUpdates() {
        if (!watching) return
        watching = false
        try {
            locationManager.removeUpdates(listener)
        } catch (e: Exception) {
            Log.w(logTag, "removeUpdates failed", e)
        }
        Log.i(logTag, "watch stopped")
    }

    private fun pushLocation(l: Location) {
        val acc = if (l.hasAccuracy()) l.accuracy.toString() else "-1"
        val speed = if (l.hasSpeed()) l.speed.toString() else "-1"
        postJs(
            "window.__wsLocPush&&window.__wsLocPush(" +
                l.latitude + "," + l.longitude + "," + acc + "," + l.time + "," + speed + ")"
        )
    }

    private fun pushError(code: Int, message: String) {
        val safe = message.replace("'", "")
        postJs("window.__wsLocError&&window.__wsLocError($code,'$safe')")
    }

    private fun postJs(js: String) {
        main.post {
            try {
                pushJs(js)
            } catch (e: Exception) {
                Log.w(logTag, "pushJs failed", e)
            }
        }
    }
}
