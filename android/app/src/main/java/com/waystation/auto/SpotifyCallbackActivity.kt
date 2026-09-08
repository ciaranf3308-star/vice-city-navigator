package com.waystation.auto

import android.app.Activity
import android.os.Bundle

/**
 * Deep-link target for the Spotify OAuth redirect
 * (waystation://spotify-callback). Runs on the phone, not the head unit:
 * hands the authorization code to [SpotifyAuthManager] and finishes.
 * Declared in AndroidManifest.xml.
 */
class SpotifyCallbackActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SpotifyAuthManager(this).handleCallback(intent?.data)
        finish()
    }
}
