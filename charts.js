// charts.js - small dependency-free SVG chart kit for the platform.
// Conventions (dataviz method): thin marks, 4px rounded data-ends square at the baseline, 2px surface gaps, hairline grids,
// one axis only, text in ink tokens (never series colour), legend for >= 2 series, every mark has a hover/focus tooltip,
// and every chart has a table equivalent elsewhere on the page. Colours are CSS custom properties defined in index.html.

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tip = (value, label) => `data-tv="${esc(value)}" data-tl="${esc(label)}" tabindex="0"`;
const nice = x => { if (x <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(x))); const f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
const fmtT = x => Math.abs(x) >= 10000 ? (x / 1000).toFixed(0) + "K" : fmtN(x, 2);
const fmtN = (x, d = 2) => x == null ? "n/a" : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-IN") : String(Number((+x).toFixed(d)));
export const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)"];           // max 3 overlapping series (all-pairs validated slots)

// rounded-end bar path: square at baseline (x0), 4px radius at the data end
function hbarPath(x0, y, w, h) {
  const r = Math.min(4, w / 2, h / 2);
  if (w <= 0.5) return "";
  return `M${x0},${y}H${x0 + w - r}Q${x0 + w},${y} ${x0 + w},${y + r}V${y + h - r}Q${x0 + w},${y + h} ${x0 + w - r},${y + h}H${x0}Z`;
}
function vbarPath(x, yBase, w, h) {
  const r = Math.min(4, w / 2, h / 2);
  if (h <= 0.5) return "";
  return `M${x},${yBase}V${yBase - h + r}Q${x},${yBase - h} ${x + r},${yBase - h}H${x + w - r}Q${x + w},${yBase - h} ${x + w},${yBase - h + r}V${yBase}Z`;
}

/** Ranked horizontal bars. rows: [{label, value, tipLabel?, sub?}] ; opts: {unit, max, limit:{value,label}, decimals, fill} */
export function rankedBars(rows, opts = {}) {
  const W = opts.width || 640, labelW = opts.labelW || Math.round(Math.min(210, W * 0.36)), valW = 64, rowH = 30, barH = 16, top = 8;
  const max = opts.max ?? nice(Math.max(...rows.map(r => r.value ?? 0), opts.limit?.value ?? 0) * 1.05);
  const plotW = W - labelW - valW;
  const H = top + rows.length * rowH + 26;
  const x = v => labelW + (v / max) * plotW;
  const ticks = plotW < 260 ? [0, max / 2, max] : [0, max / 4, max / 2, (3 * max) / 4, max];
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || "bar chart")}">`;
  s += ticks.map(t => `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 4}" y2="${H - 22}" class="grid"/><text x="${x(t)}" y="${H - 8}" class="tick" text-anchor="middle">${fmtT(t)}</text>`).join("");
  rows.forEach((r, i) => {
    const y = top + i * rowH + (rowH - barH) / 2;
    s += `<text x="${labelW - 10}" y="${y + barH / 2 + 4}" class="lab" text-anchor="end">${esc(r.label.length > Math.floor(labelW / 6.2) ? r.label.slice(0, Math.floor(labelW / 6.2) - 1) + "…" : r.label)}</text>`;
    if (r.value == null) { s += `<text x="${labelW + 4}" y="${y + barH / 2 + 4}" class="muted-t">missing</text>`; return; }
    s += `<g class="mark" data-cand="${esc(r.id || "")}" ${tip(fmtN(r.value, opts.decimals ?? 2) + (opts.unit ? " " + opts.unit : ""), r.tipLabel || r.label)}>` +
      `<rect x="${labelW}" y="${y - 6}" width="${plotW + valW}" height="${barH + 12}" fill="transparent"/>` +
      `<path d="${hbarPath(labelW, y, Math.max(0, x(r.value) - labelW), barH)}" fill="${r.fill || opts.fill || "var(--s1)"}"/></g>` +
      `<text x="${x(r.value) + 6}" y="${y + barH / 2 + 4}" class="val">${fmtN(r.value, opts.decimals ?? 2)}</text>`;
  });
  s += `<line x1="${labelW}" x2="${labelW}" y1="${top - 4}" y2="${H - 22}" class="axis"/>`;
  if (opts.limit) s += `<line x1="${x(opts.limit.value)}" x2="${x(opts.limit.value)}" y1="${top - 6}" y2="${H - 22}" class="limit"/><text x="${x(opts.limit.value) + 4}" y="${top + 4}" class="lab-s">${esc(opts.limit.label)}</text>`;
  return s + "</svg>";
}

