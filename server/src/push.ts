import webpush from "web-push";
import { env } from "./env.ts";
import { sql } from "./db.ts";

if (env.vapidPublicKey && env.vapidPrivateKey) {
  webpush.setVapidDetails("mailto:himanshu@writesonic.com", env.vapidPublicKey, env.vapidPrivateKey);
}

// single-user tool: the one row in `users` either has a push subscription or it doesn't.
// ticketId, when given, lets the service worker deep-link the notification to that job.
export async function notifyPush(title: string, body: string, ticketId?: string) {
  if (!env.vapidPublicKey) return;
  const [user] = await sql`select push_subscription from users where push_subscription is not null limit 1`;
  if (!user) return;
  await webpush.sendNotification(user.push_subscription, JSON.stringify({ title, body, ticketId })).catch((err) => {
    console.error("push send failed", err.message);
  });
}
