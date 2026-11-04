import * as E from "./engine.js";
import * as X from "./explain.js";

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const D = await (await fetch("data/dataset.json")).json();
const db = D.db, derived = E.deriveValues(db), ind = E.indicators(db);
let project = D.sample_project, retvSub = null, city = "kochi";
const weights = Object.fromEntries(db.criteria.map(c => [c.id, c.weight]));
let last = null;

$("banner").innerHTML = "<b>Research demonstrator - not a design tool.</b> Only values with a cited source are used; everything else is shown as missing and is never imputed. Grade C values are provisional. Only masonry-unit prices (secondary listings) exist for cost; service life, availability and maintenance have not been collected, so scores are <b>partial</b>.";

$("wsliders").innerHTML = db.criteria.map(c => `<label>${esc(c.name.split(" (")[0])} <input type="range" min="0.05" max="0.5" step="0.01" value="${c.weight}" data-c="${c.id}"> <b id="wv_${c.id}">${c.weight.toFixed(2)}</b></label>`).join("");
document.querySelectorAll("#wsliders input").forEach(i => i.oninput = () => { weights[i.dataset.c] = +i.value; $("wv_" + i.dataset.c).textContent = (+i.value).toFixed(2); render(); });
$("grade").onchange = render; $("legacy").onchange = render; $("retvgate").onchange = render;
$("comp").oninput = () => { $("compv").textContent = (+$("comp").value).toFixed(2); render(); };

const badge = (g, s) => `<span class="badge ${g}" title="${esc(s || "")}">${g}${s ? " &middot; " + esc(s.replace("_", " ")) : ""}</span>`;
const f = (x, n = 3) => x == null ? "n/a" : (+x).toFixed(n);

function render() {
  const gateW = Object.fromEntries(db.criteria.map(c => [c.id, c.weight]));
  const elig = {};
  if ($("retvgate").checked && retvSub) for (const [id, r] of Object.entries(retvSub)) if (!r.compliant_at_limit) elig[id] = { thermal_code: "fail" };
  const res = E.rank(db, derived, { weights, gateWeights: gateW, minGrade: $("grade").value, minCompleteness: +$("comp").value, eligOverrides: elig });
  last = res;
  let html = "";
  if ($("legacy").checked) {
    html += `<div class="banner">LEGACY DEMO - original prototype numbers, all <code>verified=false</code>; shown only to prove the new engine reproduces the old arithmetic. Not findings.</div><div class="scroll"><table><tr><th>Rank</th><th>Assembly</th><th class="num">WSM score</th></tr>` +
      E.rankLegacy(db).map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td class="num">${r.score.toFixed(4)}</td></tr>`).join("") + `</table></div><hr>`;
  }
  if (res.ranked.length) {
    const max = Math.max(...res.ranked.map(r => r.score), 0.0001);
    html += `<div class="scroll"><table><tr><th>#</th><th>Wall type</th><th class="num">Score</th><th></th><th>Completeness</th><th>Criteria scored</th></tr>` +
      res.ranked.map(r => `<tr><td>${r.rank}</td><td>${esc(r.name)}</td><td class="num"><b>${f(r.score)}</b></td><td><span class="bar" style="width:${Math.round(r.score / max * 140)}px"></span></td><td>${f(r.completeness, 2)}${r.partial ? " <span class='badge C'>partial</span>" : ""}</td><td class="small">${r.criteria_used.join(", ")}</td></tr>`).join("") + `</table></div>`;
    html += res.ranked.map(r => `<details><summary>Score breakdown - ${esc(r.name)}</summary><div class="scroll"><table><tr><th>Criterion</th><th class="num">Raw</th><th class="num">Normalised</th><th class="num">Eff. weight</th><th class="num">Contribution</th><th>Evidence</th></tr>` +
      r.breakdown.map(b => `<tr><td>${esc(b.criterion)}</td><td class="num">${f(b.raw, 2)} ${esc(b.unit)}</td><td class="num">${f(b.normalised)}</td><td class="num">${f(b.effective_weight)}</td><td class="num">${f(b.contribution, 4)}</td><td>${badge(b.grade, b.status)}</td></tr>`).join("") + `</table></div></details>`).join("");
  } else html += `<p>No candidate meets the evidence gate at these settings.</p>`;
  if (res.warnings.length) html += res.warnings.map(w => `<div class="banner">${esc(w)}</div>`).join("");
  html += `<h2 style="margin-top:14px">Not ranked (insufficient cited evidence)</h2><div class="scroll"><table><tr><th>Wall type</th><th>Reason</th><th>Missing criteria</th></tr>` +
    res.excluded.map(e => `<tr><td>${esc(e.name)}</td><td>${esc(e.reason)}</td><td class="small">${e.missing.join(", ")}</td></tr>`).join("") + `</table></div>`;
  $("rankout").innerHTML = html;

  // sensitivity
  $("sensout").innerHTML = ["u_value", "gwp_core"].map(cid => {
    const s = E.sensitivity(db, cid, { minGrade: $("grade").value, minCompleteness: +$("comp").value });
    const names = [...new Set(s.map(x => x.winner))];
    return `<p><b>${esc(db.criteria.find(c => c.id === cid).name.split(" (")[0])}</b>: ${s.map(x => `${x.weight.toFixed(2)}&rarr;${esc((x.winner || "none").split(" (")[0])}`).join(" &middot; ")}<br><span class="small mut">${names.length === 1 ? "Winner unchanged across the sweep." : "Winner CHANGES across the sweep - the result depends on this weight."} Winner stability is about preferences, not evidence reliability.</span></p>`;
  }).join("");
}

