import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { sql } from "./db.ts";
import { loginRateLimit, recordLoginFailure, recordLoginSuccess } from "./rate-limit.ts";

const scryptAsync = promisify(scrypt);
const COOKIE_NAME = "valet_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

// single-admin account: one signup ever, then it's login only — this gates the dashboard and
// browser-facing API, not a real multi-tenant system. Sessions are in-memory, so a server
// restart logs everyone out; fine for a personal tool, not for anything that needs to survive
// a Render redeploy mid-session. Upgrade to a sessions table if that starts to matter.
const sessions = new Map<string, { userId: string; username: string; expires: number }>();

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(":");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const stored_ = Buffer.from(hashHex, "hex");
  return derived.length === stored_.length && timingSafeEqual(derived, stored_);
}

const isProd = process.env.NODE_ENV === "production";

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    // the deployed web app (Vercel) and API (Render) are different registrable domains —
    // genuinely cross-site, not just cross-port like local dev. SameSite=Lax cookies are
    // never sent on cross-site fetch/XHR (only top-level navigation), so every API call right
    // after login 401'd despite the cookie having been set — reproduced live. None is required
    // for a cross-site fetch to carry the cookie, and browsers mandate Secure alongside it.
    // Local dev stays "lax": localhost:5173 -> localhost:8080 is cross-port but same-site by
    // the SameSite spec, and forcing Secure would break plain-http local dev entirely.
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
    path: "/",
    maxAge: SESSION_MS / 1000,
  });
}

export function requireAuth(req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
  const token = req.cookies[COOKIE_NAME];
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) {
    reply.code(401).send({ error: "not authenticated" });
    return;
  }
  done();
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post("/auth/signup", async (req, reply) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send({ error: "username and password required" });

    const [{ count }] = await sql`select count(*)::int as count from users`;
    if (count > 0) return reply.code(403).send({ error: "signup is closed" });

    const [user] = await sql`insert into users (username, password_hash) values (${username}, ${await hashPassword(password)}) returning id, username`;
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { userId: user.id, username: user.username, expires: Date.now() + SESSION_MS });
    setSessionCookie(reply, token);
    return { username: user.username };
  });

  app.post("/auth/login", async (req, reply) => {
    const ip = req.ip;
    const limit = loginRateLimit(ip);
    if (!limit.allowed) {
      return reply.code(429).send({ error: `too many attempts, try again in ${Math.ceil((limit.retryAfterMs ?? 0) / 1000)}s` });
    }

    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send({ error: "username and password required" });

    const [user] = await sql`select id, username, password_hash from users where username = ${username}`;
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      recordLoginFailure(ip);
      return reply.code(401).send({ error: "invalid credentials" });
    }
    recordLoginSuccess(ip);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { userId: user.id, username: user.username, expires: Date.now() + SESSION_MS });
    setSessionCookie(reply, token);
    return { username: user.username };
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = req.cookies[COOKIE_NAME];
    if (token) sessions.delete(token);
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  app.get("/auth/me", async (req, reply) => {
    const token = req.cookies[COOKIE_NAME];
    const session = token && sessions.get(token);
    if (!session || session.expires < Date.now()) return reply.code(401).send({ error: "not authenticated" });
    return { username: session.username };
  });

  app.get("/auth/signup-available", async () => {
    const [{ count }] = await sql`select count(*)::int as count from users`;
    return { available: count === 0 };
  });
}
