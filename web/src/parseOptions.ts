// matches the consistent "(1) X. (2) Y. Or tell me what you'd prefer." shape every blocked
// question/confirmation is phrased in — gives real buttons when it parses, a free-text box
// underneath always works regardless. Shared by JobCard's blocked-answer form and TaskList's
// tap-to-act confirmation prompts, which hit the exact same reply shapes via toolHandleTask.
export function parseOptions(question: string): string[] {
  const matches = [...question.matchAll(/\((\d+)\)\s*([^()]+?)(?=\s*\(\d+\)|\s*Or tell me|$)/g)];
  return matches.map((m) => m[2].trim().replace(/\.$/, "")).filter(Boolean);
}

// heuristic for "this reply is asking me something, not just reporting a result" — every
// pendingDelete/pendingCreate/pendingExecute confirmation from toolHandleTask ends in a question.
export function needsReply(message: string): boolean {
  return message.trim().endsWith("?");
}
