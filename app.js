// app.js - Envelope Studio: project intake -> BIM model -> goals & budget -> results, climate, evidence.
// All calculation is in engine.js / bim.js (parity-tested against Python and Java). This file only wires inputs to outputs.
import * as E from "./engine.js";
import * as X from "./explain.js";
import * as B from "./bim.js";
import * as C from "./charts.js";
import { ModelViewer, RAMP_STOPS } from "./viewer.js";

const $ = id => document.getElementById(id);
const esc = C.esc;
const f = (x, n = 2) => x == null || !isFinite(x) ? "n/a" : (+x).toFixed(n);
const W = id => Math.max(280, Math.round($(id).clientWidth || 600));
const inr = x => "₹" + Math.round(x).toLocaleString("en-IN");
const D = await (await fetch("data/dataset.json")).json();
const db = D.db, derived = E.deriveValues(db), ind = E.indicators(db);
const NAME = id => db.candidates.find(c => c.id === id)?.name ?? id;
const LABEL = { LAT: "Laterite", BRICK: "Clay brick", AAC: "AAC", CSEB: "CSEB", HCB: "Hollow concrete", FAB: "Fly ash brick", PCB: "Hollow clay block", GEO: "Geopolymer", RAB: "Recycled aggregate",
  SAND: "Brick + EPS sandwich", CLC: "CLC block", BRKCOIR: "Brick + coir board", SAND_CLC: "CLC + EPS sandwich" };
const SHORT = id => LABEL[id] ?? NAME(id).split(" (")[0];
const AX = { u_value: "Thermal (U)", gwp_core: "Carbon", cost: "Unit cost", service_life: "Service life", availability: "Availability", maintenance: "Maintenance" };
const BASE = Object.fromEntries(db.criteria.map(c => [c.id, c.weight]));
const PRESETS = {
  balanced: { t: "Balanced", d: "Provisional baseline weights", w: BASE },
  thermal: { t: "Thermal comfort first", d: "U-value weighted 0.40", w: { u_value: .40, gwp_core: .15, cost: .15, service_life: .12, availability: .10, maintenance: .08 } },
  carbon: { t: "Low carbon first", d: "Embodied carbon weighted 0.40", w: { u_value: .15, gwp_core: .40, cost: .15, service_life: .12, availability: .10, maintenance: .08 } },
  cost: { t: "Lowest cost first", d: "Unit cost weighted 0.40", w: { u_value: .15, gwp_core: .15, cost: .40, service_life: .12, availability: .10, maintenance: .08 } },
};

// ------------------------------------------------------------ state (per-viewer convenience storage; page works without it)
const KEY = "envstudio.v3";
const S = Object.assign({
  name: "", type: "residential", floors: 2, city: "kochi", lat: null, lon: null, notes: "",
  src: "sample", manual: { areas: { N: 30, E: 24, S: 30, W: 24 }, wwr: 0.15, winU: 5.8, winShgc: 0.7 },
  preset: "balanced", weights: { ...BASE }, grade: "C", comp: 0.5, retvGate: false, budget: null, tU: null, tRetv: null, ifcProject: null, ifcName: null,
}, (() => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } })());
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* storage unavailable or full: ignore */ } };
let ifcBytes = null, sampleProject = D.sample_project, viewer = null, lastRes = null, lastProject = null, BACKEND = null;

// ------------------------------------------------------------ theme
const applyTheme = t => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
try { applyTheme(localStorage.getItem(KEY + ".theme")); } catch {}
$("theme").onclick = () => {
  const dark = document.documentElement.dataset.theme === "dark";
  const t = dark ? "light" : "dark"; applyTheme(t); try { localStorage.setItem(KEY + ".theme", t); } catch {}
};

$("banner").innerHTML = "Research demonstrator. Only cited values are used and nothing is imputed. Carbon data exists for three materials, cost only for masonry-unit prices from secondary listings, and service life, availability and maintenance are not yet collected, so every score is <b>partial</b>.";
$("ramp").innerHTML = RAMP_STOPS.map(c => `<i style="background:${c}"></i>`).join("");
C.bindTooltips(document.body, $("tooltip"));

