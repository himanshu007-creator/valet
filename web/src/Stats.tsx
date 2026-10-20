import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

type ToolStat = { count: number; p50: number; p95: number };

export function Stats() {
  const [stats, setStats] = useState<Record<string, ToolStat>>({});

  useEffect(() => {
    const fetchStats = () =>
      fetch(`${API_URL}/api/stats`, { credentials: "include" })
        .then((r) => r.json())
        .then(setStats)
        .catch(() => {});
    fetchStats();
    const id = setInterval(fetchStats, 10_000);
    return () => clearInterval(id);
  }, []);

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
