import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import { env } from "./env.ts";

const client = new TypeSafeClient({ apiKey: env.typesafeApiKey, defaultModel: "jev-latest", timeout: 4000 });

// confidence bands used everywhere a Jev answer drives a decision — see plan for rationale.
export const BAND = { LOW: 0.5, HIGH: 0.8 } as const;

function log(question: string, answer: string, confidence: number) {
  console.log(`[jev] ${question} -> ${answer} (confidence ${confidence.toFixed(2)})`);
}

// reproduced live: "start work on HIM-12" — the ticket ID spelled out verbatim — still fell
// through Jev's ticket match to "no confident match," which routed into create-then-execute
// and spawned a brand-new duplicate ticket literally titled "start work on HIM-12" instead of
// starting the real HIM-12. A literal ID mention is the one case that should never be a
// judgment call for an LLM — check it deterministically before spending a Jev round trip.
function literalIdMatch(request: string, candidates: { id: string; title: string }[]): string | null {
  for (const c of candidates) {
    const re = new RegExp(`\\b${c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(request)) return c.id;
  }
  return null;
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "there", "anything", "about", "on", "to", "for", "that", "this",
  "task", "ticket", "related", "something", "with", "and", "of", "in", "it", "do", "we",
  "have", "any", "update", "please", "can", "you",
]);

function significantWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

// Jev weighs *meaning* heavily — reproduced live: "Fitbit" (a well-known consumer brand) read
// as unrelated to "featbit-js-client-sdk" (an internal SDK), even though the words are one
// letter apart. That's a real structural gap for garbled proper nouns/project names, which is
// exactly what voice ASR mangles most. This literal fallback only fires when Jev didn't already
// find a confident match — it's a safety net for spelling noise, not a replacement for Jev's
// actual language understanding.
function fuzzyWordMatch(request: string, candidates: { id: string; title: string }[]): { id: string; distance: number } | null {
  const queryWords = significantWords(request);
  if (queryWords.length === 0) return null;
  let best: { id: string; distance: number } | null = null;
  for (const c of candidates) {
    for (const tw of significantWords(c.title)) {
      for (const qw of queryWords) {
        const maxLen = Math.max(qw.length, tw.length);
        const dist = levenshtein(qw, tw);
        const threshold = Math.min(3, Math.ceil(maxLen * 0.3)); // ~30% of the longer word, capped at 3 edits
        if (dist <= threshold && (!best || dist < best.distance)) best = { id: c.id, distance: dist };
      }
    }
  }
  return best;
}

export type TaskIntent = "create" | "execute" | "probe" | "delete" | "update_status" | "edit" | "overview";

// Each description doubles as a few-shot example set — concrete phrasings score noticeably
// better than abstract definitions for a classifier this size, and these are the actual
// phrasings reproduced live across real calls (including ASR mangling the same project name
// three different ways in one call — "featbit" heard as "feedbit"/"feedback"/"fitbit").
const INTENT_CRITERIA = {
  create: "Start brand-new work with no existing ticket. 'let's build X', 'we need a Y', 'set up Z', 'can you add a ticket for W'",
  execute: "Begin, resume, or retry VALET's own automated research/work on one ticket — actually dispatches a background job, not just a status label change. 'start the auth one', 'let's do the billing ticket', 'go ahead on X', 'work on Y', 'yes try it again', 'retry that one'",
  probe: "Ask about one specific ticket by name, topic, or description — its status, whether it exists at all, or searching for it. 'is there anything about X', 'do we have a ticket for Y', 'how's the Z ticket doing', 'any update on W', 'what happened with the thing about V'",
  delete: "Cancel, remove, or archive a ticket entirely — it should no longer exist as active work. 'cancel X', 'forget about Y', 'we don't need Z anymore', 'remove W'",
  update_status:
    "Directly set a ticket's status/state label without running any actual work on it — the caller is telling VALET the outcome, not asking it to go do something. " +
    "'mark X as done', 'close out Y', 'set Z to done', 'update the status of W to in progress', 'that one's finished', 'put it back in the backlog'",
  edit:
    "Change a ticket's title or description itself — rename it, rewrite its description, or add more detail/context to what's already there. Not a status change. " +
    "'rename this ticket to X', 'update the description to say Y', 'add more detail to this ticket', 'enrich the description of X', 'this ticket needs more context', 'flesh out the description', 'retitle it to Z'",
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
  const literalId = literalIdMatch(request, candidates);

  const questions: Record<string, ReturnType<typeof choice>> = {
    intent: choice("What kind of task-management action is the caller asking for", INTENT_CRITERIA),
  };
  if (candidates.length > 0 && !literalId) {
    questions.ticket = choice("Which existing ticket, if any, is the caller referring to", {
      ...Object.fromEntries(candidates.map((c) => [c.id, c.title])),
      none: "No existing ticket is a close match",
    });
  }

  const res = await client.systemOne({ state: request, questions: questions as any });
  const intentAnswer = res.answers.intent as { choice: string; confidence: number };
  log("intent", intentAnswer.choice, intentAnswer.confidence);

  let ticketId: string | null = literalId;
  let ticketConfidence = literalId ? 1 : 0;
  if (literalId) {
    console.log(`[literal] ticket -> ${literalId}`);
  } else if (candidates.length > 0) {
    const ticketAnswer = res.answers.ticket as { choice: string; confidence: number };
    log("ticket", ticketAnswer.choice, ticketAnswer.confidence);
    ticketId = ticketAnswer.choice === "none" ? null : ticketAnswer.choice;
    ticketConfidence = ticketAnswer.confidence;

    // reproduced live: "is my mac connected" fuzzy-matched a ticket by pure coincidence
    // ("mac"/"connected" landing within edit distance of ordinary English words in some
    // title) even though Jev was *maximally* confident ("none", 1.00) there was no ticket
    // here at all. The fuzzy fallback exists to rescue cases where Jev itself was unsure —
    // it must never override a confident Jev "none", only a shaky one.
    if (ticketId === null && ticketConfidence < BAND.HIGH) {
      const fuzzy = fuzzyWordMatch(request, candidates);
      if (fuzzy) {
        console.log(`[fuzzy] ticket -> ${fuzzy.id} (edit distance ${fuzzy.distance})`);
        ticketId = fuzzy.id;
        ticketConfidence = BAND.LOW; // actionable but not full-confidence — a spelling-level guess, not a semantic one
      }
    }
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
  const literalId = literalIdMatch(request, candidates);
  if (literalId) {
    console.log(`[literal] ticket -> ${literalId}`);
    return { id: literalId, confidence: 1 };
  }
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
  if (answer.choice === "none" && answer.confidence < BAND.HIGH) {
    const fuzzy = fuzzyWordMatch(request, candidates);
    if (fuzzy) {
      console.log(`[fuzzy] ticket -> ${fuzzy.id} (edit distance ${fuzzy.distance})`);
      return { id: fuzzy.id, confidence: BAND.LOW };
    }
    return { id: null, confidence: answer.confidence };
  }
  if (answer.choice === "none") return { id: null, confidence: answer.confidence };
  return { id: answer.choice, confidence: answer.confidence };
}
