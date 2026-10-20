import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { env } from "./env.ts";
import { toolGetPriorities, toolHandleTask, toolAnswerQuestion, toolImplement } from "./tools.ts";

// Auricle (web/) speaks plain OpenAI-compatible STT/chat/TTS, no tool calling of its own.
// This is the proxy: one base URL, three routes, backed by Deepgram + Groq (with our tools
// run server-side) + Cartesia. Request/response shapes here are reverse-engineered from
// Auricle's own client (OpenAICompat in the `auricle` package) — not guessed.

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
      const result = await runTool(call.function.name, args);
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
    const text = await completeWithTools([...messages]);
    // ponytail: one SSE chunk, not real token streaming — Auricle's parser only needs valid
    // "data: {...}" lines ending in [DONE], it doesn't require many of them. Upgrade to true
    // streaming if first-audio latency ever needs shaving further.
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
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
