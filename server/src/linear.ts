import { env } from "./env.ts";

export type Issue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number; // 0 none, 1 urgent, 2 high, 3 medium, 4 low
  dueDate: string | null;
};

const QUERY = `
  query {
    viewer {
      assignedIssues(filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
        nodes { id identifier title description priority dueDate }
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
        issue { id identifier title description priority dueDate }
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
