// A chart for a view's answer, chosen from its shape: one row is a set of figures; a time column with
// numbers is a line (or dots, for events at irregular times, or a daily sum, for many of them); a
// label with numbers is a bar per label. `prepare` runs in the worker over every row, `draw` on the
// page over what `prepare` kept, so a million-row answer never has to be parsed on the page.

const SKIP = /^(block_number|log_index|decimals|id)$|_(id|index)$/;
const PREFER = [/^close$/, /^net_/, /_usd$/, /^usd$/, /_eth$/, /^liquidations$/, /^pending/];
const MAX_GROUPS = 8;
const MAX_POINTS = 2000;
const HOUR = 3_600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;
const isTime = (v) => typeof v === "string" && /^\d{4}-\d\d-\d\d(T\d\d:\d\d(:\d\d(\.\d+)?)?Z)?$/.test(v);

export function prepare(lines, ungrouped = false) {
  const n = lines.length;
  if (n === 0) return null;
  const stride = Math.max(1, Math.floor(n / 1000));
  const sample = [];
  for (let i = 0; i < n; i += stride) sample.push(JSON.parse(lines[i]));
  if (n === 1) return { kind: "stat", row: sample[0] };
  const cols = [...new Set(sample.flatMap((r) => Object.keys(r)))];
  const kind = (c) => {
    const vs = sample.map((r) => r[c]).filter((v) => v !== null && v !== undefined);
    if (!vs.length) return "empty";
    if (vs.every(isTime)) return "time";
    if (/timestamp$/.test(c) && vs.every((v) => Number.isInteger(v) && v > 1e9 && v < 1e10)) return "epoch";
    if (vs.every((v) => typeof v === "number")) return "num";
    return "text";
  };
  const types = Object.fromEntries(cols.map((c) => [c, kind(c)]));
  const ys = cols.filter((c) => types[c] === "num" && !SKIP.test(c));
  if (!ys.length) return null;
  const time = cols.find((c) => types[c] === "time") ?? cols.find((c) => types[c] === "epoch");
  const when = (v) => (typeof v === "number" ? v * 1000 : Date.parse(v));
  const texts = cols.filter((c) => types[c] === "text" && !sample.some((r) => typeof r[c] === "string" && r[c].startsWith("0x")));
  const y = PREFER.map((p) => ys.find((c) => p.test(c))).find(Boolean) ?? ys[0];

  if (!time) {
    const label = texts[0];
    if (!label || n > 200) return null;
    const rows = lines.map((l) => JSON.parse(l));
    const data = Object.fromEntries(ys.map((c) => [c, rows
      .filter((r) => typeof r[c] === "number")
      .map((r) => [String(r[label]), r[c]])
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 25)]));
    return { kind: "bars", label, ys, y, data };
  }

  const group = ungrouped ? undefined : texts.find((c) => {
    const d = new Set(sample.map((r) => r[c]));
    return d.size >= 2 && d.size <= MAX_GROUPS;
  });
  const aligned = sample.every((r) => r[time] === null || when(r[time]) % HOUR === 0);
  const daily = aligned && n > 30 && sample.every((r) => r[time] === null || when(r[time]) % DAY === 0);
  let mode = daily ? "days" : aligned ? "line" : n <= MAX_POINTS ? "dots" : "sum";
  const ts = sample.map((r) => when(r[time])).filter(Number.isFinite);
  const span = Math.max(...ts) - Math.min(...ts);
  const bucket = mode === "days" ? DAY : mode === "sum" ? (span > 120 * DAY ? WEEK : span < 4 * DAY && n < 50_000 ? HOUR : DAY) : 0;

  // y column -> series name -> x -> summed y; a point repeated at one x is summed, as a daily view's
  // rows for one coin already are.
  const acc = Object.fromEntries(ys.map((c) => [c, new Map()]));
  const dots = Object.fromEntries(ys.map((c) => [c, new Map()]));
  const names = new Set();
  for (let i = 0; i < n; i++) {
    const r = JSON.parse(lines[i]);
    let t = when(r[time]);
    if (!Number.isFinite(t)) continue;
    if (bucket === WEEK) {
      const d = Math.floor(t / DAY);
      t = (d - ((d + 3) % 7)) * DAY; // the Monday on or before; 1970-01-01 was a Thursday
    } else if (bucket) t -= t % bucket;
    const g = group ? String(r[group] ?? "none") : null;
    if (g !== null) {
      names.add(g);
      if (names.size > MAX_GROUPS * 2) return prepare(lines, true);
    }
    for (const c of ys) {
      const v = r[c];
      if (typeof v !== "number") continue;
      const s = g ?? c;
      if (mode === "dots") {
        if (!dots[c].has(s)) dots[c].set(s, []);
        dots[c].get(s).push([t, v]);
        continue;
      }
      if (!acc[c].has(s)) acc[c].set(s, new Map());
      const m = acc[c].get(s);
      m.set(t, (m.get(t) ?? 0) + v);
    }
  }
  const data = Object.fromEntries(ys.map((c) => {
    const src = mode === "dots" ? dots[c] : acc[c];
    return [c, [...src].map(([name, pts]) => ({
      name,
      points: (mode === "dots" ? pts : [...pts]).sort((a, b) => a[0] - b[0]),
    }))];
  }));
  const note = mode === "sum" ? `${n.toLocaleString()} rows, summed per ${bucket === WEEK ? "week" : bucket === DAY ? "UTC day" : "hour"}` : null;
  return { kind: mode === "dots" ? "dots" : mode === "sum" || mode === "days" ? "columns" : "line", bucket, time, group, ys, y, data, note };
}

