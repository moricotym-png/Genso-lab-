// 3D ビューア（three.js）
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { TransformControls } from 'three/addons/TransformControls.js';

export const LABEL_COLORS = (() => {
  const m = new Map();
  m.set(0, [0.93, 0.62, 0.62]);
  let h = 0;
  for (const q of [1, 2, 3, 4]) for (let p = 1; p <= 8; p++) {
    const c = new THREE.Color().setHSL(((h++ * 0.137) % 1), 0.55, 0.72);
    m.set(q * 10 + p, [c.r, c.g, c.b]);
  }
  return m;
})();

export function meshToGeometry(mesh, colors = null) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 4000);
    this.camera.position.set(0, -120, 60);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const d1 = new THREE.DirectionalLight(0xffffff, 1.4); d1.position.set(60, -80, 120); this.camera.add(d1);
    this.scene.add(this.camera);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.groups = {};
    this.raycaster = new THREE.Raycaster();
    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSpace('local');
    this.gizmo.size = 0.8;
    this.gizmoHelper = this.gizmo.getHelper ? this.gizmo.getHelper() : this.gizmo;
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('dragging-changed', (e) => { this.controls.enabled = !e.value; });
    this.markers = new THREE.Group();
    this.root.add(this.markers); // データ座標で置く（基準座標で表示を回しても一緒に動く）
    this.pickHandler = null;
    this._down = null;
    canvas.addEventListener('pointerdown', (e) => { this._down = [e.clientX, e.clientY, e.button]; });
    canvas.addEventListener('pointerup', (e) => {
      if (!this._down) return;
      const moved = Math.hypot(e.clientX - this._down[0], e.clientY - this._down[1]);
      if (moved < 4 && this._down[2] === 0 && this.pickHandler && !this.gizmo.dragging) this.pickHandler(e);
      this._down = null;
    });
    canvas.addEventListener('pointermove', (e) => { if (this.moveHandler && e.buttons === 1) this.moveHandler(e); });
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  setTheme(bg) { this.scene.background = new THREE.Color(bg); }

  resize() {
    const p = this.canvas.parentElement;
    const w = p.clientWidth, h = p.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  group(name) {
    if (!this.groups[name]) { const g = new THREE.Group(); g.name = name; this.root.add(g); this.groups[name] = g; }
    return this.groups[name];
  }
  clearGroup(name) {
    const g = this.group(name);
    for (const c of [...g.children]) {
      g.remove(c);
      c.traverse?.((o) => { o.geometry?.dispose?.(); if (o.material?.map) o.material.map.dispose(); o.material?.dispose?.(); });
    }
    if (this.gizmo.object && !this.gizmo.object.parent) this.gizmo.detach();
  }
  setVisible(name, v) { this.group(name).visible = v; }

  addMesh(groupName, mesh, opts = {}) {
    const geom = meshToGeometry(mesh, opts.colors || null);
    const mat = new THREE.MeshStandardMaterial({
      color: opts.color ?? 0xdddddd,
      vertexColors: !!opts.colors,
      roughness: opts.roughness ?? 0.55,
      metalness: 0,
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
      side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
      depthWrite: (opts.opacity ?? 1) >= 1,
      map: opts.map || null,
    });
    const m = new THREE.Mesh(geom, mat);
    if (opts.matrix) { m.matrixAutoUpdate = false; m.matrix.fromArray(opts.matrix); }
    m.userData = opts.userData || {};
    if (opts.renderOrder) m.renderOrder = opts.renderOrder;
    this.group(groupName).add(m);
    return m;
  }

  fit(objects = null) {
    const box = new THREE.Box3();
    const list = objects || [this.root];
    for (const o of list) box.expandByObject(o);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(c);
    const dir = this.camera.position.clone().sub(c).normalize();
    if (!isFinite(dir.x)) dir.set(0, -1, 0.5).normalize();
    this.camera.position.copy(c).add(dir.multiplyScalar(s * 1.4));
    this.camera.near = Math.max(0.1, s / 500); this.camera.far = s * 20;
    this.camera.updateProjectionMatrix();
  }
  view(dir) {
    const c = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(c);
    const v = { front: [0, -1, 0], top: [0, 0, 1], bottom: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0] }[dir];
    this.camera.position.set(c.x + v[0] * dist, c.y + v[1] * dist, c.z + v[2] * dist);
    this.camera.up.set(0, dir === 'top' || dir === 'bottom' ? 1 : 0, dir === 'top' || dir === 'bottom' ? 0 : 1);
  }

  /** 画面座標で交差判定。objects 省略時は表示中の全メッシュ */
  pick(e, objects) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const list = [];
    for (const o of objects) o.traverse((q) => { if (q.isMesh && q.visible && isVisibleChain(q)) list.push(q); });
    const hits = this.raycaster.intersectObjects(list, false);
    const h = hits[0] || null;
    // 表示全体（root）を回している場合でも、データの座標で返す
    if (h) { this.root.updateMatrixWorld(true); h.point.applyMatrix4(this.root.matrixWorld.clone().invert()); }
    return h;
  }

  /** 表示の座標系をそろえる（F: 患者座標 → データ座標 の 4x4 列優先。null で解除） */
  setDisplayFrame(F) {
    this.root.matrixAutoUpdate = false;
    if (F) this.root.matrix.fromArray(F).invert(); else this.root.matrix.identity();
    this.root.matrixWorldNeedsUpdate = true;
  }

  /** 番号などの文字ラベル（常に手前に表示） */
  addLabel(p, text, color = '#ffffff', bg = 'rgba(0,0,0,0.65)') {
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    ctx.font = 'bold 28px sans-serif';
    const w = Math.ceil(ctx.measureText(text).width) + 16;
    cv.width = w; cv.height = 40;
    ctx.font = 'bold 28px sans-serif';
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, 40);
    ctx.fillStyle = color; ctx.fillText(text, 8, 30);
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.position.set(p[0], p[1], p[2]);
    sp.scale.set(w / 12, 40 / 12, 1);
    sp.center.set(-0.15, -0.15);
    sp.renderOrder = 11;
    this.markers.add(sp);
    return sp;
  }

  /** 平面（中心・法線・大きさ）を半透明の四角で表示 */
  addPlane(groupName, center, normal, size, color, uDir = null) {
    const n = new THREE.Vector3(...normal).normalize();
    const u = uDir ? new THREE.Vector3(...uDir) : new THREE.Vector3(Math.abs(n.x) < 0.9 ? 1 : 0, Math.abs(n.x) < 0.9 ? 0 : 1, 0);
    u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
    const v = n.clone().cross(u);
    const g = new THREE.PlaneGeometry(size, size);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
    m.matrixAutoUpdate = false;
    m.matrix.makeBasis(u, v, n).setPosition(new THREE.Vector3(...center));
    this.group(groupName).add(m);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color }));
    edge.matrixAutoUpdate = false; edge.matrix.copy(m.matrix);
    this.group(groupName).add(edge);
    return m;
  }

  addMarker(p, color = 0xff3355, size = 0.6) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    m.position.set(p[0], p[1], p[2]);
    m.renderOrder = 10;
    this.markers.add(m);
    return m;
  }
  clearMarkers() { for (const c of [...this.markers.children]) { this.markers.remove(c); c.geometry?.dispose(); c.material.map?.dispose(); c.material.dispose(); } }

  snapshot() { return this.renderer.domElement.toDataURL('image/png'); }
}

