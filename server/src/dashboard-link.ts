import type { WebSocket } from "ws";
import { sql } from "./db.ts";
import { runnerConnected } from "./runner-link.ts";

const clients = new Set<WebSocket>();

// cheapest, already-correct "is the user looking at this right now" signal — a connection here
// means an authenticated (requireAuth-gated) tab has /app open with its live socket connected,
// and desk mode can't be open without this also being true (same mount). Used to decide
// call-vs-notify: a real-time update already appearing live makes a phone call on top pure noise.
export function dashboardClientCount(): number {
  return clients.size;
}

export function addDashboardClient(ws: WebSocket) {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  getStatus().then((payload) => ws.send(JSON.stringify(payload)));
}

export async function getStatus() {
  const [order] = await sql`select id, tickets, created_at from orders order by created_at desc limit 1`;
  const runnerOnline = runnerConnected();
  if (!order) return { type: "status", order: null, runnerOnline };
  const jobs = await sql`
    select id, ticket_id, title, description, status, pr_url, doc_url, ticket_url, question, answer
    from jobs where order_id = ${order.id} order by ticket_id
  `;
  return { type: "status", order: { id: order.id, createdAt: order.created_at, jobs }, runnerOnline };
}

export async function getOrderHistory() {
  const orders = await sql`select id, tickets, created_at from orders order by created_at desc limit 50`;
  const jobs = await sql`
    select id, order_id, ticket_id, title, description, status, pr_url, doc_url, ticket_url, question, answer, started_at, finished_at
    from jobs order by ticket_id
  `;
  return orders.map((order) => ({
    id: order.id,
    createdAt: order.created_at,
    jobs: jobs.filter((j) => j.order_id === order.id),
  }));
}

export async function broadcastStatus() {
  if (clients.size === 0) return;
  const payload = JSON.stringify(await getStatus());
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// lets the Today tab see the desk voice agent's tool calls as they happen — reuses this same
// authenticated socket rather than a second transport, and a distinct `type` keeps it from
// colliding with the "status" message shape above.
export function broadcastDeskEvent(event: { kind: "tool_call" | "tool_result"; name: string; args?: unknown; result?: string }) {
  if (clients.size === 0) return;
  const payload = JSON.stringify({ type: "desk_event", ...event });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}
