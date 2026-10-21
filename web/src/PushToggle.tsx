import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function PushToggle() {
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setSupported("serviceWorker" in navigator && "PushManager" in window);
    navigator.serviceWorker?.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub))
      .catch(() => {});
  }, []);

  if (!supported) return null;

  const subscribe = async () => {
    setBusy(true);
    try {
      // check the server actually has push configured BEFORE asking the browser for a
      // permission prompt — reproduced live: the user granted that prompt for a feature that
      // was never going to work, with zero feedback explaining why nothing happened after.
      const { key } = await fetch(`${API_URL}/api/push/vapid-public-key`, { credentials: "include" }).then((r) => r.json());
      if (!key) {
        setUnavailable(true);
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
      await fetch(`${API_URL}/api/push/subscribe`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub),
      });
      setSubscribed(true);
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) return <span className="muted">push not configured</span>;

  return (
    <button className="link-button" onClick={subscribe} disabled={busy || subscribed}>
      {subscribed ? "notifications on" : "enable notifications"}
    </button>
  );
}
