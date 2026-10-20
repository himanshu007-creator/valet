import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { useNavigate } from "react-router-dom";
import { JobCard, type Job } from "./JobCard.tsx";
import { api, ApiError } from "./Auth.tsx";

type Order = { id: string; createdAt: string; jobs: Job[] };

export function History() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    api("/api/orders")
      .then((d) => setOrders(d.orders ?? []))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) return navigate("/login");
        setError("Couldn't load history right now.");
      });
  }, [navigate]);

  if (error) return <p className="muted">{error}</p>;
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