/** Stacked contribution bars (score = sum of contributions). rows: [{label, parts:[{name, value}], total}] ; parts share fixed series order */
export function stackedBars(rows, partNames, opts = {}) {
  const W = opts.width || 640, labelW = Math.round(Math.min(210, W * 0.36)), valW = 52, rowH = 32, barH = 18, top = 8;
  const max = opts.max ?? 1, plotW = W - labelW - valW, H = top + rows.length * rowH + 26;
  const colors = opts.colors || ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)"];
  const x = v => labelW + (v / max) * plotW;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || "stacked bars")}"><defs><pattern id="hatch-s" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="hatch"/></pattern></defs>`;
  s += [0, 0.25, 0.5, 0.75, 1].map(t => `<line x1="${x(t * max)}" x2="${x(t * max)}" y1="${top - 4}" y2="${H - 22}" class="grid"/><text x="${x(t * max)}" y="${H - 8}" class="tick" text-anchor="middle">${fmtN(t * max, 2)}</text>`).join("");
  rows.forEach((r, i) => {
    const y = top + i * rowH + (rowH - barH) / 2;
    s += `<text x="${labelW - 10}" y="${y + barH / 2 + 4}" class="lab" text-anchor="end">${esc(r.label.length > Math.floor(labelW / 6.2) ? r.label.slice(0, Math.floor(labelW / 6.2) - 1) + "…" : r.label)}</text>`;
    let acc = 0;
    const parts = r.parts.filter(p => p.value > 1e-9);
    parts.forEach((p, k) => {
      const ci = partNames.indexOf(p.name), x0 = x(acc), w = (p.value / max) * plotW;
      const last = k === parts.length - 1;
      const gap = last ? 0 : 2;
      const d = last ? hbarPath(x0, y, w, barH) : `M${x0},${y}h${Math.max(0, w - gap)}v${barH}h${-Math.max(0, w - gap)}Z`;
      s += `<path class="mark" data-cand="${esc(r.id || "")}" d="${d}" fill="${colors[ci % colors.length]}" ${tip(fmtN(p.value, 3), r.label + " · " + p.name)}/>`;
      acc += p.value;
    });
    s += `<text x="${x(acc) + 6}" y="${y + barH / 2 + 4}" class="val">${fmtN(r.total ?? acc, 3)}</text>`;
  });
  s += `<line x1="${labelW}" x2="${labelW}" y1="${top - 4}" y2="${H - 22}" class="axis"/></svg>`;
  const used = partNames.filter(n => rows.some(r => r.parts.some(p => p.name === n && p.value > 1e-9)));
  return s + `<div class="legend">${used.map(n => `<span><i style="background:${colors[partNames.indexOf(n) % colors.length].replace(/url\(#hatch[^)]*\)/, "repeating-linear-gradient(45deg,var(--line-2) 0 2px,transparent 2px 5px)")}"></i>${esc(n)}</span>`).join("")}</div>`;
}