// climate
$("city").innerHTML = Object.entries(D.climate.cities).map(([k, c]) => `<option value="${k}">${esc(c.name)}</option>`).join("");
const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
function spark(vals, color) { const mx = Math.max(...vals), mn = Math.min(0, ...vals), w = 14;
  return `<svg width="${vals.length * w}" height="46" role="img" aria-label="monthly series">${vals.map((v, i) => { const h = Math.max(1, (v - mn) / (mx - mn || 1) * 40); return `<rect x="${i * w}" y="${44 - h}" width="${w - 2}" height="${h}" fill="${color}"><title>${MONTHS[i]}: ${v.toFixed(1)}</title></rect>`; }).join("")}</svg>`; }
function climate() {
  const cs = D.climate_summary[city], m = D.climate.cities[city].monthly;
  const rows = [["Mean temperature (C)", "T2M", "#c2573b"], ["Mean daily max (C)", "T2M_MAX", "#a1402a"], ["Relative humidity (%)", "RH2M", "#2f6b8a"], ["Rainfall (mm/day)", "PRECTOTCORR", "#2f5d50"], ["Horizontal solar (kWh/m2/day)", "ALLSKY_SFC_SW_DWN", "#b58a1b"], ["Wind 10 m (m/s)", "WS10M", "#6b6b6b"]];
  $("climout").innerHTML = `<div class="scroll"><table><tr><th>Series (Jan to Dec)</th><th>Chart</th><th class="num">Mean</th></tr>` + rows.map(([n, k, c]) => `<tr><td>${n}</td><td>${spark(m[k], c)}</td><td class="num">${f(m[k].reduce((a, b) => a + b, 0) / 12, 1)}</td></tr>`).join("") + `</table></div>` +
    `<p class="small">Rainfall ${f(cs.rain_mm_year, 0)} mm/year &middot; wet months (>=300 mm): ${cs.wet_months.join(", ")} &middot; humid months (RH>=80%): ${cs.humid_months.join(", ")} &middot; hottest month ${cs.hottest_month} (daily max ${f(cs.t_max_hottest, 1)} C, min ${f(cs.t_min_hottest, 1)} C) &middot; cooling degree-days above ${cs.cdd_base_c} C (monthly means, coarse): ${f(cs.cdd_year, 0)}</p>` +
    `<div class="banner">${esc(cs.moisture_flag)}</div>` +
    `<h2 style="margin-top:10px">Indoor surface swing, hottest month (decrement factor x outdoor amplitude of ${f((cs.t_max_hottest - cs.t_min_hottest) / 2, 1)} C)</h2><div class="scroll"><table><tr><th>Wall type</th><th class="num">Decrement</th><th class="num">Time lag (h)</th><th class="num">Heat capacity (kJ/m2K)</th><th class="num">Indoor swing (C)</th></tr>` +
    db.candidates.filter(c => ind[c.id]).map(c => `<tr><td>${esc(c.name)}</td><td class="num">${f(ind[c.id].decrement_factor, 2)}</td><td class="num">${f(ind[c.id].time_lag_h, 1)}</td><td class="num">${f(ind[c.id].areal_heat_capacity_kj_m2k, 0)}</td><td class="num">${f(ind[c.id].decrement_factor * (cs.t_max_hottest - cs.t_min_hottest) / 2, 1)}</td></tr>`).join("") + `</table></div>` +
    `<p class="small mut">${esc(D.climate.ens_zone_note)} Source ${D.climate.source}: NASA POWER gridded climatology, not an EPW weather file; the air-temperature wave excludes solar gain on the wall, so the swing is under-stated. Compare with IMD/ISHRAE data before drawing conclusions.</p>`;
}
$("city").onchange = () => { city = $("city").value; climate(); $("go").click(); }; climate();

