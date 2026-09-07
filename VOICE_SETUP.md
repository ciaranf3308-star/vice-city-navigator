# Themed AI Voice — setup (Supabase + OpenAI)

Themed / Themed + banter voice runs through your own Supabase Edge Function
`navigation-voice`. **OpenAI is the primary provider for EVERY theme** —
rewrite (`gpt-4o-mini`) + speech (`gpt-4o-mini-tts`), both on your funded
OpenAI account. Your `OPENAI_API_KEY` lives **only** as a secret on the
Supabase project — it never appears in the GitHub repo, the client
JavaScript, or the PWA/APK bundle.

Without this setup the app works fine: voice modes fall back to the standard
browser voice automatically.

## Provider order (identical for all four themes)

1. **Cached generated audio** — this client's memory cache, then the
   function's server-side `voice-cache` Storage bucket (private,
   self-provisioned, service_role only). Repeats cost nothing.
2. **OpenAI rewrite**: `gpt-4o-mini` with the theme persona.
3. **OpenAI TTS**: `gpt-4o-mini-tts` → MP3.
4. **Browser/device speech fallback** (client-side, on 502/429). The app
   always speaks the deterministic instruction immediately, so the driver
   never waits on AI.

**Gemini is NEVER attempted in the normal path.** The function keeps an
explicit opt-in `provider: 'gemini-first'` slot, but no shipped profile
uses it — nothing in the normal flow can add Gemini latency before OpenAI.
`GEMINI_API_KEY` is only needed if you ever opt a profile in; otherwise it
can be absent entirely.

## Theme voices (personaVersion v3)

| Theme | Profile | TTS voice | Persona |
|---|---|---|---|
| Vice City | `vice-city` | `echo` | Energetic 1980s Miami traffic-radio DJ |
| San Andreas | `san-andreas` | `onyx` | West Coast neighborhood OG, deep baritone |
| GTA V | `gta-v` | `alloy` | Slick modern Los Santos city guide |
| Frontier | `rdr2` | `fable` | Seasoned frontier trail guide |

Each theme's `voice` block in `themes/<id>/theme.js` is the **source of
truth**: the app sends `{ text, theme, profile, personaVersion, mode,
profanity }` and the Edge Function renders that profile's persona from its
server-side `PERSONAS` map, which mirrors the theme wording exactly.

**personaVersion v3** (bumped 2026-09-07 with the brevity pass) is part of
both the client memory-cache key and the server Storage cache key
(`v3 | profile | personaVersion | mode | profanity | normalized instruction
| TTS model | voice`, sha256). Bumping it whenever persona wording changes
guarantees stale cached audio is never reused.

## Brevity system (v3)

Every theme rewrite prompt carries the hard instruction:

> BREVITY IS MANDATORY. Most responses must be 3–9 words. Never add extra
> exposition, setup, narration, or character dialogue. Give the maneuver
> immediately. Character should come from word choice and cadence, not length.

Length ceilings: most maneuver lines **3–9 words**; advance warnings (the
source starts "In N meters,") **max 12 words**; complex roundabout or
genuinely complicated instructions **max 18 words**. Usually one sentence —
two only when genuinely required for clarity. Priority: correct maneuver,
then short, then clear, then character. If character makes the instruction
longer, cut the character.

Route facts stay sacred: the rewrite must preserve every direction,
roundabout maneuver and exit facts, every road/street name, every distance,
destination facts, and maneuver order — never invent landmarks or traffic,
never change names or distances, never swap directions, never omit or add
maneuvers. The pipeline supplies **only** the maneuver text to the voice
model — no traffic, speed, weather, road-condition, or POI data — so the
prompts forbid remarks about any of these, and landmarks may appear only if
the source instruction itself names them.

