import { runJob } from "../src/job.ts";

const args = process.argv.slice(2).filter((a) => a !== "--headless");
const [id, title, ...descParts] = args;
const headless = process.argv.includes("--headless");

if (!id || !title) {
  console.error("usage: tsx scripts/run-one.ts <id> <title> [description] [--headless]");
  process.exit(1);
}

const repoRoot = process.env.TARGET_REPO_PATH;
if (!repoRoot) {
  console.error("set TARGET_REPO_PATH to the git repo the worktree should branch from");
  process.exit(1);
}

const result = await runJob(repoRoot, { id, title, description: descParts.join(" ") || title }, headless);
console.log(result);
