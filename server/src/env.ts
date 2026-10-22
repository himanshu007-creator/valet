import { existsSync } from "node:fs";

const envPath = new URL("../.env", import.meta.url);
if (existsSync(envPath)) process.loadEnvFile(envPath);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 8080),
  publicUrl: process.env.PUBLIC_URL ?? "",
  bolnaApiKey: required("BOLNA_API_KEY"),
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  linearApiKey: process.env.LINEAR_API_KEY ?? "",
  deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? "",
  cartesiaApiKey: process.env.CARTESIA_API_KEY ?? "",
  runnerToken: required("RUNNER_TOKEN"),
  allowedCallerNumber: process.env.ALLOWED_CALLER_NUMBER ?? "",
  twilioNumber: process.env.TWILIO_NUMBER ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  typesafeApiKey: process.env.TYPESAFE_API_KEY ?? "",
  githubToken: process.env.GH_TOKEN ?? "",
};

const allowedOrigins = (process.env.ALLOWED_WEB_ORIGINS ?? "").split(",").filter(Boolean);

// shared with index.ts's @fastify/cors registration — a route that writes to reply.raw directly
// (desk.ts's chat/completions, for SSE) bypasses @fastify/cors's onSend hook entirely, so it has
// to compute and set the Access-Control-Allow-Origin header itself using this same check.
export function isAllowedOrigin(origin: string | undefined): boolean {
  return !origin || /^https?:\/\/localhost(:\d+)?$/.test(origin) || allowedOrigins.includes(origin);
}
