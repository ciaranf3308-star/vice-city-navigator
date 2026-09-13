package com.waystation.auto

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import com.spotify.sdk.android.auth.AuthorizationClient
import com.spotify.sdk.android.auth.AuthorizationRequest
import com.spotify.sdk.android.auth.AuthorizationResponse

/**
 * Transparent trampoline that runs Spotify's auth SDK from contexts with no
 * Activity of their own (notably the car CarContext).
 *
 * When the Spotify app is installed, the SDK bounces auth to it: the user
 * is already logged in there (even via Facebook), so it's a one-tap
 * approve instead of a web login in a WebView/Custom Tab that doesn't
 * share the app's session. PKCE is injected via custom params so the
 * existing token exchange works unchanged.
 *
 * Result handling: CODE -> exchange with the saved verifier; ERROR ->
 * fall back to the Custom Tab flow; anything else (user cancelled) is
 * respected — no fallback nag.
 */
class SpotifySsoActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val mgr = SpotifyAuthManager(this)
        val verifier = mgr.savedVerifier()
        val state = mgr.savedState()
        if (verifier == null || state == null) {
            Log.w(TAG, "SSO without PKCE pair; Custom Tab fallback")
            mgr.startAuth()
            finish()
            return
        }
        try {
            val request = AuthorizationRequest.Builder(
                SpotifyAuthManager.CLIENT_ID,
                AuthorizationResponse.Type.CODE,
                SpotifyAuthManager.REDIRECT_URI
            )
                .setScopes(SpotifyAuthManager.scopes.toTypedArray())
                .setState(state)
                .setCustomParam("code_challenge_method", "S256")
                .setCustomParam("code_challenge", mgr.pkceChallengeFor(verifier))
                .build()
            AuthorizationClient.openLoginActivity(this, REQ_SPOTIFY_SSO, request)
            Log.i(TAG, "Spotify SSO LoginActivity launched")
        } catch (e: Exception) {
            Log.e(TAG, "Spotify SSO launch failed; Custom Tab fallback", e)
            CarDiagnostics.log(this, "spotify auth: SSO launch failed, Custom Tab fallback", e)
            try { mgr.startAuth() } catch (e2: Exception) { }
            finish()
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_SPOTIFY_SSO) {
            val mgr = SpotifyAuthManager(this)
            val resp: AuthorizationResponse? = try {
                AuthorizationClient.getResponse(resultCode, data)
            } catch (e: Exception) {
                Log.w(TAG, "getResponse failed", e)
                null
            }
            when (resp?.type) {
                AuthorizationResponse.Type.CODE -> {
                    val code = resp.code
                    if (!code.isNullOrEmpty()) {
                        mgr.handleAppSsoCode(this, code, resp.state)
                    } else {
                        Log.w(TAG, "SSO CODE empty; Custom Tab fallback")
                        CarDiagnostics.log(this, "spotify auth: SSO empty code, Custom Tab fallback")
                        mgr.startAuth()
                    }
                }
                AuthorizationResponse.Type.ERROR -> {
                    Log.w(TAG, "SSO error ${resp.error}; Custom Tab fallback")
                    CarDiagnostics.log(this, "spotify auth: SSO error (${resp.error}), Custom Tab fallback")
                    mgr.startAuth()
                }
                else -> {
                    // EMPTY / cancelled: respect it, don't nag.
                    Log.i(TAG, "Spotify SSO cancelled by user")
                    CarDiagnostics.log(this, "spotify auth: SSO cancelled by user")
                }
            }
        }
        finish()
    }

    companion object {
        private const val TAG = "WayStationCar"
        private const val REQ_SPOTIFY_SSO = 5007
    }
}