// ------------------------------------------------------------ 1 project
const cities = D.climate.cities;
$("p-city").innerHTML = Object.entries(cities).map(([k, c]) => `<option value="${k}">${esc(c.name)} (${f(c.lat, 2)} N, ${f(c.lon, 2)} E)</option>`).join("");
const bindVal = (id, key, num = false) => { const el = $(id); el.value = S[key] ?? ""; el.oninput = () => { S[key] = num ? (el.value === "" ? null : +el.value) : el.value; save(); update(); }; };
bindVal("p-name", "name"); bindVal("p-type", "type"); bindVal("p-floors", "floors", true); bindVal("p-notes", "notes");
bindVal("p-lat", "lat", true); bindVal("p-lon", "lon", true); bindVal("p-city", "city");
bindVal("b-amt", "budget", true); bindVal("e-u", "tU", true); bindVal("e-retv", "tRetv", true);
function nearestCity(lat, lon) {
  let best = null, bd = Infinity;
  for (const [k, c] of Object.entries(cities)) { const d = Math.hypot(lat - c.lat, (lon - c.lon) * Math.cos(lat * Math.PI / 180)); if (d < bd) { bd = d; best = k; } }
  return { key: best, km: bd * 111 };
}

// ------------------------------------------------------------ 2 model
const srcBtns = [...$("m-src").querySelectorAll("button")];
srcBtns.forEach(b => b.onclick = () => { S.src = b.dataset.v; save(); renderModelSide(); loadModel(); });
function currentProject() {
  if (S.src === "manual") return B.manualProject(db, S.manual);
  if (S.src === "ifc" && S.ifcProject) return S.ifcProject;
  return sampleProject;
}
function renderModelSide() {
  srcBtns.forEach(b => b.classList.toggle("on", b.dataset.v === S.src));
  const el = $("m-side");
  if (S.src === "sample") {
    el.innerHTML = `<h3>Sample house</h3><p class="sub">Hand-authored IFC4 test model: 10 × 8 m, one storey, brick walls on three sides and AAC on the north, five single-glazed windows, true north rotated 15°. Not exported from a BIM tool.</p><p><a href="data/sample_house.ifc" download>Download sample_house.ifc</a></p>` + modelFacts(sampleProject);
  } else if (S.src === "ifc") {
    el.innerHTML = `<h3>Upload IFC</h3><p class="sub">Walls need material layer sets and a NetSideArea quantity; windows need ThermalTransmittance and SolarHeatGainTransmittance for RETV.</p>
      <label class="drop" id="drop"><input type="file" id="ifc-file" accept=".ifc" hidden><b>Drop an .ifc file here</b><br><span class="small">or click to choose</span></label>` +
      (S.ifcProject ? `<p class="small" style="margin-top:10px"><b>${esc(S.ifcName || "model.ifc")}</b></p>` + modelFacts(S.ifcProject) : "");
    const inp = $("ifc-file"), drop = $("drop");
    inp.onchange = () => inp.files[0] && readIfc(inp.files[0]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) readIfc(e.dataTransfer.files[0]); };
  } else {
    const m = S.manual;
    el.innerHTML = `<h3>Facade areas</h3><p class="sub">Gross wall area per orientation, including windows.</p>` +
      ["N", "E", "S", "W", "NE", "SE", "SW", "NW"].map(o => `<label class="f" style="display:inline-block;width:23%;margin-right:2%"><span>${o} (m²)</span><input type="number" min="0" step="0.5" data-o="${o}" value="${m.areas[o] ?? ""}"></label>`).join("") +
      `<div class="row"><label class="f" style="flex:1"><span>Window-to-wall ratio</span><input type="number" id="mm-wwr" min="0" max="0.9" step="0.01" value="${m.wwr}"></label>
       <label class="f" style="flex:1"><span>Window U</span><input type="number" id="mm-u" step="0.1" value="${m.winU}"></label>
       <label class="f" style="flex:1"><span>Window SHGC</span><input type="number" id="mm-g" step="0.05" value="${m.winShgc}"></label></div>
       <p class="small mut">Defaults (U 5.8, SHGC 0.7) are typical of single clear glazing and are your assumption; replace them with product data.</p>`;
    el.querySelectorAll("input[data-o]").forEach(i => i.oninput = () => { const v = i.value === "" ? undefined : +i.value; if (v === undefined) delete m.areas[i.dataset.o]; else m.areas[i.dataset.o] = v; save(); loadModel(); });
    $("mm-wwr").oninput = e => { m.wwr = +e.target.value; save(); loadModel(); };
    $("mm-u").oninput = e => { m.winU = +e.target.value; save(); loadModel(); };
    $("mm-g").oninput = e => { m.winShgc = +e.target.value; save(); loadModel(); };
  }
}
function modelFacts(p) {
  const ext = p.walls.filter(w => w.external);
  return `<dl class="kv"><dt>Site</dt><dd>${p.site.lat != null ? f(p.site.lat, 3) + " N, " + f(p.site.lon, 3) + " E" : "not in model"}</dd>
    <dt>Read by</dt><dd>${esc(p.reader || "built-in text parser (browser)")}</dd><dt>True north</dt><dd>${f(p.true_north_ccw_deg, 1)}° from project +Y</dd><dt>External walls</dt><dd>${ext.length} · ${f(ext.reduce((s, w) => s + (w.area_m2 || 0), 0), 1)} m² net</dd>
    <dt>Openings</dt><dd>${p.openings.length} · ${f(p.openings.reduce((s, o) => s + o.area_m2, 0), 1)} m²</dd>
    <dt>RETV as modelled</dt><dd>${p.retv_as_modelled ? f(p.retv_as_modelled.retv, 2) + " W/m²" : "not available"}</dd></dl>` +
    (p.warnings || []).map(w => `<div class="note">${esc(w)}</div>`).join("");
}
async function readIfc(file) {
  $("v-status").textContent = "Reading " + file.name + "…";
  try {
    const buf = await file.arrayBuffer();
    let p;
    if (BACKEND) {
      $("v-status").textContent = "Reading " + file.name + " with IfcOpenShell on the local backend…";
      const r = await fetch("api/ifc", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: buf });
      if (!r.ok) throw new Error("backend: " + (await r.text()).slice(0, 200));
      p = await r.json();
    } else p = B.analyse(new TextDecoder().decode(buf), db, derived);
    S.ifcProject = p; S.ifcName = file.name; ifcBytes = buf;
    if (p.site.lat != null) { S.lat = +p.site.lat.toFixed(4); S.lon = +p.site.lon.toFixed(4); $("p-lat").value = S.lat; $("p-lon").value = S.lon; const n = nearestCity(p.site.lat, p.site.lon); S.city = n.key; $("p-city").value = n.key; }
    save(); renderModelSide(); loadModel();
  } catch (e) { $("v-status").textContent = "Could not read this IFC file: " + e.message; }
}
async function loadModel() {
  const p = currentProject(); lastProject = p;
  renderWalls(p); update();
  if (S.src === "manual") { $("viewer").innerHTML = `<div style="display:grid;place-items:center;height:100%;color:var(--muted);font-size:.9rem;padding:20px;text-align:center">No 3D model in manual mode.<br>Areas are used directly for the RETV screen.</div>`; viewer = null; $("v-status").textContent = ""; return; }
  try {
    if (!viewer) { $("viewer").innerHTML = `<div style="display:grid;place-items:center;height:100%;color:var(--muted)">Loading 3D viewer…</div>`; viewer = new ModelViewer($("viewer")); await viewer.init(); }
    let bytes = S.src === "ifc" ? ifcBytes : await (await fetch("data/sample_house.ifc")).arrayBuffer();
    if (!bytes) { viewer.schematic(p); $("v-status").textContent = "Schematic view from the saved model data (re-upload the IFC to see its geometry). Wall height assumed 3 m."; return; }
    try { const n = await viewer.model(bytes, p); $("v-status").textContent = `Model geometry (${n} meshes, tessellated by web-ifc). Drag to orbit, scroll to zoom. Walls are coloured by U-value; grey = unmapped or not a wall. Red arrow = true north.`; }
    catch (e) { const n = viewer.schematic(p); $("v-status").textContent = `Schematic view (${n} walls from placements and areas, height assumed 3 m) because model geometry could not be shown: ${e.message}.`; }
  } catch (e) { $("viewer").innerHTML = `<div style="display:grid;place-items:center;height:100%;color:var(--muted);padding:20px;text-align:center">3D viewer unavailable (${esc(e.message)}). The analysis below does not depend on it.</div>`; viewer = null; }
}
function renderWalls(p) {
  $("m-walls").innerHTML = `<table><tr><th>Wall</th><th>Facing</th><th class="num">Net area (m²)</th><th>Layers → ENS Table 46</th><th class="num">U (W/m²K)</th></tr>` +
    p.walls.map(w => `<tr><td>${esc(w.name)}${w.external ? "" : " <span class='tag'>internal</span>"}</td><td>${w.orientation} ${w.azimuth_deg != null ? `<span class="small mut">${w.azimuth_deg}° · ${esc(w.orientation_source.replace("_", " "))}</span>` : ""}</td><td class="num">${f(w.area_m2, 2)}</td>` +
      `<td class="small">${w.layers.length ? w.layers.map(l => `${l.t_mm} mm ${esc(l.material)}${l.catalogue_ref ? "" : " <span class='tag bad'>unmapped</span>"}`).join(" + ") : "<span class='mut'>chosen per candidate</span>"}</td>` +
      `<td class="num">${w.u_value != null ? f(w.u_value, 2) : "<span class='mut'>–</span>"}</td></tr>`).join("") + `</table>` +
    (p.openings.length ? `<details><summary>${p.openings.length} openings</summary><table><tr><th>Opening</th><th>Facing</th><th class="num">Area (m²)</th><th class="num">U</th><th class="num">SHGC</th></tr>${p.openings.map(o => `<tr><td>${esc(o.name)}</td><td>${o.orientation}</td><td class="num">${f(o.area_m2, 2)}</td><td class="num">${o.u ?? "<span class='tag bad'>missing</span>"}</td><td class="num">${o.shgc ?? "<span class='tag bad'>missing</span>"}</td></tr>`).join("")}</table></details>` : "");
}

