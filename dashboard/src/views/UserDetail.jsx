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

// Helpers for null-safe averaging: only consider rows where the field is
// not null/undefined. Behavioural rows lack face-signal columns and vice
// versa, so naive .reduce was turning the whole page into NaN.
function avgNonNull(arr, key) {
  const xs = arr.map((e) => e[key]).filter((v) => v != null);
  if (xs.length === 0) return null;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

export default function UserDetail() {
  const { hash } = useParams();
  const [events, setEvents] = useState(null);
  const [meta, setMeta] = useState({ face: 0, behavioral: 0 });
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/reports/${hash}?limit=1000`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fetch failed"))))
      .then((data) => {
        if (alive) {
          setEvents(data.events || []);
          setMeta({
            face: data.face_count ?? 0,
            behavioral: data.behavioral_count ?? 0,
          });
        }
      })
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [hash]);

  const faceEvents = useMemo(
    () => (events || []).filter((e) => e.source === "face"),
    [events]
  );
  const behaviorEvents = useMemo(
    () => (events || []).filter((e) => e.source === "behavioral"),
    [events]
  );

  const stats = useMemo(() => {
    if (!events || events.length === 0) return null;
    const avgFatigue = avgNonNull(events, "fatigue_score");
    const avgBlink = avgNonNull(faceEvents, "blink_rate");
    const onScreenN = faceEvents.filter((e) => e.gaze_on_screen === 1).length;
    const onScreenPct =
      faceEvents.length > 0 ? (onScreenN / faceEvents.length) * 100 : null;
    const emotionCounts = faceEvents.reduce((acc, e) => {
      if (!e.emotion) return acc;
      acc[e.emotion] = (acc[e.emotion] || 0) + 1;
      return acc;
    }, {});
    const dominantEmotion =
      Object.entries(emotionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
      null;
    const avgWpm = avgNonNull(behaviorEvents, "wpm");
    const avgJitter = avgNonNull(behaviorEvents, "micro_jitter");
    return {
      avgFatigue: avgFatigue != null ? avgFatigue.toFixed(2) : "—",
      avgBlink: avgBlink != null ? avgBlink.toFixed(1) : "—",
      onScreenPct: onScreenPct != null ? onScreenPct.toFixed(0) + "%" : "—",
      dominantEmotion: dominantEmotion ?? "—",
      avgWpm: avgWpm != null ? avgWpm.toFixed(1) : "—",
      avgJitter: avgJitter != null ? avgJitter.toFixed(2) : "—",
    };
  }, [events, faceEvents, behaviorEvents]);

  // Fatigue timeline uses BOTH sources.
  const fatigueData = useMemo(
    () =>
      (events || [])
        .filter((e) => e.fatigue_score != null)
        .map((e) => ({
          t: e.recorded_at,
          fatigue: e.fatigue_score,
          src: e.source,
        })),
    [events]
  );
  const blinkData = useMemo(
    () =>
      faceEvents.map((e) => ({ t: e.recorded_at, blink: e.blink_rate })),
    [faceEvents]
  );
  const wpmData = useMemo(
    () =>
      behaviorEvents.map((e) => ({
        t: e.recorded_at,
        wpm: e.wpm,
        jitter: e.micro_jitter,
      })),
    [behaviorEvents]
  );
  const emotionData = useMemo(() => {
    const buckets = {};
    for (const e of faceEvents) {
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
  }, [faceEvents]);
  const gazeData = useMemo(() => {
    const out = [];
    for (let i = 0; i < faceEvents.length; i++) {
      const from = Math.max(0, i - 9);
      const slice = faceEvents.slice(from, i + 1);
      const pct =
        slice.reduce((s, e) => s + (e.gaze_on_screen ? 1 : 0), 0) /
        slice.length;
      out.push({ t: faceEvents[i].recorded_at, pct: Math.round(pct * 100) });
    }
    return out;
  }, [faceEvents]);

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
        <h2>
          User {hash.slice(0, 8)} — {events.length} events (
          <span style={{ color: "#1a1a2e" }}>{meta.face} face</span>
          {" / "}
          <span style={{ color: "#4a90e2" }}>{meta.behavioral} behavioural</span>
          )
        </h2>
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
          <div className="stat">
            <div className="label">Avg WPM</div>
            <div className="value">{stats.avgWpm}</div>
          </div>
          <div className="stat">
            <div className="label">Avg cursor jitter</div>
            <div className="value">{stats.avgJitter}</div>
          </div>
        </div>
      </div>

      <Export hash={hash} events={events} />

      <div className="card">
        <h2>Fatigue timeline (face + behavioural)</h2>
        {fatigueData.length === 0 ? (
          <div className="empty">No fatigue data.</div>
        ) : (
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
        )}
      </div>

      {behaviorEvents.length > 0 && (
        <div className="card">
          <h2>Typing speed & cursor jitter (behavioural)</h2>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={wpmData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="t" tick={{ fontSize: 10 }} minTickGap={40} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="wpm" stroke="#4a90e2" dot={false} />
              <Line
                type="monotone"
                dataKey="jitter"
                stroke="#e67e22"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {faceEvents.length > 0 && (
        <>
          <div className="card">
            <h2>Snapshots</h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {faceEvents
                .filter((e) => e.snapshot_base64)
                .map((e, idx) => (
                  <div
                    key={idx}
                    style={{
                      border: "1px solid #eee",
                      borderRadius: 4,
                      padding: 2,
                    }}
                  >
                    <img
                      src={`data:image/png;base64,${e.snapshot_base64}`}
                      alt={`Snapshot ${idx + 1}`}
                      style={{ width: 80, height: 60, objectFit: "cover" }}
                    />
                    <div style={{ fontSize: 10, color: "#888" }}>
                      {e.recorded_at}
                    </div>
                  </div>
                ))}
              {faceEvents.filter((e) => e.snapshot_base64).length === 0 && (
                <span style={{ color: "#aaa" }}>No snapshots available.</span>
              )}
            </div>
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
                <Line
                  type="monotone"
                  dataKey="blink"
                  stroke="#1a1a2e"
                  dot={false}
                />
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
      )}

      {faceEvents.length === 0 && (
        <div className="card">
          <div className="empty">
            No face-tracking data yet for this user. Enable the eye-tracking
            toggle in the extension popup (grant camera permission) to populate
            the blink / gaze / emotion charts.
          </div>
        </div>
      )}
    </>
  );
}
