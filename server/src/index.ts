import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { env } from "./env.ts";
import { prefetchPriorities } from "./cache.ts";
import { setRunnerSocket } from "./runner-link.ts";
import { addDashboardClient, getStatus, getOrderHistory } from "./dashboard-link.ts";
import { toolGetPriorities, toolOrder, toolGetStatus, toolAnswerQuestion, toolImplement } from "./tools.ts";
import { registerDeskRoutes } from "./desk.ts";
import { registerAuthRoutes, requireAuth } from "./auth.ts";
import { onCallStarted, isCallerAllowed } from "./call-guard.ts";
import { timed, getStats } from "./stats.ts";
import { sql } from "./db.ts";

const app = Fastify({ logger: true });
await app.register(websocket);
await app.register(cookie);
// credentialed cookies need a real origin echoed back, "*" is rejected by browsers once
// credentials are involved. ALLOWED_WEB_ORIGINS is a comma list for prod (the Vercel domain);
// any localhost origin is always allowed so local dev doesn't need it set.
const allowedOrigins = (process.env.ALLOWED_WEB_ORIGINS ?? "").split(",").filter(Boolean);
await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin || /^https?:\/\/localhost(:\d+)?$/.test(origin) || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("origin not allowed"), false);
  },
  credentials: true,
});

// Bolna POSTs application/json with an empty body for tools that take no parameters.
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  if (!body) return done(null, {});
  try {
    done(null, JSON.parse(body as string));
  } catch (err) {
    done(err as Error, undefined);
  }
});

app.get("/healthz", async () => ({ ok: true }));

registerAuthRoutes(app);

app.get("/api/priorities", { preHandler: requireAuth }, async () => {
  return { summary: await toolGetPriorities() };
});

app.get("/api/status", { preHandler: requireAuth }, async () => getStatus());

app.get("/api/stats", { preHandler: requireAuth }, async () => getStats());

app.get("/api/orders", { preHandler: requireAuth }, async () => ({ orders: await getOrderHistory() }));

app.get("/api/push/vapid-public-key", { preHandler: requireAuth }, async () => ({ key: env.vapidPublicKey }));

app.post("/api/push/subscribe", { preHandler: requireAuth }, async (req) => {
  // single-account tool — this is the one user row, no need to look up who's asking.
  await sql`update users set push_subscription = ${JSON.stringify(req.body)}`;
  return { ok: true };
});

app.get("/ws/runner", { websocket: true }, (socket, req) => {
  const token = new URL(req.url, "http://x").searchParams.get("token");
  if (token !== env.runnerToken) {
    socket.close(4001, "bad token");
    return;
  }
  setRunnerSocket(socket);
  app.log.info("runner connected");
});

app.get("/ws/dashboard", { websocket: true, preHandler: requireAuth }, (socket) => {
  addDashboardClient(socket);
});

const PRIVATE_NUMBER_MESSAGE = "This number is private.";

app.post("/tools/get_priorities", async () => {
  if (!isCallerAllowed()) return { message: PRIVATE_NUMBER_MESSAGE };
  return { message: await timed("get_priorities", toolGetPriorities) };
});

app.post("/tools/order", async (req) => {
  if (!isCallerAllowed()) return { message: PRIVATE_NUMBER_MESSAGE };
  const { tickets } = req.body as { tickets?: string };
  return { message: await timed("order", () => toolOrder(tickets ?? "")) };
});

app.post("/tools/get_status", async () => {
  if (!isCallerAllowed()) return { message: PRIVATE_NUMBER_MESSAGE };
  return { message: await timed("get_status", toolGetStatus) };
});

app.post("/tools/answer_question", async (req) => {
  if (!isCallerAllowed()) return { message: PRIVATE_NUMBER_MESSAGE };
  const { answer } = req.body as { answer?: string };
  return { message: await timed("answer_question", () => toolAnswerQuestion(answer ?? "")) };
});

app.post("/tools/implement", async (req) => {
  if (!isCallerAllowed()) return { message: PRIVATE_NUMBER_MESSAGE };
  const { ticket_id } = req.body as { ticket_id?: string };
  return { message: await timed("implement", () => toolImplement(ticket_id ?? "")) };
});

app.register(async (desk) => {
  desk.addHook("preHandler", requireAuth);
  registerDeskRoutes(desk);
});

const CALL_STARTED_STATUSES = new Set(["ringing", "initiated", "in-progress"]);

app.post("/hooks/bolna", async (req) => {
  const body = req.body as { status?: string; user_number?: string };
  if (body.status && CALL_STARTED_STATUSES.has(body.status)) {
    onCallStarted(body.user_number);
    prefetchPriorities();
  }
  app.log.info({ status: body.status }, "bolna webhook");
  return { ok: true };
});

app.listen({ port: env.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
