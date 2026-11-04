// explain.js - the AI explanation layer. Three tiers, one rule: nothing is shown unless every number in it traces to engine output.
//   Tier 0  deterministic template explainer (0 MB, always available, offline)
//   Tier 1  small in-browser LLM via WebLLM (WebGPU)         -- optional, lazy-loaded, UNTESTED in the build environment
//   Tier 2  local Ollama server (any small model)            -- optional
// Tiers 1-2 only PARAPHRASE a facts block; checkText() audits their output and the UI falls back to Tier 0 on any failure.

const f3 = x => (Math.round(x * 1000) / 1000).toString();
const f2 = x => (Math.round(x * 100) / 100).toString();

export function buildFacts(result, db, derived, sources, extra = {}) {
  const crit = Object.fromEntries(db.criteria.map(c => [c.id, c]));
  const cand = Object.fromEntries(db.candidates.map(c => [c.id, c]));
  const srcOf = new Set();
  const leaders = {};
  for (const cid of new Set(result.ranked.flatMap(r => r.criteria_used))) {
    const rows = result.ranked.map(r => ({ r, b: r.breakdown.find(b => b.criterion_id === cid) }));
    const best = rows.reduce((a, b) => (crit[cid].direction === "lower_better" ? b.b.raw < a.b.raw : b.b.raw > a.b.raw) ? b : a);
    leaders[cid] = { id: best.r.id, name: best.r.name, raw: best.b.raw, unit: crit[cid].unit, criterion: crit[cid].name };
  }
  for (const r of result.ranked) for (const b of r.breakdown) { const d = derived[r.id]?.[b.criterion_id]; if (d?.source) srcOf.add(d.source); if (b.criterion_id === "u_value") srcOf.add("S01"); }
  const nums = new Set();
  const add = x => { if (typeof x === "number" && isFinite(x)) { [f2(x), f3(x), String(Math.round(x * 10) / 10), String(Math.round(x))].forEach(s => nums.add(s)); } };
  result.ranked.forEach(r => { add(r.score); add(r.completeness); add(r.rank); r.breakdown.forEach(b => { add(b.raw); add(b.normalised); add(b.effective_weight); add(b.contribution); }); });
  result.excluded.forEach(e => add(e.completeness));
  Object.values(result.settings.weights).forEach(add); add(result.settings.minCompleteness);
  Object.values(leaders).forEach(l => add(l.raw));
  [0, 1, 2, 3, 4, 5, 10, 12, 15, 20, 40, 100].forEach(add);       // small structural numbers (ranks, counts, ENS/GRIHA thresholds quoted from ratings)
  add(result.ranked.length); add(result.excluded.length); add(db.candidates.length);
  // extra engine outputs: dynamic indicators, climate summary, RETV (all numbers shown in the text must be registered here)
  const ind = extra.indicators || {}, cs = extra.climate || null, rs = extra.retvSub || null, prj = extra.project || null;
  const withInd = result.ranked.filter(r => ind[r.id]);
  if (withInd.length) { const b = withInd.reduce((a, c) => ind[c.id].decrement_factor < ind[a.id].decrement_factor ? c : a);
    leaders.decrement = { id: b.id, name: b.name, raw: ind[b.id].decrement_factor, unit: "-", criterion: "Decrement factor" }; }
  Object.values(ind).forEach(v => v && Object.values(v).forEach(add));
  if (cs) Object.values(cs).forEach(x => typeof x === "number" && add(x));
  if (rs) Object.values(rs).forEach(v => { add(v.retv); add(v.limit); add(v.retv_rounded); add(v.opaque_part); add(v.opening_solar_part); add(v.opening_conduction_part); });
  if (prj) { add(prj.retv_modelled); add(prj.a_env); add(prj.n_openings); add(prj.n_walls); }
  db.candidates.forEach(c => (c.name.match(/\d+(?:\.\d+)?/g) || []).forEach(x => nums.add(x)));   // dimensions inside material names, e.g. '25 mm'
  add(db.retv.limit_w_m2); Object.values(db.retv.coefficients).forEach(add);
  return { indicators: ind, climate: cs, retvSub: rs, project: prj, result, db, derived, crit, cand, leaders, sources: sources || [], srcIds: [...srcOf].sort(), allowedNumbers: nums,
    materialNames: db.candidates.flatMap(c => [c.name, c.id]), };
}

const cite = ids => ids.length ? ` [${ids.join(", ")}]` : "";

