// app.js - Envelope Studio: project intake -> BIM model -> goals & budget -> results, climate, evidence.
// All calculation is in engine.js / bim.js (parity-tested against Python and Java). This file only wires inputs to outputs.
import * as E from "./engine.js";
import * as X from "./explain.js";
import * as B from "./bim.js";
import * as C from "./charts.js";
import { RAMP_STOPS, uColor as uColorOf } from "./viewer.js";
import * as GE from "./geom.js";
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
S.choices ||= {}; S.whMode ||= "now"; S.absorb ??= 0.6; S.studio ||= "AAC"; S.applyAll ??= false; S.sunMonth ??= new Date().getMonth(); S.sunHour ??= 10; S.sunNow ??= false; S.facade ||= "W";
if (!db0.candidates.some(c => c.id === S.studio)) S.studio = "AAC";
refreshData();
let ifcBytes = null, sampleProject = D.sample_project, lastRes = null, lastProject = null, BACKEND = null;

// ------------------------------------------------------------ theme
const applyTheme = t => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
try { applyTheme(localStorage.getItem(KEY + ".theme")); } catch {}
$("theme").onclick = () => {
  const dark = document.documentElement.dataset.theme === "dark";
  const t = dark ? "light" : "dark"; applyTheme(t); try { localStorage.setItem(KEY + ".theme", t); } catch {}
};

$("banner").title = "Only cited values are used and nothing is imputed. Carbon data exists for three materials, cost only for masonry-unit prices from secondary listings, and service life, availability and maintenance are not yet collected, so every score is partial.";
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

// ------------------------------------------------------------ 2 model (3D workspace)
const MODELS = { duplex: "data/models/duplex.ifc", sample: "data/sample_house.ifc" };
const MESH_EXT = /\.(glb|gltf|obj|stl|fbx)$/i;
const UNIT_SCALE = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 };
const srcBtns = [...$("m-src").querySelectorAll("button")];
srcBtns.forEach(b => b.onclick = () => { S.src = b.dataset.v; save(); renderModelSide(); loadModel(); });
S.context ||= []; S.bRot ??= 0; S.bOff ||= { x: 0, z: 0 }; S.winDefaults ??= true; S.units ||= "m"; S.waste ??= 5;
if (!["duplex", "sample", "ifc", "manual"].includes(S.src)) S.src = "duplex";
let duplexProject = null, geoProject = null, facets = [], shade = null, ws = null, meshFile = null, meshInfo = null, selInfo = null, shadeJob = 0;
const inIndia = p => p && p.lat != null && p.lat > 6 && p.lat < 37 && p.lon > 68 && p.lon < 98;
function baseProject() {
  if (S.src === "manual") return B.manualProject(db, S.manual);
  if (S.src === "ifc" && S.ifcProject && !meshFile) return S.ifcProject;
  if (S.src === "ifc" && meshFile) return { site: { lat: null, lon: null }, true_north_ccw_deg: 0, walls: [], openings: [], warnings: [], reader: "3D mesh (" + meshFile.name + ")" };
  if (S.src === "duplex" && duplexProject) return duplexProject;
  return sampleProject;
}
function currentProject() { return geoProject || baseProject(); }
async function ensureDuplex() {
  if (duplexProject || S.src !== "duplex") return;
  const buf = await (await fetch(MODELS.duplex)).arrayBuffer();
  if (BACKEND) { try { const r = await fetch("api/ifc", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: buf }); if (r.ok) duplexProject = await r.json(); } catch { /* fall back */ } }
  duplexProject ||= B.analyse(new TextDecoder().decode(buf), db, derived);
  duplexProject.warnings = (duplexProject.warnings || []).filter(w => !/latitude|TrueNorth/i.test(w));
  duplexProject.bytes = buf;
}
const SRC_TXT = { duplex: "Duplex residence (Revit)", sample: "Test house", ifc: "Upload", manual: "Facade areas" };
function renderModelSide() {
  srcBtns.forEach(b => b.classList.toggle("on", b.dataset.v === S.src));
  $("m-src-s").textContent = SRC_TXT[S.src];
  const el = $("m-side"), p = baseProject();
  const winBox = `<label class="small" style="display:block;margin-top:10px"><input type="checkbox" id="win-def" ${S.winDefaults ? "checked" : ""}> Assume U 5.8 W/m²K and SHGC 0.7 (single clear glass) for windows without thermal data</label>`;
  if (S.src === "duplex") {
    el.innerHTML = `<p class="small" style="margin:0 0 8px">Two-storey duplex apartment exported from Autodesk Revit (IFC2x3): walls, roof, slabs, ${p.openings?.length ?? "–"} windows and doors. Relocated to your site; its original site and north are ignored.</p>
      <p class="small mut" style="margin:0 0 8px">Source: BSI (2020) "Duplex Apartment Test Files", buildingSMART International, CC BY 4.0. Unchanged except for relocation.</p>` + winBox + modelFacts(p);
  } else if (S.src === "sample") {
    el.innerHTML = `<p class="small" style="margin:0 0 8px">Hand-authored IFC4 test box: 10 × 8 m, brick on three sides, AAC on the north, five windows.</p><a class="small" href="data/sample_house.ifc" download>Download sample_house.ifc</a>` + modelFacts(p);
  } else if (S.src === "ifc") {
    el.innerHTML = `<label class="drop" id="drop"><input type="file" id="ifc-file" accept=".ifc,.rvt,.rfa,.glb,.gltf,.obj,.stl,.fbx" hidden><b>Drop a model here</b><br><span class="small">IFC (best: walls, layers, windows) · glTF/GLB · OBJ · STL · FBX · Revit .rvt shows export steps</span></label>
      <label class="f" style="margin:10px 0 0"><span>Units of mesh files (OBJ, STL, FBX, glTF)</span><select id="mesh-units">${Object.keys(UNIT_SCALE).map(u => `<option ${u === S.units ? "selected" : ""}>${u}</option>`).join("")}</select></label>` +
      (meshInfo ? `<p class="small" style="margin:8px 0 0"><b>${esc(meshFile.name)}</b> · ${meshInfo.meshes} meshes · ${f(meshInfo.size.x, 1)} × ${f(meshInfo.size.z, 1)} m plan, ${f(meshInfo.size.y, 1)} m high. If these look wrong, change the units.</p>` : "") +
      (S.ifcProject && !meshFile ? `<p class="small" style="margin:8px 0 0"><b>${esc(S.ifcName || "model.ifc")}</b></p>` + winBox + modelFacts(p) : "") + IFC_HELP;
    const inp = $("ifc-file"), drop = $("drop");
    inp.onchange = () => inp.files[0] && readIfc(inp.files[0]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) readIfc(e.dataTransfer.files[0]); };
    $("mesh-units").onchange = e => { S.units = e.target.value; save(); if (meshFile) loadModel(); };
  } else {
    const m = S.manual;
    el.innerHTML = `<p class="small mut" style="margin:0 0 8px">Gross wall area per orientation, including windows.</p><div class="grid g4" style="gap:8px">` +
      ["N", "E", "S", "W", "NE", "SE", "SW", "NW"].map(o => `<label class="f" style="margin:0"><span>${o} m²</span><input type="number" min="0" step="0.5" data-o="${o}" value="${m.areas[o] ?? ""}"></label>`).join("") +
      `</div><div class="grid g3" style="gap:8px;margin-top:8px"><label class="f" style="margin:0"><span>WWR</span><input type="number" id="mm-wwr" min="0" max="0.9" step="0.01" value="${m.wwr}"></label>
       <label class="f" style="margin:0"><span>Window U</span><input type="number" id="mm-u" step="0.1" value="${m.winU}"></label><label class="f" style="margin:0"><span>SHGC</span><input type="number" id="mm-g" step="0.05" value="${m.winShgc}"></label></div>`;
    el.querySelectorAll("input[data-o]").forEach(i => i.oninput = () => { const v = i.value === "" ? undefined : +i.value; if (v === undefined) delete m.areas[i.dataset.o]; else m.areas[i.dataset.o] = v; save(); loadModel(); });
    $("mm-wwr").oninput = e => { m.wwr = +e.target.value; save(); loadModel(); };
    $("mm-u").oninput = e => { m.winU = +e.target.value; save(); loadModel(); };
    $("mm-g").oninput = e => { m.winShgc = +e.target.value; save(); loadModel(); };
  }
  const wd = $("win-def"); if (wd) wd.onchange = e => { S.winDefaults = e.target.checked; save(); rebuildGeometry(false); };
}
const IFC_HELP = `<details class="ifc-help"><summary><b>Exporting from Revit, ArchiCAD or SketchUp</b></summary><ol style="margin:6px 0 0;padding-left:18px">
  <li><b>Revit:</b> File → Export → IFC, IFC4 Reference View (or IFC2x3 Coordination View 2.0), tick <i>Export base quantities</i>; set Manage → Location and true north first.</li>
  <li><b>ArchiCAD:</b> File → Save as → IFC, "General Translator", with property sets and quantities.</li>
  <li><b>SketchUp, Rhino, Blender:</b> export glTF/GLB or OBJ in metres; walls are found from the geometry (no materials).</li>
  <li>Windows need <i>ThermalTransmittance</i> and <i>SolarHeatGainTransmittance</i> for the RETV.</li></ol>
  <p class="small mut" style="margin:6px 0 0">Revit's native .rvt is a closed Autodesk format that no browser or open-source tool can read, so export IFC.</p></details>`;
