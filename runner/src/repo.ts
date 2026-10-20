import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import type { Ticket } from "./job.ts";

const exec = promisify(execFile);

const typesafeApiKey = process.env.TYPESAFE_API_KEY;
const jev = typesafeApiKey ? new TypeSafeClient({ apiKey: typesafeApiKey, defaultModel: "jev-latest" }) : null;

// Jev picks the best-matching repo when the substring heuristic finds more than one
// plausible candidate (or none) — only called when there's real ambiguity to resolve, so
// the common one-obvious-match case still skips the network round trip entirely.
async function jevPick(ticket: Ticket, candidates: string[]): Promise<string | undefined> {
  if (!jev || candidates.length === 0) return undefined;
  const res = await jev.systemOne({
    state: `${ticket.title}\n\n${ticket.description}`,
    questions: {
      repo: choice("Which repo does this ticket belong in, if any", {
        ...Object.fromEntries(candidates.map((c) => [c, c])),
        none: "None of these repos are a good fit",
      }),
    },
  });
  const answer = res.answers.repo;
  console.log(`[jev] repo -> ${answer.choice} (confidence ${answer.confidence.toFixed(2)})`);
  return answer.choice === "none" || answer.confidence < 0.5 ? undefined : answer.choice;
}

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

function findMatches(candidates: string[], keywords: string[]): string[] {
  const hits = new Set<string>();
  for (const kw of keywords) {
    for (const c of candidates) {
      const lc = c.toLowerCase();
      if (lc === kw || lc.includes(kw) || kw.includes(lc)) hits.add(c);
    }
  }
  return [...hits];
}

// one obvious substring match: fast path, no network call. Zero or multiple matches: let
// Jev pick from the full candidate list, since the substring heuristic can't tell "no match"
// from "ambiguous match" on its own (see the ponytail note above).
async function resolveMatch(ticket: Ticket, candidates: string[], keywords: string[]): Promise<string | undefined> {
  const hits = findMatches(candidates, keywords);
  if (hits.length === 1) return hits[0];
  return jevPick(ticket, candidates);
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
  const localMatch = await resolveMatch(ticket, local, keywords);
  if (localMatch) return { repoPath: path.join(SIDEPROJECTS_DIR, localMatch), isPlan: false };

  const remote = await listGithubRepos().catch(() => []);
  const remoteMatch = await resolveMatch(ticket, remote, keywords);
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
