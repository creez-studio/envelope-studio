// studio.js - per-project material choices (product / size / market variant), budgets, reasons and computed what-ifs.
// Nothing here is advice written by a model: every sentence is assembled from engine numbers and cited dataset fields.
import * as E from "./engine.js";

const clone = o => JSON.parse(JSON.stringify(o));
const coreIndex = (cand, nonCore) => {
  let best = -1;
  cand.assembly.layers.forEach((ly, i) => { if (ly.ref && !nonCore.has(ly.ref) && (best < 0 || ly.t_mm > cand.assembly.layers[best].t_mm)) best = i; });
  return best;
};

/** Returns a copy of db with the chosen variants applied. choices: {candId: variantId | "base"}. */
export function applyChoices(db, market, choices = {}) {
  const out = clone(db), nonCore = new Set(db.layer_roles?.non_core ?? ["cement_plaster", "eps_24"]);
  for (const c of out.candidates) {
    const vid = choices[c.id];
    if (!vid || vid === "base") continue;
    const v = (market.products[c.id] || []).find(x => x.id === vid);
    if (!v) continue;
    const ci = coreIndex(c, nonCore);
    if (v.t_mm && ci >= 0 && c.assembly.layers[ci].ref) c.assembly.layers[ci].t_mm = v.t_mm;
    if (v.price_inr != null && v.l_mm && v.h_mm)
      c.properties.masonry_unit = { price_inr: v.price_inr, l_mm: v.l_mm, h_mm: v.h_mm, joint_mm: v.joint_mm, wythes: v.wythes,
        grade: v.grade, status: v.status, source: v.source, unit: "INR/piece", value: v.price_inr, note: v.label };
    else delete c.properties.masonry_unit;
  }
  return out;
}

export const piecesPerM2 = v => v.l_mm && v.h_mm ? v.wythes / (((v.l_mm + v.joint_mm) / 1000) * ((v.h_mm + v.joint_mm) / 1000)) : null;

/** Cost of masonry units for a wall area, with low/high from the listing's price range when given. */
export function budgetFor(variant, area) {
  const pcs = piecesPerM2(variant);
  if (pcs == null || variant.price_inr == null) return null;
  const per = variant.price_inr * pcs, rng = variant.price_range;
  return { pieces_m2: pcs, inr_m2: per, total: per * area, pieces_total: pcs * area,
    low: rng ? rng[0] * pcs * area : null, high: rng ? rng[1] * pcs * area : null };
}

/** Variant currently in force for a candidate (explicit choice, else a synthetic 'as published' variant). */
export function activeVariant(db, market, choices, cid) {
  const vid = choices[cid];
  const list = market.products[cid] || [];
  if (vid && vid !== "base") return list.find(v => v.id === vid) || null;
  const mu = db.candidates.find(c => c.id === cid).properties.masonry_unit;
  return mu ? { id: "base", label: "As published (dataset)", city: "-", ...mu, price_range: null, t_mm: null } : { id: "base", label: "As published (no price)", price_inr: null };
}

