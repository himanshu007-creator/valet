import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openGhosttyTab } from "./ghostty.ts";

const exec = promisify(execFile);

export type Ticket = { id: string; title: string; description: string };
export type JobResult = { status: "done"; docPath: string; prUrl: string } | { status: "blocked"; question: string } | { status: "timeout" };

const PROMPT_TEMPLATE = await readFile(new URL("../prompts/impl.md", import.meta.url), "utf8");
const POLL_MS = 3_000;
const TIMEOUT_MS = 20 * 60 * 1000;

function slug(ticketId: string) {
  return ticketId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export async function runJob(repoRoot: string, ticket: Ticket, headless = false): Promise<JobResult> {
  const id = slug(ticket.id);
  const branch = `valet/${id}`;
  const worktreeDir = path.join(repoRoot, "..", `valet-${id}`);

  await exec("git", ["worktree", "add", worktreeDir, "-b", branch, "origin/main"], { cwd: repoRoot });
  await mkdir(path.join(worktreeDir, ".valet"), { recursive: true });

  const prompt = PROMPT_TEMPLATE.replace(/{{TICKET_ID}}/g, ticket.id)
    .replace(/{{TICKET_TITLE}}/g, ticket.title)
    .replace(/{{TICKET_DESCRIPTION}}/g, ticket.description);
  await writeFile(path.join(worktreeDir, ".valet", "prompt.md"), prompt);

  const logPath = path.join(worktreeDir, ".valet", "session.log");
  const scriptPath = path.join(worktreeDir, ".valet", "run.sh");
  const script = `#!/bin/bash\nprintf '\\033]0;VALET ${ticket.id}\\007'\ncd "${worktreeDir}"\nopencode run --auto "$(cat .valet/prompt.md)" 2>&1 | tee .valet/session.log\n`;
  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);

  if (headless) {
    // ponytail: reuses the same doc-file + sentinel detection as terminal mode instead of
    // parsing opencode's --format json event stream; revisit if headless needs structured output.
    exec("/bin/bash", [scriptPath]).catch(() => {});
  } else {
    await openGhosttyTab(scriptPath, worktreeDir);
  }

  const docPath = path.join(worktreeDir, "docs", "impl", `${ticket.id}.md`);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!existsSync(logPath)) continue;
    const log = await readFile(logPath, "utf8");
    const blocked = log.match(/VALET_BLOCKED:\s*(.+)/);
    if (blocked) return { status: "blocked", question: blocked[1].trim() };
    if (log.includes("VALET_DONE") && existsSync(docPath)) {
      const prUrl = await finish(worktreeDir, branch, ticket, docPath);
      return { status: "done", docPath, prUrl };
    }
  }
  return { status: "timeout" };
}

async function finish(worktreeDir: string, branch: string, ticket: Ticket, docPath: string): Promise<string> {
  const relDoc = path.relative(worktreeDir, docPath);
  await exec("git", ["add", relDoc], { cwd: worktreeDir });
  await exec("git", ["commit", "-m", `impl doc for ${ticket.id}`], { cwd: worktreeDir });
  await exec("git", ["push", "-u", "origin", branch], { cwd: worktreeDir });
  const { stdout } = await exec(
    "gh",
    ["pr", "create", "--draft", "--title", `${ticket.id}: implementation doc`, "--body-file", relDoc],
    { cwd: worktreeDir },
  );
  return stdout.trim();
}
