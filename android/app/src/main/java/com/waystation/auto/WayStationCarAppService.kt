package com.waystation.auto

import androidx.car.app.CarAppService
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

/**
 * WayStation Android Auto entry point (personal/internal test build).
 *
 * Permissive host validation: the Desktop Head Unit and the Ioniq 5 head
 * unit are both accepted without Play review enrollment. NEVER ship this
 * validator in a production build.
 */
class WayStationCarAppService : CarAppService() {

    override fun onCreate() {
        super.onCreate()
        CarDiagnostics.header(this)
        CarDiagnostics.log(this, "CarAppService created")
        // Safety net: the car host calls into us over Binder, so an
        // exception there never produces a Play crash report. Log any
        // uncaught exception in this process to the diagnostics file,
        // then let the system handle it exactly as usual.
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, t ->
            try {
                CarDiagnostics.log(this, "UNCAUGHT on thread ${thread.name}", t)
            } catch (e: Exception) {
            }
            previous?.uncaughtException(thread, t)
        }
    }

    override fun createHostValidator(): HostValidator =
        HostValidator.ALLOW_ALL_HOSTS_VALIDATOR

    override fun onCreateSession(): Session = WayStationSession()
}
