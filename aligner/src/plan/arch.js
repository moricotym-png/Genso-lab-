// 顎（上顎/下顎）単位のモデル：スキャン、分割ラベル、歯、歯肉、歯列座標系
import { Mesh, mergeMeshes } from '../core/mesh.js';
import { add, sub, scale, dot, cross, norm, orthoNorm, pca, mApply } from '../core/vec.js';
import { faceLabels } from '../geom/segment.js';
import { createTooth, poseMatrix, attachmentMesh, computeFrame, buildRoot } from '../geom/tooth.js';
import { fitArch } from './archform.js';
import { positionOf, quadrantOf } from './teeth.js';

/** 歯冠重心から歯列座標系を推定する */
export function computeArchFrame(crowns, gingivaCentroid) {
  const fdis = [...crowns.keys()];
  const cents = fdis.map((f) => crowns.get(f).centroid);
  const all = pca(cents);
  let ez = all.axes[2];
  const teethC = all.center;
  if (dot(ez, sub(teethC, gingivaCentroid)) < 0) ez = scale(ez, -1);
  const pick = (cond) => fdis.filter(cond).map((f) => crowns.get(f).centroid);
  const avg = (ps) => scale(ps.reduce((a, b) => add(a, b), [0, 0, 0]), 1 / ps.length);
  const ant = pick((f) => positionOf(f) <= 2);
  const maxPos = Math.max(...fdis.map(positionOf));
  const post = pick((f) => positionOf(f) >= Math.max(4, maxPos - 1));
  let ey = ant.length && post.length ? orthoNorm(sub(avg(ant), avg(post)), ez) : orthoNorm(all.axes[1], ez);
  const ex = cross(ey, ez);
  const centrals = pick((f) => positionOf(f) === 1);
  const origin = centrals.length ? avg(centrals) : avg(ant.length ? ant : cents);
  return { origin, ex, ey, ez };
}

export function toArchLocal(frame, p) {
  const d = sub(p, frame.origin);
  return [dot(d, frame.ex), dot(d, frame.ey), dot(d, frame.ez)];
}
export function fromArchLocal(frame, l) {
  return add(add(add(frame.origin, scale(frame.ex, l[0])), scale(frame.ey, l[1])), scale(frame.ez, l[2]));
}

/**
 * スキャン＋頂点ラベル → 顎モデル
 * @param jaw 'upper' | 'lower'
 */
export function buildArch(jaw, scan, labels, prev = null) {
  const fl = faceLabels(scan, labels);
  const fdis = [...new Set(fl)].filter((l) => l > 0).sort((a, b) => a - b);
  const crowns = new Map();
  for (const fdi of fdis) {
    const mask = new Uint8Array(scan.nf);
    for (let f = 0; f < scan.nf; f++) mask[f] = fl[f] === fdi ? 1 : 0;
    const sub = scan.submesh(mask);
    if (sub.nf < 20) continue;
    let c = [0, 0, 0];
    for (let i = 0; i < sub.nv; i++) c = add(c, sub.p(i));
    sub.centroid = scale(c, 1 / sub.nv);
    crowns.set(fdi, sub);
  }
  const gmask = new Uint8Array(scan.nf);
  for (let f = 0; f < scan.nf; f++) gmask[f] = fl[f] === 0 ? 1 : 0;
  const ging = scan.submesh(gmask);
  let gc = [0, 0, 0];
  for (let i = 0; i < ging.nv; i++) gc = add(gc, ging.p(i));
  gc = scale(gc, 1 / Math.max(1, ging.nv));
  const frame = computeArchFrame(crowns, gc);
  // 歯列弓曲線（歯冠重心でフィット）
  let pts = [...crowns.values()].map((c) => toArchLocal(frame, c.centroid));
  frame.curve = fitArch(pts.map((p) => [p[0], p[1]]));
  // 歯列弓は前方に凸（y = c0 + c2 x^2 で c2 < 0）。逆なら前後を取り違えているので反転
  if (frame.curve.c2 > 0) {
    frame.ey = scale(frame.ey, -1); frame.ex = scale(frame.ex, -1);
    pts = [...crowns.values()].map((c) => toArchLocal(frame, c.centroid));
    frame.curve = fitArch(pts.map((p) => [p[0], p[1]]));
  }
  // 歯番号の左右の確認：同じ側（右=1・4象限、左=2・3象限）の歯は x の符号がそろうはず
  const warnings = [];
  const sx = { '-1': 0, '1': 0 };
  for (const [fdi, c] of crowns) sx[(Math.floor(fdi / 10) === 1 || Math.floor(fdi / 10) === 4) ? '-1' : '1'] += toArchLocal(frame, c.centroid)[0];
  for (const [fdi, c] of crowns) {
    const side = (Math.floor(fdi / 10) === 1 || Math.floor(fdi / 10) === 4) ? '-1' : '1';
    const x = toArchLocal(frame, c.centroid)[0];
    if (Math.abs(x) > 4 && Math.sign(x) !== Math.sign(sx[side])) warnings.push(`${fdi} の位置が反対側にあります（歯番号の左右の付け間違いの可能性）`);
  }
  const teeth = new Map();
  for (const [fdi, crown] of crowns) {
    const old = prev?.teeth?.get(fdi);
    teeth.set(fdi, createTooth(crown, fdi, frame, old ? {
      rootLength: old.rootLength, rootScale: old.rootScale, crRatio: old.crRatio, axisAdjust: old.axisAdjust, attachments: old.attachments,
    } : {}));
  }
  // 咬合平面：歯冠最上点にフィットして z=0 をそこに合わせる
  const occl = [...teeth.values()].map((t) => toArchLocal(frame, t.occlusalPoint)[2]);
  const zOff = occl.reduce((a, b) => a + b, 0) / Math.max(1, occl.length);
  frame.origin = add(frame.origin, scale(frame.ez, zOff));
  const arch = { jaw, scan, labels, faceLabels: fl, teeth, frame, gingiva: null, warnings };
  arch.gingiva = buildGingiva(arch, ging);
  return arch;
}

