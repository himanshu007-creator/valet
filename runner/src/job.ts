import { mkdir, readFile, writeFile, chmod, copyFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openGhosttyTab, closeGhosttyTab } from "./ghostty.ts";
import { planSlug, type ResolvedRepo } from "./repo.ts";

const exec = promisify(execFile);

// `git worktree add` only checks out tracked files — .env files are gitignored, so every new
// worktree starts without them. Two tickets on the same repo each get their own worktree (safe),
// but both need the real env/secrets copied in, or builds and tests just fail with missing keys.
// Tracked files like .env.example already arrive via the checkout, so skip those explicitly —
// copying them too just creates a spurious uncommitted diff if the source has local edits.
async function copyEnvFiles(source: string, dest: string) {
  const tracked = new Set(
    (await exec("git", ["ls-files"], { cwd: source }).catch(() => ({ stdout: "" }))).stdout.split("\n").filter(Boolean),
  );
  const entries = await readdir(source, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(".env")) continue;
    const parentDir = (entry as { parentPath?: string; path?: string }).parentPath ?? (entry as { path: string }).path;
    const relDir = path.relative(source, parentDir);
    if (relDir.split(path.sep).includes("node_modules") || relDir.split(path.sep).includes(".git")) continue;
    const relPath = path.join(relDir, entry.name);
    if (tracked.has(relPath)) continue;
    const destDir = path.join(dest, relDir);
    await mkdir(destDir, { recursive: true });
    await copyFile(path.join(source, relPath), path.join(destDir, entry.name)).catch(() => {});
  }
}

export type Ticket = { id: string; title: string; description: string };
export type JobResult =
  | { status: "done"; docPath: string; prUrl?: string; sessionId?: string; resumeCmd?: string }
  | { status: "blocked"; question: string }
  | { status: "timeout" };

export type JobState = {
  jobId: string;
  ticketId: string;
  ticketTitle: string;
  isPlan: boolean;
  repoPath: string;
  worktreeDir?: string;
  branch?: string;
  docPath: string;
  dataDir: string;
  logPath: string;
  promptPath: string;
};

const IMPL_PROMPT = await readFile(new URL("../prompts/impl.md", import.meta.url), "utf8");
const PLAN_PROMPT = await readFile(new URL("../prompts/plan.md", import.meta.url), "utf8");
const IMPLEMENT_PROMPT = await readFile(new URL("../prompts/implement.md", import.meta.url), "utf8");
const POLL_MS = 3_000;
const TIMEOUT_MS = 20 * 60 * 1000;

export function slug(ticketId: string) {
  return ticketId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function render(template: string, ticket: Ticket, extra: Record<string, string> = {}) {
  let out = template
    .replace(/{{TICKET_ID}}/g, ticket.id)
    .replace(/{{TICKET_TITLE}}/g, ticket.title)
    .replace(/{{TICKET_DESCRIPTION}}/g, ticket.description);
  for (const [k, v] of Object.entries(extra)) out = out.replaceAll(`{{${k}}}`, v);
  return out;
}

function jobDirFor(resolved: ResolvedRepo, id: string) {
  // sideprojects/.valet-jobs/<id>, a sibling of every repo and of plans/ — never inside a
  // worktree, so opencode's own exploration can't read back and re-print the sentinel examples.
  return path.join(resolved.repoPath, "..", ".valet-jobs", id);
}

export function jobDirForTicketId(repoHint: string, ticketId: string) {
  return path.join(repoHint, "..", ".valet-jobs", slug(ticketId));
}

export async function readState(jobDir: string): Promise<JobState | undefined> {
  try {
    return JSON.parse(await readFile(path.join(jobDir, "state.json"), "utf8"));
  } catch {
    return undefined;
  }
}

async function writeState(jobDir: string, state: JobState) {
  await writeFile(path.join(jobDir, "state.json"), JSON.stringify(state, null, 2));
}

// opencode's `session list` filters by the caller's cwd against the session's own recorded
// directory — without a matching cwd it silently returns an empty list, not an error.
async function latestSessionId(dataDir: string, cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("opencode", ["session", "list", "--format", "json", "-n", "1"], {
      cwd,
      env: { ...process.env, XDG_DATA_HOME: dataDir },
    });
    return JSON.parse(stdout)[0]?.id;
  } catch {
    return undefined;
  }
}

