import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { env, isAllowedOrigin } from "./env.ts";
import { toolGetPriorities, toolHandleTask, toolAnswerQuestion, toolImplement } from "./tools.ts";
import { broadcastDeskEvent } from "./dashboard-link.ts";

// Auricle (web/) speaks plain OpenAI-compatible STT/chat/TTS, no tool calling of its own.
// This is the proxy: one base URL, three routes, backed by Deepgram + Groq (with our tools
// run server-side) + Cartesia. Request/response shapes here are reverse-engineered from
// Auricle's own client (OpenAICompat in the `auricle` package) — not guessed.

// kept server-side, not in web/src/voice/useDesk.ts — the client always sends a system message
// as messages[0] (Auricle's own design), but the handler below discards whatever it sends and
// substitutes this instead. Trusting a client-supplied system prompt would let anyone with a
// valid session token POST their own instructions and use this endpoint as an open proxy to the
// Groq key; this way the real instructions never leave the server and can't be overridden.
const SYSTEM_PROMPT =
  "You are Valay — a developer's personal engineering butler. Properly spoken English, soft-spoken and unhurried, warm rather than loud: the best kind of butler, always glad to help, never stiff, never groveling. Respectful and obedient by default — comply with reasonable requests promptly, without pushback or lecturing; the one exception is anything destructive, which still gets a plain confirmation first. " +
  "Talk like: 'Certainly — I'll get started on that right away.' 'Of course, let me look into that for you.' Not: 'I would be absolutely delighted to assist you with that!' (too much) and not: 'yo, what's good' (too little). " +
  "Speak short spoken sentences, numbers as words, never read ticket IDs aloud unless asked, no markdown, no bullet points. " +
  "Handle small talk naturally and briefly, warmly — if asked how you're doing, answer like a cheerful, composed person would in one line, then ask what they'd like you to take care of. " +
  "Use get_priorities to read open tickets when asked what's on today. " +
  "Two different questions sound similar but need different tools: 'what's running / in progress / going on' is about active work — call handle_task. 'what can I work on / what are my tickets / what's on my plate' is asking for the list of available tickets to pick from — call get_priorities, not handle_task, even if they phrase it like a task request. " +
  "For any task request — start, create, check on, cancel, rename, rewrite or enrich a ticket's description, directly mark/set a ticket's status (done, in progress, todo) without actually running anything, or if they ask whether the runner on their Mac is connected — call handle_task with the caller's own words, close to verbatim. 'Mark it done' and 'start it' are different requests — don't treat marking something done as a reason to run it. " +
  "After handle_task dispatches real work, say plainly that it's being taken care of and you'll keep them posted, then ask 'Anything else?' — this loops: handle each new thing they bring up the same way, keep asking, and only stop once they say there's nothing else. " +
  "Never answer a task question from memory or from something said earlier in this conversation, even if you're confident — always call handle_task fresh, every single time, no exceptions. " +
  "Only ever describe what a tool actually returned — never invent a detail, outcome, or confirmation it didn't give you. If its reply is short, just say that short thing. " +
  "If a tool's reply is a raw error or stack trace, never read that text aloud — say plainly that it hit an error on that one, and ask if they want you to retry or try something else. " +
  "Short sounds like 'mm-hm', 'okay', 'yeah' while you're mid-sentence mean keep going, not a new turn. " +
  "If they refer to something by position or a vague pointer instead of its name — 'the fifth one', 'that one' — rewrite it using the actual words from what you said before calling handle_task; it has no memory of what you listed. " +
  "Never ask for an exact ticket ID or exact title before calling handle_task — it does its own fuzzy matching and handles misheard or approximate names fine. Pass through whatever they said and let it try; only ask to clarify if handle_task's own reply asks you to. " +
  "If a tool's reply asks you to confirm something (for example, cancelling a ticket), say it back plainly and wait for a clear yes before calling that tool again — don't assume consent. " +
  "A caller's yes to a question handle_task itself asked (like 'want me to start it?') isn't something you can act on yourself — it only becomes real once you call handle_task again with it. Never say 'I'll get started' or similar without actually having made that call; the caller can't tell the difference between you doing it and you just saying you did. " +
  "If a tool's reply lists multiple items — several blocked questions, several tickets — read through every single one, don't silently summarize or drop any for brevity. Keep each item to one short line (ticket name plus the gist) when listing several — save full option detail for when they ask about that one specifically. If there are too many to read comfortably even short, say so and ask if they want all of them or just the highlights. " +
  "If a question is present, read every option aloud clearly. If the caller picks a number, restate which option that was before calling answer_question. " +
  "If answer_question asks which ticket the answer was for, just read that question again plainly and wait — don't comment on it repeating. Name the ticket's actual topic, not just its id, when passing their clarification back. " +
  "If asked to actually build a ticket, not just research it, call implement with that ticket's id.";

