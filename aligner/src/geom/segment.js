// 口腔内スキャンの歯牙分割：シード付きウォーターシェッド（曲率の凹部を境界とする）
// labels: 頂点ごとに 0=歯肉, それ以外=FDI番号

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0], tk = k[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return [tk, top];
  }
}

/**
 * @param mesh   Mesh
 * @param seeds  [{ vertex, label }]  label=0 は歯肉
 * @param opts   { concavityWeight, autoGingivaBoundary }
 */
export function segmentTeeth(mesh, seeds, opts = {}) {
  const { concavityWeight = 4.0, autoGingivaBoundary = true, occlusal = null, gingivaBelow = null } = opts;
  const nv = mesh.nv;
  const K = mesh.curvature(2);
  // 「高さ」= 凹み具合。凸面は 0
  const H = new Float32Array(nv);
  let kscale = 0;
  {
    const a = Array.from(K).map(Math.abs).sort((x, y) => x - y);
    kscale = a[Math.floor(a.length * 0.9)] || 1;
  }
  for (let i = 0; i < nv; i++) H[i] = Math.max(0, -K[i] / kscale);
  const labels = new Int32Array(nv).fill(-1);
  const heap = new Heap();
  const { off, nbr } = mesh.adjacency();
  const P = mesh.positions;
  // ラベル候補を一時保持（確定は pop 時）
  const cand = new Int32Array(nv).fill(-1);
  for (const s of seeds) { cand[s.vertex] = s.label; heap.push(0, s.vertex); }
  if (autoGingivaBoundary) {
    for (const loop of mesh.boundaryLoops()) for (const v of loop) if (cand[v] < 0) { cand[v] = 0; heap.push(0, v); }
  }
  // 咬合方向が分かる場合：歯冠シードより十分低い頂点を歯肉シードに
  if (occlusal && gingivaBelow !== null) {
    for (let i = 0; i < nv; i++) {
      const h = P[3 * i] * occlusal[0] + P[3 * i + 1] * occlusal[1] + P[3 * i + 2] * occlusal[2];
      if (h < gingivaBelow && cand[i] < 0) { cand[i] = 0; heap.push(0, i); }
    }
  }
  const cost = new Float64Array(nv).fill(Infinity);
  for (let i = 0; i < nv; i++) if (cand[i] >= 0) cost[i] = 0;
  while (heap.size) {
    const [c, v] = heap.pop();
    if (labels[v] >= 0) continue;
    if (c > cost[v]) continue;
    labels[v] = cand[v];
    for (let k = off[v]; k < off[v + 1]; k++) {
      const u = nbr[k];
      if (labels[u] >= 0) continue;
      const dx = P[3 * u] - P[3 * v], dy = P[3 * u + 1] - P[3 * v + 1], dz = P[3 * u + 2] - P[3 * v + 2];
      const el = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // 経路上の最大の凹み（ミニマックス）を主キー、距離を副キーにする
      const nc = Math.max(c, Math.floor(H[u] * concavityWeight * 100) * 1000) + el * 0.001;
      if (nc < cost[u]) { cost[u] = nc; cand[u] = labels[v]; heap.push(nc, u); }
    }
  }
  for (let i = 0; i < nv; i++) if (labels[i] < 0) labels[i] = 0;
  if (!opts.noCleanup) cleanupLabels(mesh, labels);
  return labels;
}

/** 多数決フィルタ＋小島の除去 */
export function cleanupLabels(mesh, labels, iterations = 2, minIsland = 30) {
  const { off, nbr } = mesh.adjacency();
  const nv = mesh.nv;
  for (let it = 0; it < iterations; it++) {
    const next = labels.slice();
    for (let i = 0; i < nv; i++) {
      const cnt = new Map();
      for (let k = off[i]; k < off[i + 1]; k++) cnt.set(labels[nbr[k]], (cnt.get(labels[nbr[k]]) || 0) + 1);
      let best = labels[i], bc = 0;
      for (const [l, c] of cnt) if (c > bc) { bc = c; best = l; }
      if (bc * 2 > off[i + 1] - off[i]) next[i] = best;
    }
    labels.set(next);
  }
  // 各ラベルの連結成分のうち最大以外を周囲のラベルに吸収
  const comp = new Int32Array(nv).fill(-1);
  const comps = [];
  for (let s = 0; s < nv; s++) {
    if (comp[s] >= 0) continue;
    const id = comps.length, lab = labels[s];
    const verts = [s]; comp[s] = id;
    for (let q = 0; q < verts.length; q++) {
      const v = verts[q];
      for (let k = off[v]; k < off[v + 1]; k++) {
        const u = nbr[k];
        if (comp[u] < 0 && labels[u] === lab) { comp[u] = id; verts.push(u); }
      }
    }
    comps.push({ lab, verts });
  }
  const largest = new Map();
  for (const c of comps) if (!largest.has(c.lab) || largest.get(c.lab).verts.length < c.verts.length) largest.set(c.lab, c);
  for (const c of comps) {
    if (largest.get(c.lab) === c && (c.lab === 0 || c.verts.length >= minIsland)) continue;
    // 周囲で最も多いラベル
    const cnt = new Map();
    for (const v of c.verts) for (let k = off[v]; k < off[v + 1]; k++) {
      const l = labels[nbr[k]]; if (l !== c.lab) cnt.set(l, (cnt.get(l) || 0) + 1);
    }
    let best = 0, bc = -1;
    for (const [l, n] of cnt) if (n > bc) { bc = n; best = l; }
    for (const v of c.verts) labels[v] = best;
  }
  return labels;
}