async function pollForSentinel(logPath: string, docPath: string, deadline: number, fromOffset = 0): Promise<{ sentinel: "done" } | { sentinel: "blocked"; question: string } | { sentinel: "timeout" }> {
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!existsSync(logPath)) continue;
    const full = await readFile(logPath, "utf8");
    const log = full.slice(fromOffset);
    // only the LAST occurrence counts — the agent's real sentinel is always its final line,
    // earlier ones can be false positives from it reading/quoting its own prompt. `fromOffset`
    // also keeps a resume from re-matching the previous cycle's sentinel still sitting in the file.
    const lastBlocked = log.lastIndexOf("VALET_BLOCKED:");
    const lastDone = log.lastIndexOf("VALET_DONE");
    if (lastBlocked !== -1 && lastBlocked > lastDone) {
      const m = log.slice(lastBlocked).match(/VALET_BLOCKED:\s*(.+)/);
      if (m) return { sentinel: "blocked", question: m[1].trim() };
    } else if (lastDone !== -1 && existsSync(docPath)) {
      return { sentinel: "done" };
    }
  }
  return { sentinel: "timeout" };
}

// writes run.sh and launches it (Ghostty tab or headless). `append` reuses the existing
// session.log (a resume) instead of truncating it (a fresh run) so the whole conversation's
// history stays in one file for debugging.
async function launch(jobDir: string, cwd: string, dataDir: string, logPath: string, tabTitle: string, messagePath: string, opencodeExtraArgs: string, append: boolean, headless: boolean): Promise<string | undefined> {
  const scriptPath = path.join(jobDir, "run.sh");
  const teeArgs = append ? "-a" : "";
  const script = `#!/bin/bash\nprintf '\\033]0;${tabTitle}\\007'\ncd "${cwd}"\nXDG_DATA_HOME="${dataDir}" opencode run ${opencodeExtraArgs}--auto "$(cat "${messagePath}")" 2>&1 | tee ${teeArgs} "${logPath}"\n`;
  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);
  if (headless) {
    // ponytail: reuses the same doc-file + sentinel detection as terminal mode instead of
    // parsing opencode's --format json event stream; revisit if headless needs structured output.
    exec("/bin/bash", [scriptPath]).catch(() => {});
    return undefined;
  }
  return openGhosttyTab(scriptPath, cwd);
}

