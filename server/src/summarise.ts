import { env } from "./env.ts";
import type { Issue } from "./linear.ts";

const PRIORITY_WORD: Record<number, string> = { 1: "urgent", 2: "high priority", 3: "medium priority", 4: "low priority", 0: "" };

export async function summarisePriorities(issues: Issue[]): Promise<string> {
  if (issues.length === 0) return "Nothing on the board. Suspicious.";

  const listing = issues
    .map((i, idx) => {
      const due = i.dueDate ? `, due ${i.dueDate}` : "";
      const pri = PRIORITY_WORD[i.priority] ? `, ${PRIORITY_WORD[i.priority]}` : "";
      return `${idx + 1}. ${i.title}${pri}${due}`;
    })
    .join("\n");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.groqApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      max_tokens: 200,
      temperature: 0,
      // gpt-oss spends max_tokens on hidden reasoning before content; without this, a 5-ticket
      // list burns the whole budget on reasoning and content comes back empty.
      reasoning_effort: "low",
      messages: [
        {
          role: "system",
          content:
            "Turn this ticket list into 3 to 5 spoken sentences, like a human assistant reading priorities aloud in a car. " +
            "Plain spoken English, numbers as words, no markdown, no ticket IDs, start with how many items there are.",
        },
        { role: "user", content: listing },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`groq summarise failed: ${JSON.stringify(json)}`);
  return json.choices[0].message.content.trim();
}
