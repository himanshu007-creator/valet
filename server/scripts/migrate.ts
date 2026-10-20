import { readFile } from "node:fs/promises";
import { sql } from "../src/db.ts";

const schema = await readFile(new URL("../src/db/schema.sql", import.meta.url), "utf8");
await sql.unsafe(schema);
console.log("migrated");
await sql.end();
