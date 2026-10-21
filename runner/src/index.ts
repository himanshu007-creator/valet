import { existsSync } from "node:fs";
import { readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { runJob, resumeJob, implementJob, readState, jobDirForTicketId, type Ticket, type JobState, type JobResult } from "./job.ts";
import { resolveRepo } from "./repo.ts";

const exec = promisify(execFile);

const envPath = new URL("../.env", import.meta.url);
if (existsSync(envPath)) process.loadEnvFile(envPath);

const SERVER_WS_URL = process.env.SERVER_WS_URL ?? "ws://localhost:8080/ws/runner";
const RUNNER_TOKEN = process.env.RUNNER_TOKEN;
const SIDEPROJECTS_DIR = process.env.SIDEPROJECTS_DIR ?? path.join(process.env.HOME!, "Desktop", "sideprojects");
const MAX_PARALLEL = 3;

if (!RUNNER_TOKEN) throw new Error("RUNNER_TOKEN required");

let running = 0;
const queue: { jobId: string; ticket: Ticket }[] = [];

function sendResult(ws: WebSocket, jobId: string, result: JobResult, errorMessage?: string) {
  if (result.status === "done") {
    ws.send(JSON.stringify({ type: "status", jobId, status: "done", docPath: result.docPath, prUrl: result.prUrl, sessionId: result.sessionId, resumeCmd: result.resumeCmd }));
  } else if (result.status === "blocked") {
    ws.send(JSON.stringify({ type: "status", jobId, status: "blocked", question: result.question }));
  } else {
    ws.send(JSON.stringify({ type: "status", jobId, status: errorMessage ? "failed" : "timeout", error: errorMessage }));
  }
}

// A clean server-side close always fires 'close' here and reconnects fine — but a server
// restart (deploy, crash) can kill the underlying TCP connection without a proper WS close
// handshake reaching this process, leaving `ws` in a state that LOOKS open forever even
// though nothing is listening on the other end (reproduced live: the runner sat "connected"
// silently for 14+ minutes through two server restarts). Track liveness via pong responses
// to our own ping and force-terminate (which does fire 'close') if two heartbeats in a row
// go unanswered — the standard `ws` library heartbeat pattern.
const HEARTBEAT_MS = 20_000;

function connect() {
  const ws = new WebSocket(`${SERVER_WS_URL}?token=${RUNNER_TOKEN}`);
  let isAlive = true;

  ws.on("open", () => {
    console.log("connected to server");
    isAlive = true;
    reconcile(ws).catch((err) => console.error("reconcile failed", err));
  });
  ws.on("pong", () => {
    isAlive = true;
  });
  const heartbeat = setInterval(() => {
    // reproduced live: a ping fired while still CONNECTING (slow reconnect) throws
    // synchronously and crashes the whole process — only ping once actually OPEN.
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!isAlive) {
      console.log("no pong since last heartbeat, forcing reconnect");
      return ws.terminate();
    }
    isAlive = false;
    ws.ping();
  }, HEARTBEAT_MS);
  ws.on("close", () => {
    clearInterval(heartbeat);
    console.log("disconnected, retrying in 3s");
    setTimeout(connect, 3000);
  });
  ws.on("error", (err) => console.error("ws error", err.message));

  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "job") {
      queue.push({ jobId: msg.jobId, ticket: msg.ticket });
      drain(ws);
    } else if (msg.type === "answer") {
      handleAnswer(ws, msg.jobId, msg.ticketId, msg.answer);
    } else if (msg.type === "implement") {
      handleImplement(ws, msg.jobId, msg.ticket);
    }
  });
}

function drain(ws: WebSocket) {
  while (running < MAX_PARALLEL && queue.length > 0) {
    const { jobId, ticket } = queue.shift()!;
    running++;
    ws.send(JSON.stringify({ type: "status", jobId, status: "running" }));
    resolveRepo(ticket)
      .then((resolved) => runJob(resolved, ticket, jobId))
      .then((result) => sendResult(ws, jobId, result))
      .catch((err) => {
        console.error("job failed", ticket.id, err);
        ws.send(JSON.stringify({ type: "status", jobId, status: "failed", error: err.message }));
      })
      .finally(() => {
        running--;
        drain(ws);
      });
  }
}

function handleAnswer(ws: WebSocket, jobId: string, ticketId: string, answer: string) {
  const jobDir = jobDirForTicketId(SIDEPROJECTS_DIR, ticketId);
  running++;
  ws.send(JSON.stringify({ type: "status", jobId, status: "running" }));
  resumeJob(jobDir, answer)
    .then((result) => sendResult(ws, jobId, result))
    .catch((err) => {
      console.error("resume failed", ticketId, err);
      ws.send(JSON.stringify({ type: "status", jobId, status: "failed", error: err.message }));
    })
    .finally(() => {
      running--;
      drain(ws);
    });
}

function handleImplement(ws: WebSocket, jobId: string, ticket: Ticket) {
  const jobDir = jobDirForTicketId(SIDEPROJECTS_DIR, ticket.id);
  running++;
  ws.send(JSON.stringify({ type: "status", jobId, status: "running" }));
  readState(jobDir)
    .then((researchState) => {
      if (!researchState) throw new Error(`no research state found for ${ticket.id} — order it first`);
      return implementJob(researchState, jobId);
    })
    .then((result) => sendResult(ws, jobId, result))
    .catch((err) => {
      console.error("implement failed", ticket.id, err);
      ws.send(JSON.stringify({ type: "status", jobId, status: "failed", error: err.message }));
    })
    .finally(() => {
      running--;
      drain(ws);
    });
}

