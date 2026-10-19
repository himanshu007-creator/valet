import Fastify from "fastify";
import { env } from "./env.ts";
import { getPrioritiesSummary, prefetchPriorities } from "./cache.ts";

const app = Fastify({ logger: true });

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

app.post("/tools/get_priorities", async () => {
  return { message: await getPrioritiesSummary() };
});

app.post("/tools/order", async (req) => {
  const { tickets } = req.body as { tickets?: string };
  return { message: `Starting work on ${tickets ?? "those tickets"}. I'll call you when it's done.` };
});

app.post("/tools/get_status", async () => {
  return { message: "Nothing running right now." };
});

app.post("/tools/answer_question", async (req) => {
  const { job_id } = req.body as { job_id?: string };
  return { message: `Got it, noted against job ${job_id ?? "unknown"}.` };
});

const CALL_STARTED_STATUSES = new Set(["ringing", "initiated", "in-progress"]);

app.post("/hooks/bolna", async (req) => {
  const body = req.body as { status?: string };
  if (body.status && CALL_STARTED_STATUSES.has(body.status)) prefetchPriorities();
  app.log.info({ status: body.status }, "bolna webhook");
  return { ok: true };
});

app.listen({ port: env.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