function modelFacts(p) {
  const ext = p.walls.filter(w => w.external);
  return `<dl class="kv" style="margin-top:10px"><dt>Read by</dt><dd>${esc(p.reader || "built-in parser (browser)")}</dd>
    <dt>External walls</dt><dd>${ext.length}${ext.some(w => w.area_m2) ? " · " + f(ext.reduce((s, w) => s + (w.area_m2 || 0), 0), 1) + " m²" : ""}</dd>
    <dt>Openings</dt><dd>${p.openings.length} · ${f(p.openings.reduce((s, o) => s + o.area_m2, 0), 1)} m²</dd></dl>` +
    (p.warnings || []).slice(0, 3).map(w => `<div class="note">${esc(w.length > 220 ? w.slice(0, 220) + "…" : w)}</div>`).join("");
}
// Revit files: read only what is stored openly (build string, worksharing flag, embedded preview); geometry needs an IFC export.
async function readRevit(file) {
  const b = new Uint8Array(await file.arrayBuffer());
  const isOle = b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
  const txt = new TextDecoder("utf-16le").decode(b.subarray(0, Math.min(b.length, 2_000_000)));
  const ver = (txt.match(/Autodesk Revit[^\u0000\r\n]{0,40}?\d{4}/) || [])[0] || null;
  const build = (txt.match(/Build: ?(\d{8}_\d{4})/) || [])[1] || null;
  const wsh = (txt.match(/Worksharing: ?([^\u0000\r\n]{0,20})/) || [])[1] || null;
  let img = null;
  for (let i = 0; i < Math.min(b.length, 4_000_000) - 8; i++) if (b[i] === 0x89 && b[i + 1] === 0x50 && b[i + 2] === 0x4e && b[i + 3] === 0x47) {
    for (let j = i; j < Math.min(b.length, i + 2_000_000); j++) if (b[j] === 0x49 && b[j + 1] === 0x45 && b[j + 2] === 0x4e && b[j + 3] === 0x44) { img = URL.createObjectURL(new Blob([b.subarray(i, j + 8)], { type: "image/png" })); break; }
    break;
  }
  $("m-side").querySelector(".revit-card")?.remove();
  const card = document.createElement("div"); card.className = "ifc-help revit-card";
  card.innerHTML = `<b>${esc(file.name)}</b> (${(file.size / 1048576).toFixed(1)} MB)${img ? `<img src="${img}" alt="Revit preview" style="display:block;width:128px;height:128px;margin:8px 0;border:1px solid var(--line);border-radius:8px;background:#fff;image-rendering:pixelated">` : ""}
    <dl class="kv"><dt>Format</dt><dd>${isOle ? "Revit project" : "not a recognised Revit file"}</dd><dt>Saved with</dt><dd>${esc(ver || "unknown")}${build ? ` (build ${esc(build)})` : ""}</dd><dt>Worksharing</dt><dd>${esc(wsh || "unknown")}</dd></dl>
    <p style="margin:8px 0 0">Open it in Revit ${ver && /20\d\d/.test(ver) ? ver.match(/20\d\d/)[0] + " or newer" : ""} (Windows), then File → Export → IFC and drop the .ifc here. Meanwhile the Duplex residence shows how a real Revit model is analysed.</p>`;
  $("m-side").prepend(card); document.querySelector("#m-side details.ifc-help")?.setAttribute("open", "");
  $("v-status").textContent = "Read the Revit file's header only; export IFC to analyse its walls.";
}
async function readIfc(file) {
  if (/\.(rvt|rfa|rte)$/i.test(file.name)) { await readRevit(file); return; }
  if (MESH_EXT.test(file.name)) { meshFile = file; S.ifcProject = null; renderModelSide(); loadModel(); return; }
  $("v-status").textContent = "Reading " + file.name + "…";
  try {
    const buf = await file.arrayBuffer();
    let p;
    if (BACKEND) {
      const r = await fetch("api/ifc", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: buf });
      if (!r.ok) throw new Error("backend: " + (await r.text()).slice(0, 200));
      p = await r.json();
    } else p = B.analyse(new TextDecoder().decode(buf), db, derived);
    if (inIndia(p.site)) { S.lat = +p.site.lat.toFixed(4); S.lon = +p.site.lon.toFixed(4); $("p-lat").value = S.lat; $("p-lon").value = S.lon; const n = nearestCity(p.site.lat, p.site.lon); S.city = n.key; $("p-city").value = n.key; }
    else p.warnings = (p.warnings || []).filter(w => !/latitude/i.test(w)).concat(p.site.lat != null ? ["The model's own site is outside India; it is analysed at the location set on the Site tab."] : []);
    S.ifcProject = p; S.ifcName = file.name; ifcBytes = buf; meshFile = null; meshInfo = null;
    save(); renderModelSide(); loadModel();
  } catch (e) { $("v-status").textContent = "Could not read this IFC file: " + e.message; }
}
window.__envStudio = { get ws() { return ws; }, get facets() { return facets; }, get shade() { return shade; } };   // debugging hook (read-only)
async function createWorkspace() {
  const { Workspace } = await import("./viewer2.js");
  const w = new Workspace($("viewer"), { onPick, onEdit });
  await w.init();
  return w;
}
async function loadModel() {
  geoProject = null; facets = []; shade = null; selInfo = null;
  await ensureDuplex();
  const base = baseProject(); lastProject = base;
  renderModelSide(); renderWalls(base); update();
  if (S.src === "manual") { ws?.clearBuilding(); ws?.setLabels([]); $("v-status").textContent = "Manual areas: no 3D geometry."; return; }
  try {
    if (!ws) { $("v-status").textContent = "Loading the 3D workspace…"; ws = await createWorkspace(); }
    $("v-status").textContent = "Loading the model…";
    if (S.src === "ifc" && meshFile) { meshInfo = await ws.loadFile(meshFile, UNIT_SCALE[S.units]); renderModelSide(); }
    else {
      const bytes = S.src === "ifc" ? ifcBytes : S.src === "duplex" ? duplexProject.bytes : await (await fetch(MODELS.sample)).arrayBuffer();
      if (!bytes) ws.schematic(base); else { try { await ws.loadIFC(bytes, base); } catch (e) { ws.schematic(base); } }
    }
    ws.setContext(S.context); ws.setBuildingRotation(S.bRot); ws.setBuildingOffset(S.bOff.x, S.bOff.z);
    $("ed-rot").value = S.bRot; $("ed-rotv").textContent = S.bRot + "°";
    renderContextList(); rebuildGeometry(true);
  } catch (e) { $("v-status").textContent = "3D view unavailable: " + e.message + ". The analysis still uses the model's wall data."; }
}
function buildGeoProject(base, fcs) {
  const tn = ws?.tn ?? 0, byId = Object.fromEntries(base.walls.map(w => [w.id, w]));
  const walls = fcs.map(fc => {
    const az = ((fc.facet.az_p + tn) % 360 + 360) % 360, w = fc.wall || byId[fc.id] || {};
    return { ...w, id: fc.id, name: fc.name, external: true, area_m2: fc.facet.area, area_source: "3D geometry", azimuth_deg: Math.round(az * 10) / 10,
      orientation: E.orientationBin(az), orientation_source: "3D geometry", layers: w.layers || [], u_value: w.u_value ?? null, facet: fc.facet,
      labelPos: [fc.facet.cx, fc.facet.height.max + 0.6, fc.facet.cz] };
  });
  const openings = (base.openings || []).map(o => {
    const host = walls.find(w => w.id === o.host_wall);
    const ori = host ? host.orientation : o.orientation;
    return S.winDefaults ? { ...o, orientation: ori, u: o.u ?? 5.8, shgc: o.shgc ?? 0.7, data_status: o.u == null || o.shgc == null ? "assumed" : o.data_status } : { ...o, orientation: ori };
  });
  return { ...base, walls: walls.length ? walls : base.walls, openings, retv_as_modelled: null, from_geometry: walls.length > 0 };
}
let rebuildTimer = null;
function rebuildGeometry(now = false) {
  clearTimeout(rebuildTimer);
  const run = () => {
    if (!ws || S.src === "manual") { geoProject = null; update(); return; }
    facets = ws.wallFacets();
    geoProject = buildGeoProject(baseProject(), facets);
    const p = geoProject, ext = p.walls.filter(w => w.u_value != null && w.area_m2);
    if (ext.length && ext.length === p.walls.length) { const ok = p.openings.filter(o => o.u != null && o.shgc != null); p.retv_as_modelled = E.retv(db, ext.map(w => ({ area_m2: w.area_m2, u: w.u_value, orientation: w.orientation })), ok); }
    lastProject = p; renderWalls(p); computeShading(); update(); sunStudy();
  };
  if (now) run(); else rebuildTimer = setTimeout(run, 250);
}
async function computeShading() {
  const job = ++shadeJob; shade = null;
  if (!ws || !facets.length) return;
  const lat = siteLat(), F = SOL.facadeIrradiance(lat, cities[S.city].monthly.ALLSKY_SFC_SW_DWN), occ = ws.occluders();
  const out = Object.fromEntries(facets.map(fc => [fc.id, Array.from({ length: 12 }, () => new Array(24).fill(1))]));
  const front = Object.fromEntries(facets.map(fc => [fc.id, [0, 0]]));        // [hours with sun in front of the wall, of which lit]
  for (let m = 0; m < 12; m++) {
    for (let h = 0; h < 24; h++) { const v = F[m].sunVec[h]; if (!v || v.up <= 0) continue; const sw = ws.sunWorld(v);
      for (const fc of facets) { const fr = GE.sunlitFraction(fc.facet, sw, occ, fc.id); out[fc.id][m][h] = fr;
        if (fc.facet.nx * sw[0] + fc.facet.nz * sw[2] > 0.05) { front[fc.id][0]++; if (fr > 0.01) front[fc.id][1]++; } } }
    $("v-status").textContent = `Ray-tracing sun and shade… ${m + 1}/12`;
    await new Promise(r => setTimeout(r, 0));
    if (job !== shadeJob) return;
  }
  // walls that never see the sun (party walls, walls inside the building) are not part of the solar envelope
  const enclosed = facets.filter(fc => front[fc.id][0] > 0 && front[fc.id][1] / front[fc.id][0] < 0.01).map(fc => fc.id);
  if (enclosed.length) { facets = facets.filter(fc => !enclosed.includes(fc.id)); geoProject = buildGeoProject(baseProject(), facets); lastProject = geoProject; renderWalls(geoProject); }
  shade = out; update();
  $("v-status").textContent = `${facets.length} sunlit walls${enclosed.length ? ` (${enclosed.length} enclosed walls skipped)` : ""} · shade from the building and ${S.context.length} context object${S.context.length === 1 ? "" : "s"} · drag to orbit, click a wall`;
  renderWallHeat(); renderQuantities();
}
function renderWalls(p) {
  $("m-walls").innerHTML = `<table><tr><th>Wall</th><th>Facing</th><th class="num">Area m²</th><th>Layers → ENS Table 46</th><th class="num">U</th></tr>` +
    p.walls.map(w => `<tr><td>${esc(w.name)}</td><td>${w.orientation}${w.azimuth_deg != null ? ` <span class="small mut">${w.azimuth_deg}° · ${esc((w.orientation_source || "").replace("_", " "))}</span>` : ""}</td><td class="num">${f(w.area_m2, 1)}</td>` +
      `<td class="small">${w.layers?.length ? w.layers.map(l => `${l.t_mm} mm ${esc(l.material)}${l.catalogue_ref ? "" : " <span class='tag bad'>unmapped</span>"}`).join(" + ") : "<span class='mut'>material from the Materials tab</span>"}</td>` +
      `<td class="num">${w.u_value != null ? f(w.u_value, 2) : "–"}</td></tr>`).join("") + `</table>` +
    (p.openings.length ? `<p class="small mut">${p.openings.length} openings · ${f(p.openings.reduce((s, o) => s + o.area_m2, 0), 1)} m²${p.openings.some(o => o.data_status === "assumed") ? " · some with assumed glass properties" : ""}</p>` : "");
}

