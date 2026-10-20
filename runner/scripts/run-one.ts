import { randomUUID } from "node:crypto";
import { runJob } from "../src/job.ts";
import { resolveRepo } from "../src/repo.ts";

const args = process.argv.slice(2).filter((a) => a !== "--headless");
const [id, title, ...descParts] = args;
const headless = process.argv.includes("--headless");

if (!id || !title) {
  console.error("usage: tsx scripts/run-one.ts <id> <title> [description] [--headless]");
  process.exit(1);
}

const ticket = { id, title, description: descParts.join(" ") || title };
const resolved = await resolveRepo(ticket);
console.log("resolved to", resolved);
const result = await runJob(resolved, ticket, randomUUID(), headless);
console.log(result);
