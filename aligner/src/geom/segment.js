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
  // 点の細かさに合わせて曲率をなめらかにする（細かいスキャンほどノイズが多いので回数を増やす）
  const K = mesh.curvature(smoothItersFor(mesh));
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
    // スキャンの外周だけを歯肉の目印にする（歯冠の中の小さな穴の縁は使わない）
    const loops = mesh.boundaryLoops();
    const maxLen = loops.length ? loops[0].length : 0;
    for (const loop of loops) {
      if (loop.length < Math.max(50, maxLen * 0.2)) continue;
      for (const v of loop) if (cand[v] < 0) { cand[v] = 0; heap.push(0, v); }
    }
  }
  // 歯冠のシードより十分低い（歯根側の）点も歯肉の目印にする
  {
    const toothSeeds = seeds.filter((s0) => s0.label > 0).map((s0) => s0.vertex);
    if (toothSeeds.length >= 3) {
      const N = mesh.vertexNormals();
      let o = [0, 0, 0];
      for (const v of toothSeeds) { o[0] += N[3 * v]; o[1] += N[3 * v + 1]; o[2] += N[3 * v + 2]; }
      const l = Math.hypot(...o) || 1; o = o.map((x) => x / l);
      const hOf = (v) => P[3 * v] * o[0] + P[3 * v + 1] * o[1] + P[3 * v + 2] * o[2];
      const low = Math.min(...toothSeeds.map(hOf)) - 9.5;
      for (let i = 0; i < nv; i++) if (cand[i] < 0 && hOf(i) < low) { cand[i] = 0; heap.push(0, i); }
    }
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

/** 平均の辺の長さから、曲率のなめらかさ（反復回数）を決める。約 0.6mm の範囲をならす */
export function smoothItersFor(mesh) {
  const I = mesh.indices, P = mesh.positions;
  let s = 0, n = 0;
  for (let f = 0; f < I.length && n < 3000; f += 3 * Math.max(1, Math.floor(I.length / 9000))) {
    const a = 3 * I[f], b = 3 * I[f + 1];
    s += Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]); n++;
  }
  const e = n ? s / n : 0.3;
  return Math.max(2, Math.min(40, Math.round((0.6 / e) ** 2)));
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
  const K = mesh.curvature(smoothItersFor(mesh));
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

/**
 * CT から取り出した歯（歯冠＋歯根、スキャン座標）を使って、スキャンの歯冠の範囲を塗り直す
 *  - 歯肉になっている点のうち、CT の歯の表面から tol 以内 → その歯（最も近い歯）に加える
 *  - その歯として塗られているのに、CT のその歯から tol×2.5 以上離れている点 → 歯肉に戻す
 *  - 歯と歯の間の付け替えはしない（隣の CT の歯との境目がずれていても、隣の歯冠を奪わない）
 * ctTeeth: [{ fdi, mesh }]、grids はスキャン側で作った PointGrid クラス
 * 戻り値: { labels(新しい配列), added, removed }
 */
export function relabelFromCT(scan, labels, ctTeeth, PointGrid, tol = 0.5) {
  const out = Int32Array.from(labels);
  const allP = [], allN = [], owner = [];
  const per = new Map();
  for (const { fdi, mesh } of ctTeeth) {
    const P = mesh.positions, Nn = mesh.vertexNormals();
    for (let i = 0; i < P.length; i += 3) { allP.push(P[i], P[i + 1], P[i + 2]); allN.push(Nn[i], Nn[i + 1], Nn[i + 2]); owner.push(fdi); }
    per.set(fdi, new PointGrid(P, 1.0));
  }
  if (!allP.length) return { labels: out, added: 0, removed: 0, skipped: [] };
  const grid = new PointGrid(Float32Array.from(allP), 1.0);
  const SP = scan.positions, SN = scan.vertexNormals();
  // 歯ごとに変更候補を集め、変化が大きすぎる歯（CT の歯冠のずれが疑われる）は採用しない
  const addBy = new Map(), remBy = new Map();
  const before = labelCounts(labels);
  for (let v = 0; v < scan.nv; v++) {
    const p = [SP[3 * v], SP[3 * v + 1], SP[3 * v + 2]];
    const cur = out[v];
    if (cur === 0) {
      const q = grid.nearest(p, tol * 3);
      if (!q || q.dist > tol) continue;
      // 面の向きがそろっている点だけ（歯頸部で立ち上がる歯肉を歯にしない）
      const j = 3 * q.index;
      if (SN[3 * v] * allN[j] + SN[3 * v + 1] * allN[j + 1] + SN[3 * v + 2] * allN[j + 2] < 0.7) continue;
      const f = owner[q.index];
      if (!addBy.has(f)) addBy.set(f, []);
      addBy.get(f).push(v);
      continue;
    }
    if (per.has(cur)) {
      const qq = per.get(cur).nearest(p, tol * 2.5);
      if (!qq || qq.dist > tol * 2.5) { if (!remBy.has(cur)) remBy.set(cur, []); remBy.get(cur).push(v); }
    }
  }
  let added = 0, removed = 0;
  const skipped = [];
  for (const { fdi } of ctTeeth) {
    const n0 = before.get(fdi) || 0;
    const ad = addBy.get(fdi) || [], rm = remBy.get(fdi) || [];
    if (n0 > 0 && (rm.length > n0 * 0.4 || ad.length > n0 * 0.8)) { skipped.push(fdi); continue; }
    for (const v of ad) out[v] = fdi;
    for (const v of rm) out[v] = 0;
    added += ad.length; removed += rm.length;
  }
  cleanupLabels(scan, out, 1, 30);
  return { labels: out, added, removed, skipped };
}
