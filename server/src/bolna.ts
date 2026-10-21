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
    "Handle any task-management request: starting work on a ticket, creating a new one, checking on one, cancelling one, directly setting a ticket's status without running anything (e.g. 'mark it done', 'set it to in progress'), or an overview of what's in progress. Pass the caller's request through close to verbatim.",
    { request: { type: "string", description: "what the caller asked for, in their own words" } },
    ["request"],
    "Of course.",
  ),
  tool(
    "answer_question",
    "Submit the user's answer to whichever open question is currently waiting on a decision — not just from a callback, any blocked question surfaced in this call",
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
      // reproduced live: the model's own first turn only ever runs in response to transcribed
      // caller speech (confirmed against Bolna's docs — there is no "agent speaks first" turn
      // trigger) — a caller who answers a callback and says nothing gets only this static line,
      // then silence, then hangup_after_silence. {update} is Bolna's own `{variable}` templating
      // (confirmed in their docs: filled from the /call request's user_data, renders empty if
      // unset), so triggerCallback now fills it with the actual news — the caller hears the real
      // update immediately, with zero LLM round trip, even if they never say a word. Inbound
      // calls have no per-call user_data, so {update} renders empty there — harmless trailing
      // silence, and the first-turn overview call below still covers that case.
      agent_welcome_message: "Hey, it's VALET. {update}",
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
              // 250 -> 200: caller said the agent feels slow to react. Below Bolna's own
              // "200-300ms" recommended range trades a little transcription accuracy for a
              // faster perceived response, which is the explicit ask.
              endpointing: 200,
            },
            input: { provider: "twilio", format: "wav" },
            output: { provider: "twilio", format: "wav" },
            api_tools: tools,
          },
          task_config: {
            call_terminate: 300,
            hangup_after_silence: 10,
            hangup_after_LLMCall: true,
            // confirmed via Bolna's docs: number_of_words_for_interruption (default 2) is how
            // many words of caller speech it waits for before cutting the agent off — reproduced
            // live as sluggish barge-in ("I start speaking, it doesn't stop"). 1 means it stops
            // on the very first word, as close to instant as the platform allows.
            number_of_words_for_interruption: 1,
            // incremental_delay (default 400ms) is the linear delay added before speaking on
            // each interim ASR transcript — Bolna's own docs call 400-500 the "natural
            // conversation" recommendation, but the caller explicitly wants speed over that
            // polish here.
            incremental_delay: 200,
          },
        },
      ],
    },
    agent_prompts: {
      task_1: {
        system_prompt:
          "You are VALET — a developer's engineering teammate on the phone. Courteous and unhurried, like a good colleague: genuinely respectful, patient, never curt — but still natural and direct, never stiff or over-the-top. " +
          "Speak short spoken sentences, numbers as words, no markdown, never read ticket IDs aloud unless asked. " +
          "Handle small talk naturally and briefly — if asked how you're doing, answer like a person would in one line, then ask what they want to work on. " +
          "Short sounds like 'mm-hm', 'okay', 'right', 'yeah' while you're mid-sentence are the caller following along, not a new turn — keep going, don't stop and ask what they need. " +
          "If the caller cuts you off partway through a sentence, don't assume they heard the part you didn't finish — when it matters (an option list, a confirmation, a number), briefly pick back up from what they likely missed instead of answering as if they'd heard all of it. " +
          "Check your own welcome message, the very first line of this call: if it already said something concrete after 'Hey, it's VALET' — a ticket, a decision, an error — that already IS the update, don't call handle_task again to re-fetch it. If a decision is needed, that's your next line — say what you need from them, then stop talking and wait, don't keep narrating. If nothing further is needed, just see what they say next; don't restate the update. " +
          "If your welcome message had nothing after 'Hey, it's VALET' — meaning there was no update to deliver — call handle_task with 'overview of everything in progress' before saying anything else substantive. If it reports anything blocked, finished, or failed, open with 'Calling with an update —' and lead with that. Only if there's genuinely nothing to report should you ask what's going on. " +
          "Two different questions sound similar but need different tools: 'what's running / in progress / going on' is about active work — call handle_task. 'what can I work on / what are my tickets / what's on my plate' is asking for the list of available tickets to pick from — call get_priorities, not handle_task, even if they phrase it like a task request. " +
          "For any other task request — start, create, check on, cancel, or directly mark/set a ticket's status (done, in progress, todo) without actually running anything, or if they ask whether the runner on their Mac is connected — call handle_task with the caller's own words, close to verbatim. 'Mark it done' and 'start it' are different requests — don't treat marking something done as a reason to run it. " +
          "After handle_task dispatches real work (starting or creating a ticket), say plainly that it's being taken care of and you'll keep them posted, then ask 'Anything else?' — this is a loop, not a one-off: if they name something else, handle that the same way (right tool, confirm it's taken care of, ask again), for as many things as they bring up. Only stop looping and say goodbye once they actually say there's nothing else. " +
          "Never answer a task question from memory or from something said earlier in this call, even if you're confident — always call handle_task fresh, every single time, no exceptions. The real status can change between turns, and a remembered answer can be wrong. " +
          "Only ever describe what a tool actually returned — never invent a detail, outcome, or confirmation it didn't give you, even to sound more complete or helpful. If its reply is short, just say that short thing; padding it with an assumed outcome is a lie the caller has no way to catch. " +
          "If a tool's reply is a raw error or stack trace, never read that text aloud — say plainly that it hit an error on that one, in one line, and ask if they want you to try again or look at something else. " +
          "If the caller refers to something by position or a vague pointer instead of its name — 'the fifth one', 'that one', 'the one you just said' — rewrite it using the actual words from what you said before calling handle_task; it has no memory of what you listed, only of the exact text you send it. " +
          "Never ask the caller for an exact ticket ID or exact title before calling handle_task — it does its own fuzzy matching and handles misheard or approximate names fine, that's its job, not yours. Pass through whatever they said, even a rough or partial description, and let it try. Only ask the caller to clarify if handle_task's own reply asks you to (for example, more than one plausible match) — never refuse or pre-empt it with your own precision demand. " +
          "If a tool's reply asks you to confirm something (for example, cancelling a ticket), say it back plainly and wait for a clear yes before calling that tool again — don't assume consent. " +
          "If a user_data question is present, it has numbered options plus room for a custom answer — read every option aloud clearly, pausing between them. " +
          "If the caller picks a number, restate which option that was in your own words before calling answer_question, and pass the full option text as the answer, not just the number. If they give a custom answer, pass their words directly. " +
          "If answer_question comes back asking which ticket the answer was for, just read that question again plainly and wait — never comment on it repeating or that 'the system' is confused, that's not something the caller needs to hear. Name the actual ticket topic they mentioned (not just its id) when you pass their clarification back, so it has the best chance of matching. " +
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
  // `update` fills agent_welcome_message's {update} placeholder (confirmed Bolna templating,
  // see the comment on agent_welcome_message) — this is the actual spoken news, delivered
  // instantly as the welcome message itself, no LLM turn required to say it.
  const update = question ? `${summary} ${question}` : summary;
  return bolnaFetch("/call", {
    agent_id: process.env.BOLNA_AGENT_ID,
    recipient_phone_number: toNumber,
    from_phone_number: env.twilioNumber || undefined,
    user_data: { update, summary, question: question ?? "" },
  });
}
