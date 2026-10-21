import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import { env } from "./env.ts";

const client = new TypeSafeClient({ apiKey: env.typesafeApiKey, defaultModel: "jev-latest", timeout: 4000 });

// confidence bands used everywhere a Jev answer drives a decision — see plan for rationale.
export const BAND = { LOW: 0.5, HIGH: 0.8 } as const;

function log(question: string, answer: string, confidence: number) {
  console.log(`[jev] ${question} -> ${answer} (confidence ${confidence.toFixed(2)})`);
}

export type TaskIntent = "create" | "execute" | "probe" | "delete" | "overview";

// Each description doubles as a few-shot example set — concrete phrasings score noticeably
// better than abstract definitions for a classifier this size, and these are the actual
// phrasings reproduced live across real calls (including ASR mangling the same project name
// three different ways in one call — "featbit" heard as "feedbit"/"feedback"/"fitbit").
const INTENT_CRITERIA = {
  create: "Start brand-new work with no existing ticket. 'let's build X', 'we need a Y', 'set up Z', 'can you add a ticket for W'",
  execute: "Begin or resume work on one ticket that should already exist. 'start the auth one', 'let's do the billing ticket', 'go ahead on X', 'work on Y'",
  probe: "Ask about one specific ticket by name, topic, or description — its status, whether it exists at all, or searching for it. 'is there anything about X', 'do we have a ticket for Y', 'how's the Z ticket doing', 'any update on W', 'what happened with the thing about V'",
  delete: "Cancel, remove, or archive a ticket entirely. 'cancel X', 'forget about Y', 'we don't need Z anymore', 'close out W'",
  overview:
    "A general summary of how much is in progress overall (not about one particular ticket), or a question about the system/connection itself. " +
    "'what's going on', 'how's everything going', 'what's running right now', 'is my mac connected', 'can you check the connection'",
};

// Jev evaluates every named question against the same state in one round trip — asking
// "intent" and "ticket" together here instead of as two sequential calls roughly halves
// voice-call latency on the common execute/probe/delete path. The 4s client timeout above
// caps the worst case; callers still need to handle a thrown error (Jev being unreachable
// shouldn't take the whole task-routing path down with it).
export async function classifyAndMatch(
  request: string,
  candidates: { id: string; title: string }[],
): Promise<{ intent: TaskIntent; intentConfidence: number; ticketId: string | null; ticketConfidence: number }> {
  const questions: Record<string, ReturnType<typeof choice>> = {
    intent: choice("What kind of task-management action is the caller asking for", INTENT_CRITERIA),
  };
  if (candidates.length > 0) {
    questions.ticket = choice("Which existing ticket, if any, is the caller referring to", {
      ...Object.fromEntries(candidates.map((c) => [c.id, c.title])),
      none: "No existing ticket is a close match",
    });
  }

  const res = await client.systemOne({ state: request, questions: questions as any });
  const intentAnswer = res.answers.intent as { choice: string; confidence: number };
  log("intent", intentAnswer.choice, intentAnswer.confidence);

  let ticketId: string | null = null;
  let ticketConfidence = 0;
  if (candidates.length > 0) {
    const ticketAnswer = res.answers.ticket as { choice: string; confidence: number };
    log("ticket", ticketAnswer.choice, ticketAnswer.confidence);
    ticketId = ticketAnswer.choice === "none" ? null : ticketAnswer.choice;
    ticketConfidence = ticketAnswer.confidence;
  }

  return { intent: intentAnswer.choice as TaskIntent, intentConfidence: intentAnswer.confidence, ticketId, ticketConfidence };
}

// used only by toolAnswerQuestion to disambiguate which blocked question an answer is for —
// a different candidate shape (question text, not ticket titles), kept separate from the
// combined call above since it runs at a different point in the conversation.
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
