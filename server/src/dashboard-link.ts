import type { WebSocket } from "ws";
import { sql } from "./db.ts";

const clients = new Set<WebSocket>();

export function addDashboardClient(ws: WebSocket) {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  getStatus().then((payload) => ws.send(JSON.stringify(payload)));
}

export async function getStatus() {
  const [order] = await sql`select id, tickets, created_at from orders order by created_at desc limit 1`;
  if (!order) return { type: "status", order: null };
  const jobs = await sql`
    select id, ticket_id, title, status, pr_url, question, answer
    from jobs where order_id = ${order.id} order by ticket_id
  `;
  return { type: "status", order: { id: order.id, createdAt: order.created_at, jobs } };
}

export async function getOrderHistory() {
  const orders = await sql`select id, tickets, created_at from orders order by created_at desc limit 50`;
  const jobs = await sql`
    select id, order_id, ticket_id, title, status, pr_url, question, answer, started_at, finished_at
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