/** Radar profile. axes: [label] ; series: [{name, color, values:[0..1|null]}] (<= 3 overlapping). Missing values break the outline. */
export function radar(axes, series, opts = {}) {
  const S = Math.min(opts.size || 320, 380), cx = S / 2, cy = S / 2 + 4, R = S / 2 - 76, n = axes.length;
  const ang = i => -Math.PI / 2 + (2 * Math.PI * i) / n;
  const pt = (i, v) => [cx + Math.cos(ang(i)) * R * v, cy + Math.sin(ang(i)) * R * v];
  let s = `<svg class="chart radar" viewBox="0 0 ${S} ${S + 8}" role="img" aria-label="${esc(opts.title || "radar")}">`;
  for (const g of [0.25, 0.5, 0.75, 1]) s += `<polygon class="grid" fill="none" points="${axes.map((_, i) => pt(i, g).join(",")).join(" ")}"/>`;
  axes.forEach((a, i) => {
    const [x, y] = pt(i, 1), [lx, ly] = pt(i, 1.2);
    const allMissing = series.every(se => se.values[i] == null);
    s += `<line class="grid" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/>`;
    const anchor = Math.abs(lx - cx) < 8 ? "middle" : lx > cx ? "start" : "end";
    s += `<text x="${lx}" y="${ly + (allMissing ? -2 : 4)}" class="${allMissing ? "muted-t" : "lab-s"}" text-anchor="${anchor}">${esc(a)}${allMissing ? `<tspan x="${lx}" dy="13">no data</tspan>` : ""}</text>`;
  });
  series.forEach(se => {
    // contiguous runs of present values form the outline; a full set closes into a filled polygon
    const present = se.values.map(v => v != null);
    if (present.every(Boolean)) s += `<polygon points="${se.values.map((v, i) => pt(i, v).join(",")).join(" ")}" fill="${se.color}" fill-opacity="0.10" stroke="${se.color}" stroke-width="2" stroke-linejoin="round"/>`;
    else {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (present[i] && present[j]) { const [x1, y1] = pt(i, se.values[i]), [x2, y2] = pt(j, se.values[j]); s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${se.color}" stroke-width="2" stroke-linecap="round"/>`; }
      }
    }
    se.values.forEach((v, i) => {
      if (v == null) return;
      const [x, y] = pt(i, v);
      s += `<circle class="mark" cx="${x}" cy="${y}" r="5" fill="${se.color}" stroke="var(--surface)" stroke-width="2" ${tip(fmtN(v, 2) + " (normalised)", se.name + " · " + axes[i])}/>`;
    });
  });
  s += "</svg>";
  if (series.length > 1) s += `<div class="legend">${series.map(se => `<span><i style="background:${se.color}"></i>${esc(se.name)}</span>`).join("")}</div>`;
  return s;
}

/** Radial meter: one value against a limit (e.g. RETV vs 15 W/m2). Status shown with a text label, not colour alone. */
export function meter(value, limit, opts = {}) {
  const S = opts.size || 180, cx = S / 2, cy = S / 2 + 10, R = S / 2 - 18, max = opts.max ?? Math.max(limit * 1.6, value * 1.1);
  const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2;                          // 252-degree sweep
  const at = v => a0 + (a1 - a0) * Math.min(1, Math.max(0, v / max));
  const arc = (from, to) => { const [x1, y1] = [cx + R * Math.cos(from), cy + R * Math.sin(from)], [x2, y2] = [cx + R * Math.cos(to), cy + R * Math.sin(to)]; return `M${x1},${y1}A${R},${R} 0 ${to - from > Math.PI ? 1 : 0} 1 ${x2},${y2}`; };
  const ok = Math.floor(value + 0.5) <= limit;
  const lx = cx + (R + 9) * Math.cos(at(limit)), ly = cy + (R + 9) * Math.sin(at(limit)), lx0 = cx + (R - 9) * Math.cos(at(limit)), ly0 = cy + (R - 9) * Math.sin(at(limit));
  return `<svg class="chart meter" viewBox="0 0 ${S} ${S * 1.0}" role="img" aria-label="${esc(opts.title || "meter")}" ${tip(fmtN(value, 2) + " " + (opts.unit || ""), opts.title || "value")}>` +
    `<path d="${arc(a0, a1)}" class="track" fill="none" stroke-width="12" stroke-linecap="round"/>` +
    `<path d="${arc(a0, at(value))}" fill="none" stroke="${ok ? "var(--good)" : "var(--critical)"}" stroke-width="12" stroke-linecap="round"/>` +
    `<line x1="${lx0}" y1="${ly0}" x2="${lx}" y2="${ly}" class="limit"/>` +
    `<text x="${cx}" y="${cy + 2}" text-anchor="middle" class="hero-s">${fmtN(value, 1)}</text>` +
    `<text x="${cx}" y="${cy + 20}" text-anchor="middle" class="lab-s">${esc(opts.unit || "")} · limit ${limit}</text>` +
    `<text x="${cx}" y="${cy + R * 0.95 + 14}" text-anchor="middle" class="${ok ? "good-t" : "bad-t"}">${ok ? "✓ at or below limit" : "✕ above limit"}</text></svg>`;
}

