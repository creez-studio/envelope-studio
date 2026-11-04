// viewer2.js - Envelope Studio 3D workspace (three.js 0.160 via the page's import map).
// Rendering: ACES tone mapping, image-based ambient light (RoomEnvironment), soft sun shadows, GTAO ambient occlusion,
// ground grid and world-origin axes. Content: IFC (web-ifc), glTF/GLB, OBJ, STL, FBX or a schematic from wall data.
// Editing: move/rotate the building, add neighbour buildings and trees (TransformControls). Analysis helpers expose
// world-space wall facets and shading occluders to geom.js; no analysis maths lives here.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import * as GE from "./geom.js";

const WEBIFC_URL = "https://cdn.jsdelivr.net/npm/web-ifc@0.0.57/web-ifc-api.js";
const WEBIFC_WASM = "https://cdn.jsdelivr.net/npm/web-ifc@0.0.57/";
const MAT = {
  wall: { color: 0xe9e5dd, roughness: 0.92 }, roof: { color: 0xa65a3c, roughness: 0.85 }, slab: { color: 0xcfcbc3, roughness: 0.9 },
  window: { color: 0x9fc3d9, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.45 }, door: { color: 0x8a6446, roughness: 0.7 },
  other: { color: 0xd9d5cc, roughness: 0.9 }, neighbour: { color: 0xc9c6bf, roughness: 0.95 }, trunk: { color: 0x6b4f3a, roughness: 1 }, crown: { color: 0x5f8a4f, roughness: 0.95 },
};

export class Workspace {
  constructor(el, { onPick, onEdit } = {}) { this.el = el; this.onPick = onPick; this.onEdit = onEdit; this.disposed = false; this.tn = 0; this.kind = null; this.ctxSeq = 0; }

