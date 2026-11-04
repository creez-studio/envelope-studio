// app.js - Envelope Studio: project intake -> BIM model -> goals & budget -> results, climate, evidence.
// All calculation is in engine.js / bim.js (parity-tested against Python and Java). This file only wires inputs to outputs.
import * as E from "./engine.js";
import * as X from "./explain.js";
import * as B from "./bim.js";
import * as C from "./charts.js";
import { ModelViewer, RAMP_STOPS } from "./viewer.js";
import * as SOL from "./solar.js";
import * as ST from "./studio.js";

const $ = id => document.getElementById(id);
const esc = C.esc;
const f = (x, n = 2) => x == null || !isFinite(x) ? "n/a" : (+x).toFixed(n);
const W = id => Math.max(280, Math.round($(id).clientWidth || 600));
const inr = x => "₹" + Math.round(x).toLocaleString("en-IN");
const D = await (await fetch("data/dataset.json")).json();
const db0 = D.db; let db = db0, derived = E.deriveValues(db0), ind = E.indicators(db0), lastSub = {};
function refreshData() { db = ST.applyChoices(db0, D.market, S.choices); derived = E.deriveValues(db); ind = E.indicators(db); }
const NAME = id => db.candidates.find(c => c.id === id)?.name ?? id;
const LABEL = { LAT: "Laterite", BRICK: "Clay brick", AAC: "AAC", CSEB: "CSEB", HCB: "Hollow concrete", FAB: "Fly ash brick", PCB: "Hollow clay block", GEO: "Geopolymer", RAB: "Recycled aggregate",
  SAND: "Brick + EPS sandwich", CLC: "CLC block", BRKCOIR: "Brick + coir board", SAND_CLC: "CLC + EPS sandwich", SCB: "Solid concrete block" };
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
S.choices ||= {}; S.studio ||= "AAC"; S.applyAll ??= false; S.sunMonth ??= new Date().getMonth(); S.sunHour ??= 10; S.sunNow ??= false; S.facade ||= "W";
if (!db0.candidates.some(c => c.id === S.studio)) S.studio = "AAC";
refreshData();
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
      <label class="drop" id="drop"><input type="file" id="ifc-file" accept=".ifc,.rvt,.rfa" hidden><b>Drop an IFC or Revit file here</b><br><span class="small">.ifc is read directly · .rvt needs an IFC export (steps below)</span></label>` + IFC_HELP +
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
const IFC_HELP = `<details class="ifc-help"><summary><b>Exporting from Revit, ArchiCAD or SketchUp</b></summary><ol style="margin:6px 0 0;padding-left:18px">
  <li><b>Revit:</b> File → Export → IFC. Choose IFC4 Reference View (or IFC2x3 Coordination View 2.0), tick <i>Export base quantities</i> and <i>Export IFC common property sets</i>, set the project location and true north in Manage → Location, then export.</li>
  <li><b>ArchiCAD:</b> File → Save as → IFC, translator "General Translator", with property sets and quantities.</li>
  <li><b>SketchUp / others:</b> use an IFC exporter; walls need material layers named e.g. "Burnt clay brick", "AAC block", "Cement plaster".</li>
  <li>Windows need <i>ThermalTransmittance</i> and <i>SolarHeatGainTransmittance</i> (Pset_WindowCommon) for the RETV.</li></ol>
  <p class="small mut" style="margin:6px 0 0">Revit's native .rvt is a closed Autodesk format: no browser or open-source tool (including IfcOpenShell) can read it, so the IFC export is required.</p></details>`;