// ------------------------------------------------------------ 3 goals
$("g-preset").innerHTML = Object.entries(PRESETS).map(([k, p]) => `<button data-k="${k}"><b>${p.t}</b><span>${p.d}</span></button>`).join("");
const presetBtns = [...$("g-preset").querySelectorAll("button")];
presetBtns.forEach(b => b.onclick = () => { S.preset = b.dataset.k; S.weights = { ...PRESETS[b.dataset.k].w }; save(); renderSliders(); update(); });
function renderSliders() {
  presetBtns.forEach(b => b.classList.toggle("on", b.dataset.k === S.preset));
  $("g-sliders").innerHTML = db.criteria.map(c => `<div class="slider"><span>${AX[c.id]}</span><input type="range" min="0" max="0.6" step="0.01" value="${S.weights[c.id]}" data-c="${c.id}" aria-label="${AX[c.id]} weight"><b id="wv-${c.id}">${f(S.weights[c.id])}</b></div>`).join("");
  $("g-sliders").querySelectorAll("input").forEach(i => i.oninput = () => { S.weights[i.dataset.c] = +i.value; S.preset = "custom"; presetBtns.forEach(b => b.classList.remove("on")); $("wv-" + i.dataset.c).textContent = f(+i.value); save(); update(); });
}
$("g-grade").value = S.grade; $("g-grade").onchange = e => { S.grade = e.target.value; save(); update(); };
$("g-comp").value = S.comp; $("g-compv").textContent = f(S.comp); $("g-comp").oninput = e => { S.comp = +e.target.value; $("g-compv").textContent = f(S.comp); save(); update(); };
$("g-retv").checked = S.retvGate; $("g-retv").onchange = e => { S.retvGate = e.target.checked; save(); update(); };

