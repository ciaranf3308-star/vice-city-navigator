# Themed AI Voice — setup (Supabase)

Themed / Themed + banter voice runs through your own Supabase Edge Function
`navigation-voice`. Your OpenAI API key lives **only** as the `OPENAI_API_KEY`
secret on the Supabase project — it never appears in the GitHub repo, the
client JavaScript, or the PWA/APK bundle.

Without this setup the app works fine: voice modes fall back to the standard
browser voice automatically.

## Key boundary (the rule)

- App → Supabase Edge Function: `{ text, theme, mode, profanity }`
- Edge Function → OpenAI: rewrite (`gpt-4o-mini`) + speech (`gpt-4o-mini-tts`)
- Edge Function → App: `{ line, audio (base64 mp3), mime }`
- The function enforces a **per-day request cap** (`VOICE_DAILY_CAP`, default
  1000) via a Postgres counter — independent of the Google Places quota — so
  a client bug can never hammer your OpenAI balance.

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

## 4. Store the OpenAI API key — the ONLY place it lives

1. Dashboard → **Project Settings** → **Edge Functions** → **Secrets** →
   **Add new secret**.
2. Name: `OPENAI_API_KEY`, value: paste your OpenAI API key
   ([platform.openai.com](https://platform.openai.com) → API keys).
3. Optional second secret: `VOICE_DAILY_CAP` (e.g. `500`) to lower the
   per-day request cap from the default 1000.

Do NOT put the key in this repo, in `supabase-config.js`, or in the app —
anywhere. If it ever leaks into git history, rotate it at platform.openai.com.

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
persona voice takes over. If the daily cap is hit, the app answers 429 and
keeps navigating with the standard voice — navigation never breaks.

## Files

- `supabase/functions/navigation-voice/index.ts` — the function (Deno).
- `supabase/migrations/20260907164500_navigation_voice_usage.sql` — cap counter.
- `supabase-config.js` — public URL + anon key (placeholders until step 5).
- `voice.js` — client: sends `{ text, theme, mode, profanity }`, plays `{ line, audio }`.

(Replaces the old Cloudflare `tts-worker.js`, removed 2026-09-07.)