  async init() {
    const w = this.el.clientWidth || 800, h = this.el.clientHeight || 520;
    const R = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    R.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); R.setSize(w, h);
    R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 1.0; R.outputColorSpace = THREE.SRGBColorSpace;
    R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFSoftShadowMap;
    this.el.replaceChildren(R.domElement);
    const S = this.scene = new THREE.Scene();
    S.background = new THREE.Color(0xeef0f2); S.fog = new THREE.Fog(0xeef0f2, 120, 420);
    const pm = new THREE.PMREMGenerator(R); S.environment = pm.fromScene(new RoomEnvironment(R), 0.04).texture;          // per-material envMapIntensity keeps it subtle (r160)
    this.camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 3000); this.camera.position.set(28, 22, 30);
    this.controls = new OrbitControls(this.camera, R.domElement); this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI * 0.495;
    S.add(new THREE.HemisphereLight(0xf4f6ff, 0x9a9488, 0.55));
    const sun = this.sun = new THREE.DirectionalLight(0xfff1dc, 2.6); sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 4;
    S.add(sun); S.add(sun.target);
    this.sunBall = new THREE.Mesh(new THREE.SphereGeometry(0.7, 24, 12), new THREE.MeshBasicMaterial({ color: 0xffc64d })); S.add(this.sunBall);
    // ground, grid, origin
    const ground = this.ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0xe4e2dc, roughness: 1, envMapIntensity: 0.3 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; ground.userData.isGround = true; S.add(ground);
    const g1 = new THREE.GridHelper(200, 200, 0xc9c6be, 0xd8d6cf), g2 = new THREE.GridHelper(200, 20, 0xb2aea5, 0xb2aea5);
    for (const g of [g1, g2]) { g.position.y = 0.005; g.material.transparent = true; g.material.opacity = g === g1 ? 0.55 : 0.8; g.material.depthWrite = false; }
    this.grid = new THREE.Group(); this.grid.add(g1, g2); S.add(this.grid);
    const ax = this.axes = new THREE.Group();
    const line = (a, b, c) => { const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]); return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: c, depthTest: false })); };
    ax.add(line([0, 0.01, 0], [3, 0.01, 0], 0xd03b3b), line([0, 0.01, 0], [0, 0.01, -3], 0x2a78d6), line([0, 0, 0], [0, 3, 0], 0x1baf7a));
    ax.renderOrder = 10; S.add(ax);
    this.building = new THREE.Group(); this.building.name = "building"; S.add(this.building);
    this.context = new THREE.Group(); this.context.name = "context"; S.add(this.context);
    // gizmo
    const tc = this.tc = new TransformControls(this.camera, R.domElement); tc.setSize(0.85); tc.showY = false;
    tc.addEventListener("dragging-changed", e => { this.controls.enabled = !e.value; if (!e.value) this.onEdit?.(this.state()); });
    S.add(tc);
    // post-processing (ambient occlusion); falls back to direct rendering if the pass cannot load
    this.composer = null; this.aoOn = true;
    try {
      const { GTAOPass } = await import("three/addons/postprocessing/GTAOPass.js");
      const c = new EffectComposer(R); c.addPass(new RenderPass(S, this.camera));
      const ao = this.ao = new GTAOPass(S, this.camera, w, h); ao.output = GTAOPass.OUTPUT.Default; ao.blendIntensity = 0.9;
      ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: 12 }); c.addPass(ao); c.addPass(new OutputPass());
      this.composer = c;
    } catch (e) { this.composer = null; }
    // overlays
    this.compass = document.createElement("div"); this.compass.className = "compass";
    this.compass.innerHTML = `<svg viewBox="-50 -50 100 100" width="72" height="72" aria-label="true north"><circle r="46" fill="rgba(255,255,255,.92)" stroke="rgba(0,0,0,.12)" stroke-width="1.5"/>` +
      [0, 45, 90, 135, 180, 225, 270, 315].map(a => `<line x1="0" y1="-41" x2="0" y2="${a % 90 ? -35 : -31}" stroke="#8b877f" stroke-width="${a % 90 ? 1 : 2}" transform="rotate(${a})"/>`).join("") +
      `<polygon points="0,-30 6.5,0 0,4 -6.5,0" fill="#d03b3b"/><polygon points="0,30 6.5,0 0,-4 -6.5,0" fill="#b9b5ad"/><circle r="2.6" fill="#fff" stroke="#3a3935"/><text y="-36" text-anchor="middle" font-size="12" font-weight="700" fill="#d03b3b" font-family="Inter,system-ui">N</text></svg>`;
    this.el.appendChild(this.compass);
    this.labelLayer = document.createElement("div"); this.labelLayer.className = "wall-labels"; this.el.appendChild(this.labelLayer); this.labels = [];
    // picking
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); let down = null;
    R.domElement.addEventListener("pointerdown", e => down = [e.clientX, e.clientY]);
    R.domElement.addEventListener("pointerup", e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || this.tc.dragging) return;
      const r = R.domElement.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects([...this.building.children, ...this.context.children], true).find(h => h.object.visible && !h.object.userData.isGround);
      this.select(hit ? hit.object : null);
    });
    const loop = () => {
      if (this.disposed) return;
      this.controls.update();
      const f = this.controls.target.clone().sub(this.camera.position);
      this.compass.firstChild.style.transform = `rotate(${(-this.tn) - Math.atan2(f.x, -f.z) * 180 / Math.PI}deg)`;
      if (this.composer && this.aoOn) this.composer.render(); else R.render(S, this.camera);
      this._placeLabels(); requestAnimationFrame(loop);
    };
    loop();
    new ResizeObserver(() => this.resize()).observe(this.el);
  }

  resize() {
    const W = this.el.clientWidth, H = this.el.clientHeight; if (!W || !H) return;
    this.camera.aspect = W / H; this.camera.updateProjectionMatrix(); this.renderer.setSize(W, H);
    this.composer?.setSize(W, H);
  }
  setAO(on) { this.aoOn = on; }
  setGrid(on) { this.grid.visible = on; this.axes.visible = on; }

  // ------------------------------------------------------------ content
  clearBuilding() { this.tc.detach(); for (const c of [...this.building.children]) { this.building.remove(c); c.geometry?.dispose(); } this.building.position.set(0, 0, 0); this.building.rotation.set(0, 0, 0); }
  _mat(kind, extra = {}) { return new THREE.MeshStandardMaterial({ envMapIntensity: 0.32, ...MAT[kind], ...extra }); }

  /** Centre the loaded content on the origin with its lowest point on the ground. */
  _centre() {
    const box = new THREE.Box3();
    for (const ch of this.building.children) if (ch.userData.kind !== "footing" && !/foundation|footing|retaining/i.test(ch.userData.wall?.name || "")) box.expandByObject(ch);
    if (box.isEmpty()) box.setFromObject(this.building);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    for (const ch of this.building.children) { if (ch.matrixAutoUpdate) ch.position.sub(new THREE.Vector3(c.x, box.min.y, c.z)); else { ch.matrix.premultiply(new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z)); ch.matrixWorldNeedsUpdate = true; } }
    this.building.updateMatrixWorld(true);
  }

  async loadIFC(bytes, project) {
    const WebIFC = await import(WEBIFC_URL);
    const api = new WebIFC.IfcAPI(); api.SetWasmPath(WEBIFC_WASM, true); await api.Init();
    const id = api.OpenModel(new Uint8Array(bytes));
    const wallByEid = {}; for (const w of project.walls) if (w.geom) wallByEid[w.geom.eid] = w;
    const T = WebIFC, typeOf = eid => { try { return api.GetLineType(id, eid); } catch { return 0; } };
    const kindOf = t => [T.IFCWALL, T.IFCWALLSTANDARDCASE, T.IFCCURTAINWALL].includes(t) ? "wall" : [T.IFCROOF].includes(t) ? "roof" : [T.IFCSLAB, T.IFCCOVERING].includes(t) ? "slab" :
      [T.IFCWINDOW, T.IFCPLATE].includes(t) ? "window" : [T.IFCDOOR].includes(t) ? "door" : [T.IFCSPACE, T.IFCOPENINGELEMENT, T.IFCSITE].includes(t) ? "skip" : [T.IFCFOOTING, T.IFCPILE].includes(t) ? "footing" : "other";
    this.clearBuilding(); this.kind = "ifc";
    let count = 0;
    api.StreamAllMeshes(id, mesh => {
      const eid = mesh.expressID, kind = kindOf(typeOf(eid));
      if (kind === "skip") return;
      const pgs = mesh.geometries;
      for (let i = 0; i < pgs.size(); i++) {
        const pg = pgs.get(i), geo = api.GetGeometry(id, pg.geometryExpressID);
        const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize()), ix = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
        const pos = new Float32Array(v.length / 2), nor = new Float32Array(v.length / 2);
        for (let k = 0, j = 0; k < v.length; k += 6, j += 3) { pos[j] = v[k]; pos[j + 1] = v[k + 1]; pos[j + 2] = v[k + 2]; nor[j] = v[k + 3]; nor[j + 1] = v[k + 4]; nor[j + 2] = v[k + 5]; }
        const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("normal", new THREE.BufferAttribute(nor, 3)); g.setIndex(new THREE.BufferAttribute(ix, 1));
        const m = new THREE.Mesh(g, this._mat(kind));
        m.matrixAutoUpdate = false; m.matrix.fromArray(pg.flatTransformation);
        m.castShadow = kind !== "window"; m.receiveShadow = true;
        m.userData = { eid, kind, wall: wallByEid[eid] || null };
        this.building.add(m); count++; geo.delete();
      }
    });
    api.CloseModel(id);
    if (!count) throw new Error("no tessellatable geometry");
    this.tn = project.true_north_ccw_deg || 0;
    this._centre(); this.frame();
    return count;
  }

  /** Generic 3D file. units: metres per file unit. */
  async loadFile(file, unitScale = 1) {
    const ext = file.name.split(".").pop().toLowerCase(), buf = await file.arrayBuffer();
    let obj;
    if (ext === "glb" || ext === "gltf") { const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js"); obj = (await new GLTFLoader().parseAsync(ext === "glb" ? buf : new TextDecoder().decode(buf), "")).scene; }
    else if (ext === "obj") { const { OBJLoader } = await import("three/addons/loaders/OBJLoader.js"); obj = new OBJLoader().parse(new TextDecoder().decode(buf)); }
    else if (ext === "stl") { const { STLLoader } = await import("three/addons/loaders/STLLoader.js"); const g = new STLLoader().parse(buf); g.computeVertexNormals(); obj = new THREE.Mesh(g, this._mat("other")); }
    else if (ext === "fbx") { const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js"); obj = new FBXLoader().parse(buf, ""); }
    else throw new Error("unsupported format ." + ext + " (use IFC, glTF/GLB, OBJ, STL or FBX)");
    this.clearBuilding(); this.kind = "mesh"; this.tn = 0;
    obj.scale.multiplyScalar(unitScale);
    obj.updateMatrixWorld(true);
    // flatten into building group, replacing materials with neutral ones (keep glass-like transparency)
    const meshes = []; obj.traverse(o => { if (o.isMesh) meshes.push(o); });
    for (const o of meshes) {
      const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld); if (!g.attributes.normal) g.computeVertexNormals();
      const glass = [].concat(o.material).some(mm => mm && (mm.transparent && mm.opacity < 0.8));
      const m = new THREE.Mesh(g, this._mat(glass ? "window" : "wall")); m.castShadow = !glass; m.receiveShadow = true; m.userData = { kind: glass ? "window" : "surface", name: o.name || "mesh" };
      this.building.add(m);
    }
    if (!meshes.length) throw new Error("the file contains no meshes");
    this._centre(); this.frame();
    const b = new THREE.Box3().setFromObject(this.building).getSize(new THREE.Vector3());
    return { meshes: meshes.length, size: { x: b.x, y: b.y, z: b.z } };
  }

  /** Box walls from wall data (manual / fallback). */
  schematic(project, height = 3.0) {
    this.clearBuilding(); this.kind = "schematic";
    const opArea = {}; for (const o of project.openings || []) opArea[o.host_wall] = (opArea[o.host_wall] || 0) + o.area_m2;
    let n = 0;
    for (const w of project.walls) {
      if (!w.geom || w.area_m2 == null) continue;
      const len = (w.area_m2 + (opArea[w.id] || 0)) / height, t = Math.max(0.1, w.geom.thickness_m || 0.2), th = (w.geom.theta_deg * Math.PI) / 180;
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, height, t), this._mat("wall"));
      const X = w.geom.x + Math.cos(th) * len / 2 - Math.sin(th) * t / 2, Y = w.geom.y + Math.sin(th) * len / 2 + Math.cos(th) * t / 2;
      m.position.set(X, height / 2, -Y); m.rotation.y = th; m.castShadow = m.receiveShadow = true; m.userData = { kind: "wall", wall: w };
      this.building.add(m); n++;
    }
    this.tn = project.true_north_ccw_deg || 0;
    this._centre(); this.frame();
    return n;
  }

  // ------------------------------------------------------------ views
  frame() {
    const box = new THREE.Box3().setFromObject(this.building);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()), d = Math.max(s.x, s.y, s.z, 6) * 1.25;
    this.camera.position.set(c.x + d * 0.95, c.y + d * 0.75, c.z + d * 1.05); this.controls.target.copy(c); this.controls.update();
  }
  view(name) {
    const box = new THREE.Box3().setFromObject(this.building); if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), d = Math.max(...box.getSize(new THREE.Vector3()).toArray(), 6) * 1.6;
    const P = { top: [0, d * 1.4, 0.001], north: [0, d * 0.3, -d], south: [0, d * 0.3, d], east: [d, d * 0.3, 0], west: [-d, d * 0.3, 0], iso: [d * 0.75, d * 0.6, d * 0.8] }[name] || [d, d, d];
    this.camera.position.set(c.x + P[0], c.y + P[1], c.z + P[2]); this.controls.target.copy(c); this.controls.update();
  }

  // ------------------------------------------------------------ editing
  setBuildingRotation(degClockwise) { this.building.rotation.y = -degClockwise * Math.PI / 180; this.building.updateMatrixWorld(true); }
  setBuildingOffset(x, z) { this.building.position.set(x, 0, z); this.building.updateMatrixWorld(true); }
  setMode(mode) { this.tc.setMode(mode === "rotate" ? "rotate" : "translate"); this.tc.showX = mode !== "rotate"; this.tc.showZ = mode !== "rotate"; this.tc.showY = mode === "rotate"; }
  editBuilding(on) { if (on) { this.tc.attach(this.building); this.select(null, true); } else this.tc.detach(); }
  addContext(item) {
    const id = item.id || "c" + (++this.ctxSeq) + "-" + Date.now().toString(36);
    let obj;
    if (item.type === "tree") {
      obj = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.25, item.h * 0.45, 10), this._mat("trunk")); trunk.position.y = item.h * 0.225;
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(item.r, 2), this._mat("crown")); crown.position.y = item.h - item.r;
      for (const m of [trunk, crown]) { m.castShadow = true; m.receiveShadow = true; m.userData = { ctxId: id }; obj.add(m); }
    } else {
      obj = new THREE.Mesh(new THREE.BoxGeometry(item.w, item.h, item.d), this._mat("neighbour")); obj.geometry.translate(0, item.h / 2, 0);
      obj.castShadow = obj.receiveShadow = true;
    }
    obj.position.set(item.x || 0, 0, item.z || 0); obj.rotation.y = -(item.rot || 0) * Math.PI / 180;
    obj.userData = { ctxId: id, item: { ...item, id } };
    this.context.add(obj); return id;
  }
  removeContext(id) { const o = this.context.children.find(c => c.userData.ctxId === id); if (o) { if (this.tc.object === o) this.tc.detach(); this.context.remove(o); } }
  setContext(list) { for (const c of [...this.context.children]) this.context.remove(c); for (const it of list || []) this.addContext(it); }
  state() {
    return { rot: Math.round(-this.building.rotation.y * 180 / Math.PI * 10) / 10, x: this.building.position.x, z: this.building.position.z,
      context: this.context.children.map(o => ({ ...o.userData.item, x: o.position.x, z: o.position.z, rot: Math.round(-o.rotation.y * 180 / Math.PI) })) };
  }
  select(obj, keepGizmo = false) {
    const ctx = obj && (obj.userData.ctxId ? this.context.children.find(c => c.userData.ctxId === obj.userData.ctxId) : null);
    if (!keepGizmo) { if (ctx) this.tc.attach(ctx); else if (this.tc.object !== this.building) this.tc.detach(); }
    if (this._sel?.material?.emissive) this._sel.material.emissive.set(this._sel.userData.glow ? 0x6b2a00 : 0x000000);
    this._sel = obj && obj.material?.emissive ? obj : null;
    if (this._sel) this._sel.material.emissive.set(0x1d4f91);
    this.onPick?.(obj ? { kind: ctx ? "context" : obj.userData.kind, wall: obj.userData.wall, eid: obj.userData.eid, name: obj.userData.name, item: ctx?.userData.item, ctxId: ctx?.userData.ctxId } : null);
  }

  // ------------------------------------------------------------ analysis hooks
  /** World-space wall facets. For IFC: one per external wall mesh (merged per element); for meshes: exterior surfaces. */
  wallFacets() {
    this.building.updateMatrixWorld(true);
    const triOf = m => { const g = m.geometry, p = g.attributes.position, idx = g.index, mw = m.matrixWorld, v = new THREE.Vector3(), out = [];
      const n = idx ? idx.count : p.count;
      for (let i = 0; i < n; i++) { v.fromBufferAttribute(p, idx ? idx.getX(i) : i).applyMatrix4(mw); out.push(v.x, v.y, v.z); }
      return GE.triangles(out); };
    const bb = new THREE.Box3().setFromObject(this.building), bc = bb.getCenter(new THREE.Vector3());
    if (this.kind === "mesh") {
      const all = this.building.children.filter(m => m.userData.kind !== "window").flatMap(triOf);
      return GE.exteriorSurfaces(all, { x: bc.x, z: bc.z }).map((s, i) => ({ id: "surf-" + i, name: `Surface ${i + 1}`, facet: s }));
    }
    const groups = new Map();
    for (const m of this.building.children) if (m.userData.kind === "wall" && (!m.userData.wall || m.userData.wall.external !== false)) {
      const key = m.userData.eid ?? m.uuid; (groups.get(key) || groups.set(key, { mesh: m, tris: [] }).get(key)).tris.push(...triOf(m));
    }
    const out = [];
    for (const [key, g] of groups) {
      const f = GE.wallFacet(g.tris, { x: bc.x, z: bc.z });
      if (!f || f.height.max < 0.4 || /foundation|footing|retaining/i.test(g.mesh.userData.wall?.name || "")) continue;   // below-ground walls get no sun
      const w = g.mesh.userData.wall;
      out.push({ id: w?.id ?? "eid-" + key, name: w?.name ?? "Wall " + key, eid: g.mesh.userData.eid, wall: w, facet: f });
    }
    return out;
  }
  /** Occluders for shading: oriented boxes of every opaque building element and neighbour, spheres for tree crowns. */
  occluders() {
    this.building.updateMatrixWorld(true); this.context.updateMatrixWorld(true);
    const boxes = [], spheres = [];
    const add = (m, id) => { if (!m.geometry) return; m.geometry.computeBoundingBox(); const b = m.geometry.boundingBox; boxes.push(GE.makeOBB(m.matrixWorld.elements.slice(), b.min.toArray(), b.max.toArray(), id)); };
    const exact = [];
    if (this.kind !== "mesh") for (const m of this.building.children) {
      if (m.userData.kind === "window" || m.userData.kind === "door" || m.userData.kind === "footing") continue;
      if (m.userData.kind === "wall") add(m, m.userData.wall?.id ?? (m.userData.eid != null ? "eid-" + m.userData.eid : m.uuid));
      else exact.push(m);                                   // roofs, slabs, others: exact triangle test (overhangs, balconies)
    }
    const rc = new THREE.Raycaster(), O = new THREE.Vector3(), Dv = new THREE.Vector3(); rc.far = 300;
    const test = exact.length ? (o, d) => { rc.set(O.set(o[0], o[1], o[2]), Dv.set(d[0], d[1], d[2])); return rc.intersectObjects(exact, false).length > 0; } : null;
    for (const o of this.context.children) {
      if (o.userData.item?.type === "tree") { const crown = o.children[1]; const c = new THREE.Vector3(); crown.getWorldPosition(c); spheres.push({ c: c.toArray(), r: o.userData.item.r, t: 0.25 }); }
      else add(o, o.userData.ctxId);
    }
    return { boxes, spheres, test };
  }

  // ------------------------------------------------------------ appearance
  recolorWith(colorFn, glowId = null) {
    for (const m of this.building.children) if (m.userData.kind === "wall" || m.userData.kind === "surface") {
      const id = m.userData.wall?.id ?? (m.userData.eid != null ? "eid-" + m.userData.eid : null);
      const c = colorFn(m.userData.wall, id); m.material.color.set(c ?? MAT.wall.color);
      m.userData.glow = id != null && id === glowId; if (m !== this._sel) m.material.emissive.set(m.userData.glow ? 0x6b2a00 : 0x000000);
    }
  }
  recolorSurfaces(colorById) {   // generic meshes: colour by nearest surface is not tracked per triangle, so tint all surfaces
    for (const m of this.building.children) if (m.userData.kind === "surface") m.material.color.set(colorById ?? MAT.wall.color);
  }
  setLabels(items) {
    this.labelLayer.replaceChildren(); this.labels = [];
    for (const it of items) {
      if (!it.pos) continue;
      const d = document.createElement("div"); d.className = "wall-label" + (it.hot ? " hot" : ""); d.innerHTML = it.html;
      this.labelLayer.appendChild(d); this.labels.push({ el: d, pos: new THREE.Vector3(...it.pos) });
    }
  }
  _placeLabels() {
    if (!this.labels.length) return;
    const W = this.el.clientWidth, H = this.el.clientHeight;
    for (const l of this.labels) { const v = l.pos.clone().project(this.camera); l.el.style.display = v.z > 1 ? "none" : ""; l.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * W}px, ${(-v.y * 0.5 + 0.5) * H}px) translate(-50%, -100%)`; }
  }
  /** Sun: true azimuth (deg clockwise from true north), altitude (deg). */
  setSun(azTrue, alt) {
    const box = new THREE.Box3().setFromObject(this.building); const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? 20 : box.getSize(new THREE.Vector3()).length();
    const azp = (azTrue - this.tn) * Math.PI / 180, al = Math.max(alt, -5) * Math.PI / 180, D = size * 1.5 + 20;
    const dir = new THREE.Vector3(Math.sin(azp) * Math.cos(al), Math.sin(al), -Math.cos(azp) * Math.cos(al));
    this.sun.position.copy(c).addScaledVector(dir, D); this.sun.target.position.copy(c);
    this.sun.intensity = alt > 0 ? 2.6 * Math.min(1, 0.35 + Math.sin(al)) : 0; this.sun.visible = alt > -1;
    const cam = this.sun.shadow.camera, e = size * 1.6 + 20; cam.left = -e; cam.right = e; cam.top = e; cam.bottom = -e; cam.near = 0.5; cam.far = D * 2.5; cam.updateProjectionMatrix();
    this.sunBall.position.copy(c).addScaledVector(dir, Math.min(D, size * 0.9 + 8)); this.sunBall.visible = alt > 0;
    this.sunDir = dir.toArray();
  }
  /** Convert a true-frame sun vector {east, north, up} to world. */
  sunWorld(v) { const t = this.tn * Math.PI / 180, ep = v.east * Math.cos(t) - v.north * Math.sin(t), np = v.north * Math.cos(t) + v.east * Math.sin(t); return [ep, v.up, -np]; }
  dispose() { this.disposed = true; this.renderer?.dispose(); }
}