// ------------------------------------------------------------ editing: rotation, move, context
$("ed-rot").oninput = e => { S.bRot = +e.target.value; $("ed-rotv").textContent = S.bRot + "°"; ws?.setBuildingRotation(S.bRot); save(); rebuildGeometry(); };
$("ed-nb").onclick = () => { if (!ws) return; ws.addContext({ type: "box", w: 12, d: 10, h: 9, x: 0, z: 20, rot: 0 }); syncContext(); };
$("ed-tree").onclick = () => { if (!ws) return; ws.addContext({ type: "tree", h: 9, r: 3, x: 14, z: 6 }); syncContext(); };
$("ed-reset").onclick = () => { S.bRot = 0; S.bOff = { x: 0, z: 0 }; S.context = []; save(); ws?.setContext([]); ws?.setBuildingRotation(0); ws?.setBuildingOffset(0, 0); $("ed-rot").value = 0; $("ed-rotv").textContent = "0°"; renderContextList(); rebuildGeometry(); };
function syncContext() { const st = ws.state(); S.context = st.context; save(); renderContextList(); rebuildGeometry(); }
function onEdit(st) { S.bRot = st.rot; S.bOff = { x: st.x, z: st.z }; S.context = st.context; save(); $("ed-rot").value = S.bRot; $("ed-rotv").textContent = Math.round(S.bRot) + "°"; renderContextList(); rebuildGeometry(); }
function renderContextList() {
  $("ed-list").innerHTML = S.context.map(c => `<div><span>${c.type === "tree" ? "🌳 Tree" : "▦ Neighbour"} · ${c.type === "tree" ? `${c.h} m, crown ${c.r} m` : `${c.w}×${c.d}×${c.h} m`}</span><span><button class="btn sm" data-sel="${c.id}">Edit</button> <button class="btn sm" data-del="${c.id}">✕</button></span></div>`).join("") || `<p class="small mut" style="margin:0">No neighbours or trees yet. Add them to see their shade on each wall.</p>`;
  $("ed-list").querySelectorAll("[data-del]").forEach(b => b.onclick = () => { ws.removeContext(b.dataset.del); $("ed-props").innerHTML = ""; syncContext(); });
  $("ed-list").querySelectorAll("[data-sel]").forEach(b => b.onclick = () => { const o = ws.context.children.find(c => c.userData.ctxId === b.dataset.sel); if (o) ws.select(o.children?.[0] || o); });
}
function ctxProps(item) {
  const fields = item.type === "tree" ? [["h", "Height m"], ["r", "Crown radius m"]] : [["w", "Width m"], ["d", "Depth m"], ["h", "Height m"]];
  $("ed-props").innerHTML = `<div class="grid ${item.type === "tree" ? "g2" : "g3"}" style="gap:8px">${fields.map(([k, l]) => `<label class="f" style="margin:0"><span>${l}</span><input type="number" min="0.5" step="0.5" data-k="${k}" value="${item[k]}"></label>`).join("")}</div><p class="small mut" style="margin:6px 0 0">Drag it with Move / Rotate in the toolbar.</p>`;
  $("ed-props").querySelectorAll("input").forEach(i => i.onchange = () => {
    const st = ws.state(), it = st.context.find(c => c.id === item.id); if (!it) return;
    it[i.dataset.k] = Math.max(0.5, +i.value); ws.setContext(st.context); S.context = st.context; save(); renderContextList(); rebuildGeometry();
  });
}
let vpMode = "select";
$("vp-mode").querySelectorAll("button").forEach(b => b.onclick = () => {
  vpMode = b.dataset.mode; $("vp-mode").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  if (!ws) return;
  if (vpMode === "select") ws.tc.detach();
  else { ws.setMode(vpMode === "rotate" ? "rotate" : "move"); if (!ws.tc.object) ws.editBuilding(true); }
});
$("vp-views").querySelectorAll("button").forEach(b => b.onclick = () => ws?.view(b.dataset.view));
$("vp-grid").onclick = e => { e.target.classList.toggle("on"); ws?.setGrid(e.target.classList.contains("on")); };
$("vp-ao").onclick = e => { e.target.classList.toggle("on"); ws?.setAO(e.target.classList.contains("on")); };
$("vp-labels").onclick = e => { e.target.classList.toggle("on"); ws && (ws.labelLayer.style.display = e.target.classList.contains("on") ? "" : "none"); };
function onPick(info) {
  selInfo = info;
  if (info?.kind === "context" && info.item) { ctxProps(info.item); if (vpMode !== "select") ws.setMode(vpMode === "rotate" ? "rotate" : "move"); }
  renderSelection();
  if (info) $("sel-card").open = true;
}
function renderSelection() {
  const info = selInfo;
  if (!info) { $("sel-s").textContent = "click a wall or object"; $("sel-out").innerHTML = `<span class="mut">Click any wall, neighbour or tree in the 3D view.</span>`; return; }
  if (info.kind === "context") { $("sel-s").textContent = info.item.type === "tree" ? "tree" : "neighbour"; $("sel-out").innerHTML = `<p style="margin:0">${info.item.type === "tree" ? "Tree crown lets about 25% of direct sun through." : "Opaque neighbouring block."} Edit its size in <i>Edit building &amp; context</i>.</p>`; return; }
  const id = info.wall?.id ?? (info.eid != null ? "eid-" + info.eid : null), w = currentProject().walls.find(x => x.id === id);
  $("sel-s").textContent = info.kind || "element";
  if (!w) { $("sel-out").innerHTML = `<p style="margin:0">${esc(info.name || info.kind || "Element")}${info.eid != null ? ` <span class="mut">#${info.eid}</span>` : ""}. Not an external wall, so no solar analysis.</p>`; return; }
  const r = heatRows().find(x => x.wall.id === id);
  $("sel-out").innerHTML = `<p style="margin:0 0 6px"><b>${esc(w.name)}</b></p><dl class="kv"><dt>Faces</dt><dd>${w.orientation} · ${w.azimuth_deg}°</dd><dt>Net area</dt><dd>${f(w.area_m2, 1)} m² (from 3D geometry)</dd>
    <dt>Layers</dt><dd>${w.layers?.length ? w.layers.map(l => `${l.t_mm} mm ${esc(l.material)}`).join(" + ") : "–"}</dd><dt>U-value</dt><dd>${w.u_value != null ? f(w.u_value) + " W/m²K" : "unmapped layers; using the Materials tab choice"}</dd>
    ${r ? `<dt>Sun now</dt><dd>${Math.round(r.I)} W/m²${r.sunlit != null ? ` · ${Math.round(r.sunlit * 100)}% sunlit` : ""}</dd><dt>This month</dt><dd>${f(r.day, 2)} kWh/m² per day</dd><dt>Year</dt><dd>${Math.round(r.annual_kwh_m2)} kWh/m² · ${Math.round(r.annual_kwh).toLocaleString("en-IN")} kWh on the wall</dd><dt>Shade, year</dt><dd>${Math.round(r.shadeLoss * 100)}% of direct sun blocked</dd>` : ""}</dl>`;
}

// ------------------------------------------------------------ quantities: wall areas, block counts, cost
function renderQuantities() {
  const p = currentProject(), walls = p.walls.filter(w => w.external && w.area_m2);
  if (!walls.length) { $("q-out").innerHTML = `<p class="small mut" style="margin:0">Needs wall areas.</p>`; $("q-s").textContent = ""; return; }
  const area = walls.reduce((s, w) => s + w.area_m2, 0), open = p.openings.reduce((s, o) => s + o.area_m2, 0);
  const byO = {}; for (const w of walls) byO[w.orientation] = (byO[w.orientation] || 0) + w.area_m2;
  const v = ST.activeVariant(db0, D.market, S.choices, S.studio), pcs = v ? ST.piecesPerM2(v) : null, waste = 1 + (S.waste || 0) / 100;
  const blocks = pcs ? Math.ceil(area * pcs * waste) : null, cost = pcs && v.price_inr != null ? blocks * v.price_inr : null;
  $("q-s").textContent = f(area, 0) + " m²";
  $("q-out").innerHTML = `<div class="mini"><div><div class="k">Opaque wall</div><div class="v">${f(area, 1)} m²</div></div><div><div class="k">Openings</div><div class="v">${f(open, 1)} m²</div></div>
    <div><div class="k">${esc(SHORT(S.studio))} units</div><div class="v">${blocks != null ? blocks.toLocaleString("en-IN") : "–"}</div></div><div><div class="k">Unit cost</div><div class="v">${cost != null ? inr(cost) : "–"}</div></div></div>
    <p class="small mut" style="margin:8px 0">${v && v.l_mm ? `${esc(v.label || "")}: ${f(v.l_mm, 0)} × ${f(v.h_mm, 0)} mm face${v.joint_mm ? ` + ${v.joint_mm} mm joints` : ""}${v.wythes > 1 ? `, ${v.wythes} wythes` : ""} → ${f(pcs, 1)} per m²` : "Choose a material with unit dimensions on the Materials tab."} · wastage <input type="number" id="q-waste" value="${S.waste}" min="0" max="25" step="1" style="width:56px;padding:3px 6px"> %</p>
    <table><tr><th>Facing</th><th class="num">Area m²</th><th class="num">Units</th></tr>${Object.entries(byO).sort((a, b) => b[1] - a[1]).map(([o, a]) => `<tr><td>${o}</td><td class="num">${f(a, 1)}</td><td class="num">${pcs ? Math.ceil(a * pcs * waste).toLocaleString("en-IN") : "–"}</td></tr>`).join("")}</table>
    <p class="small mut" style="margin:8px 0 0">Areas are measured on the 3D geometry (outer face, openings excluded). Units only: no mortar, plaster, lintels or labour.</p>`;
  $("q-waste").onchange = e => { S.waste = Math.max(0, +e.target.value); save(); renderQuantities(); };
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

  renderClimate(); renderEvidence(res); renderStudio(res, sub, area); renderSun(); paintViewer(); renderQuantities(); renderOverview(res, sub, area, cur);
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
  const p = lastProject || currentProject(), cur = p.retv_as_modelled;
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

// ------------------------------------------------------------ overview
function renderOverview(res, sub, area, cur) {
  const top = res.ranked[0], rows = heatRows(), hotYear = rows.length ? rows.reduce((a, b) => b.annual_kwh_m2 > a.annual_kwh_m2 ? b : a) : null;
  const v = ST.activeVariant(db0, D.market, S.choices, S.studio), bud = v && v.price_inr != null ? ST.budgetFor(v, area || 0) : null;
  $("ov-title").textContent = S.name || "Your project at a glance";
  $("ov-tiles").innerHTML =
    `<div class="card tile"><p class="k">Ranks first</p><p class="v">${top ? esc(SHORT(top.id)) : "–"}</p><p class="d">${top ? `partial score ${f(top.score, 3)} · ${res.ranked.length} of ${db.candidates.length} options have enough evidence` : "no option meets the evidence gate"}</p></div>` +
    `<div class="card tile"><p class="k">Envelope RETV ${S.applyAll ? "with " + esc(SHORT(S.studio)) : "as modelled"}</p>${cur ? C.meter(cur.retv, cur.limit, { unit: "W/m²", size: 150, title: "RETV" }) : `<p class="v">–</p><p class="d">needs wall U-values; tick “use for all walls” on Materials</p>`}</div>` +
    `<div class="card tile"><p class="k">Hottest wall over the year</p><p class="v" style="font-size:1.3rem">${hotYear ? esc(hotYear.wall.orientation) + " · " + Math.round(hotYear.wall.azimuth_deg ?? 0) + "°" : "–"}</p><p class="d">${hotYear ? `${Math.round(hotYear.annual_kwh_m2)} kWh/m² a year on ${f(hotYear.wall.area_m2, 1)} m²` : "load a model"}</p></div>` +
    `<div class="card tile"><p class="k">${esc(SHORT(S.studio))} units for the walls</p><p class="v">${bud && area ? inr(bud.total) : "–"}</p><p class="d">${bud && area ? `${f(area, 0)} m² · ${Math.ceil(bud.pieces_total).toLocaleString("en-IN")} units${S.budget ? ` · <span class="tag ${bud.total <= S.budget ? "good" : "bad"}">${bud.total <= S.budget ? "within" : "over"} budget</span>` : ""}` : "choose a priced material"}</p></div>`;
  const steps = [["site", "Site", S.lat != null ? `${f(S.lat, 2)} N, ${f(S.lon, 2)} E` : "pick the location", S.lat != null],
    ["model", "3D model", SRC_TXT[S.src] + (S.context.length ? ` · ${S.context.length} context` : ""), true],
    ["materials", "Goals", PRESETS[S.preset]?.t || "custom weights", S.preset !== "balanced" || S.budget != null],
    ["materials", "Material", SHORT(S.studio) + (S.choices[S.studio] && S.choices[S.studio] !== "base" ? " · variant chosen" : ""), !!S.choices[S.studio]]];
  $("ov-steps").innerHTML = steps.map(([t, h, d, done]) => `<a href="#${t}" class="${done ? "done" : ""}"><b>${h}</b><span>${esc(d)}</span></a>`).join("");
  const names = db.criteria.map(c => AX[c.id]);
  $("ov-stack").innerHTML = res.ranked.length ? C.stackedBars(res.ranked.map(r => ({ id: r.id, label: SHORT(r.id), total: r.score, parts: r.breakdown.map(b => ({ name: AX[b.criterion_id], value: b.contribution })) })), names, { width: W("ov-stack") }) : "<p class='mut'>Nothing ranked.</p>";
  const rr = Object.entries(sub).sort((a, b) => a[1].retv - b[1].retv).map(([id, r]) => ({ id, fill: id === S.studio ? "var(--s2)" : null, label: SHORT(id), value: r.retv }));
  $("ov-retv").innerHTML = rr.length ? C.rankedBars(rr, { unit: "W/m²", limit: { value: db.retv.limit_w_m2, label: "ENS 15" }, width: W("ov-retv") }) : "<p class='mut'>Load a model with wall areas.</p>";
}

// ------------------------------------------------------------ tabs
const VIEWS = ["overview", "site", "model", "materials", "results", "climate", "evidence"];
function showTab(name) {
  if (!VIEWS.includes(name)) name = "overview";
  for (const v of VIEWS) $("v-" + v).classList.toggle("on", v === name);
  document.querySelectorAll("#tabs a").forEach(a => a.classList.toggle("on", a.dataset.v === name));
  if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
  requestAnimationFrame(() => { update(); if (name === "site") map?.invalidateSize(); if (name === "model") { ws?.resize(); renderQuantities(); } });
  scrollTo({ top: 0 });
}
document.querySelectorAll("#tabs a").forEach(a => a.onclick = e => { e.preventDefault(); showTab(a.dataset.v); });
addEventListener("hashchange", () => showTab(location.hash.slice(1)));
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
  const ms = pr.measured, srcOf = m => `<span class="src">${esc(m.source)} · ${esc(m.grade || "B")}</span>`;
  const rg = (x, nd) => !x ? "–" : x.range && x.range[0] !== x.range[1] ? `${f(x.range[0], nd)}–${f(x.range[1], nd)}` : f(x.range ? x.range[0] : x.value, nd);
  const fmtP = x => !x ? "<span class='mut'>–</span>" : x.status === "conflicting" ? `<span class="tag warn">conflicting</span> <span class="small mut">${esc(x.note)}</span>` :
    `${x.range ? x.range.join("–") : x.min != null ? "≥ " + x.min : x.max != null ? "≤ " + x.max : x.value}<span class="src">${esc(x.source || "")} · ${esc(x.grade || "")}</span>${x.note ? `<br><span class="small mut">${esc(x.note)}</span>` : ""}`;
  const rows = [
    ["Unit size (L × H × wall)", v && v.l_mm ? `${f(v.l_mm, 0)} × ${f(v.h_mm, 0)} mm, wall ${f(v.t_mm ?? core[0]?.t_mm, 0)} mm${v.joint_mm ? `, ${v.joint_mm} mm joints` : ", thin/dry joints"}${v.wythes > 1 ? `, ${v.wythes} wythes` : ""}<span class="src">${esc(v.source || "")}</span>` : "<span class='mut'>–</span>"],
    ["Market price", v && v.price_inr != null ? `INR ${v.price_inr} per piece${v.price_range ? ` (range ${v.price_range.join("–")})` : ""}${v.city && v.city !== "-" ? " · " + esc(v.city) : ""}<span class="src">${esc(v.source)} · C</span>` : "<span class='mut'>not listed</span>"],
    ["Assembly", cand.assembly.layers.map(l => l.ref ? `${l.t_mm} mm ${esc(cat[l.ref].name.split(",")[0])}` : `<i>${l.t_mm} mm ${esc(l.label)}</i>`).join(" + ") || "<span class='mut'>not defined</span>"],
    ["Core density (calculation)", core[0] ? `${cat[core[0].ref].density} kg/m³${srcOf(cat[core[0].ref])}` : "–"],
    ["Product density", fmtP(pr.density_kg_m3)],
    ["Conductivity k", core[0] ? `${cat[core[0].ref].k} W/mK (dry)${srcOf(cat[core[0].ref])}` : "<span class='mut'>no cited value</span>"],
    ["Specific heat", core[0] && cat[core[0].ref].cp_kj_kgK ? `${cat[core[0].ref].cp_kj_kgK} kJ/kgK${srcOf(cat[core[0].ref])}` : "–"],
    ["Measured in Indian labs", ms ? `${ms.n} sample${ms.n > 1 ? "s" : ""}: density ${rg(ms.density_kg_m3, 0)} kg/m³ · k ${rg(ms.k_W_mK, 2)} W/mK · cp ${rg(ms.cp_J_kgK, 0)} J/kgK · wall U ${rg(ms.u_200mm_wall, 2)} W/m²K<span class="src">${esc(ms.source)} · ${esc(ms.grade)}</span><br><span class="small mut">${esc(ms.samples)}. ${esc(ms.note)}</span>` : "<span class='mut'>no lab data collected</span>"],
    ["Compressive strength (N/mm²)", fmtP(pr.compressive_n_mm2)],
    ["Sound reduction (dB)", fmtP(pr.sound_db)],
    ["Water absorption (%)", fmtP(pr.water_absorption_pct)],
    ["Fire resistance (min)", fmtP(pr.fire_min)],
    ["Embodied energy (MJ/kg)", fmtP(pr.embodied_energy_mj_kg)],
    ["Recycled content (%)", fmtP(pr.recycled_content_pct)],
    ["Carbon factor", cand.properties.gwp?.value != null ? `${cand.properties.gwp.value} ${esc(cand.properties.gwp.unit)}<span class="src">${esc(cand.properties.gwp.source)} · ${esc(cand.properties.gwp.grade)}</span><br><span class="small mut">${esc(cand.properties.gwp.basis || "")}</span>` : `<span class='mut'>none</span>${cand.properties.gwp?.note ? `<br><span class="small mut">${esc(cand.properties.gwp.note)}</span>` : ""}`],
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
document.addEventListener("click", e => { const el = e.target.closest?.("svg.chart [data-cand]"); if (el?.dataset.cand && db.candidates.some(c => c.id === el.dataset.cand)) { selectStudio(el.dataset.cand); showTab("materials"); } });

// ------------------------------------------------------------ viewer paint + sun study
function paintViewer() { renderWallHeat(); }
const projSite = () => { const s = (lastProject || currentProject()).site; return inIndia(s) ? s : null; };
const siteLat = () => S.lat ?? projSite()?.lat ?? cities[S.city].lat;
const siteLon = () => S.lon ?? projSite()?.lon ?? cities[S.city].lon;
$("sun-m").innerHTML = SOL.MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join("");
$("sun-m").value = S.sunMonth; $("sun-h").value = S.sunHour; $("sun-now").checked = S.sunNow;
$("sun-m").onchange = e => { S.sunMonth = +e.target.value; S.sunNow = false; $("sun-now").checked = false; save(); sunStudy(); };
$("sun-h").oninput = e => { S.sunHour = +e.target.value; S.sunNow = false; $("sun-now").checked = false; save(); sunStudy(); };
$("sun-now").onchange = e => { S.sunNow = e.target.checked; save(); sunStudy(); };
let lastSunNow = null;
function sunStudy() {
  const lat = siteLat(), lon = siteLon();
  let s, label;
  if (S.sunNow) { s = SOL.sunAt(new Date(), lat, lon); label = `now`; }
  else { const n = SOL.AVG_DAY[S.sunMonth]; s = SOL.sunFromHourAngle(lat, SOL.declination(n), 15 * (S.sunHour - 12));
    const ist = SOL.istFromSolar(S.sunHour, n, lon); label = `≈ ${Math.floor(ist)}:${String(Math.round((ist % 1) * 60) % 60).padStart(2, "0")} IST`; }
  $("sun-hv").textContent = `${Math.floor(S.sunHour)}:${String(Math.round((S.sunHour % 1) * 60)).padStart(2, "0")}`;
  $("sun-txt").textContent = `${label} · altitude ${f(s.altitude, 0)}°, azimuth ${f(s.azimuth, 0)}°${s.altitude <= 0 ? " · below horizon" : ""}`;
  ws?.setSun(s.azimuth, s.altitude);
  lastSunNow = S.sunNow ? s : null;
  renderWallHeat();
  return s;
}

// ------------------------------------------------------------ wall heat analysis (per wall, exact azimuth, ray-traced shade)
let solarCache = { key: null, val: null }, playTimer = null;
const HEAT = ["#fde4d6", "#f9c4a6", "#f4a274", "#eb6834", "#c9531f", "#9c3f15", "#6e2b0c"];   // single-hue orange ramp for solar heat
const heatColor = (v, hi) => HEAT[Math.max(0, Math.min(HEAT.length - 1, Math.floor((v / (hi || 1)) * HEAT.length)))];
const MODE_TXT = { now: "sun at the chosen time", month: "daily sun this month", year: "annual sun", u: "U-value" };
const setMode = m => { S.whMode = m; $("wh-mode").value = m; $("wh-modes").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === m)); $("wh-mode-s").textContent = MODE_TXT[m]; };
setMode(S.whMode); $("wh-abs").value = String(S.absorb);
$("wh-modes").querySelectorAll("button").forEach(b => b.onclick = () => { setMode(b.dataset.v); save(); renderWallHeat(); });
$("wh-abs").onchange = e => { S.absorb = +e.target.value; save(); renderWallHeat(); };
$("wh-play").onclick = () => {
  if (playTimer) { clearInterval(playTimer); playTimer = null; $("wh-play").textContent = "▶ Play day"; return; }
  S.sunNow = false; $("sun-now").checked = false; if (S.whMode === "u" || S.whMode === "year") setMode("now");
  $("wh-play").textContent = "❚❚ Pause";
  playTimer = setInterval(() => { S.sunHour = S.sunHour >= 18 ? 6 : S.sunHour + 0.25; $("sun-h").value = S.sunHour; sunStudy(); }, 160);
};
function wallsForHeat() {
  const p = lastProject || currentProject();
  const u = S.applyAll && derived[S.studio]?.u_value ? derived[S.studio].u_value.value : null;
  return p.walls.filter(w => w.external && w.area_m2).map(w => ({ ...w, u_eff: u ?? w.u_value ?? (derived[S.studio]?.u_value?.value ?? null) }));
}
function computeWallSolar(walls) {
  const lat = siteLat(), key = [lat.toFixed(3), S.city, walls.map(w => w.id + ":" + (w.azimuth_deg ?? w.orientation) + ":" + w.area_m2).join("|")].join("/");
  if (solarCache.key !== key) solarCache = { key, val: SOL.wallSolar(lat, cities[S.city].monthly.ALLSKY_SFC_SW_DWN, walls) };
  return solarCache.val;
}
// shaded hourly irradiance: diffuse + reflected unchanged, direct x sunlit fraction
const shadedAt = (F, m, x, h) => { const tot = F[m].hourly[x.key][h], bm = F[m].beam[x.key][h], fr = shade?.[x.wall.id]?.[m]?.[h]; return fr == null ? tot : tot - bm + bm * fr; };
function heatRows() {
  const walls = wallsForHeat(); if (!walls.length) return [];
  const { F, per } = computeWallSolar(walls);
  const m = lastSunNow ? new Date().getMonth() : S.sunMonth;
  const h = Math.max(0, Math.min(23, Math.floor(lastSunNow ? lastSunNow.solarTime : S.sunHour)));
  return per.map(x => {
    const I = shadedAt(F, m, x, h);
    const dayH = Array.from({ length: 24 }, (_, k) => shadedAt(F, m, x, k)), day = dayH.reduce((a, b) => a + b, 0) / 1000;
    let annual = 0, annualUnshaded = 0, beamTot = 0, beamLost = 0;
    for (let mm = 0; mm < 12; mm++) for (let k = 0; k < 24; k++) {
      const v = shadedAt(F, mm, x, k); annual += v * SOL.MONTH_DAYS[mm] / 1000; annualUnshaded += F[mm].hourly[x.key][k] * SOL.MONTH_DAYS[mm] / 1000;
      const bm = F[mm].beam[x.key][k], fr = shade?.[x.wall.id]?.[mm]?.[k]; beamTot += bm; if (fr != null) beamLost += bm * (1 - fr);
    }
    const q = x.wall.u_eff != null ? SOL.solarHeatFlux(x.wall.u_eff, S.absorb, I) : null;
    const fr = shade?.[x.wall.id]?.[m]?.[h], bmNow = F[m].beam[x.key][h];
    return { ...x, I, day, q, qWall: q != null ? q * x.wall.area_m2 : null, peakH: dayH.indexOf(Math.max(...dayH)), annual_kwh_m2: annual, annual_kwh: annual * x.wall.area_m2,
      annualUnshaded, shadeLoss: beamTot ? beamLost / beamTot : 0, sunlit: bmNow > 1 ? fr ?? 1 : null, hourly: dayH };
  });
}
function renderWallHeat() {
  const rows = heatRows();
  if (!rows.length) { $("wh-tiles").innerHTML = "<p class='mut'>Load a model or enter facade areas.</p>"; $("wh-now").innerHTML = $("wh-year").innerHTML = $("wh-table").innerHTML = ""; return; }
  const m = lastSunNow ? new Date().getMonth() : S.sunMonth, hourIdx = Math.max(0, Math.min(23, Math.floor(lastSunNow ? lastSunNow.solarTime : S.sunHour)));
  const maxBy = k => rows.reduce((a, b) => (b[k] ?? -1) > (a[k] ?? -1) ? b : a);
  const hotNow = maxBy("I"), hotMonth = maxBy("day"), hotYear = maxBy("annual_kwh_m2"), mostShaded = maxBy("shadeLoss");
  const lbl = r => `${r.wall.name.length > 28 ? r.wall.orientation + " wall" : r.wall.name} · ${r.wall.orientation} ${Math.round(r.wall.azimuth_deg ?? 0)}°`;
  $("wh-sub").textContent = `${rows.length} external walls, each on its own compass direction from the 3D geometry${shade ? ", with ray-traced shade" : " (shade being computed)"}. ${lastSunNow ? "Now" : `${SOL.MONTHS[m]}, ${hourIdx}:00–${hourIdx + 1}:00 solar`}.`;
  $("wh-tiles").innerHTML =
    `<div class="card tile"><p class="k">Most sun now</p><p class="v" style="font-size:1.2rem">${hotNow.I > 1 ? esc(lbl(hotNow)) : "No direct sun"}</p><p class="d">${hotNow.I > 1 ? `${Math.round(hotNow.I)} W/m²${hotNow.q != null ? ` · ≈ ${f(hotNow.q, 1)} W/m² into the room` : ""}` : "sun down or behind every wall"}</p></div>` +
    `<div class="card tile"><p class="k">Hottest in ${SOL.MONTHS[m]}</p><p class="v" style="font-size:1.2rem">${esc(lbl(hotMonth))}</p><p class="d">${f(hotMonth.day, 2)} kWh/m² a day · peaks ${hotMonth.peakH}:00 solar</p></div>` +
    `<div class="card tile"><p class="k">Hottest over the year</p><p class="v" style="font-size:1.2rem">${esc(lbl(hotYear))}</p><p class="d">${Math.round(hotYear.annual_kwh_m2)} kWh/m² a year${shade && mostShaded.shadeLoss > 0.02 ? ` · most shaded: ${esc(lbl(mostShaded))} (${Math.round(mostShaded.shadeLoss * 100)}% of direct sun blocked)` : ""}</p></div>`;
  const F = computeWallSolar(wallsForHeat()).F;
  const hiNow = Math.max(1, ...rows.map(r => Math.max(...F.flatMap((mm, i) => mm.hourly[r.key]))));
  const top = rows.slice().sort((a, b) => b.I - a.I).slice(0, 14), topY = rows.slice().sort((a, b) => b.annual_kwh_m2 - a.annual_kwh_m2).slice(0, 14);
  $("wh-now").innerHTML = C.rankedBars(top.map(r => ({ label: lbl(r), value: r.I, tipLabel: `${r.wall.name}${r.sunlit != null ? ` · ${Math.round(r.sunlit * 100)}% sunlit` : ""}` })), { unit: "W/m²", decimals: 0, max: Math.ceil(hiNow / 100) * 100, width: W("wh-now"), title: "solar now per wall" }) + (rows.length > 14 ? `<p class="small mut">Top 14 of ${rows.length} walls.</p>` : "");
  $("wh-year").innerHTML = C.rankedBars(topY.map(r => ({ label: lbl(r), value: r.annual_kwh_m2, tipLabel: `${r.wall.name} · ${Math.round(r.annual_kwh).toLocaleString("en-IN")} kWh on ${f(r.wall.area_m2, 1)} m² · unshaded ${Math.round(r.annualUnshaded)}` })), { unit: "kWh/m²·yr", decimals: 0, width: W("wh-year"), title: "annual solar per wall" });
  $("wh-table").innerHTML = `<table><tr><th>Wall</th><th>Facing</th><th class="num">Area m²</th><th class="num">U</th><th class="num">Now W/m²</th><th class="num">Into room</th><th class="num">${SOL.MONTHS[m]} kWh/m²·d</th><th class="num">Year kWh/m²</th><th class="num">Shade</th><th class="num">Year kWh</th></tr>` +
    rows.map(r => `<tr${r === hotYear ? ' style="background:var(--warn-wash)"' : ""}><td>${esc(r.wall.name)}</td><td>${r.wall.orientation} <span class="small mut">${Math.round(r.wall.azimuth_deg ?? 0)}°</span></td><td class="num">${f(r.wall.area_m2, 1)}</td><td class="num">${r.wall.u_eff != null ? f(r.wall.u_eff) : "–"}</td><td class="num">${Math.round(r.I)}</td><td class="num">${r.q != null ? f(r.q, 1) : "–"}</td><td class="num">${f(r.day, 2)}</td><td class="num">${Math.round(r.annual_kwh_m2)}</td><td class="num">${shade ? Math.round(r.shadeLoss * 100) + "%" : "…"}</td><td class="num">${Math.round(r.annual_kwh).toLocaleString("en-IN")}</td></tr>`).join("") + `</table>`;
  if (!ws) return;
  const byId = Object.fromEntries(rows.map(r => [r.wall.id, r]));
  if (S.whMode !== "u") {
    const val = r => S.whMode === "now" ? r.I : S.whMode === "month" ? r.day : r.annual_kwh_m2;
    const hi = S.whMode === "now" ? hiNow : Math.max(...rows.map(val));
    const glow = S.whMode === "now" ? (hotNow.I > 1 ? hotNow.wall.id : null) : S.whMode === "month" ? hotMonth.wall.id : hotYear.wall.id;
    ws.recolorWith((w, id) => byId[id] ? heatColor(val(byId[id]), hi) : "#cfcbc3", glow);
    const unit = S.whMode === "now" ? "W/m²" : S.whMode === "month" ? "kWh/m²·d" : "kWh/m²·yr";
    const best = {}; for (const r of rows) if (!best[r.wall.orientation] || val(r) > val(best[r.wall.orientation])) best[r.wall.orientation] = r;   // one label per facade direction
    const show = Object.values(best);
    ws.setLabels(show.map(r => ({ pos: r.wall.labelPos, hot: r.wall.id === glow, html: `<b>${esc(r.wall.orientation)}</b> ${S.whMode === "month" ? f(val(r), 2) : Math.round(val(r))} ${unit}${r.wall.id === glow ? " ▲" : ""}` })));
    $("ramp").innerHTML = HEAT.map(c => `<i style="background:${c}"></i>`).join("");
    $("ramp").parentElement.querySelector("span").textContent = S.whMode === "now" ? "Sun now" : S.whMode === "month" ? "Sun, month" : "Sun, year";
    $("ramp").parentElement.lastElementChild.textContent = `0 → ${Math.round(hi)} ${unit}`;
  } else {
    $("ramp").innerHTML = RAMP_STOPS.map(c => `<i style="background:${c}"></i>`).join("");
    $("ramp").parentElement.querySelector("span").textContent = "U-value"; $("ramp").parentElement.lastElementChild.textContent = "0 → 2.5+ W/m²K";
    ws.recolorWith((w, id) => byId[id] ? uColorOf(byId[id].wall.u_eff) : "#cfcbc3");
    const one = {}; for (const r of rows) one[r.wall.orientation] ||= r;
    ws.setLabels(Object.values(one).map(r => ({ pos: r.wall.labelPos, html: `<b>${esc(r.wall.orientation)}</b> U ${r.wall.u_eff != null ? f(r.wall.u_eff) : "–"}` })));
  }
  if (selInfo) renderSelection();
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
if (S.src === "ifc" && !S.ifcProject) S.src = "duplex";
await detectBackend();
try {
  const sb = await (await fetch("data/sample_house.ifc")).arrayBuffer();
  if (BACKEND) { const r = await fetch("api/ifc", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: sb }); if (r.ok) sampleProject = await r.json(); else throw new Error(); }
  else sampleProject = B.analyse(new TextDecoder().decode(sb), db, derived);
} catch { try { sampleProject = B.analyse(await (await fetch("data/sample_house.ifc")).text(), db, derived); } catch { /* keep the Python-built copy */ } }
renderSliders(); showTab(location.hash.slice(1) || "overview"); initMap(); loadModel();
