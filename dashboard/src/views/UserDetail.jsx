import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Export from "./Export.jsx";

function bucket5Min(ts) {
  const d = new Date(ts);
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5);
  return d.toISOString().slice(11, 16);
}

export default function UserDetail() {
  const { hash } = useParams();
  const [events, setEvents] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/reports/${hash}?limit=500`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fetch failed"))))
      .then((data) => {
        if (alive) setEvents(data.events || []);
      })
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [hash]);

  const stats = useMemo(() => {
    if (!events || events.length === 0) return null;
    const n = events.length;
    const avgFatigue =
      events.reduce((s, e) => s + (e.fatigue_score || 0), 0) / n;
    const avgBlink =
      events.reduce((s, e) => s + (e.blink_rate || 0), 0) / n;
    const onScreenPct =
      (events.filter((e) => e.gaze_on_screen).length / n) * 100;
    const emotionCounts = events.reduce((acc, e) => {
      acc[e.emotion] = (acc[e.emotion] || 0) + 1;
      return acc;
    }, {});
    const dominantEmotion =
      Object.entries(emotionCounts).sort((a, b) => b[1] - a[1])[0][0];
    return {
      avgFatigue: avgFatigue.toFixed(2),
      avgBlink: avgBlink.toFixed(1),
      onScreenPct: onScreenPct.toFixed(0) + "%",
      dominantEmotion,
    };
  }, [events]);

  const fatigueData = useMemo(
    () =>
      (events || []).map((e) => ({
        t: e.recorded_at,
        fatigue: e.fatigue_score,
      })),
    [events]
  );
  const blinkData = useMemo(
    () =>
      (events || []).map((e) => ({ t: e.recorded_at, blink: e.blink_rate })),
    [events]
  );
  const emotionData = useMemo(() => {
    const buckets = {};
    for (const e of events || []) {
      const k = bucket5Min(e.recorded_at);
      buckets[k] = buckets[k] || {
        bucket: k,
        engaged: 0,
        neutral: 0,
        disengaged: 0,
      };
      const key = ["engaged", "neutral", "disengaged"].includes(e.emotion)
        ? e.emotion
        : "neutral";
      buckets[k][key]++;
    }
    return Object.values(buckets);
  }, [events]);
  const gazeData = useMemo(() => {
    const arr = events || [];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const from = Math.max(0, i - 9);
      const slice = arr.slice(from, i + 1);
      const pct =
        slice.reduce((s, e) => s + (e.gaze_on_screen ? 1 : 0), 0) / slice.length;
      out.push({ t: arr[i].recorded_at, pct: Math.round(pct * 100) });
    }
    return out;
  }, [events]);

  if (err) return <div className="error">Error: {err}</div>;
  if (events === null) return <div className="empty">Loading…</div>;
  if (events.length === 0)
    return (
      <div className="empty">
        No events yet for <code>{hash.slice(0, 8)}</code>.{" "}
        <Link to="/">Back</Link>
      </div>
    );

  return (
    <>
      <div className="card">
        <h2>User {hash.slice(0, 8)} — {events.length} events</h2>
        <div className="stats">
          <div className="stat">
            <div className="label">Avg fatigue</div>
            <div className="value">{stats.avgFatigue}</div>
          </div>
          <div className="stat">
            <div className="label">Avg blink rate</div>
            <div className="value">{stats.avgBlink}</div>
          </div>
          <div className="stat">
            <div className="label">Time on-screen</div>
            <div className="value">{stats.onScreenPct}</div>
          </div>
          <div className="stat">
            <div className="label">Dominant emotion</div>
            <div className="value">{stats.dominantEmotion}</div>
          </div>
        </div>
      </div>

      <Export hash={hash} events={events} />

      <div className="card">
        <h2>Fatigue timeline</h2>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={fatigueData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={40} />
            <YAxis domain={[0, 1]} tick={{ fontSize: 10 }} />
            <Tooltip />
            <ReferenceLine y={0.3} stroke="#f0c040" strokeDasharray="3 3" />
            <ReferenceLine y={0.6} stroke="#c0392b" strokeDasharray="3 3" />
            <Line
              type="monotone"
              dataKey="fatigue"
              stroke="#1a1a2e"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="card">
        <h2>Blink rate (per min)</h2>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={blinkData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={40} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip />
            <ReferenceLine
              y={15}
              label={{ value: "normal", fontSize: 10 }}
              stroke="#4a90e2"
              strokeDasharray="3 3"
            />
            <ReferenceLine
              y={8}
              label={{ value: "low", fontSize: 10 }}
              stroke="#c0392b"
              strokeDasharray="3 3"
            />
            <Line type="monotone" dataKey="blink" stroke="#1a1a2e" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="card">
        <h2>Emotion timeline (5-min buckets)</h2>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={emotionData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip />
            <Legend />
            <Bar dataKey="engaged" stackId="a" fill="#2ecc71" />
            <Bar dataKey="neutral" stackId="a" fill="#b0b0c0" />
            <Bar dataKey="disengaged" stackId="a" fill="#c0392b" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="card">
        <h2>Gaze on-screen % (rolling 10-sample)</h2>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={gazeData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={40} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
            <Tooltip />
            <Area
              type="monotone"
              dataKey="pct"
              stroke="#4a90e2"
              fill="#4a90e2"
              fillOpacity={0.25}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