// ------------------------------------------------------------ 4 results
function update() {
  const p = lastProject || currentProject();
  const sub = p.retv_if_all_walls_were || {};
  const ensApplies = S.type === "residential";
  const elig = {};
  if (S.retvGate && ensApplies) for (const [id, r] of Object.entries(sub)) if (!r.compliant_at_limit) elig[id] = { thermal_code: "fail" };
  const res = E.rank(db, derived, { weights: S.weights, gateWeights: BASE, minGrade: S.grade, minCompleteness: S.comp, eligOverrides: elig });
  lastRes = res;
  const area = p.walls.filter(w => w.external).reduce((s, w) => s + (w.area_m2 || 0), 0);
  const ci = nearestCity(S.lat ?? cities[S.city].lat, S.lon ?? cities[S.city].lon);
  $("p-locnote").textContent = S.lat != null ? `Nearest station: ${cities[ci.key].name}, about ${Math.round(ci.km)} km away${ci.key !== S.city ? " (you selected another)" : ""}. ${S.lat >= 23.5 ? "Latitude ≥ 23.5 N: Kerala orientation factors would not apply." : ""}` : "Enter coordinates or load a model to check the nearest station.";
  $("b-area").textContent = area ? `Opaque external wall area in the current model: ${f(area, 1)} m².` : "Load a model or enter areas to get the wall area.";

  // lead + tiles
  const top = res.ranked[0];
  $("r-lead").innerHTML = top ? `${esc(S.name || "This project")}: <b>${esc(SHORT(top.id))}</b> ranks first on the evidence available (${top.criteria_used.map(c => AX[c]).join(" and ")} scored). Treat it as a starting point for the brief, not a recommendation.` : "No material meets the evidence gate at these settings. Lower the completeness threshold to see materials ranked on less evidence.";
  const priced = Object.entries(derived).filter(([, v]) => v.cost).map(([id, v]) => ({ id, total: v.cost.value * area }));
  const fits = S.budget ? priced.filter(x => x.total <= S.budget).length : null;
  const cur = p.retv_as_modelled;
  $("r-tiles").innerHTML =
    `<div class="card tile"><p class="k">Ranks first</p><p class="v" style="font-size:1.35rem">${top ? esc(SHORT(top.id)) : "none"}</p><p class="d">${top ? `score ${f(top.score, 3)} <span class="tag warn">partial · ${f(top.completeness)}</span>` : ""}</p></div>` +
    `<div class="card tile"><p class="k">Options with enough evidence</p><p class="v">${res.ranked.length} <span style="font-size:1rem;color:var(--muted)">of ${db.candidates.length}</span></p><p class="d">${res.excluded.length} lack cited data</p></div>` +
    `<div class="card tile"><p class="k">RETV of the model as drawn</p>${cur && ensApplies ? C.meter(cur.retv, cur.limit, { unit: "W/m²", title: "RETV as modelled", size: 170 }) : `<p class="v">–</p><p class="d">${ensApplies ? "needs mapped walls and window data" : "ENS RETV applies to residential buildings"}</p>`}</div>` +
    `<div class="card tile"><p class="k">Within masonry budget</p><p class="v">${fits == null ? "–" : fits + ` <span style="font-size:1rem;color:var(--muted)">of ${priced.length} priced</span>`}</p><p class="d">${S.budget ? inr(S.budget) + " for " + f(area, 0) + " m²" : "set a budget in step 3"}</p></div>`;

  // stacked composition
  const names = db.criteria.map(c => AX[c.id]);
  $("r-stack").innerHTML = res.ranked.length ? C.stackedBars(res.ranked.map(r => ({ label: SHORT(r.id), total: r.score, parts: r.breakdown.map(b => ({ name: AX[b.criterion_id], value: b.contribution })) })), names, { title: "score composition", width: W("r-stack") }) +
    (res.ranked[0].unscored_criteria.length ? `<p class="small mut">Not scored: ${res.ranked[0].unscored_criteria.map(c => AX[c]).join(", ")} (a criterion is scored only when every ranked option has a cited value).</p>` : "") : "<p class='mut'>Nothing ranked.</p>";

  // radar top 3
  const top3 = res.ranked.slice(0, 3);
  $("r-radar").innerHTML = top3.length ? C.radar(db.criteria.map(c => AX[c.id]), top3.map((r, i) => ({ name: SHORT(r.id), color: C.SERIES[i], values: db.criteria.map(c => r.breakdown.find(b => b.criterion_id === c.id)?.normalised ?? null) })), { title: "criteria profile", size: W("r-radar") }) : "<p class='mut'>Nothing ranked.</p>";

  // RETV bars
  const retvRows = Object.entries(sub).sort((a, b) => a[1].retv - b[1].retv).map(([id, r]) => ({ label: SHORT(id), value: r.retv, tipLabel: `${NAME(id)} · ${r.compliant_at_limit ? "at or below" : "above"} limit (rounded ${r.retv_rounded})` }));
  $("r-retv-sub").textContent = ensApplies ? `Whole-envelope value for this model's windows and orientations (warm-humid a 5.15, b 1.31, c 65.21). Line = ENS limit ${db.retv.limit_w_m2} W/m²${S.tRetv ? `; your target is ${S.tRetv} W/m²` : ""}. Not a compliance determination.` : "ENS 2024 RETV applies to residential buildings; shown for reference only.";
  $("r-retv").innerHTML = retvRows.length ? C.rankedBars(retvRows, { unit: "W/m²", limit: { value: db.retv.limit_w_m2, label: `ENS limit ${db.retv.limit_w_m2}` }, title: "RETV by wall option", width: W("r-retv") }) : "<p class='mut'>Needs wall areas (load a model or enter areas).</p>";

  // scatter
  const pts = Object.entries(derived).filter(([, v]) => v.u_value && v.gwp_core).map(([id, v]) => ({ label: SHORT(id), x: v.u_value.value, y: v.gwp_core.value }));
  $("r-scatter").innerHTML = C.scatter(pts, { xLabel: "Wall U-value (W/m²K)", yLabel: "Core carbon (kgCO₂e/m²)", xUnit: "W/m²K", yUnit: "kgCO₂e/m²", title: "U-value vs carbon", width: W("r-scatter"), height: 280 }) +
    `<p class="small mut">Carbon covers the masonry core only and mixes sources and lifecycle boundaries (Auroville 2005, UK EPD via Climatiq). ${S.tU ? `Your U target: ${S.tU} W/m²K.` : ""}</p>`;

  // decrement
  const dec = Object.entries(ind).filter(([, v]) => v).sort((a, b) => a[1].decrement_factor - b[1].decrement_factor).map(([id, v]) => ({ label: SHORT(id), value: v.decrement_factor, tipLabel: `${NAME(id)} · time lag ${f(v.time_lag_h, 1)} h` }));
  $("r-dec").innerHTML = C.rankedBars(dec, { max: 1, decimals: 2, title: "decrement factor", width: W("r-dec") });

  // budget
  const bRows = priced.sort((a, b) => a.total - b.total).map(x => ({ label: SHORT(x.id), value: x.total, tipLabel: `${NAME(x.id)} · ${inr(derived[x.id].cost.value)}/m² × ${f(area, 1)} m²` }));
  $("r-budget-sub").textContent = `Unit price × pieces per m² × opaque wall area. Prices are aggregator estimates (S11), not quotations.${S.budget ? " Line = your budget." : ""}`;
  $("r-budget").innerHTML = area && bRows.length ? C.rankedBars(bRows, { unit: "₹", decimals: 0, width: W("r-budget"), limit: S.budget ? { value: S.budget, label: "budget " + inr(S.budget) } : null, title: "masonry cost" }) +
    `<p class="small mut">No price listing yet for: ${db.candidates.filter(c => !derived[c.id].cost).map(c => SHORT(c.id)).join(", ")}.</p>` : "<p class='mut'>Needs a wall area.</p>";

  // details table
  $("r-table").innerHTML = `<table><tr><th>#</th><th>Wall option</th><th class="num">Score</th><th class="num">Evidence</th><th class="num">U</th><th class="num">Carbon</th><th class="num">₹/m²</th><th class="num">RETV</th><th class="num">Decrement</th></tr>` +
    [...res.ranked.map(r => ({ r, id: r.id })), ...res.excluded.map(e => ({ e, id: e.id }))].map(({ r, e, id }) => {
      const d = derived[id], rv = sub[id], i2 = ind[id];
      return `<tr><td>${r ? r.rank : "–"}</td><td>${esc(NAME(id))}${e ? `<br><span class="small mut">${esc(e.reason)}</span>` : ""}</td><td class="num">${r ? "<b>" + f(r.score, 3) + "</b>" : "–"}</td><td class="num">${f((r || e).completeness)}</td>` +
        `<td class="num">${d.u_value ? f(d.u_value.value) : "–"}</td><td class="num">${d.gwp_core ? f(d.gwp_core.value, 1) : "–"}</td><td class="num">${d.cost ? Math.round(d.cost.value) : "–"}</td>` +
        `<td class="num">${rv ? f(rv.retv, 1) + (rv.compliant_at_limit ? "" : " <span class='tag bad'>over</span>") : "–"}</td><td class="num">${i2 ? f(i2.decrement_factor) : "–"}</td></tr>`;
    }).join("") + `</table>` + res.warnings.map(w => `<div class="note">${esc(w)}</div>`).join("");

  renderClimate(); renderEvidence(res);
  explain(false);
}

