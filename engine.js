// engine.js - browser/Node port of engine/envelope.py (no dependencies). Parity is enforced by tests/parity.test.mjs.
export const GRADE = { A: 3, B: 2, C: 1, D: 0 };

export function uValue(layers, catalogue, rsi, rse) {
  if (!layers.length) return null;
  let rt = rsi + rse; const detail = [];
  for (const ly of layers) {
    if (!ly.ref) return null;
    const m = catalogue[ly.ref]; const r = (ly.t_mm / 1000) / m.k; rt += r;
    detail.push({ layer: m.name, t_mm: ly.t_mm, k: m.k, R: r, source: m.source, grade: m.grade || "B" });
  }
  return { u: 1 / rt, rt, detail };
}

let NON_CORE = new Set(["cement_plaster", "eps_24"]);
function coreLayer(c) {
  let best = null;
  for (const ly of c.assembly.layers)
    if (ly.ref && !NON_CORE.has(ly.ref) && (!best || ly.t_mm > best.t_mm)) best = ly;
  return best;
}

function gwpPerM2(c) {
  const g = c.properties.gwp;
  if (!g || g.status === "missing" || g.value === undefined) return null;
  const core = coreLayer(c); if (!core) return null;
  const t = core.t_mm / 1000;
  if (g.unit === "kgCO2e/kg") { const rho = c.properties.core_density?.value; return rho == null ? null : g.value * rho * t; }
  if (g.unit === "kgCO2e/m3") return g.value * t;
  throw new Error("unsupported GWP unit " + g.unit);
}

export function deriveValues(db) {
  const out = {};
  NON_CORE = new Set(db.layer_roles?.non_core ?? ["cement_plaster", "eps_24"]);
  for (const c of db.candidates) {
    const v = {};
    const u = uValue(c.assembly.layers, db.layer_catalogue, db.surface_resistance.rsi, db.surface_resistance.rse);
    if (u) { const ug = u.detail.reduce((g, d) => GRADE[d.grade] < GRADE[g] ? d.grade : g, "A");
      const srcs = [...new Set(u.detail.map(d => d.source))].join(", ");
      v.u_value = { value: u.u, unit: "W/m2K", grade: ug, status: "derived", rt: u.rt, detail: u.detail,
        note: `ENS 2024 Sec. 9.3 series method, R_T=${u.rt.toFixed(3)} m2K/W, dry-state conductivities (${srcs})` }; }
    const gm = gwpPerM2(c);
    if (gm != null) { const g = c.properties.gwp;
      v.gwp_core = { value: gm, unit: "kgCO2e/m2", grade: g.grade, status: "derived", source: g.source,
        note: `${g.value} ${g.unit} (${g.source}, ${g.status}) x core thickness; core only; ${g.basis || ""}` }; }
    const mu = c.properties.masonry_unit;
    if (mu && mu.status !== "missing") {
      const pcs = mu.wythes / (((mu.l_mm + mu.joint_mm) / 1000) * ((mu.h_mm + mu.joint_mm) / 1000));
      v.cost = { value: mu.price_inr * pcs, unit: "INR/m2", grade: mu.grade, status: "derived", source: mu.source,
        note: `Rs ${mu.price_inr}/piece x ${pcs.toFixed(2)} pieces/m2 (${mu.source}, ${mu.status}); units only - no mortar, plaster, labour, transport, wastage.` };
    }
    out[c.id] = v;
  }
  return out;
}

