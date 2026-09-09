# WayStation — Android app (phone + Android Auto)

Personal / internal test build. **One APK, one install:** a phone launcher
(`MainActivity` — fullscreen WebView over the production site in normal
mode, so you can search and plan on the phone) **and** the Android Auto
car app (the real WayStation dashboard rendered inside a
hardware-accelerated WebView on the Android Auto Surface) live in the same
app. No native map, no native UI rewrite — the web app is the source of
truth on both surfaces.

## Architecture

```
Android Auto host Surface
  └─ SurfaceCallback (AppManager.setSurfaceCallback)
       ├─ onSurfaceAvailable → VirtualDisplay (exact w/h/DPI from
       │                         SurfaceContainer) → Presentation → WebView
       │                         → https://ciaranf3308-star.github.io/vice-city-navigator/?dashboard=1&car=1
       ├─ onSurfaceDestroyed → destroy WebView, dismiss Presentation,
       │                       release VirtualDisplay (no leaks; safe to
       │                       re-run when resolution/DPI changes)
       ├─ onVisibleAreaChanged / onStableAreaChanged → forwarded into JS
       │   as --car-visible-* / --car-stable-* CSS variables + JS state
       └─ onClick / onScroll / onScale / onFling → synthetic MotionEvents
           dispatched into the WebView (tap, pan, pinch, fling)
```

- **Template:** `NavigationTemplate` with minimal host chrome. The only
  native action is "Connect Spotify" (shown only while the car WebView
  isn't connected).
- **Navigation metadata:** the renderer polls `window.WayStationCar.getState()`
  every 2s; `navActive` drives `NavigationManager.navigationStarted()` /
  `navigationEnded()` so the host knows a navigation session is active.
  No native maneuver UI — the dashboard is the visual experience.
- **Spotify:** the car WebView is a separate browser profile, so it can't
  share the phone's Chrome/TWA PKCE session. Thin bridge instead:
  1. (Preferred) Tap **Connect Spotify** in the car UI → native PKCE via
     Custom Tab **on the phone** → token exchanged natively → handed into
     the page via `WayStationCar.setSpotifyAuth()` → lands in the exact
     `localStorage['vcn.spotify.auth']` key/shape the web flow uses →
     `SpotifyCore.reloadAuth()` picks it up. From there the existing web
     Spotify engine owns refresh/polling/playback — no second
     implementation.
  2. (Zero setup) Tap **Connect Spotify inside the dashboard widget** —
     the normal web PKCE flow runs inside the car WebView itself.
- **Voice:** untouched — the car WebView runs the same
  OSRM → voice.js → Supabase `navigation-voice` → OpenAI TTS pipeline.
- **Lyrics:** untouched — the WSLyrics engine renders in the WebView.

## One-time setup

1. **Spotify redirect URI.** In the Spotify developer dashboard for the
   WayStation app, add:
   ```
   waystation://spotify-callback
   ```
   (The client ID is the same public ID the web app already uses.)

2. **Prerequisites on your build machine:** JDK 17+, Android SDK
   (platform 34 + build-tools). Either open `android/` in Android Studio,
   or create `android/local.properties`:
   ```
   sdk.dir=/path/to/Android/Sdk
   ```

## Build

```sh
cd android
./gradlew :app:assembleDebug      # APK → app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:bundleRelease      # AAB → app/build/outputs/bundle/release/app-release.aab
```

Install the debug APK on your phone with `adb install`, or upload the
AAB to Play Console → **Internal app sharing** / **Internal testing**
(no car-app form-factor review applies to those tracks).

## Desktop Head Unit (DHU) testing

1. On the phone: Android Auto app → tap version 10× → developer mode →
   enable **Unknown sources**.
2. Install the debug APK, then start the DHU:
   ```sh
   ./desktop-head-unit -o  # (DHU from the AA developer site)
   adb forward tcp:5277 tcp:5277
   ```
3. In DHU, WayStation appears in the launcher. Open it: the real
   dashboard should render. `chrome://inspect` (debug builds enable
   WebView remote debugging) shows the car WebView console.

## Hyundai Ioniq 5 notes (things to verify on the car)

- **Touch:** synthetic MotionEvents are the primary path. If taps land
  offset on the Ioniq's screen, the surface→view coordinate mapping in
  `CarWebViewRenderer` is the first place to look (currently 1:1 — the
  WebView is laid out at exactly the surface pixel size).
- **Touch fallback:** if synthetic events prove unreliable, inject JS
  instead: `document.elementFromPoint(x, y)` then `.click()` on the
  result. The hook point is `CarWebViewRenderer.click()`.
- **Overlays:** if the Ioniq's host chrome covers dashboard chrome, the
  live `--car-visible-*` / `--car-stable-*` CSS variables are already
  being set — key any padding tweaks off those, don't redesign.
- **Voice:** car WebView audio routes through the phone like any AA
  audio; if TTS ducks oddly under Ioniq nav prompts, that's host audio
  focus, not the app.
- **Spotify login:** do the native "Connect Spotify" flow while parked —
  the Custom Tab opens on the phone, not the head unit.

## Files

- `WayStationCarAppService.kt` — car entry, NAVIGATION category,
  permissive host validator (internal builds only)
- `WayStationSession.kt` / `WayStationScreen.kt` — session + minimal
  NavigationTemplate + NavigationManager wiring
- `CarWebViewRenderer.kt` — Surface → VirtualDisplay → Presentation →
  WebView, touch forwarding, area forwarding, state poll, token handoff
- `SpotifyAuthManager.kt` / `SpotifyCallbackActivity.kt` — native PKCE
  → token handoff (thin bridge)
- Web side: `car.js` (?car=1 flag), `app.js` (`installCarBridge`,
  forced dashboard), `spotify-core.js` (`reloadAuth`)