// ------------------------------------------------------------ climate
function renderClimate() {
  const k = S.city, cs = D.climate_summary[k], m = cities[k].monthly;
  const DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  $("c-tiles").innerHTML = [["Mean temperature", f(cs.t_mean_c, 1) + " °C", `hottest ${cs.hottest_month}: daily max ${f(cs.t_max_hottest, 1)} °C`],
    ["Mean relative humidity", f(cs.rh_mean_pct, 0) + " %", `RH ≥ 80 % in ${cs.humid_months.length} months`],
    ["Annual rainfall", Math.round(cs.rain_mm_year).toLocaleString("en-IN") + " mm", `peak ${cs.peak_rain_month}; wet months ${cs.wet_months.join(", ")}`],
    ["Solar on horizontal", f(cs.ghi_kwh_m2_day, 1) + " kWh/m²/day", "annual mean"]].map(([a, b, c]) => `<div class="card tile"><p class="k">${a}</p><p class="v" style="font-size:1.5rem">${b}</p><p class="d">${esc(c)}</p></div>`).join("");
  $("c-charts").innerHTML = [["Mean daily maximum (°C)", m.T2M_MAX, "°C", 20], ["Relative humidity (%)", m.RH2M, "%", 0], ["Rainfall (mm per month)", m.PRECTOTCORR.map((v, i) => v * DAYS[i]), "mm", 0], ["Solar, horizontal (kWh/m²/day)", m.ALLSKY_SFC_SW_DWN, "kWh/m²/day", 0]]
    .map(([t, v, u, lo]) => `<div class="card"><h3 style="font-size:.88rem">${t}</h3>${C.monthCols(v, { unit: u, min: lo, title: t, width: Math.max(220, Math.round(($("c-charts").clientWidth - 42) / (innerWidth < 640 ? 1 : innerWidth < 900 ? 2 : 4)) - 36) })}<details><summary class="small">table</summary><table>${v.map((x, i) => `<tr><td>${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i]}</td><td class="num">${f(x, 1)}</td></tr>`).join("")}</table></details></div>`).join("");
  $("c-flag").textContent = cs.moisture_flag + " Source S13: NASA POWER gridded climatology, not station or EPW data; the daily maxima look high for coastal sites, so cross-check with IMD or ISHRAE data. " + D.climate.ens_zone_note;
}

