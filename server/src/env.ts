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
  runnerToken: required("RUNNER_TOKEN"),
  allowedCallerNumber: process.env.ALLOWED_CALLER_NUMBER ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
};
