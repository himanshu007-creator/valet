import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import { env } from "./env.ts";

const client = new TypeSafeClient({ apiKey: env.typesafeApiKey, defaultModel: "jev-latest" });

// confidence bands used everywhere a Jev answer drives a decision — see plan for rationale.
export const BAND = { LOW: 0.5, HIGH: 0.8 } as const;

function log(question: string, answer: string, confidence: number) {
  console.log(`[jev] ${question} -> ${answer} (confidence ${confidence.toFixed(2)})`);
}

export type TaskIntent = "create" | "execute" | "probe" | "delete" | "overview";

export async function classifyIntent(request: string): Promise<{ intent: TaskIntent; confidence: number }> {
  const res = await client.systemOne({
    state: request,
    questions: {
      intent: choice("What kind of task-management action is the caller asking for", {
        create: "Start a brand-new piece of work that has no existing ticket yet",
        execute: "Begin or continue work on a ticket that should already exist",
        probe: "Check the status or progress of one specific ticket already being worked on",
        delete: "Cancel, remove, or archive a ticket entirely",
        overview: "A general summary of how many things are in progress, not about one ticket",
      }),
    },
  });
  const answer = res.answers.intent;
  log("intent", answer.choice, answer.confidence);
  return { intent: answer.choice as TaskIntent, confidence: answer.confidence };
}

export async function matchTicket(
  request: string,
  candidates: { id: string; title: string }[],
): Promise<{ id: string | null; confidence: number }> {
  if (candidates.length === 0) return { id: null, confidence: 0 };
  const res = await client.systemOne({
    state: request,
    questions: {
      ticket: choice("Which existing ticket, if any, is the caller referring to", {
        ...Object.fromEntries(candidates.map((c) => [c.id, c.title])),
        none: "No existing ticket is a close match",
      }),
    },
  });
  const answer = res.answers.ticket;
  log("ticket", answer.choice, answer.confidence);
  return { id: answer.choice === "none" ? null : answer.choice, confidence: answer.confidence };
}
