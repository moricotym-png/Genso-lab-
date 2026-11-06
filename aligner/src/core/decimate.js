// メッシュの間引き（二次誤差 QEM による辺の縮約）。閉じた多様体を壊さないよう
// リンク条件と面の裏返りを検査する。シェル STL を軽くするために使う。
import { Mesh } from './mesh.js';

class MinHeap {
  constructor() { this.c = []; this.a = []; this.b = []; this.v = []; }
  get size() { return this.c.length; }
  push(cost, a, b, ver) {
    const C = this.c, A = this.a, B = this.b, V = this.v;
    let i = C.length;
    C.push(cost); A.push(a); B.push(b); V.push(ver);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (C[p] <= cost) break;
      C[i] = C[p]; A[i] = A[p]; B[i] = B[p]; V[i] = V[p];
      i = p;
    }
    C[i] = cost; A[i] = a; B[i] = b; V[i] = ver;
  }
  pop() {
    const C = this.c, A = this.a, B = this.b, V = this.v;
    const out = [C[0], A[0], B[0], V[0]];
    const lc = C.pop(), la = A.pop(), lb = B.pop(), lv = V.pop();
    const n = C.length;
    if (n === 0) return out;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = -1, mc = lc;
      if (l < n && C[l] < mc) { m = l; mc = C[l]; }
      if (r < n && C[r] < mc) { m = r; mc = C[r]; }
      if (m < 0) break;
      C[i] = C[m]; A[i] = A[m]; B[i] = B[m]; V[i] = V[m];
      i = m;
    }
    C[i] = lc; A[i] = la; B[i] = lb; V[i] = lv;
    return out;
  }
}

/**
 * @param mesh   Mesh（閉じた多様体を想定）
 * @param opts   { maxError: 許容誤差 mm, targetRatio: 目標の面数割合 }
 */
