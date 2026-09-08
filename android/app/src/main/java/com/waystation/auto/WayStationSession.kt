package com.waystation.auto

import android.content.Intent
import androidx.car.app.Screen
import androidx.car.app.Session

/** One car session = one [WayStationScreen]. No per-drive state here. */
class WayStationSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen =
        WayStationScreen(carContext)
}