// ------------------------------------------------------------ evidence
function renderEvidence(res) {
  const cols = db.criteria.map(c => c.id);
  $("e-matrix").innerHTML = C.evidenceMatrix(db.candidates.map(c => SHORT(c.id)), cols.map(c => AX[c]), (i, j) => {
    const v = derived[db.candidates[i].id][cols[j]];
    return v ? { grade: v.grade, tip: v.status + (v.source ? " · " + v.source : "") } : null;
  });
  $("e-lib").innerHTML = `<table><tr><th>Wall option</th><th>Assembly</th><th class="num">U</th><th class="num">Lag (h)</th></tr>` + db.candidates.map(c => {
    const lay = c.assembly.layers.map(l => l.ref ? `${l.t_mm} ${esc(db.layer_catalogue[l.ref].name.split(",")[0])}` : `<i>${l.t_mm} ${esc(l.label)}</i>`).join(" + ") || "<i>no assembly defined</i>";
    return `<tr><td><b>${esc(SHORT(c.id))}</b><br><span class="small mut">${esc(c.maturity)}</span></td><td class="small">${lay}${c.assembly.note ? `<br><span class="mut">${esc(c.assembly.note)}</span>` : ""}</td><td class="num">${derived[c.id].u_value ? f(derived[c.id].u_value.value) : "–"}</td><td class="num">${ind[c.id] ? f(ind[c.id].time_lag_h, 1) : "–"}</td></tr>`;
  }).join("") + `</table>`;
  const fw = D.framework, st = ["implemented", "partial", "data_needed"], lab = { implemented: "Implemented", partial: "Partial", data_needed: "Data needed" };
  $("e-fw-sub").textContent = `${fw.count} criteria in 7 categories from your framework (S14). ${fw.categories.flatMap(c => c.criteria).filter(x => x.engine_status !== "data_needed").length} are implemented or partly implemented.`;
  $("e-fw").innerHTML = C.stackedBars(fw.categories.map(c => ({ label: c.name.replace(/^\d+ /, ""), total: c.criteria.length, parts: st.map(s => ({ name: lab[s], value: c.criteria.filter(x => x.engine_status === s).length })) })), st.map(s => lab[s]), { max: 10, title: "framework coverage", width: W("e-fw"), colors: ["var(--s1)", "var(--q2)", "url(#hatch-s)"] }) +
    fw.categories.map(c => `<details><summary>${esc(c.name)}</summary><table>${c.criteria.map(x => `<tr><td>${esc(x.name)}</td><td class="small">${esc(x.unit)}</td><td>${x.engine_status === "data_needed" ? "<span class='tag'>data needed</span>" : x.engine_status === "partial" ? "<span class='tag warn'>partial</span>" : "<span class='tag good'>✓ implemented</span>"}</td><td class="small mut">${esc(x.note)}</td></tr>`).join("")}</table></details>`).join("");
}
$("e-rat").innerHTML = `<h3 style="margin-top:12px">Codes and rating systems</h3><table><tr><th>System</th><th>Requirement</th><th>Read in primary</th></tr>` + D.ratings.items.map(r => `<tr><td>${esc(r.system)}<br><span class="small mut">${esc(r.ref)}</span></td><td class="small">${esc(r.requirement)}</td><td>${r.verified ? "<span class='tag good'>✓ yes</span>" : "<span class='tag warn'>secondary only</span>"}</td></tr>`).join("") + `</table>`;
$("e-src").innerHTML = `<h3 style="margin-top:16px">Source register</h3><table><tr><th>ID</th><th>Source</th><th>Verification</th></tr>` + D.sources.map(s => `<tr><td>${s.id}</td><td>${esc(s.title)}<br><span class="small mut">${esc(s.org)}</span>${s.url ? ` · <a class="small" href="${esc(s.url)}" target="_blank" rel="noopener">link</a>` : ""}</td><td class="small">${esc(s.verification.replace(/_/g, " "))}<br><span class="mut">${esc(s.note)}</span></td></tr>`).join("") + `</table>`;

