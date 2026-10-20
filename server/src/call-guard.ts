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