// BIM + RETV
function bim() {
  const p = project, ext = p.walls.filter(w => w.external);
  const wallsOk = ext.filter(w => w.area_m2 != null);
  const opens = p.openings.filter(o => o.u != null && o.shgc != null);
  retvSub = E.retvSubstitution(db, derived, { walls: wallsOk, openings: opens });
  const cur = p.retv_as_modelled;
  let h = `<p><b>Site</b> lat ${f(p.site.lat, 3)}, lon ${f(p.site.lon, 3)} &middot; true north ${f(p.true_north_ccw_deg, 1)}&deg; CCW of project +Y &middot; ${ext.length} external walls, ${p.openings.length} openings</p>`;
  h += `<div class="scroll"><table><tr><th>Wall</th><th>Orientation</th><th class="num">Area (m2)</th><th>Layers (IFC &rarr; ENS Table 46)</th><th class="num">U (W/m2K)</th></tr>` +
    p.walls.map(w => `<tr><td>${esc(w.name)}</td><td>${w.orientation} <span class="small mut">${w.azimuth_deg}&deg; (${esc(w.orientation_source.replace("_", " "))})</span></td><td class="num">${f(w.area_m2, 2)}</td><td class="small">${w.layers.map(l => `${l.t_mm} mm ${esc(l.material)}${l.catalogue_ref ? "" : " <b>(unmapped)</b>"}`).join(" + ")}</td><td class="num">${w.u_value != null ? f(w.u_value, 2) : "<span class='badge D'>unknown</span>"}</td></tr>`).join("") + `</table></div>`;
  h += cur ? `<p>RETV as modelled: <b>${f(cur.retv, 2)} W/m2</b> (limit ${cur.limit}; opaque ${f(cur.opaque_part, 1)} + window conduction ${f(cur.opening_conduction_part, 1)} + window solar ${f(cur.opening_solar_part, 1)})</p>` : `<p class="small mut">RETV as modelled unavailable: some walls lack a mapped U-value or area.</p>`;
  h += `<h2 style="margin-top:10px">RETV if every external wall were...</h2><div class="scroll"><table><tr><th>Wall type</th><th class="num">U</th><th class="num">RETV (W/m2)</th><th>vs ENS limit ${db.retv.limit_w_m2}</th></tr>` +
    Object.entries(retvSub).sort((a, b) => a[1].retv - b[1].retv).map(([id, r]) => `<tr><td>${esc(db.candidates.find(c => c.id === id).name)}</td><td class="num">${f(derived[id].u_value.value, 2)}</td><td class="num">${f(r.retv, 2)}</td><td>${r.compliant_at_limit ? "<span class='badge B'>at/below limit (rounded " + r.retv_rounded + ")</span>" : "<span class='badge D'>above limit (rounded " + r.retv_rounded + ")</span>"}</td></tr>`).join("") + `</table></div>`;
  h += `<label style="display:block;margin-top:8px"><input type="checkbox" id="retvgate2"> Use as eligibility screen in the ranking (walls above the limit are excluded)</label>`;
  h += p.warnings.map(w => `<div class="banner">${esc(w)}</div>`).join("") + `<p class="small mut">${esc(p.note)}</p>`;
  $("bimout").innerHTML = h;
  $("retvgate2").checked = $("retvgate").checked; $("retvgate2").onchange = e => { $("retvgate").checked = e.target.checked; render(); };
}
$("prjsample").onclick = () => { project = D.sample_project; bim(); render(); $("go").click(); };
$("prjfile").onchange = async e => { const t = await e.target.files[0].text(); try { project = JSON.parse(t); bim(); render(); $("go").click(); } catch (x) { $("bimout").innerHTML = `<div class="banner">Could not read project file: ${esc(x.message)}</div>`; } };

// framework
$("fwout").innerHTML = `<p class="small mut">${esc(D.framework.note)}</p>` + D.framework.categories.map(c => `<details><summary><b>${esc(c.name)}</b> &middot; ${c.criteria.length} criteria &middot; ${c.criteria.filter(x => x.engine_status !== "data_needed").length} implemented or partial</summary><table><tr><th>Criterion</th><th>Unit</th><th>Preferred</th><th>Role</th><th>Engine</th><th>Note</th></tr>` +
  c.criteria.map(x => `<tr><td>${esc(x.name)}</td><td class="small">${esc(x.unit)}</td><td class="small">${x.preferred}</td><td class="small">${x.role.replace(/_/g, " ")}</td><td>${x.engine_status === "data_needed" ? "<span class='badge D'>data needed</span>" : x.engine_status === "partial" ? "<span class='badge C'>partial</span>" : "<span class='badge B'>implemented</span>"}</td><td class="small">${esc(x.note)}</td></tr>`).join("") + `</table></details>`).join("");