/** 歯肉シート：各頂点に「どの歯にどれだけ追従するか」の重みを付ける */
export function buildGingiva(arch, ging, sigma = 2.5) {
  const teeth = arch.teeth;
  // 元のスキャン頂点番号 → 歯
  const marginOwner = new Map();
  for (const [fdi, t] of teeth) for (const v of t.marginLoop) marginOwner.set(t.crown.fromOld[v], fdi);
  const P = Array.from(ging.positions);
  const I = Array.from(ging.indices);
  const nv0 = ging.nv;
  const capVertexTooth = [];
  // 歯の穴はふさがない（歯根の「カラー」が穴を埋める）
  const mesh = new Mesh(Float32Array.from(P), Uint32Array.from(I));
  // 追従の重み（近い2本まで）
  const nv = mesh.nv;
  const wTooth = new Int32Array(nv * 2);
  const wVal = new Float32Array(nv * 2);
  const marginPts = [];
  for (const [fdi, t] of teeth) for (const v of t.marginLoop) marginPts.push([fdi, t.crown.p(v)]);
  // グリッド
  const cell = 3;
  const grid = new Map();
  const key = (p) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  for (const mp of marginPts) { const k = key(mp[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(mp); }
  for (let i = 0; i < nv; i++) {
    if (i >= nv0) { wTooth[2 * i] = capVertexTooth[i - nv0]; wVal[2 * i] = 1; continue; }
    const p = mesh.p(i);
    const best = new Map();
    const [cx, cy, cz] = [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)];
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
      const a = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!a) continue;
      for (const [fdi, q] of a) {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
        if (!best.has(fdi) || best.get(fdi) > d) best.set(fdi, d);
      }
    }
    const arr = [...best.entries()].sort((a, b) => a[1] - b[1]).slice(0, 2);
    arr.forEach(([fdi, d], k) => { wTooth[2 * i + k] = fdi; wVal[2 * i + k] = Math.exp(-((d / sigma) ** 2)); });
  }
  return { mesh, wTooth, wVal, capCount: nv - nv0, fromOld: ging.fromOld };
}

/** 歯肉を各歯の変換に追従させた位置 */
export function morphGingiva(g, mats) {
  const P = g.mesh.positions;
  const out = new Float32Array(P.length);
  const nv = P.length / 3;
  for (let i = 0; i < nv; i++) {
    const p = [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
    let dx = 0, dy = 0, dz = 0, ws = 0;
    for (let k = 0; k < 2; k++) {
      const fdi = g.wTooth[2 * i + k], w = g.wVal[2 * i + k];
      if (!fdi || w < 1e-4) continue;
      const M = mats.get(fdi);
      if (!M) continue;
      const q = mApply(M, p);
      dx += w * (q[0] - p[0]); dy += w * (q[1] - p[1]); dz += w * (q[2] - p[2]);
      ws += w;
    }
    const s = ws > 1 ? 1 / ws : 1;
    out[3 * i] = p[0] + dx * s; out[3 * i + 1] = p[1] + dy * s; out[3 * i + 2] = p[2] + dz * s;
  }
  return new Mesh(out, g.mesh.indices);
}

/** 歯の再計算（歯根長・歯軸補正を変えたとき） */
export function refreshTooth(arch, t) {
  arch._contactBase = null;
  computeFrame(t, arch.frame);
  buildRoot(t);
}

/**
 * あるステージの姿勢でシェル生成用の入力を作る
 * poses: Map(fdi → pose)
 */
export function shellInput(arch, poses, params, toothThickness) {
  const mats = new Map();
  for (const [fdi, t] of arch.teeth) mats.set(fdi, poseMatrix(t, poses.get(fdi) || {}));
  const groups = [];
  const margins = [];
  const teethInfo = [];
  for (const [fdi, t] of arch.teeth) {
    const M = mats.get(fdi);
    const m = t.mesh.transformed(M);
    groups.push({ positions: m.positions, indices: m.indices });
    for (const v of t.marginLoop) margins.push(...mApply(M, t.crown.p(v)));
    teethInfo.push({ center: mApply(M, t.centroid), thickness: toothThickness(fdi) });
    for (const att of t.attachments) {
      const am = attachmentMesh(t, att).transformed(M);
      groups.push({ positions: am.positions, indices: am.indices });
    }
  }
  const g = morphGingiva(arch.gingiva, mats);
  groups.push({ positions: g.positions, indices: g.indices });
  const f = arch.frame;
  return {
    groups,
    frame: { origin: f.origin, ex: f.ex, ey: f.ey, ez: f.ez },
    margins: Float32Array.from(margins),
    teeth: teethInfo,
    params,
  };
}

export { mergeMeshes, quadrantOf };