// self-healing: a runner restart loses all in-memory job tracking, but opencode processes it
// launched keep running independently, and job state now lives on disk (state.json). On every
// (re)connect, catch up on anything that finished, is still genuinely running, or died with the
// runner and needs to be reported so it doesn't sit at "running" in the DB forever.
async function reconcile(ws: WebSocket) {
  const jobsRoot = path.join(SIDEPROJECTS_DIR, ".valet-jobs");
  if (!existsSync(jobsRoot)) return;
  const dirs = await readdir(jobsRoot, { withFileTypes: true }).catch(() => []);

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const jobDir = path.join(jobsRoot, dir.name);
    const statePath = path.join(jobDir, "state.json");
    if (!existsSync(statePath)) continue;
    const state: JobState = JSON.parse(await readFile(statePath, "utf8"));
    const logPath = state.logPath;
    const log = existsSync(logPath) ? await readFile(logPath, "utf8") : "";

    const lastBlocked = log.lastIndexOf("VALET_BLOCKED:");
    const lastDone = log.lastIndexOf("VALET_DONE");
    if (lastBlocked !== -1 && lastBlocked > lastDone) {
      const m = log.slice(lastBlocked).match(/VALET_BLOCKED:\s*(.+)/);
      if (m) ws.send(JSON.stringify({ type: "status", jobId: state.jobId, status: "blocked", question: m[1].trim() }));
      continue;
    }
    if (lastDone !== -1 && existsSync(state.docPath)) {
      // already completed but possibly never reported — reuse the same finish path a fresh
      // run would take (idempotent: finish()/gh pr view-before-create), nothing to resume.
      console.log(`reconcile: ${state.ticketId} already reached VALET_DONE, reporting`);
      // minimal report without re-running finish() work twice isn't worth the branch here —
      // next answer_question/order cycle would just no-op push; skip the network calls and
      // tell the server it's done with whatever we already know.
      ws.send(JSON.stringify({ type: "status", jobId: state.jobId, status: "done", docPath: state.docPath }));
      continue;
    }

    const alive = await isOpencodeStillRunning(jobDir);
    if (alive) {
      console.log(`reconcile: ${state.ticketId} still running, resuming watch`);
      running++;
      ws.send(JSON.stringify({ type: "status", jobId: state.jobId, status: "running" }));
      watchUntilDone(state)
        .then((result) => sendResult(ws, state.jobId, result))
        .catch((err) => ws.send(JSON.stringify({ type: "status", jobId: state.jobId, status: "failed", error: err.message })))
        .finally(() => {
          running--;
        });
    } else {
      console.log(`reconcile: ${state.ticketId} orphaned (process gone, no sentinel), reporting failed`);
      ws.send(JSON.stringify({ type: "status", jobId: state.jobId, status: "failed", error: "runner restarted while this job was still in flight" }));
      // without this, every single future reconnect finds the same dead job dir and re-reports
      // it — harmless on its own now that the server dedupes repeat terminal reports, but it's
      // the actual reason that dedupe was needed in the first place, and it's needless work on
      // every reconnect forever. Rename, don't delete — logs/docs stay for debugging, reconcile
      // just stops finding a "state.json" to pick up.
      await rename(statePath, `${statePath}.reported`).catch(() => {});
    }
  }
}

async function isOpencodeStillRunning(jobDir: string): Promise<boolean> {
  try {
    // plain `pgrep -f jobDir` false-positives on anything whose command line merely
    // mentions the path (e.g. a shell watching session.log for a sentinel) — require
    // "opencode run" too, since jobDir appears in XDG_DATA_HOME before "opencode run".
    const { stdout } = await exec("pgrep", ["-f", `${jobDir}.*opencode run`]);
    return stdout.trim().length > 0;
  } catch {
    return false; // pgrep exits non-zero when nothing matches
  }
}

async function watchUntilDone(state: JobState): Promise<JobResult> {
  const POLL_MS = 3_000;
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const log = existsSync(state.logPath) ? await readFile(state.logPath, "utf8") : "";
    const lastBlocked = log.lastIndexOf("VALET_BLOCKED:");
    const lastDone = log.lastIndexOf("VALET_DONE");
    if (lastBlocked !== -1 && lastBlocked > lastDone) {
      const m = log.slice(lastBlocked).match(/VALET_BLOCKED:\s*(.+)/);
      if (m) return { status: "blocked", question: m[1].trim() };
    } else if (lastDone !== -1 && existsSync(state.docPath)) {
      return { status: "done", docPath: state.docPath };
    }
    if (!(await isOpencodeStillRunning(path.dirname(state.logPath)))) {
      return { status: "timeout" };
    }
  }
  return { status: "timeout" };
}

// Render's free tier spins down after ~15 min idle. Vercel Cron can't ping sub-daily on the
// Hobby plan, but the runner is already an always-on daemon — simplest fix, no new accounts.
const healthzUrl = SERVER_WS_URL.replace(/^wss?:\/\//, (m) => (m === "wss://" ? "https://" : "http://")).replace(/\/ws\/runner.*$/, "/healthz");
setInterval(() => {
  fetch(healthzUrl).catch((err) => console.error("keep-alive ping failed", err.message));
}, 10 * 60 * 1000);

connect();
