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

    override fun createHostValidator(): HostValidator =
        HostValidator.ALLOW_ALL_HOSTS_VALIDATOR

    override fun onCreateSession(): Session = WayStationSession()
}
