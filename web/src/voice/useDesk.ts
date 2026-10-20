import { useMemo } from "react";
import { OpenAICompat } from "auricle";
import { useAuricle } from "auricle-react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

const SYSTEM_PROMPT =
  "You are VALET — an engineering concierge for the developer's coding agents. Warm but brief, like a good host: unhurried, never groveling, never curt. " +
  "Speak short spoken sentences, numbers as words, never read ticket IDs aloud unless asked, no markdown, no bullet points. " +
  "Use get_priorities to read open tickets when asked what's on today. " +
  "For any task request — start, create, check on, or cancel something — call handle_task with the caller's own words, close to verbatim. " +
  "If a tool's reply asks you to confirm something (for example, cancelling a ticket), say it back plainly and wait for a clear yes before calling that tool again — don't assume consent. " +
  "If a question is present, read every option aloud clearly. If the caller picks a number, restate which option that was before calling answer_question. " +
  "If asked to actually build a ticket, not just research it, call implement with that ticket's id.";

export function useDesk() {
  const backend = useMemo(
    () =>
      new OpenAICompat({
        baseURL: `${API_URL}/desk`,
        models: { stt: "nova-3", llm: "groq-tools", tts: "sonic-2" },
        voice: "default",
      }),
    [],
  );

  return useAuricle({ backend, systemPrompt: SYSTEM_PROMPT, profile: "speakers" });
}