// ------------------------------------------------------------ explanation (AI layer)
let explainTimer = null;
function factsFor() {
  const p = lastProject, cur = p.retv_as_modelled;
  return X.buildFacts(lastRes, db, derived, D.sources, { indicators: ind, climate: D.climate_summary[S.city], retvSub: S.type === "residential" ? p.retv_if_all_walls_were : null,
    project: { retv_modelled: cur ? cur.retv : 0, a_env: cur ? cur.a_env_m2 : 0, n_walls: p.walls.filter(w => w.external).length, n_openings: p.openings.length } });
}
async function explain(useTier = true) {
  if (!lastRes) return;
  clearTimeout(explainTimer);
  const run = async () => {
    const tier = useTier ? $("x-tier").value : "deterministic";
    $("x-status").textContent = tier === "deterministic" ? "" : "working…";
    const out = await X.explain(factsFor(), tier, { onProgress: t => $("x-status").textContent = t, url: "http://localhost:11434", model: BACKEND?.default_model || "qwen2.5:1.5b", backend: !!BACKEND });
    $("x-status").textContent = "";
    let h = out.text.split("\n\n").map(p => `<p>${esc(p)}</p>`).join("");
    h += `<p class="small ${out.audit.ok ? "audit-ok" : "audit-bad"}">${out.audit.ok ? "✓ Fidelity audit passed: every number traces to the engine output and no unsupported claims were found." : "✕ Audit issues: " + out.audit.issues.map(i => esc(i.detail)).join("; ")} · shown: ${out.tier}</p>`;
    if (out.fallbackReason) h += `<details><summary class="small">Why the optional model output was not used</summary><pre class="small" style="white-space:pre-wrap">${esc(JSON.stringify(out.fallbackReason, null, 1))}</pre></details>`;
    $("x-out").innerHTML = h;
  };
  if (useTier) await run(); else explainTimer = setTimeout(run, 250);
}
$("x-go").onclick = () => explain(true);

