import { useMemo } from "react";
import { OpenAICompat } from "auricle";
import { useAuricle } from "auricle-react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

// the real instructions live server-side now (server/src/desk.ts's SYSTEM_PROMPT) — the handler
// there discards whatever system message this client sends and substitutes its own, so a client
// with a valid session token can't override Valay's behavior or use the endpoint as an open
// proxy to the Groq key. Auricle always sends messages[0] as role:"system" regardless, so this
// just needs to be non-empty; its content is otherwise ignored.
const SYSTEM_PROMPT = "(overridden server-side)";

export function useDesk(token: string | null) {
  const backend = useMemo(
    () =>
      new OpenAICompat({
        baseURL: `${API_URL}/desk`,
        models: { stt: "nova-3", llm: "groq-tools", tts: "sonic-2" },
        voice: "default",
        // the desk routes are session-cookie-gated (requireAuth), but this client's own fetch()
        // calls don't set credentials:"include" — a cross-origin cookie (prod: Vercel -> Render)
        // never gets attached regardless of login state. apiKey sends it as a Bearer header
        // instead, which requireAuth also accepts — see server/src/auth.ts's sessionToken().
        apiKey: token ?? undefined,
      }),
    [token],
  );

  return useAuricle({ backend, systemPrompt: SYSTEM_PROMPT, profile: "speakers" });
}
