// Pushes server/.env to Render's bulk env-var endpoint without ever printing secret values —
// reads the file, posts it, logs only the keys that were set.
import { readFileSync } from "node:fs";

const RENDER_KEY = process.argv[2];
const SERVICE_ID = process.argv[3];
if (!RENDER_KEY || !SERVICE_ID) {
  console.error("usage: node push-render-env.mjs <render_api_key> <service_id>");
  process.exit(1);
}

const envPath = new URL("../.env", import.meta.url);
const lines = readFileSync(envPath, "utf8").split("\n");
const envVars = [];
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq);
  const value = trimmed.slice(eq + 1);
  if (key === "PORT") continue; // Render sets its own PORT
  envVars.push({ key, value });
}

envVars.push({ key: "NODE_ENV", value: "production" });

const res = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${RENDER_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify(envVars),
});
const json = await res.json();
if (!res.ok) {
  console.error("FAILED", res.status, JSON.stringify(json));
  process.exit(1);
}
console.log("set", envVars.length, "env vars:", envVars.map((v) => v.key).join(", "));
