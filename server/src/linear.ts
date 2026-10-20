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
