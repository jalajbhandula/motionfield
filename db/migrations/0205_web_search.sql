-- WS2 step 12 — agent web tools (T4).
--
-- llm_user_prefs.searxng_url: the caller's own SearXNG instance base URL —
-- the ONLY web_search provider (an external AGPL service, never bundled).
-- NULL = web_search disabled, which is also the default: the tool is not
-- offered, not listed, and refuses to run until a URL is saved.
-- Offline mode requires this to be loopback (enforced at save + at exec).

ALTER TABLE llm_user_prefs
  ADD COLUMN IF NOT EXISTS searxng_url text;