The delivery style is a passenger giving quick callouts, not a character
performing a monologue. Each theme keeps its own personality and example
lines (Vice City "Right here, hotshot." / San Andreas "Straight on,
homie." / GTA V "Right here, genius." / Frontier "Keep straight,
partner.") — instantly recognisable, never four versions of one GPS voice.

Banter mode may append ONE very short quip (under 10 words) after the
instruction — never before it, never instead of it. The server also caps
rewrite output at 60 tokens as a backstop.

## 1. Create the Supabase project

1. Sign in at [supabase.com](https://supabase.com) → **New project**.
2. Name: `vice-city-navigator`, region: EU (Ireland is closest to you).
3. Save the database password somewhere safe (1Password etc.).

## 2. Create the Edge Function

1. Dashboard → **Edge Functions** → **Create a new function**, name:
   `navigation-voice`.
2. Paste the contents of `supabase/functions/navigation-voice/index.ts`
   from this repo into the function editor → **Deploy**.
3. Leave **Enforce JWT verification** ON — the app sends the anon key with
   every call, and this keeps random curl off the endpoint.

**A GitHub push does NOT deploy the function.** After every change to
`index.ts`, redeploy it in the dashboard (paste + Deploy). The client
sends its `personaVersion` with each request, so a mismatched deployment
serves stale personas until redeployed.

## 3. Create the daily-cap counter

1. Dashboard → **SQL Editor** → New query.
2. Paste `supabase/migrations/20260907164500_navigation_voice_usage.sql`
   → **Run**. (Creates `navigation_voice_usage` + the
   `navigation_voice_bump()` RPC, executable by `service_role` only.)

## 4. Store the OpenAI API key — the ONLY place it lives

1. Dashboard → **Project Settings** → **Edge Functions** → **Secrets** →
   **Add new secret**.
2. Name: `OPENAI_API_KEY`, value: paste your OpenAI API key.
3. Optional second secret: `VOICE_DAILY_CAP` (e.g. `500`) to lower the
   per-day request cap from the default 1000.

`OPENAI_API_KEY` is **required** — every shipped profile is OpenAI-primary,
and a missing key is a hard `server_misconfigured` 500, not a silent
fallback. (`GEMINI_API_KEY` is optional and only used by the explicit
`gemini-first` opt-in, which no shipped profile uses.)

Do NOT put the key in this repo, in `supabase-config.js`, or in the app —
anywhere. If it ever leaks, rotate it in the OpenAI dashboard.

No Storage dashboard step is needed: the function creates the private
`voice-cache` bucket itself on first use (it already has `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` for the usage counter).

## 5. Point the app at Supabase

1. Dashboard → **Project Settings** → **API**: copy the **Project URL** and
   the **anon public** key.
2. Paste them into `supabase-config.js` (replacing the two placeholders).
3. Commit + push — the anon key is public-by-design and safe in the repo.

## 6. Verify

```bash
# Health (no auth needed for the shape check; JWT still enforced on POST)
curl https://YOUR_PROJECT_REF.supabase.co/functions/v1/navigation-voice
# → {"ok":true,"service":"navigation-voice"}

# Key-absence audit — must print NOTHING:
git log -p --all | grep -iE "sk-(proj-)?[A-Za-z0-9]{20,}" | head
grep -riE "sk-(proj-)?[A-Za-z0-9]{20,}" --exclude-dir=.git --exclude-dir=node_modules .
```

Then drive with **Themed** voice: the first maneuver speaks in standard voice
while themed audio generates in the background; from the second maneuver the
persona voice takes over. If the daily cap is hit, the app keeps navigating
with the standard voice — navigation never breaks.

## Key boundary (the rule)

- App → Supabase Edge Function: `{ text, theme, profile, personaVersion,
  mode, profanity }`
- Edge Function → OpenAI: rewrite (`gpt-4o-mini`) + speech
  (`gpt-4o-mini-tts`, MP3 audio)
- Edge Function → App: `{ line, audio (base64 mp3), mime }`
- The function enforces a **per-day request cap** (`VOICE_DAILY_CAP`, default
  1000) via a Postgres counter — independent of any other quota — so a
  client bug can never hammer the provider.
- Global server deadline: 10s, under the client's 12s timeout; the
  deadline also fires on client disconnect, so the function never burns
  provider calls after nobody is listening.

## Files

- `supabase/functions/navigation-voice/index.ts` — the function (Deno).
- `supabase/migrations/20260907164500_navigation_voice_usage.sql` — cap counter.
- `supabase-config.js` — public URL + anon key (placeholders until step 5).
- `voice.js` — client: sends `{ text, theme, profile, personaVersion, mode,
  profanity }`, plays `{ line, audio }`; controller-backed in-flight map,
  deduped generation, stale-abort on reroute/theme switch, pregenerates 5
  upcoming instructions.
- `themes/<id>/theme.js` — each theme's `voice` block (source of truth for
  its persona; bump `personaVersion` whenever the wording changes).
- `tools/theme_tests.js` — 800 assertions covering the voice pipeline,
  personas, brevity rules, cache keys, and client/server prompt mirroring.
