import { useEffect, useState } from "react";

function toCSV(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return (
    cols.join(",") +
    "\n" +
    rows.map((r) => cols.map((c) => escape(r[c])).join(",")).join("\n")
  );
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function Export({ hash, events: eventsProp }) {
  const [events, setEvents] = useState(eventsProp || null);

  useEffect(() => {
    if (eventsProp) {
      setEvents(eventsProp);
      return;
    }
    if (!hash) return;
    fetch(`/api/reports/${hash}?limit=500`)
      .then((r) => r.json())
      .then((d) => setEvents(d.events || []))
      .catch(() => setEvents([]));
  }, [hash, eventsProp]);

  if (!hash) return null;

  return (
    <div className="card">
      <h2>Export — {hash.slice(0, 8)}</h2>
      <button
        className="primary"
        disabled={!events || events.length === 0}
        onClick={() =>
          download(
            `helix_${hash.slice(0, 8)}.csv`,
            toCSV(events),
            "text/csv"
          )
        }
      >
        Export CSV
      </button>
      <button
        className="primary"
        disabled={!events || events.length === 0}
        onClick={() =>
          download(
            `helix_${hash.slice(0, 8)}.json`,
            JSON.stringify(events, null, 2),
            "application/json"
          )
        }
      >
        Export JSON
      </button>
    </div>
  );
}