/** Scatter, single hue + direct labels (few points). points: [{label, x, y}] */
export function scatter(points, opts = {}) {
  const W = opts.width || 560, H = opts.height || 300, L = 56, B = 40, T = 14, Rm = 16;
  const xmax = nice(Math.max(...points.map(p => p.x)) * 1.1), ymax = nice(Math.max(...points.map(p => p.y)) * 1.1);
  const X = v => L + (v / xmax) * (W - L - Rm), Y = v => H - B - (v / ymax) * (H - B - T);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || "scatter")}">`;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    s += `<line class="grid" x1="${L}" x2="${W - Rm}" y1="${Y(t * ymax)}" y2="${Y(t * ymax)}"/><text class="tick" x="${L - 6}" y="${Y(t * ymax) + 4}" text-anchor="end">${fmtN(t * ymax, 1)}</text>`;
    s += `<text class="tick" x="${X(t * xmax)}" y="${H - B + 16}" text-anchor="middle">${fmtN(t * xmax, 2)}</text>`;
  }
  s += `<line class="axis" x1="${L}" x2="${W - Rm}" y1="${H - B}" y2="${H - B}"/><line class="axis" x1="${L}" x2="${L}" y1="${T}" y2="${H - B}"/>`;
  s += `<text class="lab-s" x="${(W + L) / 2}" y="${H - 6}" text-anchor="middle">${esc(opts.xLabel)}</text><text class="lab-s" x="14" y="${(H - B) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(H - B) / 2})">${esc(opts.yLabel)}</text>`;
  points.forEach(p => {
    s += `<circle class="mark" data-cand="${esc(p.id || "")}" cx="${X(p.x)}" cy="${Y(p.y)}" r="6" fill="${p.fill || "var(--s1)"}" stroke="var(--surface)" stroke-width="2" ${tip(`${fmtN(p.x, 2)} ${opts.xUnit || ""} · ${fmtN(p.y, 1)} ${opts.yUnit || ""}`, p.label)}/>`;
    const right = X(p.x) > W * 0.72;
    s += `<text class="lab-s" x="${X(p.x) + (right ? -10 : 10)}" y="${Y(p.y) - 8}" text-anchor="${right ? "end" : "start"}">${esc(p.label)}</text>`;
  });
  return s + "</svg>";
}

/** Monthly columns, one series per chart (never dual axis). */
export function monthCols(values, opts = {}) {
  const M = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"], FULL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const W = opts.width || 300, H = opts.height || 150, L = 34, B = 22, T = 10;
  const lo = opts.min ?? 0, max = nice(Math.max(...values) * 1.05);
  const Y = v => H - B - ((v - lo) / (max - lo)) * (H - B - T), bw = Math.min(16, (W - L) / 12 - 4);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || "monthly")}">`;
  for (const t of [lo, (lo + max) / 2, max]) s += `<line class="grid" x1="${L}" x2="${W}" y1="${Y(t)}" y2="${Y(t)}"/><text class="tick" x="${L - 4}" y="${Y(t) + 4}" text-anchor="end">${fmtN(t, 0)}</text>`;
  values.forEach((v, i) => {
    const x = L + 2 + i * ((W - L) / 12);
    s += `<path class="mark" d="${vbarPath(x, H - B, bw, H - B - Y(v))}" fill="${opts.fill || "var(--s1)"}" ${tip(fmtN(v, 1) + " " + (opts.unit || ""), FULL[i])}/>`;
    s += `<text class="tick" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${M[i]}</text>`;
  });
  return s + `<line class="axis" x1="${L}" x2="${W}" y1="${H - B}" y2="${H - B}"/></svg>`;
}