export function explainDeterministic(F) {
  const { result: R, db, derived, crit, leaders } = F;
  const P = [];
  const n = db.candidates.length;
  P.push(`Evidence status. Of ${n} candidate wall types, ${R.ranked.length} met the evidence gate (at least ${f2(R.settings.minCompleteness)} of the criterion weight backed by grade ${R.settings.minGrade} or better) and ${R.excluded.length} did not. Excluded options are not "worse" - they simply lack cited data (${R.excluded.map(e => e.name.split(" (")[0]).join("; ")}).`);
  if (R.ranked.length) {
    const top = R.ranked[0];
    const parts = top.breakdown.map(b => `${b.criterion.split(" (")[0]} ${f2(b.raw)} ${b.unit} (normalised ${f2(b.normalised)}, weight share ${f2(b.effective_weight)}, contribution ${f3(b.contribution)})`);
    P.push(`Ranking. ${top.name} scores highest at ${f3(top.score)} ${top.partial ? "(a partial score over " + top.criteria_used.length + " evidenced criteria, completeness " + f2(top.completeness) + ")" : ""}. Its breakdown: ${parts.join("; ")}.${cite(F.srcIds)}`);
    if (R.ranked.length > 1) P.push(`Order. ${R.ranked.map(r => `${r.rank}. ${r.name.split(" (")[0]} ${f3(r.score)}`).join("; ")}. Scores are relative to this small set only and are not percentages of sustainability.`);
    const lead = Object.values(leaders).map(l => `${l.criterion.split(" (")[0].toLowerCase()}: ${l.name.split(" (")[0]} (${f2(l.raw)} ${l.unit})`);
    P.push(`Trade-offs. The leader differs by criterion - ${lead.join("; ")}. ${new Set(Object.values(leaders).map(l => l.id)).size > 1 ? "No option leads on every criterion, so the weights decide the winner; test them with the sensitivity sweep." : "One option leads every scored criterion."}`);
  } else P.push("No candidate met the evidence gate, so no ranking is shown. Lower the completeness threshold only if you accept ranking on very little evidence.");
  const nm = id => crit[id].name.split(" (")[0];
  const everyoneLacks = db.criteria.filter(c => db.candidates.every(k => !F.derived[k.id]?.[c.id])).map(c => nm(c.id));
  const someLack = db.criteria.filter(c => db.candidates.some(k => !F.derived[k.id]?.[c.id]) && db.candidates.some(k => F.derived[k.id]?.[c.id])).map(c => nm(c.id));
  P.push(`What is missing. No option has a cited value yet for: ${everyoneLacks.join(", ") || "none"}. These need a dealer survey and expert input before this can be a full multi-criteria ranking.${someLack.length ? ` Some options also lack cited values for: ${someLack.join(", ")}.` : ""}`);
  const idn = id => (db.candidates.find(c => c.id === id)?.name || id).split(" (")[0];
  if (F.indicators && Object.keys(F.indicators).length && R.ranked.length) {
    const rows = R.ranked.map(r => ({ r, i: F.indicators[r.id] })).filter(x => x.i);
    if (rows.length) P.push(`Thermal dynamics (indicator, not scored). ` + rows.map(x => `${x.r.name.split(" (")[0]}: decrement factor ${f2(x.i.decrement_factor)}, time lag ${f2(x.i.time_lag_h)} h, areal heat capacity ${f2(x.i.areal_heat_capacity_kj_m2k)} kJ/m2K`).join("; ") + `. A lower decrement factor damps the daily temperature wave more; these come from a periodic heat-transfer calculation with ENS Table 46 properties.${cite(["S01"])}`);
  }
  if (F.climate) {
    const c = F.climate;
    P.push(`Climate exposure (input, not scored). ${c.city}: mean temperature ${f2(c.t_mean_c)} C, mean relative humidity ${f2(c.rh_mean_pct)} %, rainfall ${f2(c.rain_mm_year)} mm per year, wettest months ${c.wet_months.join(", ")}. ${c.moisture_flag} Values are gridded reanalysis climatology, not station data.${cite(["S13"])}`);
  }
  if (F.retvSub && Object.keys(F.retvSub).length) {
    const ids = Object.keys(F.retvSub), lim = db.retv.limit_w_m2;
    const within = ids.filter(i => F.retvSub[i].compliant_at_limit).map(idn), over = ids.filter(i => !F.retvSub[i].compliant_at_limit).map(idn);
    P.push(`Envelope code screen (ENS 2024 RETV, limit ${lim} W/m2). For the loaded building (${F.project.n_walls} external walls, ${F.project.n_openings} openings) the model as drawn gives ${f2(F.project.retv_modelled)} W/m2. If every external wall were: ` + ids.map(i => `${idn(i)} ${f2(F.retvSub[i].retv)}`).join("; ") + `. At or below the limit after rounding: ${within.join(", ") || "none"}. Above it: ${over.join(", ") || "none"}. This is a whole-envelope calculation that depends on the windows and shading, so it does not establish compliance for any wall material.${cite(["S01"])}`);
  }
  for (const w of R.warnings) P.push(`Caution. ${w}`);
  P.push("Limits. This is decision support for an architect: it does not establish structural, fire, moisture or code compliance, does not predict maintenance dates, and uses dry-state conductivities from the ENS 2024 default table rather than measured wall data.");
  return P;
}

