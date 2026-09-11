package com.waystation.auto

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import androidx.car.app.AppManager
import androidx.car.app.CarContext
import androidx.car.app.OnRequestPermissionsListener
import androidx.car.app.Screen
import androidx.car.app.SurfaceCallback
import androidx.car.app.SurfaceContainer
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.Template
import androidx.car.app.navigation.NavigationManager
import androidx.car.app.navigation.NavigationManagerCallback
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.core.content.ContextCompat

/**
 * The single car screen. It deliberately shows almost nothing native:
 * the WayStation dashboard WebView IS the UI, rendered onto the host
 * Surface by [CarWebViewRenderer] (SurfaceCallback → VirtualDisplay →
 * Presentation → WebView).
 *
 * The NavigationTemplate is support infrastructure: it keeps the host's
 * own chrome minimal and, via [NavigationManager], tells Android Auto a
 * navigation session is active while the JS side is navigating.
 */
class WayStationScreen(carContext: CarContext) : Screen(carContext) {

    private val main = Handler(Looper.getMainLooper())
    private val renderer = CarWebViewRenderer(carContext)
    private val navManager: NavigationManager =
        carContext.getCarService(NavigationManager::class.java)

    private var navActive = false
    private var locationGranted = false
    private var pageFailed = false

    private val surfaceCallback = object : SurfaceCallback {
        override fun onSurfaceAvailable(surfaceContainer: SurfaceContainer) {
            renderer.attach(surfaceContainer)
        }

        override fun onSurfaceDestroyed(surfaceContainer: SurfaceContainer) {
            renderer.detach()
        }

        override fun onVisibleAreaChanged(visibleArea: Rect) {
            renderer.setVisibleArea(visibleArea)
        }

        override fun onStableAreaChanged(stableArea: Rect) {
            renderer.setStableArea(stableArea)
        }

        // ---- touch: forwarded into the WebView (see CarWebViewRenderer) ----
        override fun onClick(x: Float, y: Float) = renderer.click(x, y)
        override fun onScroll(distanceX: Float, distanceY: Float) =
            renderer.scroll(distanceX, distanceY)

        override fun onScale(focusX: Float, focusY: Float, scaleFactor: Float) =
            renderer.pinch(focusX, focusY, scaleFactor)

        override fun onFling(velocityX: Float, velocityY: Float) =
            renderer.fling(velocityX, velocityY)
    }

    init {
        carContext.getCarService(AppManager::class.java)
            .setSurfaceCallback(surfaceCallback)
        navManager.setNavigationManagerCallback(object : NavigationManagerCallback {
            override fun onAutoDriveEnabled() { /* not used */ }

            /** Host asked to stop navigation: forward into the JS app so it
             *  stops the route, the voice and the driving state normally.
             *  Navigation state itself stays in JS — nothing duplicated. */
            override fun onStopNavigation() {
                main.post { renderer.stopNavigation() }
            }
        })
        // JS state (polled by the renderer) drives host nav metadata.
        renderer.onNavActive = { active ->
            main.post {
                if (active == navActive) return@post
                navActive = active
                if (active) navManager.navigationStarted()
                else navManager.navigationEnded()
            }
        }
        // Spotify connection state is no longer needed here — auth happens
        // on the phone and the car picks it up automatically. No Connect
        // action to show/hide.
        renderer.locationPermissionGranted = { locationGranted }
        // When the page needs geolocation but we don't have permission yet,
        // trigger the system permission request immediately — don't wait for
        // the user to find the "Enable location" action.
        renderer.onLocationPermissionNeeded = {
            main.post { requestLocationPermission() }
        }
        // Dashboard load state drives the native Reload action: while the
        // page has failed (and is auto-retrying) the user gets a manual
        // escape hatch on the head unit instead of a dead surface.
        renderer.onPageLoadState = { loaded ->
            main.post {
                val failed = !loaded
                if (failed == pageFailed) return@post
                pageFailed = failed
                invalidate()
            }
        }
        refreshLocationState()
    }

    // ---------------- location permission ----------------

    private fun refreshLocationState() {
        locationGranted = ContextCompat.checkSelfPermission(
            carContext, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(
                carContext, Manifest.permission.ACCESS_COARSE_LOCATION
            ) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestLocationPermission() {
        carContext.requestPermissions(
            listOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            ),
            ContextCompat.getMainExecutor(carContext),
            OnRequestPermissionsListener { granted, _ ->
                locationGranted = granted.contains(Manifest.permission.ACCESS_FINE_LOCATION) ||
                    granted.contains(Manifest.permission.ACCESS_COARSE_LOCATION)
                // Answer any held WebView geolocation callbacks with the real
                // result, then reload for a clean page state.
                renderer.onLocationPermissionResult()
                invalidate() // show/hide the Enable location action
            }
        )
    }

    override fun onGetTemplate(): Template {
        val builder = NavigationTemplate.Builder()
        // REQUIRED for the host to deliver SurfaceCallback touch events
        // (onClick/onScroll/onScale/onFling). On touchscreen hosts Android
        // Auto hides the PAN button itself, but the strip must still be
        // present. All actual touch handling stays in the WebView bridge.
        builder.setMapActionStrip(
            ActionStrip.Builder()
                .addAction(Action.PAN)
                .build()
        )
        builder.setPanModeListener { _ ->
            // Pan-mode UI is the dashboard itself; nothing native to do.
        }
        // Minimal host chrome. Native actions only for one-time setup the
        // WebView cannot do itself.
        val actions = mutableListOf<Action>()
        if (!locationGranted) {
            actions.add(
                Action.Builder()
                    .setTitle("Enable location")
                    .setOnClickListener { requestLocationPermission() }
                    .build()
            )
        }
        // NOTE: No "Connect Spotify" action on the head unit. Spotify auth
        // happens once in the phone app (which mirrors the token to native
        // storage); the car WebView picks it up automatically via
        // trySpotifyHandoff(). The old Custom Tab flow was unreliable and
        // is now redundant.
        if (pageFailed) {
            actions.add(
                Action.Builder()
                    .setTitle("Reload")
                    .setOnClickListener { renderer.reloadNow() }
                    .build()
            )
        }
        if (actions.isNotEmpty()) {
            val strip = ActionStrip.Builder()
            actions.forEach { strip.addAction(it) }
            builder.setActionStrip(strip.build())
        }
        return builder.build()
    }
}