// library
$("libout").innerHTML = `<table><tr><th>Wall type</th><th>Assembly (ENS Table 46 conductivities)</th><th class="num">U (W/m²K)</th><th class="num">Core carbon (kgCO₂e/m²)</th><th class="num">Unit cost (INR/m²)</th><th>Rating notes</th></tr>` +
  db.candidates.map(c => {
    const d = derived[c.id], u = d.u_value, g = d.gwp_core, k = d.cost;
    const lay = c.assembly.layers.map(l => l.ref ? `${l.t_mm} mm ${esc(db.layer_catalogue[l.ref].name.split(",")[0])}` : `<i>${l.t_mm} mm ${esc(l.label)}</i>`).join(" + ") || "<i>none defined</i>";
    return `<tr><td><b>${esc(c.name)}</b><br><span class="small mut">${esc(c.maturity)}</span></td><td class="small">${lay}${c.assembly.note ? `<br><span class="mut">${esc(c.assembly.note)}</span>` : ""}</td>` +
      `<td class="num">${u ? f(u.value, 2) + "<br>" + badge(u.grade, u.status) : "<span class='badge D'>missing</span>"}</td>` +
      `<td class="num">${g ? f(g.value, 1) + "<br>" + badge(g.grade, c.properties.gwp.status) + `<br><span class='small mut'>${esc(c.properties.gwp.source)}</span>` : "<span class='badge D'>missing</span>"}</td>` +
      `<td class="num">${k ? f(k.value, 0) + "<br>" + badge(k.grade, "secondary") + `<br><span class='small mut'>${esc(k.source)}</span>` : "<span class='badge D'>missing</span>"}</td><td class="small">${(c.rating_notes || []).map(esc).join("<br>") || "-"}${c.candidate_unverified ? `<br><span class='mut'>Unverified candidate k=${c.candidate_unverified.k_W_mK} W/mK (${c.candidate_unverified.source}) - not used.</span>` : ""}</td></tr>`;
  }).join("") + `</table><p class="small mut">U-values use dry-state conductivities; wet masonry in a monsoon climate will conduct more. Core carbon excludes mortar, plaster and transport and mixes different sources and boundaries.</p>`;

// ratings + sources
$("ratout").innerHTML = `<table><tr><th>System</th><th>Reference</th><th>Requirement</th><th>Verified</th></tr>` +
  D.ratings.items.map(r => `<tr><td>${esc(r.system)}</td><td class="small">${esc(r.ref)}</td><td class="small">${esc(r.requirement)}</td><td>${r.verified ? "<span class='badge B'>read in primary</span>" : "<span class='badge C'>secondary only</span>"}</td></tr>`).join("") + `</table><p class="small mut">Not yet covered: ${D.ratings.unverified_gaps.map(esc).join(" &middot; ")}</p>`;
$("srcout").innerHTML = `<table><tr><th>ID</th><th>Source</th><th>Locator</th><th>Verification</th></tr>` +
  D.sources.map(s => `<tr><td>${s.id}</td><td>${esc(s.title)}<br><span class="small mut">${esc(s.org)}</span>${s.url ? `<br><a class="small" href="${esc(s.url)}" target="_blank" rel="noopener">link</a>` : ""}</td><td class="small">${esc(s.locator)}</td><td class="small">${esc(s.verification.replace("_", " "))}<br><span class="mut">${esc(s.note)}</span></td></tr>`).join("") + `</table>`;

// explanation
$("go").onclick = async () => {
  if (!last) return; const tier = $("tier").value;
  $("status").textContent = tier === "deterministic" ? "" : "working...";
  const cs = D.climate_summary[city], cur = project.retv_as_modelled;
  const F = X.buildFacts(last, db, derived, D.sources, { indicators: ind, climate: cs, retvSub, project: { retv_modelled: cur ? cur.retv : 0, a_env: cur ? cur.a_env_m2 : 0, n_walls: project.walls.filter(w => w.external).length, n_openings: project.openings.length } });
  const out = await X.explain(F, tier, { onProgress: t => $("status").textContent = t, url: "http://localhost:11434", model: "qwen2.5:1.5b" });
  $("status").textContent = "";
  let h = out.text.split("\n\n").map(p => `<p>${esc(p)}</p>`).join("");
  h += `<p class="small ${out.audit.ok ? "audit-ok" : "audit-bad"}">Fidelity audit: ${out.audit.ok ? "passed (all numbers traced to the engine output; no unsupported claims detected)" : "ISSUES: " + out.audit.issues.map(i => esc(i.detail)).join("; ")} &middot; shown: ${out.tier}</p>`;
  if (out.fallbackReason) h += `<details><summary class="small">Why the optional model output was not used</summary><pre class="small" style="white-space:pre-wrap">${esc(JSON.stringify(out.fallbackReason, null, 1))}</pre></details>`;
  $("expout").innerHTML = h;
};
bim(); render();
$("go").click();
