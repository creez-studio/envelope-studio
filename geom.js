// geom.js - mesh geometry analysis without three.js (testable in Node).
// Coordinates: three.js world space, +Y up, project north = -Z, project east = +X.
// Input triangles are flat arrays [ax,ay,az, bx,by,bz, cx,cy,cz, ...] in metres, already in world space.
const R2D = 180 / Math.PI;

/** Azimuth (deg clockwise from project north) of a horizontal direction (nx, nz). */
export const azimuthFromNormal = (nx, nz) => ((Math.atan2(nx, -nz) * R2D) + 360) % 360;

/** Per-triangle data: unit normal, area, centroid. */
export function triangles(pos) {
  const out = [];
  for (let i = 0; i + 8 < pos.length; i += 9) {
    const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
    const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len; ny /= len; nz /= len;
    out.push({ nx, ny, nz, area: len / 2, cx: (pos[i] + pos[i + 3] + pos[i + 6]) / 3, cy: (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3, cz: (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3 });
  }
  return out;
}

/** Pick up to n sample points spread over the triangles of a facet, proportional to area. */
function samplePoints(tris, n = 12) {
  const tot = tris.reduce((s, t) => s + t.area, 0);
  if (!tot) return [];
  const sorted = tris.slice().sort((a, b) => b.area - a.area), pts = [];
  for (const t of sorted) { const k = Math.max(1, Math.round((t.area / tot) * n)); for (let j = 0; j < k && pts.length < n; j++) pts.push({ x: t.cx, y: t.cy, z: t.cz, w: t.area / k }); if (pts.length >= n) break; }
  return pts;
}

/** Outward facade of one wall element. bc = building centroid {x,z}. Returns {az_p, area, nx, nz, samples, height:{min,max}} or null. */
export function wallFacet(tris, bc, { binDeg = 12 } = {}) {
  const vert = tris.filter(t => Math.abs(t.ny) < 0.15);
  if (!vert.length) return null;
  const bins = new Map();
  for (const t of vert) { const b = Math.round(azimuthFromNormal(t.nx, t.nz) / binDeg) % Math.round(360 / binDeg); (bins.get(b) || bins.set(b, []).get(b)).push(t); }
  let best = null;
  for (const [, ts] of bins) {
    const a = ts.reduce((s, t) => s + t.area, 0), nx = ts.reduce((s, t) => s + t.nx * t.area, 0) / a, nz = ts.reduce((s, t) => s + t.nz * t.area, 0) / a;
    const cx = ts.reduce((s, t) => s + t.cx * t.area, 0) / a, cz = ts.reduce((s, t) => s + t.cz * t.area, 0) / a;
    const out = (cx - bc.x) * nx + (cz - bc.z) * nz;
    if (out <= 0) continue;
    const score = a * (1 + 1e-6 * out);
    if (!best || score > best.score) best = { score, area: a, nx, nz, ts, cx, cz };
  }
  if (!best) return null;
  const ys = best.ts.flatMap(t => [t.cy]);
  return { az_p: azimuthFromNormal(best.nx, best.nz), area: best.area, nx: best.nx, nz: best.nz, samples: samplePoints(best.ts), height: { min: Math.min(...ys), max: Math.max(...ys) }, cx: best.cx, cz: best.cz };
}

/** Exterior vertical surfaces of an arbitrary mesh (no BIM data): cluster by orientation and plane, keep outward ones. */
export function exteriorSurfaces(tris, bc, { binDeg = 15, planeTol = 0.3, minArea = 0.5 } = {}) {
  const vert = tris.filter(t => Math.abs(t.ny) < 0.15 && ((t.cx - bc.x) * t.nx + (t.cz - bc.z) * t.nz) > 0);
  const groups = [];
  for (const t of vert) {
    const az = azimuthFromNormal(t.nx, t.nz), d = t.nx * t.cx + t.nz * t.cz;
    let g = groups.find(g => Math.abs(((az - g.az + 540) % 360) - 180) < binDeg / 2 && Math.abs(d - g.d) < planeTol);
    if (!g) { g = { az, d, ts: [] }; groups.push(g); }
    g.ts.push(t);
  }
  return groups.map(g => {
    const a = g.ts.reduce((s, t) => s + t.area, 0), nx = g.ts.reduce((s, t) => s + t.nx * t.area, 0) / a, nz = g.ts.reduce((s, t) => s + t.nz * t.area, 0) / a;
    return { az_p: azimuthFromNormal(nx, nz), area: a, nx, nz, samples: samplePoints(g.ts), height: { min: Math.min(...g.ts.map(t => t.cy)), max: Math.max(...g.ts.map(t => t.cy)) } };
  }).filter(s => s.area >= minArea).sort((a, b) => b.area - a.area);
}

/** Roof / upward-facing area (|ny| >= 0.3, ny > 0) and its footprint. */
export function upwardArea(tris) {
  return tris.filter(t => t.ny >= 0.3).reduce((s, t) => s + t.area, 0);
}

// ------------------------------------------------------------ ray tests for shading
/** Oriented box from a 4x4 column-major world matrix (three.js Matrix4.elements) and local min/max. Stores the inverse for ray tests. */
export function makeOBB(m, min, max, id, kind = "solid") {
  const inv = invert(m);
  return { inv, min, max, id, kind };
}
function invert(m) {                                   // general 4x4 inverse (column-major)
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
    b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
    b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  return [(a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det, (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det, (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det, (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det, (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det];
}
const xfP = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const xfD = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];

/** Does the ray (origin o, direction d) hit the box before distance tMax? Slab test in the box's local frame. */
export function rayHitsOBB(o, d, box, tMax = Infinity) {
  if (!box.inv) return false;
  const lo = xfP(box.inv, o[0], o[1], o[2]), ld = xfD(box.inv, d[0], d[1], d[2]);
  let t0 = 1e-4, t1 = tMax;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ld[k]) < 1e-12) { if (lo[k] < box.min[k] || lo[k] > box.max[k]) return false; continue; }
    let a = (box.min[k] - lo[k]) / ld[k], b = (box.max[k] - lo[k]) / ld[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return true;
}
/** Ray vs sphere (tree crown). */
export function rayHitsSphere(o, d, s) {
  const ox = o[0] - s.c[0], oy = o[1] - s.c[1], oz = o[2] - s.c[2];
  const b = ox * d[0] + oy * d[1] + oz * d[2], c = ox * ox + oy * oy + oz * oz - s.r * s.r, disc = b * b - c;
  return disc >= 0 && (-b + Math.sqrt(disc)) > 1e-4;
}

/** Sunlit fraction (0..1) of a facet for a sun direction (unit vector, world). Occluders: OBBs and spheres
 *  (spheres carry transmittance t: 0 = opaque, e.g. 0.25 for a dense tree crown). selfId is skipped. */
export function sunlitFraction(facet, sun, occ, selfId) {
  const cosI = facet.nx * sun[0] + facet.nz * sun[2];
  if (sun[1] <= 0 || cosI <= 0 || !facet.samples.length) return 0;
  let lit = 0, wsum = 0;
  for (const p of facet.samples) {
    const o = [p.x + facet.nx * 0.05, p.y, p.z + facet.nz * 0.05];
    let trans = 1;
    for (const b of occ.boxes) { if (b.id === selfId) continue; if (rayHitsOBB(o, sun, b)) { trans = 0; break; } }
    if (trans > 0 && occ.test && occ.test(o, sun, selfId)) trans = 0;          // exact mesh test (roofs, slabs) supplied by the viewer
    if (trans > 0) for (const s of occ.spheres) if (rayHitsSphere(o, sun, s)) trans *= s.t;
    lit += trans * p.w; wsum += p.w;
  }
  return wsum ? lit / wsum : 0;
}
