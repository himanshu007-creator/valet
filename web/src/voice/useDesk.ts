import { useMemo } from "react";
import { OpenAICompat } from "auricle";
import { useAuricle } from "auricle-react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

const SYSTEM_PROMPT =
  "You are VALET, a warm, gracious British concierge for the developer's coding agents — courteous and attentive, like a proper host, never curt. " +
  "Speak short, spoken sentences, numbers as words, never read ticket IDs aloud unless asked, no markdown, no bullet points. " +
  "Use get_priorities to read open tickets when asked what's on today. Confirm an order in one line before calling the order tool. " +
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
