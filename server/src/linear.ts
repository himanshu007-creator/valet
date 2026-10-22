import { env } from "./env.ts";

export type Issue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number; // 0 none, 1 urgent, 2 high, 3 medium, 4 low
  dueDate: string | null;
  state: { id: string; name: string; type: string } | null;
  url: string;
};

const QUERY = `
  query {
    viewer {
      assignedIssues(filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
        nodes { id identifier title description priority dueDate state { id name type } url }
      }
    }
  }
`;

export async function fetchAssignedIssues(): Promise<Issue[]> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: env.linearApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`linear fetch failed: ${JSON.stringify(json.errors ?? json)}`);
  const issues: Issue[] = json.data.viewer.assignedIssues.nodes;
  return sortByPriorityAndDue(issues);
}

export async function postComment(issueId: string, body: string): Promise<void> {
  const mutation = `
    mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }
  `;
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: env.linearApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: mutation, variables: { issueId, body } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`linear comment failed: ${JSON.stringify(json.errors ?? json)}`);
}

let teamIdCache: string | null = null;
let viewerIdCache: string | null = null;

// single-user, single-team tool — cache for process lifetime, no env var needed.
async function getDefaultTeamId(): Promise<string> {
  if (teamIdCache) return teamIdCache;
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: env.linearApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `query { teams(first: 1) { nodes { id } } }` }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`linear teams fetch failed: ${JSON.stringify(json.errors ?? json)}`);
  const id = json.data.teams.nodes[0]?.id;
  if (!id) throw new Error("no Linear team found for this API key");
  teamIdCache = id;
  return id;
}

async function getViewerId(): Promise<string> {
  if (viewerIdCache) return viewerIdCache;
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: env.linearApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `query { viewer { id } }` }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`linear viewer fetch failed: ${JSON.stringify(json.errors ?? json)}`);
  viewerIdCache = json.data.viewer.id;
  return viewerIdCache!;
}

// self-assigned: fetchAssignedIssues() only ever returns viewer.assignedIssues, so a ticket
// VALET creates has to be assigned to the same user to be findable by every other journey.
export async function createIssue(title: string, description: string): Promise<Issue> {
  const [teamId, assigneeId] = await Promise.all([getDefaultTeamId(), getViewerId()]);
  const mutation = `
    mutation($teamId: String!, $assigneeId: String!, $title: String!, $description: String!) {
      issueCreate(input: { teamId: $teamId, assigneeId: $assigneeId, title: $title, description: $description }) {
        success
        issue { id identifier title description priority dueDate state { id name type } url }
      }
    }
  `;
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: env.linearApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: mutation, variables: { teamId, assigneeId, title, description } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors || !json.data.issueCreate.success) {
    throw new Error(`linear issueCreate failed: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data.issueCreate.issue;
}

// reversible — archived issues land in Linear's own Trash, restorable from there. Deliberately
// not issueDelete (permanent): a voice-triggered destructive action gets the undo-able option.
export async function archiveIssue(issueId: string): Promise<void> {
  const mutation = `
    mutation($issueId: String!) {
      issueArchive(id: $issueId) { success }
    }
  `;
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: env.linearApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: mutation, variables: { issueId } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors || !json.data.issueArchive.success) {
    throw new Error(`linear issueArchive failed: ${JSON.stringify(json.errors ?? json)}`);
  }
}

// Linear's workflow states are per-team and named freely ("In Progress", "Todo", etc.) but
// each has a stable `type`: unstarted | started | completed | canceled | triage. Fetched once
// and cached for process lifetime — shared by the type-based lookup below and the name-based one
// (e.g. "Awaiting inputs", which has no corresponding `type` in Linear's fixed enum).
let teamStatesCache: { id: string; name: string; type: string }[] | null = null;

async function fetchTeamStates(): Promise<{ id: string; name: string; type: string }[]> {
  if (teamStatesCache) return teamStatesCache;
  const teamId = await getDefaultTeamId();
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: env.linearApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($teamId: String!) { team(id: $teamId) { states { nodes { id name type } } } }`,
      variables: { teamId },
    }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`linear states fetch failed: ${JSON.stringify(json.errors ?? json)}`);
  teamStatesCache = json.data.team.states.nodes;
  return teamStatesCache!;
}

