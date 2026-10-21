import { env } from "./env.ts";

// Single-user MVP (§3.7 of the plan): track the one call in flight and gate phone tool calls
// on it. Bolna's tool-call requests carry no caller identity of their own, only the webhook
// does, so this is the only place that identity is available to check against.
let currentCallerAllowed: boolean | null = null;

export function onCallStarted(fromNumber: string | undefined) {
  if (!env.allowedCallerNumber) {
    currentCallerAllowed = true; // no allow-list configured: open
    return;
  }
  currentCallerAllowed = fromNumber === env.allowedCallerNumber;
}

export function isCallerAllowed(): boolean {
  return currentCallerAllowed !== false;
}

// reproduced live: a job that finished/failed *during* an active call triggered its own
// outbound callback, overlapping with the call the caller was already on. One call at a time —
// a terminal event during an active call gets pushed + commented on Linear same as always, it
// just doesn't also ring the phone that's already ringing. callActiveUntil is a safety-net
// expiry (slightly past Bolna's own call_terminate ceiling) in case the end-webhook is ever
// missed, so a stuck "active" flag can never permanently block real callbacks.
let callActiveUntil = 0;
const CALL_SAFETY_NET_MS = 6 * 60 * 1000; // call_terminate is 300s; this is that plus a buffer

export function onCallActiveStatus() {
  callActiveUntil = Date.now() + CALL_SAFETY_NET_MS;
}

export function onCallEnded() {
  callActiveUntil = 0;
}

export function isCallActive(): boolean {
  return Date.now() < callActiveUntil;
}