const PALETTE = ["var(--accent)", "#3f88a6", "#7d9b3c", "#a8577f", "#c79a2a", "#6170b8", "#8a8378", "#3aa38a"];
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 });
const full = new Intl.NumberFormat("en", { maximumFractionDigits: 4 });
const fmt = (v) => (Math.abs(v) >= 10_000 ? compact.format(v) : full.format(v));
const day = (t, withHour) => new Date(t).toLocaleString("en", {
  month: "short", day: "numeric", timeZone: "UTC", ...(withHour ? { hour: "2-digit", hourCycle: "h23", minute: "2-digit" } : {}),
});
const el = (tag, attrs = {}, text) => {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
};

function niceTicks(lo, hi, count = 5) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; ; v += step) {
    ticks.push(+v.toPrecision(12));
    if (v >= hi - step * 1e-9) break;
  }
  return ticks;
}

export function stat(container, row) {
  container.replaceChildren(...Object.entries(row).map(([k, v]) => {
    const card = document.createElement("div");
    card.className = "stat";
    const big = typeof v === "number" ? fmt(v) : isTime(v) ? new Date(v).toUTCString().slice(5, 22) + " UTC" : String(v ?? "");
    card.append(
      Object.assign(document.createElement("div"), { className: "stat-value", textContent: big, title: String(v) }),
      Object.assign(document.createElement("div"), { className: "stat-label", textContent: k.replace(/_/g, " ") }),
    );
    return card;
  }));
}

