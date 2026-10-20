import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "./Auth.tsx";

type ToolStat = { count: number; p50: number; p95: number };

export function Stats() {
  const [stats, setStats] = useState<Record<string, ToolStat>>({});
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    const fetchStats = () =>
      api("/api/stats")
        .then((d) => setStats(d ?? {}))
        .catch((err) => {
          if (err instanceof ApiError && err.status === 401) return navigate("/login");
          setError("Couldn't load stats right now.");
        });
    fetchStats();
    const id = setInterval(fetchStats, 10_000);
    return () => clearInterval(id);
  }, [navigate]);

  if (error) return <p className="muted">{error}</p>;
  const tools = Object.entries(stats);
  if (tools.length === 0) return <p className="muted">No tool calls yet this session.</p>;

  return (
    <table className="stats-table">
      <thead>
        <tr>
          <th>Tool</th>
          <th>Calls</th>
          <th>p50</th>
          <th>p95</th>
        </tr>
      </thead>
      <tbody>
        {tools.map(([tool, s]) => (
          <tr key={tool}>
            <td>{tool}</td>
            <td>{s.count}</td>
            <td>{s.p50}ms</td>
            <td className={s.p95 > 1500 ? "stats-slow" : undefined}>{s.p95}ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
