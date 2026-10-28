import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { env, isAllowedOrigin } from "./env.ts";
import { prefetchPriorities } from "./cache.ts";
import { setRunnerSocket, catchUpIfNeeded } from "./runner-link.ts";
import { addDashboardClient, getStatus, getOrderHistory, broadcastStatus } from "./dashboard-link.ts";
import { toolGetPriorities, toolHandleTask, toolAnswerQuestion, toolImplement, toolOrder, recordAnswer } from "./tools.ts";
import { getCachedIssues } from "./cache.ts";
import { registerDeskRoutes } from "./desk.ts";
import { registerAuthRoutes, requireAuth } from "./auth.ts";
import { onCallStarted, isCallerAllowed, onCallActiveStatus, onCallEnded } from "./call-guard.ts";
import { timed, getStats } from "./stats.ts";
import { wsRunnerRateLimit, recordWsRunnerFailure } from "./rate-limit.ts";
import { sql } from "./db.ts";

const app = Fastify({ logger: true });
await app.register(websocket);
await app.register(cookie);
// credentialed cookies need a real origin echoed back, "*" is rejected by browsers once
// credentials are involved. ALLOWED_WEB_ORIGINS is a comma list for prod (the Vercel domain);
// any localhost origin is always allowed so local dev doesn't need it set.
await app.register(cors, {
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
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

// structured tickets for the Today tab's tap-to-act task list — same cache toolGetPriorities
// already reads, just not collapsed down to prose first.
app.get("/api/tasks", { preHandler: requireAuth }, async () => ({ tasks: await getCachedIssues() }));

// the in-app equivalent of the voice `handle_task` tool — same function, so every intent,
// confirmation (pendingDelete/pendingCreate/pendingExecute), and dispatch path it already has
// works here for free, with nothing new to maintain per action.
app.post("/api/handle_task", { preHandler: requireAuth }, async (req, reply) => {
  const { request } = req.body as { request?: string };
  if (!request) return reply.code(400).send({ error: "request required" });
  return { message: await toolHandleTask(request) };
});

app.get("/api/stats", { preHandler: requireAuth }, async () => getStats());

app.get("/api/orders", { preHandler: requireAuth }, async () => ({ orders: await getOrderHistory() }));

app.get("/api/push/vapid-public-key", { preHandler: requireAuth }, async () => ({ key: env.vapidPublicKey }));

app.post("/api/push/subscribe", { preHandler: requireAuth }, async (req) => {
  // single-account tool — this is the one user row, no need to look up who's asking.
  await sql`update users set push_subscription = ${JSON.stringify(req.body)}`;
  return { ok: true };
});

// in-app resolution for a blocked/failed job — the dashboard already knows exactly which card
// this is, so unlike the voice path there's no disambiguation to do at all, which makes this
// strictly more reliable than answering by phone for the same job.
app.post("/api/jobs/:id/answer", { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const { answer } = req.body as { answer?: string };
  if (!answer) return reply.code(400).send({ error: "answer required" });
  const [job] = await sql`select id from jobs where id = ${id} and status = 'blocked'`;
  if (!job) return reply.code(404).send({ error: "no blocked job with that id" });
  const message = await recordAnswer(id, answer);
  return { message };
});

app.post("/api/jobs/:id/retry", { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const [job] = await sql`select ticket_id from jobs where id = ${id} and status in ('failed', 'timeout')`;
  if (!job) return reply.code(404).send({ error: "no failed/timed-out job with that id" });
  const message = await toolOrder(job.ticket_id);
  return { message };
});

app.post("/api/jobs/:id/dismiss", { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const result = await sql`update jobs set delivered_at = now() where id = ${id} and status in ('done', 'failed', 'timeout') returning id`;
  if (result.length === 0) return reply.code(404).send({ error: "no terminal job with that id" });
  broadcastStatus();
  return { ok: true };
});

app.get("/ws/runner", { websocket: true }, (socket, req) => {
  const ip = req.ip;
  const limit = wsRunnerRateLimit(ip);
  if (!limit.allowed) {
    app.log.warn({ ip }, "runner ws: rate-limited after repeated bad tokens");
    socket.close(4003, "too many attempts");
    return;
  }

  const token = new URL(req.url, "http://x").searchParams.get("token");
  // constant-time compare — a plain !== leaks timing information about how many leading
  // characters matched, which a patient attacker can use to recover the token byte by byte.
  const tokenBuf = Buffer.from(token ?? "");
  const expectedBuf = Buffer.from(env.runnerToken);
  const match = tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf);
  if (!match) {
    recordWsRunnerFailure(ip);
    app.log.warn({ ip }, "runner ws: rejected bad token");
    socket.close(4001, "bad token");
    return;
  }

  setRunnerSocket(socket);
  app.log.info({ ip }, "runner connected");
});

app.get("/ws/dashboard", { websocket: true, preHandler: requireAuth }, (socket) => {
  addDashboardClient(socket);
});

const PRIVATE_NUMBER_MESSAGE = "This number is private.";

app.post("/tools/get_priorities", async () => {
  if (!isCallerAllowed()) return { message: PRIVATE_NUMBER_MESSAGE };
  return { message: await timed("get_priorities", toolGetPriorities) };
});

app.post("/tools/handle_task", async (req) => {
  if (!isCallerAllowed()) return { message: PRIVATE_NUMBER_MESSAGE };
  const { request } = req.body as { request?: string };
  return { message: await timed("handle_task", () => toolHandleTask(request ?? "")) };
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
    onCallActiveStatus();
    prefetchPriorities();
  } else if (body.status) {
    // anything else (completed, busy, no-answer, call-disconnected, failed, ...) means the
    // call is over — release the "don't ring again" guard.
    onCallEnded();
    // and check whether anything was waiting on it — a blocked/finished job that showed up
    // while this call was active would have been correctly skipped, not lost; catch up now.
    catchUpIfNeeded().catch((err) => console.error("catch-up check failed", err));
  }
  app.log.info({ status: body.status }, "bolna webhook");
  return { ok: true };
});

app.listen({ port: env.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