/** Evidence heatmap: rows x cols, cell grade A/B/C/D(missing). Ordinal blue ramp; missing = hatched. */
export function evidenceMatrix(rowLabels, colLabels, cell) {
  const cw = 92, rh = 28, L = 230, T = 40, W = L + colLabels.length * cw + 8, H = T + rowLabels.length * rh + 8;
  const fill = { A: "var(--q4)", B: "var(--q3)", C: "var(--q2)" };
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="evidence matrix"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="hatch"/></pattern></defs>`;
  colLabels.forEach((c, j) => s += `<text class="lab-s" x="${L + j * cw + cw / 2}" y="${T - 12}" text-anchor="middle">${esc(c)}</text>`);
  rowLabels.forEach((r, i) => {
    s += `<text class="lab" x="${L - 10}" y="${T + i * rh + rh / 2 + 4}" text-anchor="end">${esc(r.length > 32 ? r.slice(0, 31) + "…" : r)}</text>`;
    colLabels.forEach((c, j) => {
      const g = cell(i, j);
      const f = g && fill[g.grade] ? fill[g.grade] : "url(#hatch)";
      s += `<rect class="mark" x="${L + j * cw + 1}" y="${T + i * rh + 1}" width="${cw - 2}" height="${rh - 2}" rx="4" fill="${f}" ${tip(g ? "grade " + g.grade : "missing", r + " · " + c + (g?.tip ? " · " + g.tip : ""))}/>`;
      s += `<text x="${L + j * cw + cw / 2}" y="${T + i * rh + rh / 2 + 4}" text-anchor="middle" class="in-${g && fill[g.grade] ? g.grade : "m"}">${g ? g.grade : "–"}</text>`;
    });
  });
  return s + `</svg><div class="legend"><span><i style="background:var(--q4)"></i>A product-verified</span><span><i style="background:var(--q3)"></i>B published</span><span><i style="background:var(--q2)"></i>C provisional</span><span><i class="hatch-key"></i>missing</span></div>`;
}

/** Attach one shared tooltip to every element with data-tv/data-tl inside root (textContent only). */
export function bindTooltips(root, tipEl) {
  const show = (el, x, y) => {
    tipEl.replaceChildren();
    const v = document.createElement("b"); v.textContent = el.dataset.tv;
    const l = document.createElement("span"); l.textContent = el.dataset.tl;
    tipEl.append(v, l); tipEl.hidden = false;
    const r = tipEl.getBoundingClientRect();
    tipEl.style.left = Math.min(window.innerWidth - r.width - 8, x + 14) + "px";
    tipEl.style.top = Math.max(8, y - r.height - 10) + "px";
  };
  root.addEventListener("pointermove", e => { const el = e.target.closest("[data-tv]"); if (el) show(el, e.clientX, e.clientY); else tipEl.hidden = true; });
  root.addEventListener("pointerleave", () => tipEl.hidden = true);
  root.addEventListener("focusin", e => { const el = e.target.closest("[data-tv]"); if (el) { const b = el.getBoundingClientRect(); show(el, b.right, b.top + 10); } });
  root.addEventListener("focusout", () => tipEl.hidden = true);
}

// ------------------------------------------------------------ radial and heat-map charts (v3.2)
export const SEQ = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];   // validated blue ramp, light -> dark
const seqColor = (v, lo, hi) => SEQ[Math.max(0, Math.min(SEQ.length - 1, Math.floor(((v - lo) / ((hi - lo) || 1)) * SEQ.length)))];
const inkOn = c => SEQ.indexOf(c) >= 3 ? "#ffffff" : "#0b0b0b";
const arcPath = (cx, cy, r0, r1, a0, a1) => {                  // annular sector, angles in radians, 0 = north, clockwise
  const p = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const [x0, y0] = p(r1, a0), [x1, y1] = p(r1, a1), [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0), large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0},${y0}A${r1},${r1} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${large} 0 ${x3},${y3}Z`;
};
export function rampLegend(lo, hi, unit) {
  return `<div class="ramp" style="margin-top:6px"><span>${fmtN(lo, 1)}</span><span class="bar">${SEQ.map(c => `<i style="background:${c}"></i>`).join("")}</span><span>${fmtN(hi, 1)} ${esc(unit)}</span></div>`;
}