// ---------------------------------------------------------------- fidelity checker
const BANNED = [/\b(better|best|ideal|suitable|right) (choice|option|for)\b/i, /\brecommend(s|ed|ation)?\b/i, /\b(cooler|colder|hotter|drier) climates?\b/i,/\bcompl(y|ies|iant|iance)\b/i, /\bcertif(ied|ication)\b/i, /\bguarantee/i, /\bproven\b/i, /\bwill last\b/i, /\bbest material\b/i,
  /\bidea?l\b/i, /\bavailable (locally|in kerala)\b/i, /\bin stock\b/i, /\brepaint(ing)? (in|every|after) \d+/i, /\bpoints? (will be|awarded)\b/i];
const SUPER = { lowest: "lower_better", smallest: "lower_better", best: null, highest: "higher_better", maximum: null, minimum: null };
const CRIT_WORDS = { "embodied carbon": "gwp_core", carbon: "gwp_core", "u-value": "u_value", "thermal transmittance": "u_value", thermal: "u_value" };

export function checkText(text, F) {
  const issues = [];
  // 1) numbers
  const stripped = text.replace(/\[[^\]]*\]/g, " ").replace(/\bS\d{2}\b/g, " ").replace(/\b(19\.1\.\d|ENS 2024|GRIHA v?2019|9\.\d|\d{4}(?![\d.]\d)|Table \d+|Sec\. \d+|Eq\. \d)\b/g, " ");
  for (const m of stripped.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const raw = m[0].replace(/^-/, "");
    const x = parseFloat(raw);
    const ok = F.allowedNumbers.has(raw) || F.allowedNumbers.has(String(Math.round(x * 100) / 100)) || F.allowedNumbers.has(String(Math.round(x * 1000) / 1000));
    if (!ok) issues.push({ type: "unsupported_number", detail: `number ${raw} does not appear in the engine output` });
  }
  // 2) banned claims - per sentence, ignored when the sentence is a negated disclaimer ("does not establish compliance")
  const NEG = /\b(not|no|nor|cannot|neither|without|never|n't)\b/i;
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if (NEG.test(s)) continue;
    for (const re of BANNED) { const m = s.match(re); if (m) issues.push({ type: "banned_claim", detail: `unsupported claim wording: "${m[0]}"` }); }
  }
  // 3) superlative vs leader: attach each superlative to the nearest material named BEFORE it (else after) in the same sentence
  const aliases = F.db.candidates.map(c => ({ id: c.id, names: [c.name.split(" (")[0].toLowerCase(), ...(c.name.match(/\(([A-Z]{3,})/) ? [c.name.match(/\(([A-Z]{3,})/)[1].toLowerCase()] : []), ...(c.name.split(" ")[0].length <= 4 ? [c.name.split(" ")[0].toLowerCase()] : [])] }));
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    const low = s.toLowerCase();
    const mentions = [];
    for (const a of aliases) for (const nm of a.names) { let i = low.indexOf(nm); while (i >= 0) { mentions.push({ id: a.id, pos: i }); i = low.indexOf(nm, i + 1); } }
    for (const [w, dir] of Object.entries(SUPER)) {
      const m = low.match(new RegExp(`\\b${w}\\b`)); if (!m) continue;
      for (const [cw, cid] of Object.entries(CRIT_WORDS)) {
        if (!low.includes(cw) || !F.leaders[cid]) continue;
        if (!(dir === null || dir === F.crit[cid].direction)) continue;
        const before = mentions.filter(x => x.pos < m.index).sort((p, q) => q.pos - p.pos)[0];
        const after = mentions.filter(x => x.pos >= m.index).sort((p, q) => p.pos - q.pos)[0];
        const subject = before || after;
        if (subject && subject.id !== F.leaders[cid].id)
          issues.push({ type: "wrong_leader", detail: `"${s.trim().slice(0, 90)}" - the leader on ${F.crit[cid].name} is ${F.leaders[cid].name}, not ${F.cand[subject.id].name}` });
      }
    }
  }
  // 4) damping claims: "X dampens ... more / the most / best" must name the decrement-factor leader
  if (F.leaders.decrement) for (const s of text.split(/(?<=[.!?])\s+/)) {
    const low = s.toLowerCase();
    if (!/damp|decrement/.test(low) || !/\b(more|most|better|best|lowest|least|greatest)\b/.test(low) || NEG.test(s)) continue;
    const ms = []; for (const a of aliases) for (const nm of a.names) { const i = low.indexOf(nm); if (i >= 0) ms.push({ id: a.id, pos: i }); }
    const subj = ms.sort((p, q) => p.pos - q.pos)[0];
    if (subj && subj.id !== F.leaders.decrement.id) issues.push({ type: "wrong_leader", detail: `"${s.trim().slice(0, 90)}" - the strongest damping (lowest decrement factor) is ${F.leaders.decrement.name}, not ${F.cand[subj.id].name}` });
  }
  // 5) truncated output (model hit its token limit): must end at a sentence boundary
  if (text.trim() && !/[.!?)\]"]\s*$/.test(text.trim())) issues.push({ type: "truncated", detail: "output ends mid-sentence (likely cut off at the token limit)" });
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------- optional LLM tiers
export function buildPrompt(F, paragraphs) {
  return `You rewrite a technical summary for an architect. Use ONLY the facts below. Do not add any number, material, standard, claim of compliance, availability, certification, maintenance interval or recommendation that is not in the facts. Keep every number exactly as written. Keep source tags like [S01]. Output at most 5 short paragraphs of plain prose, no headings, no lists, no markdown. Do not compare materials beyond what the facts state.\n\nFACTS:\n${paragraphs.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
}

// Pin and verify these before relying on Tier 1 (not exercised in the build environment).
export const WEBLLM_URL = "https://esm.run/@mlc-ai/web-llm";
export const WEBLLM_MODEL = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";

export async function generateWebLLM(prompt, onProgress) {
  if (!("gpu" in navigator)) throw new Error("WebGPU not available in this browser");
  const webllm = await import(/* @vite-ignore */ WEBLLM_URL);
  const engine = await webllm.CreateMLCEngine(WEBLLM_MODEL, { initProgressCallback: p => onProgress?.(p.text) });
  const out = await engine.chat.completions.create({ messages: [{ role: "user", content: prompt }], temperature: 0.1, max_tokens: 500 });
  return out.choices[0].message.content;
}

export async function generateOllama(prompt, { url = "http://localhost:11434", model = "qwen2.5:1.5b" } = {}) {
  const r = await fetch(url + "/api/generate", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.1 } }) });
  if (!r.ok) throw new Error("Ollama HTTP " + r.status);
  return (await r.json()).response;
}

// Backend route (FastAPI /api/llm -> local Ollama). Same audit applies to its output.
export async function generateBackend(prompt, { model } = {}) {
  const r = await fetch("/api/llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, model }) });
  if (!r.ok) throw new Error("backend HTTP " + r.status + ": " + (await r.text()).slice(0, 200));
  return (await r.json()).response;
}

// Runs an optional tier, audits it, and falls back to Tier 0. Returns {text, tier, audit, fallbackReason}.
export async function explain(F, tier = "deterministic", opts = {}) {
  const base = explainDeterministic(F);
  if (tier === "deterministic") return { text: base.join("\n\n"), tier: "deterministic", audit: checkText(base.join("\n\n"), F) };
  try {
    const prompt = buildPrompt(F, base);
    const gen = tier === "webllm" ? await generateWebLLM(prompt, opts.onProgress) : opts.backend ? await generateBackend(prompt, opts) : await generateOllama(prompt, opts);
    const audit = checkText(gen, F);
    if (audit.ok) return { text: gen, tier, audit };
    return { text: base.join("\n\n"), tier: "deterministic", audit: checkText(base.join("\n\n"), F), fallbackReason: { rejected: gen, issues: audit.issues } };
  } catch (e) {
    return { text: base.join("\n\n"), tier: "deterministic", audit: checkText(base.join("\n\n"), F), fallbackReason: { error: String(e.message || e) } };
  }
}
