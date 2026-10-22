import { env } from "./env.ts";

// same plumbing as summarise.ts (Groq, not the Jev classification client) — this is
// generation, not classification, so it belongs on the chat-completions path.
async function groqJson(system: string, user: string): Promise<any> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.groqApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      max_tokens: 400,
      temperature: 0,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`groq compose failed: ${JSON.stringify(json)}`);
  return JSON.parse(json.choices[0].message.content);
}

// reproduced live (HIM-21): ticket creation just truncated the caller's raw spoken sentence to
// 80 chars as the title and used the whole sentence as the description — no composition at all.
// Falls back to that exact old behavior if the LLM call fails, so a flaky call never blocks
// ticket creation — a mediocre ticket beats a missing one.
export async function composeTicket(rawText: string): Promise<{ title: string; description: string }> {
  try {
    const out = await groqJson(
      "The caller described a new ticket out loud. Write a concise title (under 60 characters) and a " +
        "complete description that preserves every concrete detail they mentioned — links, constraints, " +
        "specifics — never invent anything they didn't say. Reply as JSON: {\"title\": \"...\", \"description\": \"...\"}.",
      rawText,
    );
    if (typeof out.title === "string" && typeof out.description === "string" && out.title.trim()) {
      return { title: out.title.trim(), description: out.description.trim() };
    }
  } catch (err) {
    console.error("composeTicket failed, falling back to raw text", err);
  }
  return { title: rawText.length > 80 ? rawText.slice(0, 80) : rawText, description: rawText };
}

// used by the "enrich this ticket's description" edit path — expands an existing, often sparse
// description using whatever new context the caller just gave, without inventing beyond that.
export async function enrichDescription(existingTitle: string, existingDescription: string, newContext: string): Promise<string> {
  try {
    const out = await groqJson(
      "Expand this ticket's description using the new context the caller just gave, in their own words as " +
        "much as possible. Keep everything already there; add detail, don't remove it. Don't invent anything " +
        "beyond the existing description and the new context. Reply as JSON: {\"description\": \"...\"}.",
      `Title: ${existingTitle}\n\nCurrent description: ${existingDescription || "(none)"}\n\nNew context from the caller: ${newContext}`,
    );
    if (typeof out.description === "string" && out.description.trim()) return out.description.trim();
  } catch (err) {
    console.error("enrichDescription failed, falling back to appending raw text", err);
  }
  return existingDescription ? `${existingDescription}\n\n${newContext}` : newContext;
}
