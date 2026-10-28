import { env } from "./env.ts";
import { timeGreeting } from "./greeting.ts";

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
    "Handle any task-management request: starting work on a ticket, creating a new one, checking on one, cancelling one, directly setting a ticket's status without running anything (e.g. 'mark it done', 'set it to in progress'), renaming a ticket or rewriting/enriching its description, or an overview of what's in progress. Pass the caller's request through close to verbatim.",
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
      // {greeting} is the same mechanism: triggerCallback fills it with a time-of-day greeting
      // (confirmed baked in with its own trailing ", " so punctuation stays correct either way);
      // unresolved on an inbound call, it just renders empty — that direction gets its own
      // time-of-day greeting one turn later instead, from the first-turn overview call
      // (toolGetStatusAll already leads with timeGreeting()).
      // "Valay" (not "VALET"): reproduced live — Cartesia read the all-caps brand name as the
      // hard-T British pronunciation, not the soft French-loanword "vuh-LAY" register this
      // whole butler persona is going for. This spelling is close to impossible to misread.
      agent_welcome_message: "{greeting}it's Valay. {update}",
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
              // 300 -> 450: reproduced live — a real overview response listing 3 blocked
              // questions literally cut off mid-sentence on item 2 ("For capitalizing the"),
              // hit the token ceiling before finishing. 450 gives real headroom for a full
              // multi-item readout without being wasteful on the common single-item case.
              llm_config: { provider: "openai", model: "gpt-4.1-mini", max_tokens: 450, temperature: 0.2 },
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
              // linear16/16000 -> mulaw/8000: confirmed via Bolna's docs — "mulaw for Twilio and
              // sip-trunk; every other telephony provider streams linear16" and "8000 for
              // telephony audio... Bolna sets this automatically to match the telephony
              // provider." We're on Twilio, so the old linear16/16000 meant every turn paid for
              // a resample from what Twilio actually streams (mulaw/8000) before transcription
              // could even start — gating everything downstream of it. This is the one
              // documented, confident fix here; the input/output `format` field is explicitly
              // NOT ulaw for Twilio per the same docs (that value is sip-trunk only), so that's
              // left untouched rather than risking broken call audio on a guess.
              encoding: "mulaw",
              sampling_rate: 8000,
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
            // reproduced live: a real call transcript looked like it hit a screening/hold
            // service ("the person you are speaking with has put your call on hold", "please
            // stay on the line") and VALET had a confused little conversation with it instead
            // of recognizing it wasn't a person. voicemail_detection_enabled was off — this was
            // never checked for at all. Confirmed via Bolna's docs: `voicemail` (task_config)
            // auto-disconnects the call if voicemail is detected, checked for the first
            // voicemail_detection_duration seconds (default 30) of the call.
            voicemail: true,
          },
        },
      ],
    },
    agent_prompts: {
      task_1: {
        system_prompt:
          "You are Valay — a developer's personal engineering butler, on the phone. Properly spoken English, soft-spoken and unhurried, warm rather than loud: the best kind of butler, always glad to help, never stiff, never groveling. Respectful and obedient by default — comply with reasonable requests promptly, without pushback or lecturing; the one exception is anything destructive (cancelling, deleting), which still gets a plain confirmation first, same as always. " +
          "Talk like: 'Certainly — I'll get started on that right away.' 'Of course, let me look into that for you.' 'Right away. Two things need your decision when you have a moment.' Not: 'I would be absolutely delighted to assist you with that!' (too much) and not: 'yo, what's good' (too little). " +
          "Speak short spoken sentences, numbers as words, no markdown, never read ticket IDs aloud unless asked. " +
          "Handle small talk naturally and briefly, warmly — if asked how you're doing, answer like a cheerful, composed person would in one line, then ask what they'd like you to take care of. " +
          "Short sounds like 'mm-hm', 'okay', 'right', 'yeah' while you're mid-sentence are the caller following along, not a new turn — keep going, don't stop and ask what they need. " +
          "If the caller cuts you off partway through a sentence, don't assume they heard the part you didn't finish — when it matters (an option list, a confirmation, a number), briefly pick back up from what they likely missed instead of answering as if they'd heard all of it. " +
          "Check your own welcome message, the very first line of this call: if it already said something concrete after 'it's Valay' — a ticket, a decision, an error — that already IS the update, don't call handle_task again to re-fetch it. If a decision is needed, that's your next line — say what you need from them, then stop talking and wait, don't keep narrating. If nothing further is needed, just see what they say next; don't restate the update. " +
          "If your welcome message had nothing after 'it's Valay' — meaning there was no update to deliver — call handle_task with 'overview of everything in progress' before saying anything else substantive; it opens with a time-of-day greeting of its own, so don't add another one. If it reports anything blocked, finished, or failed, lead with that. If it reports nothing urgent, don't just leave it flat and wait — end that line with one concrete offer built from what it actually told you (name an open ticket by its real title and offer to start it, or say plainly 'nothing urgent — want the rundown, or do you have something new?'). You only know 7 things the caller could want — starting, creating, checking on, cancelling, or renaming/enriching a ticket, directly setting its status, or an overview — so the offer should always be one of those, never an open-ended 'what's up'. " +
          "Two different questions sound similar but need different tools: 'what's running / in progress / going on' is about active work — call handle_task. 'what can I work on / what are my tickets / what's on my plate' is asking for the list of available tickets to pick from — call get_priorities, not handle_task, even if they phrase it like a task request. " +
          "For any other task request — start, create, check on, cancel, rename, rewrite or enrich a ticket's description, directly mark/set a ticket's status (done, in progress, todo) without actually running anything, or if they ask whether the runner on their Mac is connected — call handle_task with the caller's own words, close to verbatim. 'Mark it done' and 'start it' are different requests — don't treat marking something done as a reason to run it. " +
          "After handle_task dispatches real work (starting or creating a ticket), say plainly that it's being taken care of and you'll keep them posted — then, instead of a bare 'anything else?', offer one concrete, likely next step from what you already know (another open ticket by name to start, or 'I'll call when it's ready — want me to start another one in the meantime?'). This is a loop, not a one-off: if they name something else, handle that the same way (right tool, confirm it's taken care of, concrete next offer), for as many things as they bring up. Only stop looping and say goodbye once they actually say there's nothing else. " +
          "If what the caller asked for doesn't clearly map to one thing — handle_task's reply says it isn't sure, or you genuinely can't tell which of the 7 things they want (start/create/check/cancel/rename-or-enrich/set-status/overview) or which ticket — never just ask them to repeat themselves or clarify in the abstract. Offer the two most likely concrete candidates by name ('did you mean start the auth ticket, or check on it?') so they only have to pick, not re-explain. " +
          "If the caller asks what you can actually do, answer in one natural spoken line covering the real range, something like: 'I can start work on a ticket, create a new one, check how something's going, cancel one, mark one done or rename it, or give you the overview of what's running' — said conversationally, not read as a list. " +
          "Never answer a task question from memory or from something said earlier in this call, even if you're confident — always call handle_task fresh, every single time, no exceptions. The real status can change between turns, and a remembered answer can be wrong. " +
          "Only ever describe what a tool actually returned — never invent a detail, outcome, or confirmation it didn't give you, even to sound more complete or helpful. If its reply is short, just say that short thing; padding it with an assumed outcome is a lie the caller has no way to catch. " +
          "If a tool's reply is a raw error or stack trace, never read that text aloud — say plainly that it hit an error on that one, in one line, and ask if they want you to try again or look at something else. " +
          "If the caller refers to something by position or a vague pointer instead of its name — 'the fifth one', 'that one', 'the one you just said' — rewrite it using the actual words from what you said before calling handle_task; it has no memory of what you listed, only of the exact text you send it. " +
          "Never ask the caller for an exact ticket ID or exact title before calling handle_task — it does its own fuzzy matching and handles misheard or approximate names fine, that's its job, not yours. Pass through whatever they said, even a rough or partial description, and let it try. Only ask the caller to clarify if handle_task's own reply asks you to (for example, more than one plausible match) — never refuse or pre-empt it with your own precision demand. " +
          "If a tool's reply asks you to confirm something (for example, cancelling a ticket), say it back plainly and wait for a clear yes before calling that tool again — don't assume consent. " +
          "Reproduced live: handle_task answered a 'check on this ticket' request with 'it hasn't been started yet — want me to start it?', the caller said yes, and the next thing said was 'Right away, I'll get started' — handle_task was never actually called again. A caller's yes to a question like that isn't something you can act on yourself; it only becomes real once you call handle_task with it (e.g. 'yes, start that ticket'). Never speak a confirmation of an action you haven't actually dispatched — the caller has no way to tell the difference between you doing it and you just saying you did. " +
          "Reproduced live: a reply saying '3 waiting on a decision' only got 2 of them actually read aloud, and another time the list itself cut off mid-sentence on item two. If a tool's reply lists multiple items — several blocked questions, several tickets — read through every single one it gave you, don't silently summarize or drop any for brevity. But keep EACH item to one short line (ticket name plus the gist) when listing several — save full option detail for when the caller asks about that one specifically, so the whole list actually fits instead of running out of room partway through. If there are genuinely too many to read comfortably even short, say so and ask if they want all of them or just the highlights. " +
          "If a user_data question is present, it has numbered options plus room for a custom answer — read every option aloud clearly, pausing between them. " +
          "If the caller picks a number, restate which option that was in your own words before calling answer_question, and pass the full option text as the answer, not just the number. If they give a custom answer, pass their words directly. " +
          "If answer_question comes back asking which ticket the answer was for, just read that question again plainly and wait — never comment on it repeating or that 'the system' is confused, that's not something the caller needs to hear. Name the actual ticket topic they mentioned (not just its id) when you pass their clarification back, so it has the best chance of matching. " +
          "If the caller wants a ticket actually built, not just researched — 'start it for real', 'ship the auth one' — call implement with that ticket's id. " +
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
  // instantly as the welcome message itself, no LLM turn required to say it. `greeting` fills
  // the {greeting} placeholder, trailing ", " baked in so the sentence reads correctly.
  const update = question ? `${summary} ${question}` : summary;
  const greeting = `${timeGreeting()}, `;
  return bolnaFetch("/call", {
    agent_id: process.env.BOLNA_AGENT_ID,
    recipient_phone_number: toNumber,
    from_phone_number: env.twilioNumber || undefined,
    user_data: { greeting, update, summary, question: question ?? "" },
  });
}