/** Radial bar "rose": one sector per criterion, length = normalised value (0..1); missing = hatched stub + "no data". */
export function radialBars(axes, values, opts = {}) {
  const S = Math.min(opts.size || 320, 360), cx = S / 2, cy = S / 2, R = S / 2 - 58, r0 = 18, n = axes.length, gap = 0.06;
  let s = `<svg class="chart radar" viewBox="0 0 ${S} ${S}" role="img" aria-label="${esc(opts.title || "radial bars")}"><defs><pattern id="hatch-r" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="hatch"/></pattern></defs>`;
  for (const g of [0.25, 0.5, 0.75, 1]) s += `<circle class="grid" cx="${cx}" cy="${cy}" r="${r0 + (R - r0) * g}" fill="none"/>`;
  axes.forEach((a, i) => {
    const a0 = (2 * Math.PI * i) / n + gap, a1 = (2 * Math.PI * (i + 1)) / n - gap, mid = (a0 + a1) / 2, v = values[i];
    s += v == null ? `<path d="${arcPath(cx, cy, r0, r0 + 10, a0, a1)}" fill="url(#hatch-r)"/>`
      : `<path class="mark" d="${arcPath(cx, cy, r0, r0 + (R - r0) * Math.max(0.02, v), a0, a1)}" fill="${opts.color || "var(--s1)"}" ${tip(fmtN(v, 2) + " normalised", a)}/>`;
    const lx = cx + (R + 22) * Math.sin(mid), ly = cy - (R + 22) * Math.cos(mid);
    s += `<text x="${lx}" y="${ly}" class="${v == null ? "muted-t" : "lab-s"}" text-anchor="middle">${esc(a)}${v == null ? `<tspan x="${lx}" dy="12">${esc(opts.missText ? opts.missText(i) : "no data")}</tspan>` : `<tspan x="${lx}" dy="12" class="val">${fmtN(v, 2)}</tspan>`}</text>`;
  });
  if (opts.center != null) s += `<text x="${cx}" y="${cy + 5}" text-anchor="middle" class="lab">${esc(opts.center)}</text>`;
  return s + "</svg>";
}

/** Radial heat wheel: sectors = orientations (N up, clockwise), rings = months (Jan inside -> Dec outside). */
export function radialHeat(orients, months, value, opts = {}) {
  const S = Math.min(opts.size || 340, 380), cx = S / 2, cy = S / 2, R = S / 2 - 30, r0 = 26, n = orients.length, ring = (R - r0) / months.length;
  const all = orients.flatMap((_, i) => months.map((_, m) => value(i, m))), lo = Math.min(...all), hi = Math.max(...all);
  let s = `<svg class="chart radar" viewBox="0 0 ${S} ${S}" role="img" aria-label="${esc(opts.title || "radial heat map")}">`;
  orients.forEach((o, i) => {
    const a0 = (2 * Math.PI * (i - 0.5)) / n, a1 = (2 * Math.PI * (i + 0.5)) / n;
    months.forEach((m, k) => {
      const v = value(i, k), c = seqColor(v, lo, hi);
      s += `<path class="mark" d="${arcPath(cx, cy, r0 + k * ring + 0.5, r0 + (k + 1) * ring - 0.5, a0 + 0.012, a1 - 0.012)}" fill="${c}" ${tip(fmtN(v, 2) + " " + (opts.unit || ""), o + " facade · " + m)}/>`;
    });
    const lx = cx + (R + 14) * Math.sin((2 * Math.PI * i) / n), ly = cy - (R + 14) * Math.cos((2 * Math.PI * i) / n) + 4;
    s += `<text x="${lx}" y="${ly}" text-anchor="middle" class="lab">${esc(o)}</text>`;
  });
  s += `<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="lab-s">Jan</text><text x="${cx}" y="${cy + 10}" text-anchor="middle" class="muted-t">inside</text>`;
  return s + "</svg>" + rampLegend(lo, hi, opts.unit || "");
}

