package com.waystation.auto

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Base64
import android.util.Log
import androidx.browser.customtabs.CustomTabsIntent
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import kotlin.concurrent.thread

/**
 * THIN Spotify auth/state bridge — not a second Spotify implementation.
 *
 * The car WebView is a separate browser profile from the phone's Chrome/TWA,
 * so it cannot reuse the existing PKCE session (separate localStorage).
 * Instead this manager performs the Spotify PKCE flow ONCE, natively, via a
 * Custom Tab on the phone (no password typing on the head unit), then hands
 * the resulting {access_token, refresh_token, expires_at} JSON to the car
 * WebView through window.WayStationCar.setSpotifyAuth() — the exact same
 * storage key and shape the web flow uses. From there the existing
 * SpotifyCore owns refresh, polling and playback; the themed widget,
 * lyrics and controls are untouched.
 *
 * Fallback (no setup): tapping "Connect Spotify" inside the dashboard
 * widget runs the normal web PKCE flow inside the car WebView itself.
 *
 * One-time setup: add `waystation://spotify-callback` as a Redirect URI in
 * the Spotify developer dashboard for this app (see android/README.md).
 */
class SpotifyAuthManager(private val context: Context) {

    companion object {
        private const val TAG = "WayStationCar"

        /** Public client ID — identical to the web app's (client IDs are
         *  public by Spotify's design; the secret never leaves the server). */
        const val CLIENT_ID = "e15ad96d357849999f72380200c0e37d"

        /** Must be registered in the Spotify dashboard (see README). */
        const val REDIRECT_URI = "waystation://spotify-callback"

        private const val PREFS = "waystation_car_spotify"
        private const val KEY_TOKEN = "token_json"
        private const val KEY_VERIFIER = "pkce_verifier"
        private const val KEY_STATE = "pkce_state"

        private val SCOPES = listOf(
            "user-read-currently-playing",
            "user-read-playback-state",
            "user-modify-playback-state"
        )
    }

    private val prefs =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Token JSON previously handed off (null until the user connects). */
    fun storedTokenJson(): String? = prefs.getString(KEY_TOKEN, null)

    /** Launch the Spotify authorize page in a Custom Tab on the phone. */
    fun startAuth() {
        val verifier = randomString(64)
        val state = randomString(24)
        prefs.edit()
            .putString(KEY_VERIFIER, verifier)
            .putString(KEY_STATE, state)
            .apply()

        val authUri = Uri.parse("https://accounts.spotify.com/authorize")
            .buildUpon()
            .appendQueryParameter("client_id", CLIENT_ID)
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("redirect_uri", REDIRECT_URI)
            .appendQueryParameter("code_challenge_method", "S256")
            .appendQueryParameter("code_challenge", pkceChallenge(verifier))
            .appendQueryParameter("scope", SCOPES.joinToString(" "))
            .appendQueryParameter("state", state)
            .build()

        val intent = CustomTabsIntent.Builder().build().intent.apply {
            data = authUri
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        Log.i(TAG, "Spotify PKCE authorize launched")
    }

    /** Called by [SpotifyCallbackActivity] with the redirect URI data. */
    fun handleCallback(data: Uri?) {
        val code = data?.getQueryParameter("code")
        val state = data?.getQueryParameter("state")
        val error = data?.getQueryParameter("error")
        if (!error.isNullOrEmpty()) {
            Log.w(TAG, "Spotify auth error: $error")
            return
        }
        if (code.isNullOrEmpty()) {
            Log.w(TAG, "Spotify callback without code")
            return
        }
        val savedState = prefs.getString(KEY_STATE, null)
        if (savedState == null || savedState != state) {
            Log.w(TAG, "Spotify state mismatch")
            return
        }
        val verifier = prefs.getString(KEY_VERIFIER, null) ?: return
        thread(name = "spotify-token-exchange") {
            try {
                exchangeCode(code, verifier)
            } catch (e: Exception) {
                Log.e(TAG, "Spotify token exchange failed", e)
            }
        }
    }

    private fun exchangeCode(code: String, verifier: String) {
        val body = "grant_type=authorization_code" +
            "&code=${Uri.encode(code)}" +
            "&redirect_uri=${Uri.encode(REDIRECT_URI)}" +
            "&client_id=${Uri.encode(CLIENT_ID)}" +
            "&code_verifier=${Uri.encode(verifier)}"
        val conn = (URL("https://accounts.spotify.com/api/token")
            .openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            connectTimeout = 15000
            readTimeout = 15000
        }
        conn.outputStream.use { os ->
            OutputStreamWriter(os, Charsets.UTF_8).use { it.write(body) }
        }
        val resCode = conn.responseCode
        val text = (if (resCode in 200..299) conn.inputStream else conn.errorStream)
            .bufferedReader().readText()
        if (resCode !in 200..299) {
            Log.e(TAG, "Spotify token exchange HTTP $resCode: $text")
            return
        }
        val t = JSONObject(text)
        val auth = JSONObject().apply {
            put("access_token", t.getString("access_token"))
            put("refresh_token", t.optString("refresh_token", ""))
            put("expires_at", System.currentTimeMillis() + t.getLong("expires_in") * 1000)
        }
        prefs.edit()
            .putString(KEY_TOKEN, auth.toString())
            .remove(KEY_VERIFIER)
            .remove(KEY_STATE)
            .apply()
        Log.i(TAG, "Spotify token stored; will hand off to car WebView on next poll")
    }

    private fun randomString(len: Int): String {
        val chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
        val rnd = SecureRandom()
        return CharArray(len) { chars[rnd.nextInt(chars.length)] }.concatToString()
    }

    private fun pkceChallenge(verifier: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(verifier.toByteArray(Charsets.US_ASCII))
        return Base64.encodeToString(
            digest, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
        )
    }
}