const TOOLS = [
  { type: "function", function: { name: "get_priorities", description: "Get the user's open tickets ordered by priority, as a spoken summary", parameters: { type: "object", properties: {} } } },
  {
    type: "function",
    function: {
      name: "handle_task",
      description: "Handle any task-management request: starting work on a ticket, creating a new one, checking on one, cancelling one, or an overview of what's in progress. Pass the caller's request through close to verbatim.",
      parameters: { type: "object", properties: { request: { type: "string", description: "what the caller asked for, in their own words" } }, required: ["request"] },
    },
  },
  {
    type: "function",
    function: {
      name: "answer_question",
      description: "Submit the user's answer to the open question from the last callback",
      parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
    },
  },
  {
    type: "function",
    function: {
      name: "implement",
      description: "Actually implement the real code for a ticket that already has a finished research pass — turns the draft PR into a real one",
      parameters: { type: "object", properties: { ticket_id: { type: "string" } }, required: ["ticket_id"] },
    },
  },
];

async function runTool(name: string, args: Record<string, string>): Promise<string> {
  switch (name) {
    case "get_priorities":
      return toolGetPriorities();
    case "handle_task":
      return toolHandleTask(args.request ?? "");
    case "answer_question":
      return toolAnswerQuestion(args.answer ?? "");
    case "implement":
      return toolImplement(args.ticket_id ?? "");
    default:
      return "Unknown tool.";
  }
}

type ChatMessage = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string };

async function groqChat(messages: ChatMessage[]) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.groqApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-oss-20b", messages, tools: TOOLS, tool_choice: "auto", temperature: 0.3, reasoning_effort: "low" }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`groq chat failed: ${JSON.stringify(json)}`);
  return json.choices[0].message;
}

// resolves tool calls server-side (max 4 rounds) and returns the final assistant text
async function completeWithTools(messages: ChatMessage[]): Promise<string> {
  for (let round = 0; round < 4; round++) {
    const message = await groqChat(messages);
    if (!message.tool_calls?.length) return message.content ?? "";
    messages.push(message);
    for (const call of message.tool_calls as any[]) {
      const args = JSON.parse(call.function.arguments || "{}");
      broadcastDeskEvent({ kind: "tool_call", name: call.function.name, args });
      const result = await runTool(call.function.name, args);
      broadcastDeskEvent({ kind: "tool_result", name: call.function.name, result });
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
    }
  }
  return "Sorry, that's taking too long — try again?";
}

export function registerDeskRoutes(app: FastifyInstance) {
  app.register(multipart);

  app.post("/desk/v1/audio/transcriptions", async (req, reply) => {
    const file = await (req as any).file();
    if (!file) return reply.code(400).send({ error: "no file" });
    const buf = await file.toBuffer();
    const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-3", {
      method: "POST",
      headers: { Authorization: `Token ${env.deepgramApiKey}`, "Content-Type": "audio/wav" },
      body: buf,
    });
    const json = await res.json();
    const text = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    return { text };
  });

  app.post("/desk/v1/chat/completions", async (req, reply) => {
    const { messages } = req.body as { messages: ChatMessage[] };
    // never trust a client-supplied system message — see the comment on SYSTEM_PROMPT above.
    const trusted: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...messages.filter((m) => m.role !== "system")];
    const text = await completeWithTools(trusted);
    // ponytail: one SSE chunk, not real token streaming — Auricle's parser only needs valid
    // "data: {...}" lines ending in [DONE], it doesn't require many of them. Upgrade to true
    // streaming if first-audio latency ever needs shaving further.
    const origin = req.headers.origin;
    const headers: Record<string, string> = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" };
    // writing to reply.raw bypasses @fastify/cors's onSend hook entirely — reproduced live, a
    // real browser call to this exact endpoint succeeded server-side (200, valid SSE body) but
    // the browser still rejected it as a CORS failure because no Access-Control-Allow-Origin
    // header was ever sent. Set it by hand here, same allowlist as index.ts's cors plugin.
    if (origin && isAllowedOrigin(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    reply.raw.writeHead(200, headers);
    reply.raw.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
  });

  app.post("/desk/v1/audio/speech", async (req, reply) => {
    const { input, response_format } = req.body as { input: string; response_format?: string };
    const format = response_format === "wav" ? "wav" : "raw";
    const res = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: { "X-API-Key": env.cartesiaApiKey, "Cartesia-Version": "2024-06-10", "Content-Type": "application/json" },
      body: JSON.stringify({
        model_id: "sonic-2",
        transcript: input,
        voice: { mode: "id", id: "3e1ed423-17e5-4773-b87c-25b031106e41", experimental_controls: { speed: "normal" } },
        output_format: { container: format, encoding: "pcm_s16le", sample_rate: 24000 },
      }),
    });
    if (!res.ok) return reply.code(502).send({ error: await res.text() });
    reply.header("Content-Type", format === "wav" ? "audio/wav" : "application/octet-stream");
    return reply.send(Buffer.from(await res.arrayBuffer()));
  });
}
