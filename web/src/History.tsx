import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { JobCard, type Job } from "./JobCard.tsx";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

type Order = { id: string; createdAt: string; jobs: Job[] };

export function History() {
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    fetch(`${API_URL}/api/orders`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setOrders(d.orders))
      .catch(() => {});
  }, []);

  if (orders.length === 0) return <p className="muted">No orders yet.</p>;

  return (
    <div className="history">
      {orders.map((order) => (
        <div key={order.id} className="history-order">
          <div className="history-date">{new Date(order.createdAt).toLocaleString()}</div>
          <ul className="jobs">
            <AnimatePresence initial={false}>
              {order.jobs.map((job) => (
                <JobCard key={job.id} job={job} />
              ))}
            </AnimatePresence>
          </ul>
        </div>
      ))}
    </div>
  );
}
