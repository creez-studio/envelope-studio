// bim.js - browser port of engine/bim_ifc.py: dependency-free IFC (STEP text) reader -> envelope project -> RETV.
// Orientation: OrientationDeg property if present, else the wall placement axis ASSUMING the exterior face is the
// first material layer on the -y side of the wall axis (flagged 'placement_assumed'). Unmapped materials are never guessed.
import * as E from "./engine.js";

// ------------------------------------------------------------ STEP parsing
function tokenise(s) {
  let pos = 0;
  const ws = () => { while (pos < s.length && " \t\r\n".includes(s[pos])) pos++; };
  function value() {
    ws();
    const c = s[pos];
    if (c === "(") {
      pos++; const items = [];
      for (;;) {
        while (" \t\r\n,".includes(s[pos])) pos++;
        if (s[pos] === ")") { pos++; return items; }
        items.push(value());
      }
    }
    if (c === "'") {
      pos++; let buf = "";
      for (;;) {
        if (s[pos] === "'") {
          if (s[pos + 1] === "'") { buf += "'"; pos += 2; continue; }
          pos++; return buf;
        }
        buf += s[pos++];
      }
    }
    if (c === "#") { const m = /^#(\d+)/.exec(s.slice(pos)); pos += m[0].length; return { t: "ref", id: +m[1] }; }
    if (c === "$" || c === "*") { pos++; return null; }
    if (c === ".") { const m = /^\.([A-Z0-9_]+)\./.exec(s.slice(pos)); pos += m[0].length; return { t: "enum", v: m[1] }; }
    let m = /^-?\d+(?:\.\d*)?(?:[eE][-+]?\d+)?/.exec(s.slice(pos));
    if (m) { pos += m[0].length; return parseFloat(m[0]); }
    m = /^([A-Z0-9_]+)\s*\(/.exec(s.slice(pos));
    if (m) {
      pos += m[0].length - 1;
      const inner = value();
      return { t: "typed", name: m[1], v: Array.isArray(inner) && inner.length === 1 ? inner[0] : inner };
    }
    throw new Error("cannot parse STEP near: " + s.slice(pos, pos + 40));
  }
  const out = [];
  while (pos < s.length) {
    while (pos < s.length && " \t\r\n,".includes(s[pos])) pos++;
    if (pos >= s.length) break;
    out.push(value());
  }
  return out;
}

export function parseStep(text) {
  const data = text.split("DATA;", 2)[1].split("ENDSEC;", 1)[0];
  const ents = new Map();
  for (const m of data.matchAll(/#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*?)\)\s*;/g)) {
    let args = null;
    try { args = tokenise(m[3]); } catch { args = null; }
    ents.set(+m[1], [m[2], args]);
  }
  return ents;
}

const val = v => v && v.t === "typed" ? v.v : v && v.t === "enum" ? ({ T: true, F: false }[v.v] ?? v.v) : v;
const get = (ents, r) => (r && r.t === "ref") ? ents.get(r.id) : undefined;

// ------------------------------------------------------------ material mapping (same order as Python)
export const MATERIAL_KEYWORDS = [
  [/plaster|render/, "cement_plaster"],
  [/\baac\b|aerated|autoclaved/, "aac_642"],
  [/cseb|stabili[sz]ed (earth|soil|mud)|compressed earth/, "cseb_1800"],
  [/fly ?ash/, "fly_ash_brick_1650"],
  [/hollow clay|perforated|resource efficient/, "hollow_clay_1520"],
  [/clc|cellular|foam concrete/, "cellular_concrete_704"],
  [/coir/, "coir_board_97"],
  [/eps|polystyrene/, "eps_24"],
  [/solid concrete|concrete block/, "solid_concrete_block_2427"],
  [/brick/, "clay_brick_1920"],
];
export function mapMaterial(name) {
  const low = (name || "").toLowerCase();
  for (const [rx, ref] of MATERIAL_KEYWORDS) if (rx.test(low)) return ref;
  return null;
}

// ------------------------------------------------------------ extraction
function lengthScale(ents) {
  for (const [t, a] of ents.values())
    if (t === "IFCSIUNIT" && a && a[1] && a[1].t === "enum" && a[1].v === "LENGTHUNIT") {
      const pre = a[2] ? a[2].v : null;
      return { MILLI: 0.001, CENTI: 0.01 }[pre] ?? 1.0;
    }
  return 1.0;
}
function angle(v) {
  if (!v) return null;
  const d = v[0], m = v.length > 1 ? v[1] : 0, s = v.length > 2 ? v[2] : 0;
  const sign = d < 0 ? -1 : 1;
  return d + sign * (Math.abs(m) / 60 + Math.abs(s) / 3600);
}
const deg = r => r * 180 / Math.PI, mod = (a, n) => ((a % n) + n) % n;
function placementAzimuthX(ents, pl) {
  let total = 0, cur = pl, depth = 0;
  while (cur && depth < 20) {
    const e = get(ents, cur);
    if (!e || e[0] !== "IFCLOCALPLACEMENT") break;
    const [rel, ax] = e[1];
    const a = get(ents, ax);
    if (a && a[0] === "IFCAXIS2PLACEMENT3D" && a[1][2]) { const d = get(ents, a[1][2])[1][0]; total += deg(Math.atan2(d[0], d[1])); }
    cur = rel; depth++;
  }
  return mod(total, 360);
}

// World position (project units -> m) and axis angle (deg, CCW from +X) of a placement, composing the PlacementRelTo chain.
function placement2D(ents, pl, scale) {
  const chain = []; let cur = pl, depth = 0;
  while (cur && depth < 20) {
    const e = get(ents, cur);
    if (!e || e[0] !== "IFCLOCALPLACEMENT") break;
    const a = get(ents, e[1][1]);
    let loc = [0, 0], th = 0;
    if (a && a[0] === "IFCAXIS2PLACEMENT3D") {
      const p = get(ents, a[1][0]); if (p) loc = [p[1][0][0] || 0, p[1][0][1] || 0];
      if (a[1][2]) { const d = get(ents, a[1][2])[1][0]; th = Math.atan2(d[1], d[0]); }
    }
    chain.unshift({ loc, th }); cur = e[1][0]; depth++;
  }
  let x = 0, y = 0, t = 0;
  for (const c of chain) { x += (Math.cos(t) * c.loc[0] - Math.sin(t) * c.loc[1]) * scale; y += (Math.sin(t) * c.loc[0] + Math.cos(t) * c.loc[1]) * scale; t += c.th; }
  return { x, y, theta_deg: deg(t) };
}

export function extract(ents, db) {
  const scale = lengthScale(ents), byt = {};
  for (const [i, [t]] of ents) (byt[t] ||= []).push(i);
  for (const k in byt) byt[k].sort((a, b) => a - b);
  const warnings = [];
  let lat = null, lon = null;
  for (const i of byt.IFCSITE || []) { const a = ents.get(i)[1]; if (a && a.length > 10) { lat = angle(a[9]); lon = angle(a[10]); } }
  let tn = 0, foundTn = false;
  for (const i of byt.IFCGEOMETRICREPRESENTATIONCONTEXT || []) {
    const a = ents.get(i)[1];
    if (a && a.length > 5 && a[5]) { const d = get(ents, a[5])[1][0]; tn = deg(Math.atan2(-d[0], d[1])); foundTn = true; break; }
  }
  if (!foundTn) warnings.push("No TrueNorth in the model: assuming project +Y = true north.");
  if (lat === null) warnings.push("No IfcSite latitude: climate zone must be set manually.");
  else if (lat >= 23.5) warnings.push("Site latitude >= 23.5 N: ENS orientation factors for lat < 23.5 N (Kerala) would be wrong.");

  const props = {}, quants = {};
  for (const i of byt.IFCRELDEFINESBYPROPERTIES || []) {
    const a = ents.get(i)[1], pdef = get(ents, a[5]);
    if (!pdef) continue;
    for (const o of a[4] || []) {
      if (pdef[0] === "IFCPROPERTYSET") {
        for (const pr of pdef[1][4] || []) { const p = get(ents, pr); if (p && p[0] === "IFCPROPERTYSINGLEVALUE") (props[o.id] ||= {})[p[1][0]] = val(p[1][2]); }
      } else if (pdef[0] === "IFCELEMENTQUANTITY") {
        for (const qr of pdef[1][5] || []) { const q = get(ents, qr); if (q && q[0] === "IFCQUANTITYAREA") (quants[o.id] ||= {})[q[1][0]] = q[1][3] * scale * scale; }
      }
    }
  }
  const mats = {};
  for (const i of byt.IFCRELASSOCIATESMATERIAL || []) {
    const a = ents.get(i)[1], rel = get(ents, a[5]);
    let set = null, sense = "POSITIVE";
    if (rel && rel[0] === "IFCMATERIALLAYERSETUSAGE") { sense = rel[1][2] ? rel[1][2].v : "POSITIVE"; set = get(ents, rel[1][0]); }
    else if (rel && rel[0] === "IFCMATERIALLAYERSET") set = rel;
    if (!set) continue;
    const layers = set[1][0].map(lr => { const ly = get(ents, lr), m = get(ents, ly[1][0]); return { material: m ? m[1][0] : null, t_mm: ly[1][1] * scale * 1000 }; });
    for (const o of a[4]) mats[o.id] = [layers, sense];
  }
  const opToWall = {}, winOfWall = {};
  for (const i of byt.IFCRELVOIDSELEMENT || []) { const a = ents.get(i)[1]; opToWall[a[5].id] = a[4].id; }
  for (const i of byt.IFCRELFILLSELEMENT || []) { const a = ents.get(i)[1], w = opToWall[a[4].id]; if (w !== undefined) (winOfWall[w] ||= []).push(a[5].id); }

  const orient = (wid, a) => {
    const p = props[wid] || {};
    for (const k of ["OrientationDeg", "Orientation_deg"]) if (k in p) return [mod(+p[k], 360), "property"];
    const sense = (mats[wid] || [null, "POSITIVE"])[1];
    const outP = mod(placementAzimuthX(ents, a[5]) + 90 + (sense === "NEGATIVE" ? 180 : 0), 360);
    return [mod(outP + tn, 360), "placement_assumed"];
  };

  const cat = db.layer_catalogue, sr = db.surface_resistance, walls = [], openings = [];
  for (const i of [...(byt.IFCWALLSTANDARDCASE || []), ...(byt.IFCWALL || [])]) {
    const a = ents.get(i)[1], p = props[i] || {}, external = p.IsExternal;
    const [az, azSrc] = orient(i, a);
    const layers = (mats[i] || [null])[0];
    let allMapped = !!(layers && layers.length);
    const lay = (layers || []).map(ly => { const ref = mapMaterial(ly.material); allMapped = allMapped && ref !== null; return { material: ly.material, t_mm: Math.round(ly.t_mm * 1000) / 1000, catalogue_ref: ref }; });
    let u = null;
    if (allMapped) { const r = E.uValue(lay.map(l => ({ ref: l.catalogue_ref, t_mm: l.t_mm })), cat, sr.rsi, sr.rse); u = r ? r.u : null; }
    const area = quants[i]?.NetSideArea ?? null;
    const pl2 = placement2D(ents, a[5], scale);
    if (external === undefined) warnings.push(`Wall '${a[2]}' has no IsExternal flag; treated as external.`);
    walls.push({ id: a[0], name: a[2], external: external === undefined ? true : !!external, area_m2: area, area_source: area !== null ? "NetSideArea" : "missing",
      azimuth_deg: Math.round(az * 10) / 10, orientation: E.orientationBin(az), orientation_source: azSrc, layers: lay, u_value: u,
      u_status: u !== null ? "derived" : "unknown (unmapped or missing layers)",
      geom: { eid: i, x: pl2.x, y: pl2.y, theta_deg: pl2.theta_deg, thickness_m: lay.reduce((t, l) => t + l.t_mm / 1000, 0) } });
    for (const wi of winOfWall[i] || []) {
      const [wt, wa] = ents.get(wi), wp = props[wi] || {};
      const h = (wa[8] || 0) * scale, w = (wa[9] || 0) * scale;
      const uw = wp.ThermalTransmittance ?? null, sh = wp.SolarHeatGainTransmittance ?? wp.SHGC ?? null;
      openings.push({ id: wa[0], name: wa[2], type: wt === "IFCWINDOW" ? "window" : "door", host_wall: a[0], area_m2: h * w,
        azimuth_deg: Math.round(az * 10) / 10, orientation: E.orientationBin(az), u: uw, shgc: sh, esf: 1.0,
        data_status: uw !== null && sh !== null ? "from_model" : "missing_u_or_shgc" });
    }
  }
  return { site: { lat, lon }, true_north_ccw_deg: Math.round(tn * 1000) / 1000, length_scale_to_m: scale, walls, openings, warnings };
}

export function analyse(text, db, derived = E.deriveValues(db)) {
  const prj = extract(parseStep(text), db);
  const ext = prj.walls.filter(w => w.external);
  prj.unmapped_walls = ext.filter(w => w.u_value === null).map(w => w.name);
  if (ext.some(w => w.area_m2 === null)) prj.warnings.push("Some external walls have no NetSideArea quantity; RETV cannot be computed for them.");
  if (prj.unmapped_walls.length) prj.warnings.push("Walls with unmapped materials have no U-value: " + prj.unmapped_walls.join(", "));
  const ok = prj.openings.filter(o => o.u !== null && o.shgc !== null);
  if (ok.length < prj.openings.length) prj.warnings.push("Some openings lack ThermalTransmittance / SolarHeatGainTransmittance; they are excluded from RETV and the result is not valid until they are supplied.");
  const okWalls = ext.filter(w => w.u_value !== null && w.area_m2 !== null);
  prj.retv_as_modelled = okWalls.length && okWalls.length === ext.length
    ? E.retv(db, okWalls.map(w => ({ area_m2: w.area_m2, u: w.u_value, orientation: w.orientation })), ok) : null;
  prj.retv_if_all_walls_were = E.retvSubstitution(db, derived, { walls: ext.filter(w => w.area_m2 !== null).map(w => ({ area_m2: w.area_m2, orientation: w.orientation })), openings: ok });
  prj.note = "RETV is a whole-envelope code check (ENS 2024 Sec. 9.5). 'retv_if_all_walls_were' swaps every external wall for each candidate to show the effect of the wall alone; windows, shading (ESF) and opaque doors are not optimised. Not a compliance determination.";
  return prj;
}

// Manual project (no BIM file): wall areas and window areas per orientation, one window type.
export function manualProject(db, { areas, wwr, winU, winShgc }) {
  const walls = [], openings = [];
  for (const [o, gross] of Object.entries(areas)) {
    if (!(gross > 0)) continue;
    const win = gross * wwr;
    walls.push({ id: "manual-" + o, name: `${o} facade`, external: true, area_m2: gross - win, area_source: "manual", azimuth_deg: null,
      orientation: o, orientation_source: "manual", layers: [], u_value: null, u_status: "chosen per candidate" });
    if (win > 0) openings.push({ id: "manual-win-" + o, name: `${o} windows`, type: "window", host_wall: "manual-" + o, area_m2: win, orientation: o, u: winU, shgc: winShgc, esf: 1, data_status: "manual" });
  }
  const derived = E.deriveValues(db);
  return { site: { lat: null, lon: null }, true_north_ccw_deg: 0, walls, openings, warnings: ["Manual geometry: areas and window data are your inputs, not read from a model."],
    unmapped_walls: [], retv_as_modelled: null,
    retv_if_all_walls_were: walls.length ? E.retvSubstitution(db, derived, { walls, openings }) : {},
    note: "RETV is a whole-envelope code check (ENS 2024 Sec. 9.5) computed from your manual areas. Not a compliance determination." };
}