export function decimate(mesh, { maxError = 0.01, targetRatio = 0.25 } = {}) {
  const nv = mesh.nv, nf = mesh.nf;
  const P = Float64Array.from(mesh.positions);
  const F = Int32Array.from(mesh.indices);
  const faceAlive = new Uint8Array(nf).fill(1);
  const vAlive = new Uint8Array(nv).fill(1);
  const ver = new Uint32Array(nv);
  // 頂点 → 面リスト
  const vf = Array.from({ length: nv }, () => []);
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) vf[F[3 * f + k]].push(f);
  // 二次誤差行列（対称 4x4 の上三角 10 要素）
  const Q = new Float64Array(nv * 10);
  const faceNormal = (f, out) => {
    const a = 3 * F[3 * f], b = 3 * F[3 * f + 1], c = 3 * F[3 * f + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
    const l = Math.hypot(out[0], out[1], out[2]);
    return l;
  };
  const n = [0, 0, 0];
  for (let f = 0; f < nf; f++) {
    const l = faceNormal(f, n);
    if (l < 1e-20) continue;
    const a = n[0] / l, b = n[1] / l, c = n[2] / l;
    const v0 = 3 * F[3 * f];
    const d = -(a * P[v0] + b * P[v0 + 1] + c * P[v0 + 2]);
    const w = l / 2; // 面積で重み付け
    const q = [a * a, a * b, a * c, a * d, b * b, b * c, b * d, c * c, c * d, d * d];
    for (let k = 0; k < 3; k++) { const o = 10 * F[3 * f + k]; for (let i = 0; i < 10; i++) Q[o + i] += w * q[i]; }
  }
  const evalQ = (o1, o2, x, y, z) => {
    const q = (i) => Q[o1 + i] + Q[o2 + i];
    return q(0) * x * x + 2 * q(1) * x * y + 2 * q(2) * x * z + 2 * q(3) * x + q(4) * y * y + 2 * q(5) * y * z + 2 * q(6) * y + q(7) * z * z + 2 * q(8) * z + q(9);
  };
  // 縮約先の候補：両端・中点のうち誤差最小
  const best = (u, v) => {
    const cands = [
      [P[3 * u], P[3 * u + 1], P[3 * u + 2]],
      [P[3 * v], P[3 * v + 1], P[3 * v + 2]],
      [(P[3 * u] + P[3 * v]) / 2, (P[3 * u + 1] + P[3 * v + 1]) / 2, (P[3 * u + 2] + P[3 * v + 2]) / 2],
    ];
    let bc = Infinity, bp = cands[2];
    for (const p of cands) { const c = evalQ(10 * u, 10 * v, p[0], p[1], p[2]); if (c < bc) { bc = c; bp = p; } }
    // 面積で重み付けしているので「誤差²×面積」。面積当たりに直す目安として隣接面積で割る
    return [Math.max(0, bc), bp];
  };
  const areaCalc = (v) => { let s = 0; for (const f of vf[v]) if (faceAlive[f]) s += faceNormal(f, n) / 2; return s || 1e-9; };
  const va = new Float64Array(nv);
  for (let v = 0; v < nv; v++) va[v] = areaCalc(v);
  const area = (v) => va[v];
  const heap = new MinHeap();
  const pushEdge = (u, v) => {
    if (u > v) [u, v] = [v, u];
    const [c] = best(u, v);
    heap.push(c / (area(u) + area(v)), u, v, ver[u] + ver[v] * 65536);
  };
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) {
    const a = F[3 * f + k], b = F[3 * f + ((k + 1) % 3)];
    if (a < b) pushEdge(a, b);
  }
  const target = Math.max(4, Math.floor(nf * targetRatio));
  let alive = nf;
  const maxErr2 = maxError * maxError;
  const nbrs = (v) => { const s = new Set(); for (const f of vf[v]) if (faceAlive[f]) for (let k = 0; k < 3; k++) s.add(F[3 * f + k]); s.delete(v); return s; };
  const nOld = [0, 0, 0], nNew = [0, 0, 0];
  while (heap.size && alive > target) {
    const [cost, u, v, vv] = heap.pop();
    if (!vAlive[u] || !vAlive[v] || vv !== ver[u] + ver[v] * 65536) continue;
    if (cost > maxErr2) break;
    // リンク条件：共通の隣接頂点がちょうど2つ
    const nu = nbrs(u), nvs = nbrs(v);
    if (!nu.has(v)) continue;
    let common = 0;
    for (const x of nu) if (nvs.has(x)) common++;
    if (common !== 2) continue;
    const [, p] = best(u, v);
    // 面の裏返り検査
    let ok = true;
    for (const w of [u, v]) {
      for (const f of vf[w]) {
        if (!faceAlive[f]) continue;
        const has = [F[3 * f], F[3 * f + 1], F[3 * f + 2]];
        if (has.includes(u) && has.includes(v)) continue;
        const l0 = faceNormal(f, nOld);
        const k = has.indexOf(w);
        const save = [P[3 * w], P[3 * w + 1], P[3 * w + 2]];
        P[3 * w] = p[0]; P[3 * w + 1] = p[1]; P[3 * w + 2] = p[2];
        const l1 = faceNormal(f, nNew);
        P[3 * w] = save[0]; P[3 * w + 1] = save[1]; P[3 * w + 2] = save[2];
        if (l1 < 1e-12 || (nOld[0] * nNew[0] + nOld[1] * nNew[1] + nOld[2] * nNew[2]) / (l0 * l1) < 0.5) { ok = false; break; }
        void k;
      }
      if (!ok) break;
    }
    if (!ok) continue;
    // 縮約 v → u
    P[3 * u] = p[0]; P[3 * u + 1] = p[1]; P[3 * u + 2] = p[2];
    for (let i = 0; i < 10; i++) Q[10 * u + i] += Q[10 * v + i];
    for (const f of vf[v]) {
      if (!faceAlive[f]) continue;
      const has = [F[3 * f], F[3 * f + 1], F[3 * f + 2]];
      if (has.includes(u)) { faceAlive[f] = 0; alive--; continue; }
      for (let k = 0; k < 3; k++) if (F[3 * f + k] === v) F[3 * f + k] = u;
      vf[u].push(f);
    }
    vf[u] = vf[u].filter((f) => faceAlive[f]);
    vAlive[v] = 0; vf[v] = [];
    ver[u]++;
    const nn = nbrs(u);
    va[u] = areaCalc(u);
    for (const w of nn) va[w] = areaCalc(w);
    for (const w of nn) pushEdge(u, w);
  }
  // 詰め直し
  const remap = new Int32Array(nv).fill(-1);
  const pos = [];
  const idx = [];
  for (let f = 0; f < nf; f++) {
    if (!faceAlive[f]) continue;
    for (let k = 0; k < 3; k++) {
      const v = F[3 * f + k];
      if (remap[v] < 0) { remap[v] = pos.length / 3; pos.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); }
      idx.push(remap[v]);
    }
  }
  return new Mesh(Float32Array.from(pos), Uint32Array.from(idx));
}
