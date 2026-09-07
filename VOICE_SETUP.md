# Themed AI Voice — setup (Supabase + Gemini free tier)

Themed / Themed + banter voice runs through your own Supabase Edge Function
`navigation-voice`. The provider is the **Gemini Developer API free tier** —
rewrite (`gemini-2.0-flash`) + speech (`gemini-2.5-flash-preview-tts`), both
free of charge on the free tier. Your Gemini API key lives **only** as the
`GEMINI_API_KEY` secret on the Supabase project — it never appears in the
GitHub repo, the client JavaScript, or the PWA/APK bundle.

Use a **separate Google AI Studio project** for this key — NOT the billed
Google Cloud project that holds your Places API key. AI Studio keys work on
the free tier with no billing attached, so there is nothing to charge, ever:
if the free quota is hit the function answers 502 and the app falls back to
the standard voice.

Without this setup the app works fine: voice modes fall back to the standard
browser voice automatically.

## Key boundary (the rule)

- App → Supabase Edge Function: `{ text, theme, mode, profanity }`
- Edge Function → Gemini: rewrite (`gemini-2.0-flash`) + speech
  (`gemini-2.5-flash-preview-tts`, WAV audio)
- Edge Function → App: `{ line, audio (base64 wav), mime }`
- The function enforces a **per-day request cap** (`VOICE_DAILY_CAP`, default
  1000) via a Postgres counter — independent of the Google Places quota — so
  a client bug can never hammer any provider.

Provider chain (per theme — the server decides from the `theme` the app sends):

- `san-andreas`: **OpenAI primary** (funded account). Gemini is never
  attempted for this profile.
  1. Server audio cache (`voice-cache` Storage bucket — self-provisioned
     by the function on first use, private, service_role only).
  2. OpenAI rewrite: `gpt-4o-mini` with the San Andreas persona.
  3. OpenAI TTS: `gpt-4o-mini-tts`, voice `onyx` → MP3.
  4. Browser/device speech fallback (client-side, on 502/429).
- `vice-city` (default): `GEMINI_API_KEY` (free, default) → `OPENAI_API_KEY`
  (optional paid fallback, kept in code) → `server_misconfigured` if neither
  is set.

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

## 3. Create the daily-cap counter

1. Dashboard → **SQL Editor** → New query.
2. Paste `supabase/migrations/20260907164500_navigation_voice_usage.sql`
   → **Run**. (Creates `navigation_voice_usage` + the `navigation_voice_bump()`
   RPC, executable by `service_role` only.)

## 4. Store the Gemini API key — the ONLY place it lives

1. Go to [Google AI Studio](https://aistudio.google.com) → **Get API key** →
   **Create API key in new project** (a fresh project, separate from your
   billed Places project — no billing needed for the free tier).
2. Dashboard → **Project Settings** → **Edge Functions** → **Secrets** →
   **Add new secret**.
3. Name: `GEMINI_API_KEY`, value: paste the AI Studio key.
4. Optional second secret: `VOICE_DAILY_CAP` (e.g. `500`) to lower the
   per-day request cap from the default 1000.

Do NOT put the key in this repo, in `supabase-config.js`, or in the app —
anywhere. If it ever leaks, delete/rotate it in AI Studio (free, 30 seconds).

(The `OPENAI_API_KEY` secret is **required** for the San Andreas profile
(OpenAI-primary); for Vice City it remains an optional fallback behind
Gemini whenever `GEMINI_API_KEY` is set.)

No Storage dashboard step is needed: the function creates the private
`voice-cache` bucket itself on the first San Andreas request (it already
has `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for the usage counter).

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
grep -riE "AIza[A-Za-z0-9_-]{30,}" --exclude-dir=.git --exclude-dir=node_modules .
```

Then drive with **Themed** voice: the first maneuver speaks in standard voice
while themed audio generates in the background; from the second maneuver the
persona voice takes over. If the daily cap or the Gemini free quota is hit,
the app keeps navigating with the standard voice — navigation never breaks.

## Files

- `supabase/functions/navigation-voice/index.ts` — the function (Deno).
- `supabase/migrations/20260907164500_navigation_voice_usage.sql` — cap counter.
- `supabase-config.js` — public URL + anon key (placeholders until step 5).
- `voice.js` — client: sends `{ text, theme, mode, profanity }`, plays `{ line, audio }`.

(Replaces the old Cloudflare `tts-worker.js`, removed 2026-09-07.)
