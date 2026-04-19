import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function UserList() {
  const [users, setUsers] = useState(null);
  const [err, setErr] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    // Use the /api proxy (same as UserDetail) for consistency & to avoid
    // mixed-origin issues.
    fetch("/api/reports")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fetch failed"))))
      .then((data) => {
        if (alive) setUsers(data.users || []);
      })
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, []);

  if (err) return <div className="error">Error loading users: {err}</div>;
  if (users === null) return <div className="empty">Loading…</div>;
  if (users.length === 0)
    return (
      <div className="empty">
        No data yet. Browse with the extension installed and the backend running.
      </div>
    );

  return (
    <div className="card">
      <h2>Users</h2>
      <table>
        <thead>
          <tr>
            <th>User (hash)</th>
            <th>Last seen</th>
            <th>Sessions</th>
            <th>Total events</th>
            <th>Face / Behav</th>
            <th>Avg fatigue</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr
              key={u.user_ip_hash}
              onClick={() => navigate(`/user/${u.user_ip_hash}`)}
            >
              <td>
                <code>{u.user_ip_hash.slice(0, 8)}</code>
              </td>
              <td>{u.last_seen}</td>
              <td>{u.session_count}</td>
              <td>{u.event_count}</td>
              <td>
                <span style={{ color: "#1a1a2e" }}>{u.face_count ?? 0}</span>
                {" / "}
                <span style={{ color: "#4a90e2" }}>{u.behavioral_count ?? 0}</span>
              </td>
              <td>
                {u.avg_fatigue != null ? Number(u.avg_fatigue).toFixed(2) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