/** Computed what-ifs for the chosen material in the current project. All values come from the engines. */
export function whatIfs(db, market, choices, project, cid) {
  const tips = [];
  const der = E.deriveValues(applyChoices(db, market, choices));
  const ext = project.walls.filter(w => w.external && w.area_m2 != null);
  const area = ext.reduce((s, w) => s + w.area_m2, 0);
  const openings = (project.openings || []).filter(o => o.u != null && o.shgc != null);
  const cur = der[cid];
  // 1. cheaper size / market variant of the same material
  const vs = (market.products[cid] || []).map(v => ({ v, b: budgetFor(v, area), d: E.deriveValues(applyChoices(db, market, { ...choices, [cid]: v.id }))[cid] })).filter(x => x.b);
  if (cur.cost && vs.length) {
    const best = vs.reduce((a, b) => (b.b.inr_m2 < a.b.inr_m2 ? b : a));
    const save = (cur.cost.value - best.b.inr_m2) * area;
    if (save > 1) tips.push({ kind: "cost", text: `Use "${best.v.label}"${best.v.note ? ` (${best.v.note.replace(/\.$/, "")})` : ""}: INR ${Math.round(best.b.inr_m2)}/m2 instead of INR ${Math.round(cur.cost.value)}/m2, about INR ${Math.round(save).toLocaleString("en-IN")} less for ${area.toFixed(1)} m2 of wall` + (best.d.u_value && cur.u_value && Math.abs(best.d.u_value.value - cur.u_value.value) > 0.01 ? `, but the U-value changes from ${cur.u_value.value.toFixed(2)} to ${best.d.u_value.value.toFixed(2)} W/m2K.` : "."), source: best.v.source });
  }
  // 2. cheapest priced alternative that keeps RETV within the ENS limit
  if (ext.length) {
    const alt = Object.entries(der).filter(([id, d]) => id !== cid && d.cost && d.u_value).map(([id, d]) => ({ id, d, r: E.retv(db, ext.map(w => ({ area_m2: w.area_m2, u: d.u_value.value, orientation: w.orientation })), openings) }))
      .filter(x => x.r.compliant_at_limit).sort((a, b) => a.d.cost.value - b.d.cost.value)[0];
    if (alt && (!cur.cost || alt.d.cost.value < cur.cost.value))
      tips.push({ kind: "cost", text: `Lowest-priced listed alternative that keeps this model's RETV within ${db.retv.limit_w_m2} W/m2: ${db.candidates.find(c => c.id === alt.id).name.split(" (")[0]} at INR ${Math.round(alt.d.cost.value)}/m2 (RETV ${alt.r.retv.toFixed(2)}).`, source: alt.d.cost.source });
  }
  // 3. RETV levers that do not change the wall: glazing and shading
  if (cur.u_value && ext.length && openings.length) {
    const base = E.retv(db, ext.map(w => ({ area_m2: w.area_m2, u: cur.u_value.value, orientation: w.orientation })), openings);
    const g05 = E.retv(db, ext.map(w => ({ area_m2: w.area_m2, u: cur.u_value.value, orientation: w.orientation })), openings.map(o => ({ ...o, shgc: Math.min(o.shgc, 0.5) })));
    const shade = E.retv(db, ext.map(w => ({ area_m2: w.area_m2, u: cur.u_value.value, orientation: w.orientation })), openings.map(o => ({ ...o, esf: o.orientation === "N" ? 1 : 0.7 })));
    tips.push({ kind: "climate", text: `With this wall the model's RETV is ${base.retv.toFixed(2)} W/m2; windows with SHGC 0.5 would give ${g05.retv.toFixed(2)}, and overhangs or fins with a shading factor of 0.7 on the non-north windows would give ${shade.retv.toFixed(2)}.`, source: "S01" });
  }
  // 4. lower-carbon option with a cited value
  if (cur.gwp_core) {
    const low = Object.entries(der).filter(([id, d]) => d.gwp_core && d.gwp_core.value < cur.gwp_core.value - 1e-9).sort((a, b) => a[1].gwp_core.value - b[1].gwp_core.value)[0];
    if (low) tips.push({ kind: "material", text: `${db.candidates.find(c => c.id === low[0]).name.split(" (")[0]} has lower cited core carbon (${low[1].gwp_core.value.toFixed(1)} against ${cur.gwp_core.value.toFixed(1)} kgCO2e/m2), from sources with different boundaries.`, source: low[1].gwp_core.source });
  } else tips.push({ kind: "material", text: "No cited carbon factor for this material, so a lower-carbon comparison is not possible yet.", source: null });
  return { tips, area };
}

/** Plain-language reasons built from the rank breakdown (no model). */
export function reasons(db, res, der, ind, sub, cid) {
  const name = id => db.candidates.find(c => c.id === id).name.split(" (")[0];
  const out = [];
  const r = res.ranked.find(x => x.id === cid), ex = res.excluded.find(x => x.id === cid);
  if (r) {
    out.push(`Ranks ${r.rank} of ${res.ranked.length} with a partial score of ${r.score.toFixed(3)} (evidence completeness ${r.completeness.toFixed(2)}).`);
    for (const b of r.breakdown) {
      const better = res.ranked.filter(o => o.id !== cid && o.breakdown.find(x => x.criterion_id === b.criterion_id)?.normalised < b.normalised).length;
      out.push(`${b.criterion.split(" (")[0]}: ${b.raw.toFixed(2)} ${b.unit}, better than ${better} of the other ${res.ranked.length - 1} ranked options (normalised ${b.normalised.toFixed(2)}, contributes ${b.contribution.toFixed(3)}).`);
    }
  } else if (ex) out.push(`Not ranked: ${ex.reason}. Missing: ${ex.missing.join(", ")}.`);
  const i = ind[cid];
  if (i) out.push(`Daily heat-wave damping: decrement factor ${i.decrement_factor.toFixed(2)}, time lag ${i.time_lag_h.toFixed(1)} h (indicator, not scored).`);
  if (sub && sub[cid]) out.push(`If every external wall of this model were ${name(cid)}, RETV would be ${sub[cid].retv.toFixed(2)} W/m2 (${sub[cid].compliant_at_limit ? "at or below" : "above"} the ENS limit of ${db.retv.limit_w_m2} after rounding).`);
  return out;
}