export function draw(container, spec, y, tip) {
  const W = Math.max(320, container.clientWidth), H = 300;
  const m = { l: 64, r: 16, t: 12, b: spec.kind === "bars" ? 12 : 28 };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `${y} chart` });
  container.replaceChildren(svg);

  if (spec.kind === "bars") {
    const rows = spec.data[y];
    const lo = Math.min(0, ...rows.map((r) => r[1])), hi = Math.max(0, ...rows.map((r) => r[1]));
    const left = 96, bh = (H - m.t - m.b) / Math.max(rows.length, 1);
    const x = (v) => left + ((v - lo) / (hi - lo || 1)) * (W - left - m.r - 56);
    rows.forEach(([label, v], i) => {
      const yy = m.t + i * bh;
      svg.append(el("text", { x: left - 6, y: yy + bh * 0.68, "text-anchor": "end", class: "axis" }, label.length > 14 ? label.slice(0, 13) + "…" : label));
      const r = el("rect", { x: Math.min(x(0), x(v)), y: yy + bh * 0.15, width: Math.max(1, Math.abs(x(v) - x(0))), height: bh * 0.7, fill: PALETTE[0], rx: 2 });
      r.append(el("title", {}, `${label}: ${full.format(v)}`));
      svg.append(r, el("text", { x: Math.max(x(0), x(v)) + 4, y: yy + bh * 0.68, class: "axis" }, fmt(v)));
    });
    return;
  }

  const series = spec.data[y].filter((s) => s.points.length);
  const all = series.flatMap((s) => s.points);
  if (!all.length) { container.textContent = `no values in ${y}`; return; }
  const cols = spec.kind === "columns";
  // Columns stack by sign at each bucket: the domain is the stacked extent, not the single values.
  const stacks = new Map();
  if (cols) for (const [t, v] of all) {
    const s = stacks.get(t) ?? { pos: 0, neg: 0 };
    v >= 0 ? (s.pos += v) : (s.neg += v);
    stacks.set(t, s);
  }
  const xs = cols ? [...stacks.keys()].sort((a, b) => a - b) : null;
  const x0 = Math.min(...all.map((p) => p[0]));
  const x1 = Math.max(...all.map((p) => p[0])) + (cols ? spec.bucket : 0);
  let lo = cols ? Math.min(0, ...[...stacks.values()].map((s) => s.neg)) : Math.min(...all.map((p) => p[1]));
  let hi = cols ? Math.max(0, ...[...stacks.values()].map((s) => s.pos)) : Math.max(...all.map((p) => p[1]));
  if (lo > 0 && lo < hi * 0.25) lo = 0;
  const yt = niceTicks(lo, hi);
  lo = Math.min(lo, yt[0]); hi = Math.max(hi, yt[yt.length - 1]);
  const X = (t) => m.l + ((t - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((v - lo) / (hi - lo || 1)) * (H - m.t - m.b);

  for (const v of yt) {
    svg.append(el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: v === 0 ? "zero" : "grid" }));
    svg.append(el("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", class: "axis" }, fmt(v)));
  }
  const xticks = Math.max(2, Math.min(7, Math.floor((W - m.l) / 110)));
  const withHour = (x1 - x0) / xticks < 2 * DAY;
  for (let i = 0; i <= xticks; i++) {
    const t = x0 + ((x1 - x0) * i) / xticks;
    svg.append(el("text", { x: X(t), y: H - 8, "text-anchor": i === 0 ? "start" : i === xticks ? "end" : "middle", class: "axis" }, day(t, withHour)));
  }

  const color = (i) => PALETTE[i % PALETTE.length];
  if (cols) {
    const bw = Math.max(1, (X(x0 + spec.bucket) - X(x0)) * 0.78);
    const base = new Map(xs.map((t) => [t, { pos: 0, neg: 0 }]));
    series.forEach((s, i) => {
      for (const [t, v] of s.points) {
        const b = base.get(t);
        const from = v >= 0 ? b.pos : b.neg;
        v >= 0 ? (b.pos += v) : (b.neg += v);
        const top = Y(Math.max(from, from + v)), bottom = Y(Math.min(from, from + v));
        svg.append(el("rect", { x: X(t) + (X(x0 + spec.bucket) - X(x0) - bw) / 2, y: top, width: bw, height: Math.max(0.5, bottom - top), fill: color(i) }));
      }
    });
  } else {
    series.forEach((s, i) => {
      // A series far sparser than the densest is drawn as points: a line would invent the months between.
      const sparse = s.points.length < 40 && s.points.length * 5 < Math.max(...series.map((q) => q.points.length));
      if (spec.kind === "dots" || sparse) {
        for (const [t, v] of s.points) {
          const c = el("circle", { cx: X(t), cy: Y(v), r: 4, fill: color(i), "fill-opacity": 0.75 });
          c.append(el("title", {}, `${s.name} · ${day(t, true)} UTC · ${full.format(v)}`));
          svg.append(c);
        }
      } else {
        svg.append(el("polyline", { points: s.points.map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(" "), fill: "none", stroke: color(i), "stroke-width": 1.6, "stroke-linejoin": "round" }));
      }
    });
  }

  if ((spec.kind === "line" || cols) && tip) {
    const cross = el("line", { y1: m.t, y2: H - m.b, class: "cross", visibility: "hidden" });
    svg.append(cross);
    const hit = el("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" });
    svg.append(hit);
    const nearest = (ts, t) => {
      let a = 0, b = ts.length - 1;
      while (b - a > 1) { const k = (a + b) >> 1; ts[k] < t ? (a = k) : (b = k); }
      return Math.abs(ts[a] - t) <= Math.abs(ts[b] - t) ? a : b;
    };
    const lookup = series.map((s) => new Map(s.points));
    const times = xs ?? [...new Set(all.map((p) => p[0]))].sort((a, b) => a - b);
    const half = cols ? spec.bucket / 2 : 0;
    hit.addEventListener("mousemove", (e) => {
      const box = svg.getBoundingClientRect();
      const t = x0 + ((e.clientX - box.left) * (W / box.width) - m.l) / (W - m.l - m.r) * (x1 - x0) - half;
      const tx = times[nearest(times, t)];
      cross.setAttribute("x1", X(tx + half)); cross.setAttribute("x2", X(tx + half)); cross.setAttribute("visibility", "visible");
      const label = spec.bucket === WEEK ? `week of ${day(tx, false)}` : `${day(tx, !cols || spec.bucket < DAY)}${!cols || spec.bucket < DAY ? " UTC" : ""}`;
      tip(label, series.flatMap((s, i) => {
        const v = lookup[i].get(tx);
        return v === undefined ? [] : [[color(i), `${series.length > 1 ? s.name + " " : ""}${full.format(v)}`]];
      }));
    });
    hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); tip("", []); });
  }
  return series.map((s, i) => [s.name, color(i)]);
}
