package com.waystation.auto

import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import androidx.car.app.AppManager
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.SurfaceCallback
import androidx.car.app.SurfaceContainer
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.Template
import androidx.car.app.navigation.NavigationManager
import androidx.car.app.navigation.NavigationManagerCallback
import androidx.car.app.navigation.model.NavigationTemplate

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
    private var spotifyConnected = false

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
        renderer.onSpotifyConnected = { connected ->
            main.post {
                if (connected == spotifyConnected) return@post
                spotifyConnected = connected
                invalidate() // show/hide the Connect Spotify action
            }
        }
    }

    override fun onGetTemplate(): Template {
        val builder = NavigationTemplate.Builder()
        // Minimal host chrome. The only native action: kick off the Spotify
        // PKCE login on the phone when the car WebView isn't connected yet.
        // (Tapping "Connect Spotify" inside the dashboard widget also works —
        // that runs the normal web flow inside the car WebView.)
        if (!spotifyConnected) {
            val connect = Action.Builder()
                .setTitle("Connect Spotify")
                .setOnClickListener { renderer.startSpotifyAuth() }
                .build()
            builder.setActionStrip(ActionStrip.Builder().addAction(connect).build())
        }
        return builder.build()
    }
}
