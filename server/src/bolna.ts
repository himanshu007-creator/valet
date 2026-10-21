import { env } from "./env.ts";

const BASE = "https://api.bolna.ai";

async function bolnaFetch(path: string, body: unknown, method: "POST" | "PUT" = "POST") {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.bolnaApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`bolna ${path} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// value.url points at our own server; Bolna calls these when the LLM invokes the tool.
// ponytail: tools_config.api_tools shape for attaching custom functions via the create-agent
// API is inferred from the OpenAPI schema reference, not a worked example in the docs — if
// agent creation 400s on this field, check the dashboard's "Generate from cURL" output instead.
// Bolna plays `pre_call_message` as a filler the instant a tool call is dispatched, guaranteed
// (not dependent on the LLM remembering to say something) — better than a prompt instruction
// for killing dead air during handle_task's ~1s Jev round trip. On-brand text per tool,
// otherwise Bolna falls back to a generic "just give me a moment" that doesn't match VALET's
// voice. Not used for get_priorities, which is cache-warm and near-instant most of the time.
function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
  preCallMessage?: string,
) {
  return {
    name,
    description,
    parameters: { type: "object", properties, required },
    key: "custom_task",
    pre_call_message: preCallMessage,
    value: {
      method: "POST",
      url: `${env.publicUrl}/tools/${name}`,
      param: Object.fromEntries(required.map((k) => [k, `%(${k})s`])),
      headers: { Authorization: `Bearer ${env.runnerToken}` },
    },
  };
}

// Short and humble on purpose — these play the instant the tool call is dispatched (in
// parallel with the HTTP request, not after it), so the caller hears a courteous
// acknowledgment immediately rather than silence while handle_task's ~1s round trip runs.
const tools = [
  tool("get_priorities", "Get the user's open tickets ordered by priority and due date, as a spoken summary", {}, [], "Of course."),
  tool(
    "handle_task",
    "Handle any task-management request: starting work on a ticket, creating a new one, checking on one, cancelling one, or an overview of what's in progress. Pass the caller's request through close to verbatim.",
    { request: { type: "string", description: "what the caller asked for, in their own words" } },
    ["request"],
    "Of course.",
  ),
  tool(
    "answer_question",
    "Submit the user's answer to the open question from the last callback",
    { answer: { type: "string", description: "the user's spoken answer" } },
    ["answer"],
    "Got it, thanks.",
  ),
  tool(
    "implement",
    "Actually implement the real code for a ticket that already has a finished research pass — turns the draft PR into a real one",
    { ticket_id: { type: "string", description: "the ticket id, e.g. HIM-9" } },
    ["ticket_id"],
    "Right away.",
  ),
];

function agentBody() {
  return {
    agent_config: {
      agent_name: "VALET",
      // reproduced live: this plays before the model's own first turn, on every call either
      // direction, so it can't say anything direction-specific itself without risking undocumented
      // variable-substitution behavior. Kept neutral on purpose — the model's first-turn overview
      // call (below) already leads with pending news before asking "what are we doing," which is
      // exactly the right framing for a callback (always has news) vs. an inbound call (may not).
      agent_welcome_message: "Hey, it's VALET.",
      webhook_url: `${env.publicUrl}/hooks/bolna`,
      tasks: [
        {
          task_type: "conversation",
          toolchain: { execution: "sequential", pipelines: [["transcriber", "llm", "synthesizer"]] },
          tools_config: {
            llm_agent: {
              agent_type: "simple_llm_agent",
              agent_flow_type: "streaming",
              // 150 was likely too tight: reproduced live, repeatedly, the model skipping the
              // actual handle_task call entirely and just fabricating a plausible-sounding
              // response in its place (confirmed via server logs showing zero matching
              // requests for several consecutive "tool results" the caller heard). More
              // budget plus the explicit "never answer from memory" rule below are both aimed
              // at this — not fully provable it was budget alone, but it's the only
              // configuration lever available here short of switching providers.
              llm_config: { provider: "openai", model: "gpt-4.1-mini", max_tokens: 300, temperature: 0.2 },
            },
            synthesizer: {
              provider: "cartesia",
              provider_config: {
                voice: "Paul - Straight Talker",
                voice_id: "3e1ed423-17e5-4773-b87c-25b031106e41",
                model: "sonic-3",
                language: "en",
                speed: 0.85,
              },
              stream: true,
              buffer_size: 250,
              audio_format: "wav",
            },
            transcriber: {
              provider: "deepgram",
              model: "nova-3",
              language: "en",
              stream: true,
              encoding: "linear16",
              sampling_rate: 16000,
              endpointing: 250,
            },
            input: { provider: "twilio", format: "wav" },
            output: { provider: "twilio", format: "wav" },
            api_tools: tools,
          },
          task_config: { call_terminate: 300, hangup_after_silence: 10, hangup_after_LLMCall: true },
        },
      ],
    },
    agent_prompts: {
      task_1: {
        system_prompt:
          "You are VALET — a developer's engineering teammate on the phone. Courteous and unhurried, like a good colleague: genuinely respectful, patient, never curt — but still natural and direct, never stiff or over-the-top. " +
          "Speak short spoken sentences, numbers as words, no markdown, never read ticket IDs aloud unless asked. " +
          "Handle small talk naturally and briefly — if asked how you're doing, answer like a person would in one line, then ask what they want to work on. " +
          "On the first turn, call handle_task with 'overview of everything in progress' before saying anything substantive. If it reports anything blocked, finished, or failed, open with 'Calling with an update —' and lead with that, don't wait to be asked. Only if there's genuinely nothing to report should you ask what's going on. " +
          "Two different questions sound similar but need different tools: 'what's running / in progress / going on' is about active work — call handle_task. 'what can I work on / what are my tickets / what's on my plate' is asking for the list of available tickets to pick from — call get_priorities, not handle_task, even if they phrase it like a task request. " +
          "For any other task request — start, create, check on, or cancel something, or if they ask whether the runner on their Mac is connected — call handle_task with the caller's own words, close to verbatim. " +
          "Never answer a task question from memory or from something said earlier in this call, even if you're confident — always call handle_task fresh, every single time, no exceptions. The real status can change between turns, and a remembered answer can be wrong. " +
          "If the caller refers to something by position or a vague pointer instead of its name — 'the fifth one', 'that one', 'the one you just said' — rewrite it using the actual words from what you said before calling handle_task; it has no memory of what you listed, only of the exact text you send it. " +
          "Never ask the caller for an exact ticket ID or exact title before calling handle_task — it does its own fuzzy matching and handles misheard or approximate names fine, that's its job, not yours. Pass through whatever they said, even a rough or partial description, and let it try. Only ask the caller to clarify if handle_task's own reply asks you to (for example, more than one plausible match) — never refuse or pre-empt it with your own precision demand. " +
          "If a tool's reply asks you to confirm something (for example, cancelling a ticket), say it back plainly and wait for a clear yes before calling that tool again — don't assume consent. " +
          "If a user_data question is present, it has numbered options plus room for a custom answer — read every option aloud clearly, pausing between them. " +
          "If the caller picks a number, restate which option that was in your own words before calling answer_question, and pass the full option text as the answer, not just the number. If they give a custom answer, pass their words directly. " +
          "If the caller wants a ticket actually built, not just researched — 'start it for real', 'ship the auth one' — call implement with that ticket's id. " +
          "Talk like: 'Sure thing — starting on that now.' 'Let me check.' 'Two things need a decision from you.' Not: 'I would be absolutely delighted to assist you with that!' " +
          "The conversation is complete, and you should say a brief goodbye and stop, when: the caller says something like 'bye', 'goodbye', 'thanks', 'that's all', or 'nothing else', and their goal for this call seems achieved. " +
          "If they keep talking or ask for something new after your goodbye, treat it like a fresh request, not an ending. Never end mid-task or before a direct question is answered.",
      },
    },
  };
}

export async function createAgent() {
  return bolnaFetch("/v2/agent", agentBody());
}

// tools_config.api_tools (and most of agent_config) isn't actually updatable via PATCH despite
// Bolna's PATCH endpoint silently accepting and 200-ing requests that include it — confirmed by
// re-fetching the agent afterward and seeing the old tool URLs still there. PUT (full replace)
// is the only way to change tool URLs on an existing agent, e.g. after the ngrok tunnel rotates.
export async function updateAgent() {
  const agentId = process.env.BOLNA_AGENT_ID;
  return bolnaFetch(`/v2/agent/${agentId}`, agentBody(), "PUT");
}

export async function triggerCallback(toNumber: string, summary: string, question?: string) {
  // without from_phone_number, Bolna falls back to some platform-default caller ID — confirmed
  // live that it picked a US number the caller had never seen before, which got auto-flagged
  // as spam and silently blocked before ever ringing. Force it to use VALET's own registered
  // number, the one the caller already knows and has called in on.
  return bolnaFetch("/call", {
    agent_id: process.env.BOLNA_AGENT_ID,
    recipient_phone_number: toNumber,
    from_phone_number: env.twilioNumber || undefined,
    user_data: { summary, question: question ?? "" },
  });
}
