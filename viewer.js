// viewer.js - 3D view of the BIM model with three.js. Two modes:
//   "model"     : real IFC geometry tessellated in the browser by web-ifc (WASM, loaded from the CDN on first use)
//   "schematic" : boxes built from the wall placements and areas read by bim.js (fallback; height assumed 3 m)
// Walls are coloured by U-value (one-hue sequential ramp) so the thermal weak spots are visible. Libraries load lazily.
const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
const ORBIT_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js";
const WEBIFC_URL = "https://cdn.jsdelivr.net/npm/web-ifc@0.0.57/web-ifc-api.js";
const WEBIFC_WASM = "https://cdn.jsdelivr.net/npm/web-ifc@0.0.57/";

let T = null, Orbit = null;
async function three() {
  if (!T) { T = await import(THREE_URL); Orbit = (await import(ORBIT_URL)).OrbitControls; }
  return T;
}

// sequential blue ramp (light -> dark = low -> high U); U above 2.5 W/m2K clamps to the darkest step
const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
export const uColor = u => u == null ? "#b9b8b0" : RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.floor((u / 2.5) * RAMP.length)))];
export const RAMP_STOPS = RAMP;

export class ModelViewer {
  constructor(el) { this.el = el; this.mode = null; this.disposed = false; }

  async init() {
    const THREE = await three();
    const w = this.el.clientWidth || 600, h = this.el.clientHeight || 380;
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 2000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h);
    this.el.replaceChildren(this.renderer.domElement);
    this.controls = new Orbit(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a80, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(20, 40, 25); this.scene.add(sun);
    this.group = new THREE.Group(); this.scene.add(this.group);
    const loop = () => { if (this.disposed) return; this.controls.update(); this.renderer.render(this.scene, this.camera); requestAnimationFrame(loop); };
    loop();
    new ResizeObserver(() => { const W = this.el.clientWidth, H = this.el.clientHeight; if (!W || !H) return; this.camera.aspect = W / H; this.camera.updateProjectionMatrix(); this.renderer.setSize(W, H); }).observe(this.el);
  }

  clear() { while (this.group.children.length) { const c = this.group.children.pop(); c.geometry?.dispose(); c.material?.dispose?.(); } }

  frame(target = this.group) {
    const THREE = T, box = new THREE.Box3().setFromObject(target), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const d = Math.max(s.x, s.y, s.z, 4) * 0.75;
    this.camera.position.set(c.x + d * 0.8, c.y + d * 0.7, c.z + d * 0.9);
    this.controls.target.copy(c); this.controls.update();
  }

