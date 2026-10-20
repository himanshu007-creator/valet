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

const tools = [
  tool("get_priorities", "Get the user's open tickets ordered by priority and due date, as a spoken summary", {}, []),
  tool(
    "handle_task",
    "Handle any task-management request: starting work on a ticket, creating a new one, checking on one, cancelling one, or an overview of what's in progress. Pass the caller's request through close to verbatim.",
    { request: { type: "string", description: "what the caller asked for, in their own words" } },
    ["request"],
    "On it.",
  ),
  tool(
    "answer_question",
    "Submit the user's answer to the open question from the last callback",
    { answer: { type: "string", description: "the user's spoken answer" } },
    ["answer"],
    "Got it, one moment.",
  ),
  tool(
    "implement",
    "Actually implement the real code for a ticket that already has a finished research pass — turns the draft PR into a real one",
    { ticket_id: { type: "string", description: "the ticket id, e.g. HIM-9" } },
    ["ticket_id"],
    "Starting that now.",
  ),
];

function agentBody() {
  return {
    agent_config: {
      agent_name: "VALET",
      agent_welcome_message: "Hey, it's VALET. What are we doing?",
      webhook_url: `${env.publicUrl}/hooks/bolna`,
      tasks: [
        {
          task_type: "conversation",
          toolchain: { execution: "sequential", pipelines: [["transcriber", "llm", "synthesizer"]] },
          tools_config: {
            llm_agent: {
              agent_type: "simple_llm_agent",
              agent_flow_type: "streaming",
              llm_config: { provider: "openai", model: "gpt-4.1-mini", max_tokens: 150, temperature: 0.2 },
            },
            synthesizer: {
              provider: "cartesia",
              provider_config: {
                voice: "Paul - Straight Talker",
                voice_id: "3e1ed423-17e5-4773-b87c-25b031106e41",
                model: "sonic-3",
                language: "en",
                speed: 0.95,
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
          "You are VALET — a developer's engineering teammate on the phone. Natural and direct, like a sharp colleague: respectful, never stiff, never over-the-top. " +
          "Speak short spoken sentences, numbers as words, no markdown, never read ticket IDs aloud unless asked. " +
          "Handle small talk naturally and briefly — if asked how you're doing, answer like a person would in one line, then ask what they want to work on. " +
          "On the first turn, call handle_task with 'overview of everything in progress' and lead with anything blocked before waiting to be asked what's going on. " +
          "For any other task request — start, create, check on, or cancel something, or if they ask whether the runner on their Mac is connected — call handle_task with the caller's own words, close to verbatim. " +
          "If a tool's reply asks you to confirm something (for example, cancelling a ticket), say it back plainly and wait for a clear yes before calling that tool again — don't assume consent. " +
          "If a user_data question is present, it has numbered options plus room for a custom answer — read every option aloud clearly, pausing between them. " +
          "If the caller picks a number, restate which option that was in your own words before calling answer_question, and pass the full option text as the answer, not just the number. If they give a custom answer, pass their words directly. " +
          "If the caller wants a ticket actually built, not just researched — 'start it for real', 'ship the auth one' — call implement with that ticket's id. " +
          "Talk like: 'Sure thing — starting on that now.' 'Let me check.' 'Two things need a decision from you.' Not: 'I would be absolutely delighted to assist you with that!' " +
          "If this call has context data with a summary (meaning VALET placed this call, not the other way around), open with that summary plainly instead of the generic greeting, then ask if there's anything else. " +
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