function modelFacts(p) {
  const ext = p.walls.filter(w => w.external);
  return `<dl class="kv"><dt>Site</dt><dd>${p.site.lat != null ? f(p.site.lat, 3) + " N, " + f(p.site.lon, 3) + " E" : "not in model"}</dd>
    <dt>Read by</dt><dd>${esc(p.reader || "built-in text parser (browser)")}</dd><dt>True north</dt><dd>${f(p.true_north_ccw_deg, 1)}° from project +Y</dd><dt>External walls</dt><dd>${ext.length} · ${f(ext.reduce((s, w) => s + (w.area_m2 || 0), 0), 1)} m² net</dd>
    <dt>Openings</dt><dd>${p.openings.length} · ${f(p.openings.reduce((s, o) => s + o.area_m2, 0), 1)} m²</dd>
    <dt>RETV as modelled</dt><dd>${p.retv_as_modelled ? f(p.retv_as_modelled.retv, 2) + " W/m²" : "not available"}</dd></dl>` +
    (p.warnings || []).map(w => `<div class="note">${esc(w)}</div>`).join("");
}
async function readIfc(file) {
  if (/\.(rvt|rfa|rte)$/i.test(file.name)) {
    $("v-status").innerHTML = `<b>${esc(file.name)}</b> is a native Revit file, which cannot be read outside Revit. Export it as IFC (open "Exporting from Revit" above) and upload the .ifc.`;
    const d = document.querySelector(".ifc-help"); if (d) d.open = true; return;
  }
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
    try { const n = await viewer.model(bytes, p); $("v-status").textContent = `Model geometry (${n} meshes, tessellated by web-ifc). Drag to orbit, scroll to zoom. Walls are coloured by U-value (grey = unmapped); the compass shows true north; the yellow sphere and shadows follow the sun study.`; }
    catch (e) { const n = viewer.schematic(p); $("v-status").textContent = `Schematic view (${n} walls from placements and areas, height assumed 3 m) because model geometry could not be shown: ${e.message}.`; }
    paintViewer(); sunStudy();
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
  const extW = p.walls.filter(w => w.external && w.area_m2 != null), okO = p.openings.filter(o => o.u != null && o.shgc != null);
  const sub = extW.length ? E.retvSubstitution(db, derived, { walls: extW, openings: okO }) : {};
  lastSub = sub;
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
  const cur = S.applyAll && sub[S.studio] ? sub[S.studio] : p.retv_as_modelled;
  $("r-tiles").innerHTML =
    `<div class="card tile"><p class="k">Ranks first</p><p class="v" style="font-size:1.35rem">${top ? esc(SHORT(top.id)) : "none"}</p><p class="d">${top ? `score ${f(top.score, 3)} <span class="tag warn">partial · ${f(top.completeness)}</span>` : ""}</p></div>` +
    `<div class="card tile"><p class="k">Options with enough evidence</p><p class="v">${res.ranked.length} <span style="font-size:1rem;color:var(--muted)">of ${db.candidates.length}</span></p><p class="d">${res.excluded.length} lack cited data</p></div>` +
    `<div class="card tile"><p class="k">RETV of the model as drawn</p>${cur && ensApplies ? C.meter(cur.retv, cur.limit, { unit: "W/m²", title: "RETV as modelled", size: 170 }) : `<p class="v">–</p><p class="d">${ensApplies ? "needs mapped walls and window data" : "ENS RETV applies to residential buildings"}</p>`}</div>` +
    `<div class="card tile"><p class="k">Within masonry budget</p><p class="v">${fits == null ? "–" : fits + ` <span style="font-size:1rem;color:var(--muted)">of ${priced.length} priced</span>`}</p><p class="d">${S.budget ? inr(S.budget) + " for " + f(area, 0) + " m²" : "set a budget in step 3"}</p></div>`;

  // stacked composition
  const names = db.criteria.map(c => AX[c.id]);
  $("r-stack").innerHTML = res.ranked.length ? C.stackedBars(res.ranked.map(r => ({ id: r.id, label: SHORT(r.id), total: r.score, parts: r.breakdown.map(b => ({ name: AX[b.criterion_id], value: b.contribution })) })), names, { title: "score composition", width: W("r-stack") }) +
    (res.ranked[0].unscored_criteria.length ? `<p class="small mut">Not scored: ${res.ranked[0].unscored_criteria.map(c => AX[c]).join(", ")} (a criterion is scored only when every ranked option has a cited value).</p>` : "") : "<p class='mut'>Nothing ranked.</p>";

  // radar top 3
  const top3 = res.ranked.slice(0, 3);
  $("r-radar").innerHTML = top3.length ? C.radar(db.criteria.map(c => AX[c.id]), top3.map((r, i) => ({ name: SHORT(r.id), color: C.SERIES[i], values: db.criteria.map(c => r.breakdown.find(b => b.criterion_id === c.id)?.normalised ?? null) })), { title: "criteria profile", size: W("r-radar") }) : "<p class='mut'>Nothing ranked.</p>";

  // RETV bars
  const retvRows = Object.entries(sub).sort((a, b) => a[1].retv - b[1].retv).map(([id, r]) => ({ id, fill: id === S.studio ? "var(--s2)" : null, label: SHORT(id), value: r.retv, tipLabel: `${NAME(id)} · ${r.compliant_at_limit ? "at or below" : "above"} limit (rounded ${r.retv_rounded})` }));
  $("r-retv-sub").textContent = ensApplies ? `Whole-envelope value for this model's windows and orientations (warm-humid a 5.15, b 1.31, c 65.21). Line = ENS limit ${db.retv.limit_w_m2} W/m²${S.tRetv ? `; your target is ${S.tRetv} W/m²` : ""}. Not a compliance determination.` : "ENS 2024 RETV applies to residential buildings; shown for reference only.";
  $("r-retv").innerHTML = retvRows.length ? C.rankedBars(retvRows, { unit: "W/m²", limit: { value: db.retv.limit_w_m2, label: `ENS limit ${db.retv.limit_w_m2}` }, title: "RETV by wall option", width: W("r-retv") }) : "<p class='mut'>Needs wall areas (load a model or enter areas).</p>";

  // scatter
  const pts = Object.entries(derived).filter(([, v]) => v.u_value && v.gwp_core).map(([id, v]) => ({ id, fill: id === S.studio ? "var(--s2)" : null, label: SHORT(id), x: v.u_value.value, y: v.gwp_core.value }));
  $("r-scatter").innerHTML = C.scatter(pts, { xLabel: "Wall U-value (W/m²K)", yLabel: "Core carbon (kgCO₂e/m²)", xUnit: "W/m²K", yUnit: "kgCO₂e/m²", title: "U-value vs carbon", width: W("r-scatter"), height: 280 }) +
    `<p class="small mut">Carbon covers the masonry core only and mixes sources and lifecycle boundaries (Auroville 2005, UK EPD via Climatiq). ${S.tU ? `Your U target: ${S.tU} W/m²K.` : ""}</p>`;

  // decrement
  const dec = Object.entries(ind).filter(([, v]) => v).sort((a, b) => a[1].decrement_factor - b[1].decrement_factor).map(([id, v]) => ({ id, fill: id === S.studio ? "var(--s2)" : null, label: SHORT(id), value: v.decrement_factor, tipLabel: `${NAME(id)} · time lag ${f(v.time_lag_h, 1)} h` }));
  $("r-dec").innerHTML = C.rankedBars(dec, { max: 1, decimals: 2, title: "decrement factor", width: W("r-dec") });

  // budget
  const bRows = priced.sort((a, b) => a.total - b.total).map(x => ({ id: x.id, fill: x.id === S.studio ? "var(--s2)" : null, label: SHORT(x.id), value: x.total, tipLabel: `${NAME(x.id)} · ${inr(derived[x.id].cost.value)}/m² × ${f(area, 1)} m²` }));
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

  renderClimate(); renderEvidence(res); renderStudio(res, sub, area); renderSun(); paintViewer();
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
  return X.buildFacts(lastRes, db, derived, D.sources, { indicators: ind, climate: D.climate_summary[S.city], retvSub: S.type === "residential" ? lastSub : null,
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
const stepIds = ["s-project", "s-model", "s-goals", "s-studio", "s-results", "s-sun", "s-evidence"];
const markStep = () => { let on = stepIds[0]; for (const id of stepIds) if ($(id).getBoundingClientRect().top < 140) on = id; links.forEach(a => a.classList.toggle("on", a.dataset.step === on)); };
addEventListener("scroll", markStep, { passive: true }); markStep();

let rz = null; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(update, 200); });

// ------------------------------------------------------------ material studio
$("st-apply").checked = S.applyAll; $("st-apply").onchange = e => { S.applyAll = e.target.checked; save(); update(); };
$("st-var").onchange = e => { S.choices[S.studio] = e.target.value; save(); refreshData(); update(); };
function selectStudio(id) { S.studio = id; save(); update(); }
function renderStudio(res, sub, area) {
  const cid = S.studio, cand = db.candidates.find(c => c.id === cid), d = derived[cid];
  const ranked = new Set(res.ranked.map(r => r.id));
  $("st-chips").innerHTML = db.candidates.map(c => `<button data-c="${c.id}" class="${c.id === cid ? "on" : ""}" title="${esc(c.name)}"><i style="background:${ranked.has(c.id) ? "var(--good)" : "var(--line-2)"}"></i>${esc(SHORT(c.id))}</button>`).join("");
  $("st-chips").querySelectorAll("button").forEach(b => b.onclick = () => selectStudio(b.dataset.c));
  const vars = D.market.products[cid] || [];
  $("st-var").innerHTML = `<option value="base">As published in the dataset</option>` + vars.map(v => `<option value="${v.id}">${esc(v.label)}${v.price_inr != null ? ` · INR ${v.price_inr}/piece` : " · no price"}</option>`).join("");
  $("st-var").value = S.choices[cid] || "base";
  const v = ST.activeVariant(db0, D.market, S.choices, cid), bud = v && v.price_inr != null ? ST.budgetFor(v, area || 0) : null;
  const r = res.ranked.find(x => x.id === cid), rv = sub[cid];
  // tiles
  $("st-tiles").innerHTML =
    `<div class="card tile"><p class="k">Masonry units for ${f(area || 0, 0)} m²</p><p class="v" style="font-size:1.5rem">${bud && area ? inr(bud.total) : "–"}</p><p class="d">${bud ? `INR ${Math.round(bud.inr_m2)}/m² · ${f(bud.pieces_m2, 1)} pieces/m² · ${Math.ceil(bud.pieces_total || 0)} pieces${bud.low != null && area ? `<br>range ${inr(bud.low)} – ${inr(bud.high)}` : ""}` : "no price for this variant"}${S.budget && bud && area ? `<br><span class="tag ${bud.total <= S.budget ? "good" : "bad"}">${bud.total <= S.budget ? "✓ within" : "✕ over"} your ${inr(S.budget)}</span>` : ""}</p></div>` +
    `<div class="card tile"><p class="k">Wall U-value</p><p class="v">${d.u_value ? f(d.u_value.value) : "–"}<span style="font-size:.9rem;color:var(--muted)"> W/m²K</span></p><p class="d">${d.u_value ? `R ${f(1 / d.u_value.value)} m²K/W · ENS 2024 method` : "no cited conductivity"}${S.tU && d.u_value ? `<br><span class="tag ${d.u_value.value <= S.tU ? "good" : "bad"}">${d.u_value.value <= S.tU ? "✓ meets" : "✕ misses"} target ${S.tU}</span>` : ""}</p></div>` +
    `<div class="card tile"><p class="k">RETV if all walls were this</p>${rv ? C.meter(rv.retv, rv.limit, { unit: "W/m²", title: "RETV with this wall", size: 160 }) : `<p class="v">–</p><p class="d">needs a U-value and wall areas</p>`}</div>` +
    `<div class="card tile"><p class="k">Core carbon · evidence</p><p class="v">${d.gwp_core ? f(d.gwp_core.value, 1) : "–"}<span style="font-size:.9rem;color:var(--muted)"> kgCO₂e/m²</span></p><p class="d">${d.gwp_core ? `grade ${d.gwp_core.grade} · ${esc(d.gwp_core.source)}` : "no cited factor"}<br>${r ? `ranked ${r.rank} of ${res.ranked.length} · score ${f(r.score, 3)}` : "not ranked (evidence gate)"}</p></div>`;
  // rose
  $("st-rose").innerHTML = C.radialBars(db.criteria.map(c => AX[c.id]), db.criteria.map(c => r?.breakdown.find(b => b.criterion_id === c.id)?.normalised ?? null), { size: W("st-rose"), color: "var(--s2)", center: SHORT(cid), title: "criteria rose", missText: i => d[db.criteria[i].id] ? (r ? "not scored*" : "held, not ranked") : "no data" }) +
    `<p class="small mut">* held for this material but not scored, because a criterion is scored only when every ranked option has a value.</p>`;
  // data table
  const pr = D.market.properties[cid] || {}, cat = db.layer_catalogue;
  const core = cand.assembly.layers.filter(l => l.ref && !["cement_plaster", "eps_24", "coir_board_97"].includes(l.ref));
  const fmtP = x => !x ? "<span class='mut'>–</span>" : x.status === "conflicting" ? `<span class="tag warn">conflicting</span> <span class="small mut">${esc(x.note)}</span>` :
    `${x.range ? x.range.join("–") : x.min != null ? "≥ " + x.min : x.max != null ? "≤ " + x.max : x.value}<span class="src">${esc(x.source || "")} · ${esc(x.grade || "")}</span>${x.note ? `<br><span class="small mut">${esc(x.note)}</span>` : ""}`;
  const rows = [
    ["Unit size (L × H × wall)", v && v.l_mm ? `${f(v.l_mm, 0)} × ${f(v.h_mm, 0)} mm, wall ${f(v.t_mm ?? core[0]?.t_mm, 0)} mm${v.joint_mm ? `, ${v.joint_mm} mm joints` : ", thin/dry joints"}${v.wythes > 1 ? `, ${v.wythes} wythes` : ""}<span class="src">${esc(v.source || "")}</span>` : "<span class='mut'>–</span>"],
    ["Market price", v && v.price_inr != null ? `INR ${v.price_inr} per piece${v.price_range ? ` (range ${v.price_range.join("–")})` : ""}${v.city && v.city !== "-" ? " · " + esc(v.city) : ""}<span class="src">${esc(v.source)} · C</span>` : "<span class='mut'>not listed</span>"],
    ["Assembly", cand.assembly.layers.map(l => l.ref ? `${l.t_mm} mm ${esc(cat[l.ref].name.split(",")[0])}` : `<i>${l.t_mm} mm ${esc(l.label)}</i>`).join(" + ") || "<span class='mut'>not defined</span>"],
    ["Core density (ENS table)", core[0] ? `${cat[core[0].ref].density} kg/m³<span class="src">S01 · B</span>` : "–"],
    ["Product density (claimed)", fmtP(pr.density_kg_m3)],
    ["Conductivity k", core[0] ? `${cat[core[0].ref].k} W/mK (dry)<span class="src">S01 · B</span>` : "<span class='mut'>no cited value</span>"],
    ["Specific heat", core[0] && cat[core[0].ref].cp_kj_kgK ? `${cat[core[0].ref].cp_kj_kgK} kJ/kgK<span class="src">S01 · B</span>` : "–"],
    ["Compressive strength (N/mm²)", fmtP(pr.compressive_n_mm2)],
    ["Sound reduction (dB)", fmtP(pr.sound_db)],
    ["Water absorption (%)", fmtP(pr.water_absorption_pct)],
    ["Fire resistance (min)", fmtP(pr.fire_min)],
    ["Decrement / time lag", ind[cid] ? `${f(ind[cid].decrement_factor)} · ${f(ind[cid].time_lag_h, 1)} h<span class="src">EN ISO 13786</span>` : "–"],
    ["Indian standard", esc(pr.standard || "–") + (pr.note ? `<br><span class="small mut">${esc(pr.note)}</span>` : "")],
    ["Rating notes", (cand.rating_notes || []).map(esc).join("<br>") || "–"],
  ];
  $("st-data").innerHTML = `<table>${rows.map(([k, x]) => `<tr><th style="width:34%">${k}</th><td>${x}</td></tr>`).join("")}</table>`;
  // why / fit / save
  $("st-why").innerHTML = ST.reasons(db, res, derived, ind, sub, cid).map(t => `<li>${esc(t)}</li>`).join("");
  const cs = D.climate_summary[S.city], fit = [];
  if (rv) fit.push(`${rv.compliant_at_limit ? "✓" : "✕"} ENS RETV with this wall: ${f(rv.retv)} W/m² (limit ${rv.limit}); against the planned 12 W/m²: ${Math.floor(rv.retv + 0.5) <= 12 ? "✓ within" : "✕ above"}.`);
  if (ind[cid]) fit.push(`Hottest month (${cs.hottest_month}) indoor surface swing about ${f(ind[cid].decrement_factor * (cs.t_max_hottest - cs.t_min_hottest) / 2, 1)} °C for an outdoor swing of ${f((cs.t_max_hottest - cs.t_min_hottest) / 2, 1)} °C (air only, no solar).`);
  fit.push(`Climate: ${Math.round(cs.rain_mm_year).toLocaleString("en-IN")} mm rain a year, RH ≥ 80 % in ${cs.humid_months.length} months. ${cs.moisture_flag}`);
  if (S.budget && bud && area) fit.push(`${bud.total <= S.budget ? "✓" : "✕"} Masonry units ${inr(bud.total)} against your budget ${inr(S.budget)}.`);
  fit.push(`Structure, fire and moisture eligibility: not assessed in the platform; check against the product's IS test certificate.`);
  $("st-fit").innerHTML = fit.map(t => `<li>${esc(t)}</li>`).join("");
  const w = ST.whatIfs(db0, D.market, S.choices, lastProject || currentProject(), cid);
  $("st-save").innerHTML = w.tips.map(t => `<li><span class="tag">${t.kind}</span> ${esc(t.text)}${t.source ? `<span class="src">${esc(t.source)}</span>` : ""}</li>`).join("");
  const q = D.market.search.queries[cid] || SHORT(cid);
  $("st-links").innerHTML = `<p style="margin:10px 0 4px"><b>Check current prices</b> (opens IndiaMART search; prices there are sellers' asking rates):</p>` +
    D.market.search.cities.map(city => `<a href="${D.market.search.url_template.replace("{q}", encodeURIComponent(q).replace(/%20/g, "+")).replace("{city}", encodeURIComponent(city))}" target="_blank" rel="noopener">${esc(city)}</a>`).join(" · ");
}

// ------------------------------------------------------------ cross-highlighting: one material traced across every chart
const hlStyle = document.createElement("style"); document.head.appendChild(hlStyle);
document.addEventListener("pointerover", e => { const el = e.target.closest?.("[data-cand]"); const id = el?.dataset.cand;
  hlStyle.textContent = id ? `svg.chart [data-cand]:not([data-cand="${CSS.escape(id)}"]){opacity:.22} svg.chart [data-cand="${CSS.escape(id)}"]{opacity:1}` : ""; });
document.addEventListener("click", e => { const el = e.target.closest?.("svg.chart [data-cand]"); if (el?.dataset.cand && db.candidates.some(c => c.id === el.dataset.cand)) { selectStudio(el.dataset.cand); $("s-studio").scrollIntoView(); } });

// ------------------------------------------------------------ viewer paint + sun study
function paintViewer() {
  if (!viewer) return;
  const u = S.applyAll && derived[S.studio]?.u_value ? derived[S.studio].u_value.value : null;
  viewer.recolor(w => (u != null && w.external !== false) ? u : w.u_value);
}
const siteLat = () => S.lat ?? (lastProject || currentProject()).site.lat ?? cities[S.city].lat;
const siteLon = () => S.lon ?? (lastProject || currentProject()).site.lon ?? cities[S.city].lon;
$("sun-m").innerHTML = SOL.MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join("");
$("sun-m").value = S.sunMonth; $("sun-h").value = S.sunHour; $("sun-now").checked = S.sunNow;
$("sun-m").onchange = e => { S.sunMonth = +e.target.value; S.sunNow = false; $("sun-now").checked = false; save(); sunStudy(); };
$("sun-h").oninput = e => { S.sunHour = +e.target.value; S.sunNow = false; $("sun-now").checked = false; save(); sunStudy(); };
$("sun-now").onchange = e => { S.sunNow = e.target.checked; save(); sunStudy(); };
function sunStudy() {
  const lat = siteLat(), lon = siteLon();
  let s, label;
  if (S.sunNow) { s = SOL.sunAt(new Date(), lat, lon); label = `now (solar ${f(s.solarTime, 2)} h)`; }
  else { const n = SOL.AVG_DAY[S.sunMonth]; s = SOL.sunFromHourAngle(lat, SOL.declination(n), 15 * (S.sunHour - 12));
    const ist = SOL.istFromSolar(S.sunHour, n, lon); label = `${SOL.MONTHS[S.sunMonth]} average day, ${Math.floor(S.sunHour)}:${String(Math.round((S.sunHour % 1) * 60)).padStart(2, "0")} solar ≈ ${Math.floor(ist)}:${String(Math.round((ist % 1) * 60) % 60).padStart(2, "0")} IST`; }
  $("sun-hv").textContent = f(S.sunHour, 2).replace(/\.00$/, ":00");
  $("sun-txt").textContent = `${label} · altitude ${f(s.altitude, 1)}°, azimuth ${f(s.azimuth, 0)}°${s.altitude <= 0 ? " (below horizon)" : ""}`;
  viewer?.setSun(s.azimuth, s.altitude);
  return s;
}

// ------------------------------------------------------------ sun & solar charts
$("hm-f").innerHTML = SOL.ORIENTS.map(([o]) => `<option>${o}</option>`).join(""); $("hm-f").value = S.facade;
$("hm-f").onchange = e => { S.facade = e.target.value; save(); renderSun(); };
function renderSun() {
  const lat = siteLat(), lon = siteLon(), now = SOL.sunAt(new Date(), lat, lon);
  $("sp-sub").textContent = `Site ${f(lat, 3)} N, ${f(lon, 3)} E. Hour dots every 2 h of solar time; at this latitude the sun is north of the wall-line in midsummer.`;
  $("sp-chart").innerHTML = C.sunPathChart([{ label: "21 Jun", pts: SOL.sunPath(lat, 172) }, { label: "21 Mar / 23 Sep", pts: SOL.sunPath(lat, 80) }, { label: "21 Dec", pts: SOL.sunPath(lat, 355) }], now, { size: W("sp-chart") });
  const F = SOL.facadeIrradiance(lat, cities[S.city].monthly.ALLSKY_SFC_SW_DWN);
  $("sw-chart").innerHTML = C.radialHeat(SOL.ORIENTS.map(o => o[0]), SOL.MONTHS, (i, m) => F[m].daily[SOL.ORIENTS[i][0]], { unit: "kWh/m²/day", size: W("sw-chart") });
  const ann = SOL.ORIENTS.map(([o]) => ({ id: "", label: o + " facade", value: F.reduce((t, m, k) => t + m.daily[o] * [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][k], 0) }));
  const om = db.retv.omega_lat_lt_23_5;
  $("sf-sub").textContent = `Annual incident solar per facade (kWh/m² per year), ${cities[S.city].name} radiation. ENS orientation factors for comparison: ` + SOL.ORIENTS.map(([o]) => `${o} ${om[o]}`).join(", ") + ".";
  $("sf-chart").innerHTML = C.rankedBars(ann.sort((a, b) => b.value - a.value), { unit: "kWh/m²/yr", decimals: 0, width: W("sf-chart"), title: "annual solar by facade" });
  const hrs = Array.from({ length: 24 }, (_, h) => String(h));
  $("hm-chart").innerHTML = C.heatGrid(SOL.MONTHS, hrs, F.map(m => m.hourly[S.facade]), { unit: "W/m²", width: Math.max(560, W("hm-chart")), colEvery: 2, xLabel: "solar hour", zeroBelow: 0.5, min: 0 });
  map && drawSunLines();
}

// ------------------------------------------------------------ map (Leaflet + OpenStreetMap)
let map = null, pin = null, sunLayer = null;
function setLocation(lat, lon, fromMap = true) {
  S.lat = +lat.toFixed(5); S.lon = +lon.toFixed(5); $("p-lat").value = S.lat; $("p-lon").value = S.lon;
  const n = nearestCity(S.lat, S.lon); S.city = n.key; $("p-city").value = n.key; save();
  if (pin && fromMap) pin.setLatLng([S.lat, S.lon]);
  update(); sunStudy();
}
function dest(lat, lon, az, km) { const r = az * Math.PI / 180; return [lat + (km * Math.cos(r)) / 111, lon + (km * Math.sin(r)) / (111 * Math.cos(lat * Math.PI / 180))]; }
function drawSunLines() {
  if (!map || !window.L) return;
  sunLayer?.remove(); sunLayer = L.layerGroup().addTo(map);
  const lat = siteLat(), lon = siteLon(), km = 30 / Math.pow(2, map.getZoom() - 9);
  const day = SOL.sunPath(lat, SOL.AVG_DAY[new Date().getMonth()], 0.25), rise = day[0], set = day[day.length - 1], now = SOL.sunAt(new Date(), lat, lon);
  const line = (az, color, label, dash) => L.polyline([[lat, lon], dest(lat, lon, az, km)], { color, weight: 3, dashArray: dash, opacity: 0.9 }).bindTooltip(label).addTo(sunLayer);
  if (rise) line(rise.azimuth, "#eb6834", `Sunrise direction ${f(rise.azimuth, 0)}° (this month)`, "6 5");
  if (set) line(set.azimuth, "#6250d6", `Sunset direction ${f(set.azimuth, 0)}° (this month)`, "6 5");
  if (now.altitude > 0) { line(now.azimuth, "#eda100", `Sun now: azimuth ${f(now.azimuth, 0)}°, altitude ${f(now.altitude, 1)}°`);
    L.circleMarker(dest(lat, lon, now.azimuth, km), { radius: 9, color: "#fff", weight: 2, fillColor: "#eda100", fillOpacity: 1 }).bindTooltip("Sun now").addTo(sunLayer); }
}
function initMap() {
  if (!window.L) { $("map").innerHTML = `<div style="display:grid;place-items:center;height:100%;color:var(--muted)">Map library could not load (offline?). Enter coordinates above.</div>`; return; }
  const lat = siteLat(), lon = siteLon();
  map = L.map("map", { scrollWheelZoom: false }).setView([lat, lon], 11);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  pin = L.marker([lat, lon], { draggable: true, icon: L.divIcon({ className: "", html: '<div class="site-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 22] }) }).addTo(map).bindTooltip("Site (drag to move)");
  pin.on("dragend", () => { const p = pin.getLatLng(); setLocation(p.lat, p.lng, false); });
  map.on("click", e => setLocation(e.latlng.lat, e.latlng.lng));
  map.on("zoomend", drawSunLines);
  drawSunLines();
}
$("geo-go").onclick = async () => {
  const q = $("geo-q").value.trim(); if (!q) return;
  $("geo-res").textContent = "Searching OpenStreetMap…";
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=in&q=${encodeURIComponent(q)}`, { headers: { "Accept-Language": "en" } });
    const js = await r.json();
    $("geo-res").innerHTML = js.length ? js.map((x, i) => `<button class="btn" style="margin:4px 4px 0 0;font-size:.8rem" data-i="${i}">${esc(x.display_name.split(",").slice(0, 3).join(","))}</button>`).join("") : "No places found.";
    $("geo-res").querySelectorAll("button").forEach(b => b.onclick = () => { const x = js[+b.dataset.i]; map?.setView([+x.lat, +x.lon], 14); setLocation(+x.lat, +x.lon); });
  } catch (e) { $("geo-res").textContent = "Search unavailable: " + e.message; }
};
$("geo-q").onkeydown = e => { if (e.key === "Enter") $("geo-go").click(); };

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
renderSliders(); renderModelSide(); initMap(); loadModel();