function isVisibleChain(o) {
  for (let q = o; q; q = q.parent) if (!q.visible) return false;
  return true;
}

/** CBCT の直交断面（テクスチャ付き四角形）を作る */
export function makeSliceMesh(vol, axis, index, wl, ww, toWorld) {
  const [nx, ny, nz] = vol.dims;
  let w, h, get, corners;
  const D = vol.data;
  if (axis === 2) {
    w = nx; h = ny; const k = index;
    get = (i, j) => D[i + nx * (j + ny * k)];
    corners = [[-0.5, -0.5, k], [nx - 0.5, -0.5, k], [nx - 0.5, ny - 0.5, k], [-0.5, ny - 0.5, k]];
  } else if (axis === 1) {
    w = nx; h = nz; const j = index;
    get = (i, k) => D[i + nx * (j + ny * k)];
    corners = [[-0.5, j, -0.5], [nx - 0.5, j, -0.5], [nx - 0.5, j, nz - 0.5], [-0.5, j, nz - 0.5]];
  } else {
    w = ny; h = nz; const i = index;
    get = (j, k) => D[i + nx * (j + ny * k)];
    corners = [[i, -0.5, -0.5], [i, ny - 0.5, -0.5], [i, ny - 0.5, nz - 0.5], [i, -0.5, nz - 0.5]];
  }
  const img = new Uint8Array(w * h * 4);
  const lo = wl - ww / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.max(0, Math.min(255, ((get(x, y) - lo) / ww) * 255));
    const o = 4 * (x + w * y);
    img[o] = img[o + 1] = img[o + 2] = v; img[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(img, w, h, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.magFilter = THREE.LinearFilter;
  const g = new THREE.BufferGeometry();
  const P = new Float32Array(corners.flatMap((c) => toWorld(c[0], c[1], c[2])));
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, opacity: 0.92 });
  return new THREE.Mesh(g, mat);
}

export { THREE };