/** 頂点ラベル → 面ラベル（多数決、同数なら歯を優先） */
export function faceLabels(mesh, labels) {
  const I = mesh.indices, nf = mesh.nf;
  const out = new Int32Array(nf);
  for (let f = 0; f < nf; f++) {
    const a = labels[I[3 * f]], b = labels[I[3 * f + 1]], c = labels[I[3 * f + 2]];
    out[f] = a === b || a === c ? a : b === c ? b : Math.max(a, b, c);
  }
  return out;
}

/** 凹み具合（0=平ら・凸、大きいほど深いくぼみ＝歯頸線・歯間）。手塗りの境界判定に使う */
export function concavity(mesh) {
  const K = mesh.curvature(2);
  const a = [];
  for (let i = 0; i < K.length; i += Math.max(1, Math.floor(K.length / 20000))) a.push(Math.abs(K[i]));
  a.sort((x, y) => x - y);
  const sc = a[Math.floor(a.length * 0.9)] || 1;
  const H = new Float32Array(K.length);
  for (let i = 0; i < K.length; i++) H[i] = Math.max(0, -K[i] / sc);
  return H;
}

/**
 * ブラシ：中心頂点から半径 r 内（つながった面をたどる）の頂点に label を塗る
 * opts.barrier（凹み具合）と opts.barrierThr を渡すと、深いくぼみ（歯頸線・歯間）を越えて広がらない
 * opts.protect = true なら、他の歯のラベルが付いた頂点は塗り替えない
 * 戻り値: 塗り替えた頂点番号の配列
 */
export function paintLabels(mesh, labels, centerVertex, radius, label, opts = {}) {
  const { off, nbr } = mesh.adjacency();
  const P = mesh.positions;
  const { barrier = null, barrierThr = 1.0, protect = false } = opts;
  const c = [P[3 * centerVertex], P[3 * centerVertex + 1], P[3 * centerVertex + 2]];
  const seen = new Set([centerVertex]);
  const q = [centerVertex];
  const r2 = radius * radius;
  const changed = [];
  const canPaint = (v) => !(protect && label > 0 && labels[v] > 0 && labels[v] !== label);
  for (let i = 0; i < q.length; i++) {
    const v = q[i];
    if (canPaint(v) && labels[v] !== label) { labels[v] = label; changed.push(v); }
    // 境界：くぼみの深い頂点は塗るが、その先へは広げない
    if (barrier && i > 0 && barrier[v] > barrierThr) continue;
    for (let k = off[v]; k < off[v + 1]; k++) {
      const u = nbr[k];
      if (seen.has(u)) continue;
      const d2 = (P[3 * u] - c[0]) ** 2 + (P[3 * u + 1] - c[1]) ** 2 + (P[3 * u + 2] - c[2]) ** 2;
      if (d2 <= r2) { seen.add(u); q.push(u); }
    }
  }
  return changed;
}

/**
 * 塗りつぶし：クリックした点から、くぼみ（歯頸線・歯間）で囲まれた範囲を塗る
 * maxRadius で最大の広がりを制限（歯冠 1 本分程度）
 */
export function fillRegion(mesh, labels, seedVertex, label, { barrier, barrierThr = 1.0, maxRadius = 7, protect = false } = {}) {
  return paintLabels(mesh, labels, seedVertex, maxRadius, label, { barrier, barrierThr, protect });
}

/** ラベルごとの頂点数 */
export function labelCounts(labels) {
  const m = new Map();
  for (let i = 0; i < labels.length; i++) m.set(labels[i], (m.get(labels[i]) || 0) + 1);
  return m;
}
