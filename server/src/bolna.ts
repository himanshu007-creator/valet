import { env } from "./env.ts";

const BASE = "https://api.bolna.ai";

async function bolnaFetch(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
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
function tool(name: string, description: string, properties: Record<string, { type: string; description: string }>, required: string[]) {
  return {
    name,
    description,
    parameters: { type: "object", properties, required },
    key: "custom_task",
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
    "order",
    "Start implementation-doc work on the given tickets",
    { tickets: { type: "string", description: "comma-separated ticket ids, e.g. HIM-9,HIM-10" } },
    ["tickets"],
  ),
  tool("get_status", "Get the status of in-progress or recent ticket jobs", {}, []),
  tool(
    "answer_question",
    "Submit the user's answer to a job's open question",
    {
      job_id: { type: "string", description: "the job id the question belongs to" },
      answer: { type: "string", description: "the user's spoken answer" },
    },
    ["job_id", "answer"],
  ),
];

export async function createAgent() {
  return bolnaFetch("/v2/agent", {
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
                voice: "Ronald - Thinker",
                voice_id: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
                model: "sonic-3",
                language: "en",
                speed: 0.8,
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
          task_config: { call_terminate: 300, hangup_after_silence: 10 },
        },
      ],
    },
    agent_prompts: {
      task_1: {
        system_prompt:
          "You are VALET, the developer's concierge for their coding agents. Speak short, spoken sentences, numbers as words, never read ticket IDs aloud unless asked. " +
          "Use get_priorities to read open tickets when asked what's on today. Confirm an order in one line before calling the order tool. " +
          "If a user_data question is present, ask it and call answer_question with the reply. End calls cleanly.",
      },
    },
  });
}

export async function triggerCallback(toNumber: string, summary: string, question?: string) {
  return bolnaFetch("/call", {
    agent_id: process.env.BOLNA_AGENT_ID,
    recipient_phone_number: toNumber,
    user_data: { summary, question: question ?? "" },
  });
}