  // north arrow on the ground plane (true north from the model)
  northArrow(tnCcwDeg, at) {
    const THREE = T, g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 8), new THREE.MeshStandardMaterial({ color: 0x52514e }));
    shaft.rotation.z = Math.PI / 2; shaft.position.x = 0; g.add(shaft);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 12), new THREE.MeshStandardMaterial({ color: 0xd03b3b }));
    head.rotation.z = -Math.PI / 2; head.position.x = 1.5; g.add(head);
    // IFC +Y (project north) maps to three -Z; true north is rotated tnCcwDeg CCW (seen from above) from it
    g.rotation.y = Math.PI / 2 + (tnCcwDeg * Math.PI) / 180;
    g.position.set(at.x, 0.05, at.z);
    this.group.add(g);
  }

  /** Schematic boxes from bim.js wall data. walls: [{geom:{x,y,theta_deg,thickness_m}, area_m2, u_value}] ; openings for gross length */
  schematic(project, height = 3.0) {
    const THREE = T; this.clear(); this.mode = "schematic";
    const opArea = {}; for (const o of project.openings || []) opArea[o.host_wall] = (opArea[o.host_wall] || 0) + o.area_m2;
    let cx = 0, cz = 0, n = 0;
    for (const w of project.walls) {
      if (!w.geom || w.area_m2 == null) continue;
      const len = (w.area_m2 + (opArea[w.id] || 0)) / height, t = Math.max(0.1, w.geom.thickness_m || 0.2), th = (w.geom.theta_deg * Math.PI) / 180;
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, height, t), new THREE.MeshStandardMaterial({ color: uColor(w.u_value), roughness: 0.85 }));
      // local centre: (len/2, +t/2) in wall axes (layers run along +local y); IFC (x,y,z) -> three (x, z, -y)
      const lx = len / 2, ly = t / 2;
      const X = w.geom.x + Math.cos(th) * lx - Math.sin(th) * ly, Y = w.geom.y + Math.sin(th) * lx + Math.cos(th) * ly;
      m.position.set(X, height / 2, -Y); m.rotation.y = th; m.userData = { wall: w };
      this.group.add(m); cx += X; cz += -Y; n++;
    }
    const walls = new THREE.Box3().setFromObject(this.group), sz = walls.getSize(new THREE.Vector3());
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(sz.x, sz.z, 6) * 2.2, Math.max(sz.x, sz.z, 6) * 2.2), new THREE.MeshStandardMaterial({ color: 0xe9e8e2 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(cx / Math.max(n, 1), 0, cz / Math.max(n, 1)); this.group.add(ground);
    if (n) this.northArrow(project.true_north_ccw_deg || 0, { x: walls.max.x + 2.5, z: (walls.min.z + walls.max.z) / 2 });
    this.frame();
    return n;
  }

  /** Real geometry via web-ifc. Returns number of meshes, throws on failure (caller falls back to schematic). */
  async model(bytes, project) {
    const THREE = T;
    const WebIFC = await import(WEBIFC_URL);
    const api = new WebIFC.IfcAPI();
    api.SetWasmPath(WEBIFC_WASM, true);
    await api.Init();
    const id = api.OpenModel(new Uint8Array(bytes));
    const wallByEid = {}; for (const w of project.walls) if (w.geom) wallByEid[w.geom.eid] = w;
    this.clear(); this.mode = "model";
    let count = 0;
    api.StreamAllMeshes(id, mesh => {
      const pgs = mesh.geometries;
      for (let i = 0; i < pgs.size(); i++) {
        const pg = pgs.get(i), geo = api.GetGeometry(id, pg.geometryExpressID);
        const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize()), ix = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
        const pos = new Float32Array(v.length / 2), nor = new Float32Array(v.length / 2);
        for (let k = 0, j = 0; k < v.length; k += 6, j += 3) { pos[j] = v[k]; pos[j + 1] = v[k + 1]; pos[j + 2] = v[k + 2]; nor[j] = v[k + 3]; nor[j + 1] = v[k + 4]; nor[j + 2] = v[k + 5]; }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("normal", new THREE.BufferAttribute(nor, 3)); g.setIndex(new THREE.BufferAttribute(ix, 1));
        const w = wallByEid[mesh.expressID];
        const col = w ? uColor(w.u_value) : new THREE.Color(pg.color.x, pg.color.y, pg.color.z).getHexString().replace(/^/, "#");
        const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: col, roughness: 0.85, transparent: !w && pg.color.w < 1, opacity: w ? 1 : pg.color.w }));
        m.matrixAutoUpdate = false; m.matrix.fromArray(pg.flatTransformation); m.userData = { wall: w };
        this.group.add(m); count++;
        geo.delete();
      }
    });
    api.CloseModel(id);
    if (!count) throw new Error("the IFC file contains no tessellatable geometry");
    const box = new THREE.Box3().setFromObject(this.group), c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
    const side = Math.max(sz.x, sz.z, 6) * 2.2;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(side, side), new THREE.MeshStandardMaterial({ color: 0xe9e8e2 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(c.x, box.min.y - 0.01, c.z); this.group.add(ground);
    this.northArrow(project.true_north_ccw_deg || 0, { x: box.max.x + 2.5, z: c.z });
    this.frame();
    return count;
  }

  dispose() { this.disposed = true; this.renderer?.dispose(); }
}