// ------------------------------------------------------------ step highlighting
const links = [...document.querySelectorAll("#steps a")];
const stepIds = ["s-project", "s-model", "s-goals", "s-results", "s-evidence"];
const markStep = () => { let on = stepIds[0]; for (const id of stepIds) if ($(id).getBoundingClientRect().top < 140) on = id; links.forEach(a => a.classList.toggle("on", a.dataset.step === on)); };
addEventListener("scroll", markStep, { passive: true }); markStep();

let rz = null; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(update, 200); });

// ------------------------------------------------------------ backend (optional: FastAPI + IfcOpenShell + Ollama on this machine)
async function detectBackend() {
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 2500);
    const r = await fetch("api/health", { signal: ctl.signal });
    BACKEND = r.ok ? await r.json() : null;
  } catch { BACKEND = null; }
  const el = $("backend");
  if (BACKEND) {
    el.className = "tag good"; el.textContent = "✓ Local backend";
    el.title = `IfcOpenShell ${BACKEND.ifcopenshell} · Ollama ${BACKEND.ollama.running ? "running (" + (BACKEND.ollama.models.join(", ") || "no models") + ")" : "not running"}`;
  } else { el.className = "tag"; el.textContent = "Browser only"; el.title = "No local backend found: IFC is read by the built-in parser; Ollama is called directly if you pick it."; }
  const opt = $("x-tier").querySelector('option[value="ollama"]');
  opt.textContent = BACKEND ? `Local Ollama via backend (${BACKEND.ollama.running ? BACKEND.default_model : "Ollama not running"})` : "Local Ollama model (optional)";
}

// ------------------------------------------------------------ boot
if (S.src === "ifc" && !S.ifcProject) S.src = "sample";
await detectBackend();
try {
  const sb = await (await fetch("data/sample_house.ifc")).arrayBuffer();
  if (BACKEND) { const r = await fetch("api/ifc", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: sb }); if (r.ok) sampleProject = await r.json(); else throw new Error(); }
  else sampleProject = B.analyse(new TextDecoder().decode(sb), db, derived);
} catch { try { sampleProject = B.analyse(await (await fetch("data/sample_house.ifc")).text(), db, derived); } catch { /* keep the Python-built copy */ } }
renderSliders(); renderModelSide(); loadModel();