export async function runJob(resolved: ResolvedRepo, ticket: Ticket, jobId: string, headless = false): Promise<JobResult> {
  const id = slug(ticket.id);
  const jobDir = jobDirFor(resolved, id);
  await mkdir(jobDir, { recursive: true });
  const tabTitle = `${ticket.id}: ${ticket.title}`.replace(/'/g, "").slice(0, 60);
  const logPath = path.join(jobDir, "session.log");
  const promptPath = path.join(jobDir, "prompt.md");
  const dataDir = path.join(jobDir, "opencode-data");

  if (resolved.isPlan) {
    const docName = planSlug(ticket);
    const prompt = render(PLAN_PROMPT, ticket, { PLAN_FILE: docName });
    await writeFile(promptPath, prompt);
    const docPath = path.join(resolved.repoPath, `${docName}.md`);

    await writeState(jobDir, { jobId, ticketId: ticket.id, ticketTitle: ticket.title, isPlan: true, repoPath: resolved.repoPath, docPath, dataDir, logPath, promptPath });

    const tabId = await launch(jobDir, resolved.repoPath, dataDir, logPath, tabTitle, promptPath, "", false, headless);
    const result = await pollForSentinel(logPath, docPath, Date.now() + TIMEOUT_MS);
    if (result.sentinel === "blocked") return { status: "blocked", question: result.question };
    if (result.sentinel === "timeout") return { status: "timeout" };

    await exec("git", ["add", `${docName}.md`], { cwd: resolved.repoPath });
    await exec("git", ["commit", "-m", `plan: ${ticket.id}`], { cwd: resolved.repoPath });
    const sessionId = await latestSessionId(dataDir, resolved.repoPath);
    if (tabId) closeGhosttyTab(tabId).catch(() => {});
    return {
      status: "done",
      docPath,
      sessionId,
      resumeCmd: sessionId ? `cd ${resolved.repoPath} && XDG_DATA_HOME="${dataDir}" opencode -s ${sessionId}` : undefined,
    };
  }

  const branch = `valet/${id}`;
  const worktreeDir = path.join(resolved.repoPath, "..", `${path.basename(resolved.repoPath)}-${id}`);
  // -B (not -b): a stale branch/worktree from an earlier crashed or orphaned attempt on the
  // same ticket must not block a fresh order — reset to a clean branch off origin/main instead.
  if (existsSync(worktreeDir)) {
    await exec("git", ["worktree", "remove", worktreeDir, "--force"], { cwd: resolved.repoPath }).catch(() => {});
  }
  await exec("git", ["worktree", "add", worktreeDir, "-B", branch, "origin/main"], { cwd: resolved.repoPath });
  await copyEnvFiles(resolved.repoPath, worktreeDir);

  const prompt = render(IMPL_PROMPT, ticket);
  await writeFile(promptPath, prompt);
  const docPath = path.join(worktreeDir, "docs", "impl", `${ticket.id}.md`);

  await writeState(jobDir, { jobId, ticketId: ticket.id, ticketTitle: ticket.title, isPlan: false, repoPath: resolved.repoPath, worktreeDir, branch, docPath, dataDir, logPath, promptPath });

  const tabId = await launch(jobDir, worktreeDir, dataDir, logPath, tabTitle, promptPath, "", false, headless);
  const result = await pollForSentinel(logPath, docPath, Date.now() + TIMEOUT_MS);
  if (result.sentinel === "blocked") return { status: "blocked", question: result.question };
  if (result.sentinel === "timeout") return { status: "timeout" };

  const prUrl = await finish(worktreeDir, branch, ticket, docPath);
  const sessionId = await latestSessionId(dataDir, worktreeDir);
  if (tabId) closeGhosttyTab(tabId).catch(() => {});
  return {
    status: "done",
    docPath,
    prUrl,
    sessionId,
    resumeCmd: sessionId ? `cd ${worktreeDir} && XDG_DATA_HOME="${dataDir}" opencode -s ${sessionId}` : undefined,
  };
}

// resumes a blocked job's opencode session with the user's answer, instead of just appending
// text to the doc file. Picks up state.json written by runJob so it works even if the runner
// restarted since the job was first dispatched.
export async function resumeJob(jobDir: string, answer: string, headless = false): Promise<JobResult> {
  const state = await readState(jobDir);
  if (!state) throw new Error(`no state.json in ${jobDir} — can't resume`);

  const cwd = state.worktreeDir ?? state.repoPath;
  const sessionId = await latestSessionId(state.dataDir, cwd);
  if (!sessionId) throw new Error(`no opencode session found for ${state.ticketId} to resume`);

  const offset = (await stat(state.logPath).catch(() => undefined))?.size ?? 0;
  const answerPath = path.join(jobDir, `answer-${Date.now()}.md`);
  await writeFile(answerPath, answer);
  const tabTitle = `${state.ticketId}: ${state.ticketTitle}`.replace(/'/g, "").slice(0, 60);
  const tabId = await launch(jobDir, cwd, state.dataDir, state.logPath, tabTitle, answerPath, `-s ${sessionId} `, true, headless);

  const result = await pollForSentinel(state.logPath, state.docPath, Date.now() + TIMEOUT_MS, offset);
  if (result.sentinel === "blocked") return { status: "blocked", question: result.question };
  if (result.sentinel === "timeout") return { status: "timeout" };

  const prUrl = state.isPlan
    ? await (async () => {
        await exec("git", ["add", path.relative(state.repoPath, state.docPath)], { cwd: state.repoPath });
        await exec("git", ["commit", "-m", `plan: ${state.ticketId}`], { cwd: state.repoPath }).catch(() => {});
        return undefined;
      })()
    : await finish(state.worktreeDir!, state.branch!, { id: state.ticketId, title: state.ticketTitle, description: "" }, state.docPath);

  const newSessionId = await latestSessionId(state.dataDir, cwd);
  if (tabId) closeGhosttyTab(tabId).catch(() => {});
  return {
    status: "done",
    docPath: state.docPath,
    prUrl,
    sessionId: newSessionId,
    resumeCmd: newSessionId ? `cd ${cwd} && XDG_DATA_HOME="${state.dataDir}" opencode -s ${newSessionId}` : undefined,
  };
}

// "start it for real": reuses the worktree/branch/PR a research pass already created, runs
// the implement prompt instead of the research prompt, and flips the existing draft PR ready
// instead of creating a new one. Needs a prior `done` research job for this ticket — the
// caller (toolImplement, server-side) already enforces that before dispatching.
export async function implementJob(researchState: JobState, jobId: string, headless = false): Promise<JobResult> {
  if (researchState.isPlan || !researchState.worktreeDir || !researchState.branch) {
    throw new Error("implement is only for code tickets with an existing worktree/branch");
  }
  const id = slug(researchState.ticketId);
  const implDir = path.join(researchState.repoPath, "..", ".valet-jobs", `${id}-implement`);
  await mkdir(implDir, { recursive: true });

  const { worktreeDir, branch } = researchState;
  if (!existsSync(worktreeDir)) {
    await exec("git", ["worktree", "add", worktreeDir, "-B", branch, `origin/${branch}`], { cwd: researchState.repoPath });
  }

  const ticket: Ticket = { id: researchState.ticketId, title: researchState.ticketTitle, description: "" };
  const prompt = render(IMPLEMENT_PROMPT, ticket);
  const promptPath = path.join(implDir, "prompt.md");
  await writeFile(promptPath, prompt);
  const logPath = path.join(implDir, "session.log");
  const dataDir = path.join(implDir, "opencode-data");
  const tabTitle = `${ticket.id} (real): ${ticket.title}`.replace(/'/g, "").slice(0, 60);

  await writeState(implDir, { jobId, ticketId: ticket.id, ticketTitle: ticket.title, isPlan: false, repoPath: researchState.repoPath, worktreeDir, branch, docPath: researchState.docPath, dataDir, logPath, promptPath });

  const tabId = await launch(implDir, worktreeDir, dataDir, logPath, tabTitle, promptPath, "", false, headless);
  const result = await pollForSentinel(logPath, researchState.docPath, Date.now() + TIMEOUT_MS);
  if (result.sentinel === "blocked") return { status: "blocked", question: result.question };
  if (result.sentinel === "timeout") return { status: "timeout" };

  await exec("git", ["add", "-A"], { cwd: worktreeDir });
  await exec("git", ["commit", "-m", `implement ${ticket.id}`], { cwd: worktreeDir }).catch(() => {});
  await exec("git", ["push"], { cwd: worktreeDir });
  await exec("gh", ["pr", "ready"], { cwd: worktreeDir }).catch((err) => console.error("gh pr ready failed", err));
  const { stdout: prUrl } = await exec("gh", ["pr", "view", "--json", "url", "-q", ".url"], { cwd: worktreeDir }).catch(() => ({ stdout: "" }));

  const sessionId = await latestSessionId(dataDir, worktreeDir);
  if (tabId) closeGhosttyTab(tabId).catch(() => {});
  return {
    status: "done",
    docPath: researchState.docPath,
    prUrl: prUrl.trim() || undefined,
    sessionId,
    resumeCmd: sessionId ? `cd ${worktreeDir} && XDG_DATA_HOME="${dataDir}" opencode -s ${sessionId}` : undefined,
  };
}

async function finish(worktreeDir: string, branch: string, ticket: Ticket, docPath: string): Promise<string> {
  const relDoc = path.relative(worktreeDir, docPath);
  await exec("git", ["add", relDoc], { cwd: worktreeDir });
  await exec("git", ["commit", "-m", `impl doc for ${ticket.id}`], { cwd: worktreeDir }).catch(() => {});
  await exec("git", ["push", "-u", "origin", branch], { cwd: worktreeDir });
  const { stdout } = await exec(
    "gh",
    ["pr", "view", "--json", "url", "-q", ".url"],
    { cwd: worktreeDir },
  ).catch(() => ({ stdout: "" }));
  if (stdout.trim()) return stdout.trim();
  const { stdout: created } = await exec(
    "gh",
    ["pr", "create", "--draft", "--title", `${ticket.id}: implementation doc`, "--body-file", relDoc],
    { cwd: worktreeDir },
  );
  return created.trim();
}
