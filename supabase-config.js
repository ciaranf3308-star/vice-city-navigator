/* ============================================================================
   Vice City Navigator — Supabase client config.

   PUBLIC values only: the project URL and the anon key are safe to ship in
   client code by design (Supabase RLS + the Edge Function's own checks guard
   everything).

   The OpenAI API key lives ONLY as the OPENAI_API_KEY secret on the Supabase
   project (Project Settings → Edge Functions → Secrets). It must NEVER be
   pasted here, committed to git, or shipped in the app bundle.

   Setup: see VOICE_SETUP.md — then replace the two placeholders below.
   ========================================================================== */
window.VCNSupabase = {
  url: 'https://fhhnlbqsqtdsvmrvquqb.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZoaG5sYnFzcXRkc3ZtcnZxdXFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3OTMyMTQsImV4cCI6MjEwNDM2OTIxNH0.miYv7L_wYmDD0Bgk0IDvYGYHBZF1GsFUb8McH_0oSW8',
  functionPath: '/functions/v1/navigation-voice',
};