let stateIdsByType: Record<string, string> | null = null;

// a team can have more than one state of the same type (confirmed: "In Progress" and "In
// Review" both type "started") — prefer the one actually named this, falling back to
// whichever comes first, rather than picking an arbitrary one.
const PREFERRED_NAME: Partial<Record<string, string>> = { started: "in progress", unstarted: "todo", completed: "done" };

async function getStateId(type: "started" | "unstarted" | "completed"): Promise<string | null> {
  if (!stateIdsByType) {
    const states = await fetchTeamStates();
    stateIdsByType = {};
    const byType: Record<string, { id: string; name: string }[]> = {};
    for (const s of states) (byType[s.type] ??= []).push(s);
    for (const [t, group] of Object.entries(byType)) {
      const preferred = group.find((s) => s.name.toLowerCase() === PREFERRED_NAME[t]);
      stateIdsByType[t] = (preferred ?? group[0]).id;
    }
  }
  return stateIdsByType[type] ?? null;
}

// "blocked" has no corresponding entry in Linear's fixed 5-value type enum, so a state like
// "Awaiting inputs" can only be targeted by its literal name, not by type.
async function getStateIdByName(name: string): Promise<string | null> {
  const states = await fetchTeamStates();
  return states.find((s) => s.name.toLowerCase() === name.toLowerCase())?.id ?? null;
}

async function applyStateId(issueId: string, stateId: string): Promise<void> {
  const mutation = `
    mutation($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
    }
  `;
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: env.linearApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: mutation, variables: { issueId, stateId } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors || !json.data.issueUpdate.success) {
    throw new Error(`linear issueUpdate(state) failed: ${JSON.stringify(json.errors ?? json)}`);
  }
}

// Linear as the actual source of truth for "is this ticket being worked on" — a caller asking
// to start something already in a "started"-type state gets turned away before a duplicate job
// ever gets dispatched, not just an in-memory/DB check that only this process knows about.
export async function setIssueState(issueId: string, type: "started" | "unstarted" | "completed"): Promise<void> {
  const stateId = await getStateId(type);
  if (!stateId) return; // team has no state of this type configured — nothing sensible to set, skip rather than error
  await applyStateId(issueId, stateId);
}

// graceful by design: a state like "Awaiting inputs" is something the user configures in Linear
// themselves (Team Settings → Workflow, not Project statuses — the two are separate lists) —
// until it exists there, this just logs and leaves the ticket's state untouched rather than
// erroring the whole job report.
export async function setIssueStateByName(issueId: string, name: string): Promise<void> {
  const stateId = await getStateIdByName(name);
  if (!stateId) {
    console.warn(`linear: no issue workflow state named "${name}" found — add it under Team Settings → Workflow`);
    return;
  }
  await applyStateId(issueId, stateId);
}

export async function updateIssue(issueId: string, fields: { title?: string; description?: string }): Promise<void> {
  const mutation = `
    mutation($issueId: String!, $title: String, $description: String) {
      issueUpdate(id: $issueId, input: { title: $title, description: $description }) { success }
    }
  `;
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: env.linearApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: mutation, variables: { issueId, ...fields } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors || !json.data.issueUpdate.success) {
    throw new Error(`linear issueUpdate failed: ${JSON.stringify(json.errors ?? json)}`);
  }
}

export function sortByPriorityAndDue(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const pa = a.priority === 0 ? 5 : a.priority;
    const pb = b.priority === 0 ? 5 : b.priority;
    if (pa !== pb) return pa - pb;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });
}
