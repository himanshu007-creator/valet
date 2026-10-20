import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { Ticket } from "./job.ts";

const exec = promisify(execFile);

const SIDEPROJECTS_DIR = process.env.SIDEPROJECTS_DIR ?? path.join(process.env.HOME!, "Desktop", "sideprojects");
const PLANS_DIR = path.join(SIDEPROJECTS_DIR, "plans");
const GH_OWNER = process.env.GH_OWNER ?? "himanshu007-creator";

const PLANNING_RE = /\b(hld|brainstorm|plan|rfc|design doc|research)\b/i;

export type ResolvedRepo = { repoPath: string; isPlan: boolean };

export function isPlanningTask(ticket: Ticket): boolean {
  return PLANNING_RE.test(ticket.title) || PLANNING_RE.test(ticket.description);
}

export function planSlug(ticket: Ticket): string {
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${ticket.id.toLowerCase()}_${slug}`;
}

// ponytail: substring keyword match against repo names, not real NLP. Good enough for a
// one-person repo list; revisit with embeddings if the sideprojects folder gets large.
function keywordsFrom(text: string): string[] {
  const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "your", "make", "find"]);
  return [...new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOP.has(w)))];
}

function findMatch(candidates: string[], keywords: string[]): string | undefined {
  for (const kw of keywords) {
    const hit = candidates.find((c) => {
      const lc = c.toLowerCase();
      return lc === kw || lc.includes(kw) || kw.includes(lc);
    });
    if (hit) return hit;
  }
  return undefined;
}

async function listLocalRepos(): Promise<string[]> {
  if (!existsSync(SIDEPROJECTS_DIR)) return [];
  const entries = await readdir(SIDEPROJECTS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && e.name !== "plans" && !e.name.startsWith(".")).map((e) => e.name);
}

async function listGithubRepos(): Promise<string[]> {
  const { stdout } = await exec("gh", ["repo", "list", GH_OWNER, "--limit", "200", "--json", "name", "-q", ".[].name"]);
  return stdout.trim().split("\n").filter(Boolean);
}

async function ensurePlansDir() {
  await mkdir(PLANS_DIR, { recursive: true });
  if (!existsSync(path.join(PLANS_DIR, ".git"))) {
    await exec("git", ["init", "-b", "main"], { cwd: PLANS_DIR });
  }
}

export async function resolveRepo(ticket: Ticket): Promise<ResolvedRepo> {
  if (isPlanningTask(ticket)) {
    await ensurePlansDir();
    return { repoPath: PLANS_DIR, isPlan: true };
  }

  const keywords = keywordsFrom(`${ticket.title} ${ticket.description}`);

  const local = await listLocalRepos();
  const localMatch = findMatch(local, keywords);
  if (localMatch) return { repoPath: path.join(SIDEPROJECTS_DIR, localMatch), isPlan: false };

  const remote = await listGithubRepos().catch(() => []);
  const remoteMatch = findMatch(remote, keywords);
  if (remoteMatch) {
    const dest = path.join(SIDEPROJECTS_DIR, remoteMatch);
    await exec("gh", ["repo", "clone", `${GH_OWNER}/${remoteMatch}`, dest]);
    return { repoPath: dest, isPlan: false };
  }

  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const dest = path.join(SIDEPROJECTS_DIR, slug);
  await mkdir(dest, { recursive: true });
  await exec("git", ["init", "-b", "main"], { cwd: dest });
  await exec("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dest });
  await exec("gh", ["repo", "create", `${GH_OWNER}/${slug}`, "--private", "--source=.", "--remote=origin", "--push"], { cwd: dest });
  return { repoPath: dest, isPlan: false };
}
