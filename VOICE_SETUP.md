# Themed AI Voice — setup

Themed / Themed + banter voice uses OpenAI's `gpt-4o-mini-tts` through your
own tiny Cloudflare Worker. Your OpenAI API key lives **only** as a Worker
secret — it never appears in the GitHub Pages JavaScript.

Without this setup the app works fine: voice modes fall back to the standard
browser voice automatically.

## 1. Deploy the worker

You need a Cloudflare account (free) and an OpenAI API key
([platform.openai.com](https://platform.openai.com) → API keys).

```bash
cd vice-city-nav
npx wrangler login
npx wrangler secret put OPENAI_API_KEY   # paste your OpenAI key when asked
npx wrangler deploy tts-worker.js --name vcn-tts --compatibility-date 2026-09-01
```

Wrangler prints your worker URL, e.g.
`https://vcn-tts.<your-subdomain>.workers.dev`.

Sanity check:

```bash
curl https://vcn-tts.<your-subdomain>.workers.dev/health
# → {"ok":true}
```

## 2. Point the app at it

1. Open Vice City Navigator → menu (☰) → **Voice**.
2. Set **Mode** to *Themed* (or *Themed + banter*).
3. Paste the worker URL into **Themed voice server**.
4. Toggle **Profanity** if you want the persona unfiltered.

The setting is stored on the device (localStorage), per browser.

## How it works

- OSRM stays authoritative: the app builds the deterministic maneuver text
  (`Turn left onto Main Street in 300 metres`) and shows it on screen.
- The worker rewrites it in the theme's persona (`gpt-4o-mini`) and speaks it
  (`gpt-4o-mini-tts`), returning MP3. The structured maneuver info is never
  changed — only the phrasing.
- When a route is calculated, the app pre-generates audio for the next few
  maneuvers in the background and caches it. Navigation **never waits** for
  the network: if themed audio isn't ready, the standard voice speaks
  immediately and the themed version warms the cache for next time.
- Rerouting regenerates upcoming audio and drops stale clips.
- If the worker is down or the key is invalid, everything falls back to the
  standard voice silently.