// EN ISO 13786 periodic response (indicator only; mirrors envelope.periodic_response)
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cadd = (a, b) => [a[0] + b[0], a[1] + b[1]];
export function periodicResponse(layers, cat, rsi, rse, period = 86400) {
  let z = [[[1, 0], [-rse, 0]], [[0, 0], [1, 0]]], kappa = 0;
  for (const ly of layers) {
    if (!ly.ref) return null;
    const m = cat[ly.ref]; if (m.cp_kj_kgK == null || m.density == null) return null;
    const k = m.k, rho = m.density, c = m.cp_kj_kgK * 1000, d = ly.t_mm / 1000;
    kappa += rho * c * d / 1000;
    const delta = Math.sqrt(k * period / (Math.PI * rho * c)), xi = d / delta;
    const ch = Math.cosh(xi), sh = Math.sinh(xi), co = Math.cos(xi), si = Math.sin(xi);
    const z11 = [ch * co, sh * si];
    const f12 = -(delta / (2 * k)), z12 = [f12 * (sh * co + ch * si), f12 * (ch * si - sh * co)];
    const f21 = -(k / delta), z21 = [f21 * (sh * co - ch * si), f21 * (sh * co + ch * si)];
    z = [[cadd(cmul(z[0][0], z11), cmul(z[0][1], z21)), cadd(cmul(z[0][0], z12), cmul(z[0][1], z11))],
         [cadd(cmul(z[1][0], z11), cmul(z[1][1], z21)), cadd(cmul(z[1][0], z12), cmul(z[1][1], z11))]];
  }
  const z12 = cadd(z[0][1], cmul(z[0][0], [-rsi, 0]));
  const uP = 1 / Math.hypot(z12[0], z12[1]);
  const rt = rsi + rse + layers.reduce((s, ly) => s + (ly.t_mm / 1000) / cat[ly.ref].k, 0), u = 1 / rt;
  const phi = (((Math.atan2(-z12[1], -z12[0])) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return { u_periodic: uP, decrement_factor: uP / u, time_lag_h: phi * period / (2 * Math.PI) / 3600, areal_heat_capacity_kj_m2k: kappa };
}
export function indicators(db) {
  const per = db.thermal_dynamic?.period_s ?? 86400;
  return Object.fromEntries(db.candidates.map(c => [c.id, c.assembly.layers.length ? periodicResponse(c.assembly.layers, db.layer_catalogue, db.surface_resistance.rsi, db.surface_resistance.rse, per) : null]));
}

// RETV (ENS 2024 Sec. 9.5)
export function orientationBin(az) {
  const a = ((az % 360) + 360) % 360;
  if (a > 337.5 || a <= 22.5) return "N";
  for (const [lim, n] of [[67.5, "NE"], [112.5, "E"], [157.5, "SE"], [202.5, "S"], [247.5, "SW"], [292.5, "W"], [337.5, "NW"]]) if (a <= lim) return n;
}
export function retv(db, opaque, openings) {
  const cfg = db.retv, { a, b, c } = cfg.coefficients, om = cfg.omega_lat_lt_23_5;
  const aEnv = opaque.reduce((s, x) => s + x.area_m2, 0) + openings.reduce((s, x) => s + x.area_m2, 0);
  if (aEnv <= 0) throw new Error("envelope area is zero");
  const tOp = a * opaque.reduce((s, x) => s + x.area_m2 * x.u * om[x.orientation], 0);
  const tCond = b * openings.reduce((s, x) => s + x.area_m2 * x.u * om[x.orientation], 0);
  const tSol = c * openings.reduce((s, x) => s + x.area_m2 * x.shgc * (x.esf ?? 1) * om[x.orientation], 0);
  const val = (tOp + tCond + tSol) / aEnv, rounded = Math.floor(val + 0.5);
  return { retv: val, retv_rounded: rounded, limit: cfg.limit_w_m2, a_env_m2: aEnv, opaque_part: tOp / aEnv, opening_conduction_part: tCond / aEnv,
    opening_solar_part: tSol / aEnv, compliant_at_limit: rounded <= cfg.limit_w_m2 };
}
export function retvSubstitution(db, derived, project) {
  const out = {};
  if (project.walls.reduce((t, w) => t + w.area_m2, 0) + (project.openings ?? []).reduce((t, o) => t + o.area_m2, 0) <= 0) return out;
  for (const c of db.candidates) {
    const u = derived[c.id]?.u_value; if (!u) continue;
    out[c.id] = retv(db, project.walls.map(w => ({ area_m2: w.area_m2, u: u.value, orientation: w.orientation })), project.openings ?? []);
  }
  return out;
}

function normalise(vals, dir) {
  const lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) return vals.map(() => 1);
  return vals.map(v => dir === "lower_better" ? (hi - v) / (hi - lo) : (v - lo) / (hi - lo));
}

export function rank(db, derived = deriveValues(db), { weights = {}, minGrade, minCompleteness, gateWeights = {}, only = null, eligOverrides = {} } = {}) {
  const pol = db.policy; minGrade = minGrade ?? pol.min_grade; minCompleteness = minCompleteness ?? pol.min_completeness;
  const crit = db.criteria;
  const w = Object.fromEntries(crit.map(c => [c.id, c.weight])); Object.assign(w, weights);
  const gw = Object.fromEntries(crit.map(c => [c.id, c.weight])); Object.assign(gw, gateWeights);
  const wAll = Object.values(gw).reduce((a, b) => a + b, 0);
  const accepted = new Map(), excluded = [];
  for (const cand of db.candidates) {
    if (only && !only.includes(cand.id)) continue;
    const vals = derived[cand.id] || {};
    const ok = Object.fromEntries(Object.entries(vals).filter(([k, v]) => k in w && GRADE[v.grade] >= GRADE[minGrade]));
    const comp = Object.keys(ok).reduce((s, k) => s + gw[k], 0) / wAll;
    const missing = crit.filter(c => !(c.id in ok)).map(c => c.id);
    const fails = Object.entries({ ...cand.eligibility, ...(eligOverrides[cand.id] || {}) }).filter(([, s]) => s === "fail").map(([k]) => k);
    if (fails.length) excluded.push({ id: cand.id, name: cand.name, reason: `failed mandatory eligibility: ${fails}`, completeness: comp, missing });
    else if (comp + 1e-12 < minCompleteness) excluded.push({ id: cand.id, name: cand.name, reason: `evidence completeness ${comp.toFixed(2)} < required ${minCompleteness.toFixed(2)}`, completeness: comp, missing });
    else accepted.set(cand.id, { cand, ok, comp });
  }
  const ranked = [];
  if (accepted.size) {
    const ids = [...accepted.keys()];
    const common = crit.filter(c => ids.every(i => c.id in accepted.get(i).ok));
    const wc = common.reduce((s, c) => s + w[c.id], 0);
    const norm = {};
    for (const c of common) norm[c.id] = Object.fromEntries(ids.map((i, n) => [i, normalise(ids.map(j => accepted.get(j).ok[c.id].value), c.direction)[n]]));
    for (const i of ids) {
      const { cand, ok, comp } = accepted.get(i); let total = 0; const breakdown = [];
      for (const c of common) { const n = norm[c.id][i], ew = w[c.id] / wc; total += n * ew;
        breakdown.push({ criterion_id: c.id, criterion: c.name, raw: ok[c.id].value, unit: c.unit, normalised: n, effective_weight: ew, contribution: n * ew, grade: ok[c.id].grade, status: ok[c.id].status }); }
      ranked.push({ id: i, name: cand.name, score: total, completeness: comp, partial: comp < 1 - 1e-12, criteria_used: common.map(c => c.id),
        breakdown, unscored_criteria: crit.filter(c => !common.includes(c)).map(c => c.id) });
    }
    ranked.sort((a, b) => (Math.round(b.score * 1e10) - Math.round(a.score * 1e10)) || a.name.localeCompare(b.name));
    ranked.forEach((r, n) => r.rank = n + 1);
  }
  const warnings = [];
  if (ranked.some(r => r.partial)) warnings.push("PARTIAL scores: only evidenced criteria are scored (weights renormalised). Not a full multi-criteria result.");
  if (ranked.some(r => r.breakdown.some(b => b.grade === "C"))) warnings.push("Grade C inputs are provisional (secondary/aggregator/generic sources) and mix different lifecycle boundaries and geographies.");
  if (ranked.length >= 2 && Math.abs(ranked[0].score - ranked[1].score) < 0.02) warnings.push("Top two scores differ by < 0.02: treat as a tie.");
  return { ranked, excluded, warnings, settings: { minGrade, minCompleteness, weights: w } };
}

export function sensitivity(db, criterionId, { lo = 0.05, hi = 0.5, steps = 10, ...kw } = {}) {
  return Array.from({ length: steps + 1 }, (_, s) => {
    const wv = lo + (hi - lo) * s / steps;
    const r = rank(db, undefined, { weights: { [criterionId]: wv }, gateWeights: {}, ...kw });
    return { weight: +wv.toFixed(4), winner: r.ranked[0]?.name ?? null };
  });
}

export function rankLegacy(db) {
  const leg = db.legacy_indicative, crit = db.criteria, ids = Object.keys(leg.materials);
  const tw = crit.reduce((s, c) => s + c.weight, 0);
  const norm = Object.fromEntries(crit.map(c => [c.id, normalise(ids.map(i => leg.materials[i][c.id]), c.direction)]));
  return ids.map((i, n) => ({ id: i, name: leg.names[i], score: Math.round(crit.reduce((s, c) => s + norm[c.id][n] * c.weight / tw, 0) * 1e4) / 1e4 }))
    .sort((a, b) => b.score - a.score);
}