/** Heat grid: rows x columns (e.g. month x hour) on the sequential ramp, with values in cells where they fit. */
export function heatGrid(rowLabels, colLabels, values, opts = {}) {
  const W = opts.width || 640, L = 40, T = 18, cw = (W - L - 4) / colLabels.length, rh = opts.rowH || 20, H = T + rowLabels.length * rh + 18;
  const flat = values.flat(), lo = opts.min ?? Math.min(...flat), hi = opts.max ?? Math.max(...flat);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || "heat map")}">`;
  colLabels.forEach((c, j) => { if (j % (opts.colEvery || 1) === 0) s += `<text class="tick" x="${L + j * cw + cw / 2}" y="${T - 6}" text-anchor="middle">${esc(c)}</text>`; });
  rowLabels.forEach((r, i) => {
    s += `<text class="lab-s" x="${L - 6}" y="${T + i * rh + rh / 2 + 4}" text-anchor="end">${esc(r)}</text>`;
    values[i].forEach((v, j) => {
      const c = v <= (opts.zeroBelow ?? -Infinity) ? "var(--surface-2)" : seqColor(v, lo, hi);
      s += `<rect class="mark" x="${L + j * cw + 0.5}" y="${T + i * rh + 0.5}" width="${cw - 1}" height="${rh - 1}" rx="2" fill="${c}" ${tip(fmtN(v, 0) + " " + (opts.unit || ""), r + " · " + colLabels[j])}/>`;
    });
  });
  if (opts.xLabel) s += `<text class="lab-s" x="${(W + L) / 2}" y="${H - 2}" text-anchor="middle">${esc(opts.xLabel)}</text>`;
  return s + "</svg>" + rampLegend(lo, hi, opts.unit || "");
}

/** Polar sun-path diagram: zenith at centre, horizon at edge, north up. paths: [{label, pts:[{altitude, azimuth, t}]}]; now: {altitude, azimuth}. */
export function sunPathChart(paths, now, opts = {}) {
  const S = Math.min(opts.size || 340, 380), cx = S / 2, cy = S / 2, R = S / 2 - 30;
  const P = (alt, az) => { const r = R * (90 - alt) / 90, a = az * Math.PI / 180; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
  const cols = ["var(--s1)", "var(--s2)", "var(--s3)"];
  let s = `<svg class="chart radar" viewBox="0 0 ${S} ${S}" role="img" aria-label="sun path diagram">`;
  for (const alt of [0, 30, 60]) s += `<circle class="grid" cx="${cx}" cy="${cy}" r="${R * (90 - alt) / 90}" fill="none"/><text class="tick" x="${cx + 3}" y="${cy - R * (90 - alt) / 90 + 11}">${alt}°</text>`;
  for (let az = 0; az < 360; az += 45) { const [x, y] = P(0, az); s += `<line class="grid" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/>`; }
  [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(([l, az]) => { const [x, y] = P(-11, az); s += `<text class="lab" x="${x}" y="${y + 4}" text-anchor="middle" font-weight="600">${l}</text>`; });
  paths.forEach((p, k) => {
    s += `<polyline fill="none" stroke="${p.color || cols[k % 3]}" stroke-width="2" stroke-linejoin="round" ${p.dash ? 'stroke-dasharray="4 3"' : ""} points="${p.pts.map(q => P(q.altitude, q.azimuth).join(",")).join(" ")}"/>`;
    p.pts.filter(q => Math.abs(q.t - Math.round(q.t)) < 1e-6 && Math.round(q.t) % 2 === 0).forEach(q => { const [x, y] = P(q.altitude, q.azimuth);
      s += `<circle class="mark" cx="${x}" cy="${y}" r="3.5" fill="${p.color || cols[k % 3]}" stroke="var(--surface)" stroke-width="1.5" ${tip(`altitude ${fmtN(q.altitude, 1)}° · azimuth ${fmtN(q.azimuth, 0)}°`, `${p.label} · ${Math.round(q.t)}:00 solar time`)}/>`; });
  });
  if (now && now.altitude > 0) { const [x, y] = P(now.altitude, now.azimuth);
    s += `<circle cx="${x}" cy="${y}" r="9" fill="#eda100" stroke="var(--surface)" stroke-width="2" ${tip(`altitude ${fmtN(now.altitude, 1)}° · azimuth ${fmtN(now.azimuth, 0)}°`, "sun now")} tabindex="0"/>`; }
  s += "</svg>";
  return s + `<div class="legend">${paths.map((p, k) => `<span><i style="background:${p.color || cols[k % 3]}"></i>${esc(p.label)}</span>`).join("")}${now ? `<span><i style="background:#eda100;border-radius:50%"></i>sun ${now.altitude > 0 ? "now" : "below horizon now"}</span>` : ""}</div>`;
}
