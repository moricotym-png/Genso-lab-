// 剛体位置合わせ：対応点（ランドマーク）による Horn 法、および ICP による微調整
import { jacobiEigen, mFromRT, mApply, mMul, r3Axis, r3Mul } from '../core/vec.js';
import { edt3d } from './shell.js';

/**
 * 対応点 src[i] → dst[i] を最小二乗で合わせる剛体変換（4x4 列優先）
 * Horn (1987) の四元数法
 */
export function rigidFromPairs(src, dst, weights = null) {
  const n = src.length;
  if (n < 3) throw new Error('3点以上の対応点が必要です');
  let W = 0;
  const cs = [0, 0, 0], cd = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1; W += w;
    for (let k = 0; k < 3; k++) { cs[k] += w * src[i][k]; cd[k] += w * dst[i][k]; }
  }
  for (let k = 0; k < 3; k++) { cs[k] /= W; cd[k] /= W; }
  const S = new Array(9).fill(0);
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    const a = [src[i][0] - cs[0], src[i][1] - cs[1], src[i][2] - cs[2]];
    const b = [dst[i][0] - cd[0], dst[i][1] - cd[1], dst[i][2] - cd[2]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r * 3 + c] += w * a[r] * b[c];
  }
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = S;
  const N = [
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz,
  ];
  const { vectors } = jacobiEigen(N, 4);
  const [qw, qx, qy, qz] = vectors[0];
  const R = [
    qw * qw + qx * qx - qy * qy - qz * qz, 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy),
    2 * (qy * qx + qw * qz), qw * qw - qx * qx + qy * qy - qz * qz, 2 * (qy * qz - qw * qx),
    2 * (qz * qx - qw * qy), 2 * (qz * qy + qw * qx), qw * qw - qx * qx - qy * qy + qz * qz,
  ];
  const Rc = [
    R[0] * cs[0] + R[1] * cs[1] + R[2] * cs[2],
    R[3] * cs[0] + R[4] * cs[1] + R[5] * cs[2],
    R[6] * cs[0] + R[7] * cs[1] + R[8] * cs[2],
  ];
  return mFromRT(R, [cd[0] - Rc[0], cd[1] - Rc[1], cd[2] - Rc[2]]);
}

export function rmsError(M, src, dst) {
  let s = 0;
  for (let i = 0; i < src.length; i++) {
    const p = mApply(M, src[i]);
    s += (p[0] - dst[i][0]) ** 2 + (p[1] - dst[i][1]) ** 2 + (p[2] - dst[i][2]) ** 2;
  }
  return Math.sqrt(s / src.length);
}

/** 一様グリッドによる最近傍探索（数値キーのハッシュ） */
export class PointGrid {
  constructor(points, cell = 1.0) {
    this.cell = cell;
    this.points = points; // Float32Array 3n
    this.map = new Map();
    for (let i = 0; i < points.length / 3; i++) {
      const k = this.key(Math.floor(points[3 * i] / cell), Math.floor(points[3 * i + 1] / cell), Math.floor(points[3 * i + 2] / cell));
      let a = this.map.get(k); if (!a) { a = []; this.map.set(k, a); }
      a.push(i);
    }
  }
  key(ix, iy, iz) { return ((ix + 4096) * 8192 + (iy + 4096)) * 8192 + (iz + 4096); }
  /** 粗い距離マップ（1mm 格子）。遠い点の問い合わせを即座に打ち切るため */
  buildDistanceMap(h = 1.0, pad = 25) {
    const P = this.points;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i + k]); mx[k] = Math.max(mx[k], P[i + k]); }
    const o = mn.map((v) => v - pad);
    const n = mx.map((v, k) => Math.ceil((v + pad - o[k]) / h) + 1);
    const occ = new Uint8Array(n[0] * n[1] * n[2]);
    for (let i = 0; i < P.length; i += 3) {
      const a = Math.round((P[i] - o[0]) / h), b = Math.round((P[i + 1] - o[1]) / h), c = Math.round((P[i + 2] - o[2]) / h);
      occ[a + n[0] * (b + n[1] * c)] = 1;
    }
    this.dm = { o, n, h, d: edt3d(occ, n[0], n[1], n[2]) };
    return this;
  }
  nearest(p, maxR = 5) {
    const c = this.cell, P = this.points;
    if (this.dm) {
      const { o, n, h, d } = this.dm;
      const a = Math.round((p[0] - o[0]) / h), b = Math.round((p[1] - o[1]) / h), cc = Math.round((p[2] - o[2]) / h);
      if (a < 0 || b < 0 || cc < 0 || a >= n[0] || b >= n[1] || cc >= n[2]) return null;
      const est = d[a + n[0] * (b + n[1] * cc)] * h;
      if (est - h > maxR) return null;
      maxR = Math.min(maxR, est + h);
    }
    const ix = Math.floor(p[0] / c), iy = Math.floor(p[1] / c), iz = Math.floor(p[2] / c);
    let best = -1, bd = Infinity;
    const rings = Math.ceil(maxR / c);
    for (let r = 0; r <= rings; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        const edge = Math.abs(dx) === r || Math.abs(dy) === r;
        for (let dz = -r; dz <= r; dz += edge ? 1 : 2 * r || 1) {
          const a = this.map.get(this.key(ix + dx, iy + dy, iz + dz));
          if (!a) continue;
          for (const i of a) {
            const d = (P[3 * i] - p[0]) ** 2 + (P[3 * i + 1] - p[1]) ** 2 + (P[3 * i + 2] - p[2]) ** 2;
            if (d < bd) { bd = d; best = i; }
          }
        }
      }
      if (best >= 0 && Math.sqrt(bd) <= r * c) break;
    }
    return best < 0 ? null : { index: best, dist: Math.sqrt(bd) };
  }
}

/** 6x6 連立一次方程式（部分ピボット付きガウス消去） */
function solve6(A0, b0) {
  const A = Array.from({ length: 6 }, (_, i) => [...A0.slice(i * 6, i * 6 + 6), b0[i]]);
  for (let c = 0; c < 6; c++) {
    let p = c;
    for (let r = c + 1; r < 6; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-14) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 6; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 7; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[6] / row[i]);
}

function bboxVolume(P) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i + k]); mx[k] = Math.max(mx[k], P[i + k]); }
  return (mx[0] - mn[0] + 50) * (mx[1] - mn[1] + 50) * (mx[2] - mn[2] + 50);
}

/**
 * 「正面方向」と「上方向」から初期姿勢の候補を作る（顔スキャン ⇄ CT の皮膚 など）
 * frontSrc: src の正面方向（面の法線の平均）, frontDst/upDst: dst の前方・上方向
 * 正面軸まわりの回転（roll）を総当たりし、最も前に出た点（鼻尖付近）どうしをそろえる
 */
export function frontFacingCandidates(srcPts, dstPts, { frontSrc, frontDsts, upDst, rolls = 12, vshifts = [-25, 0, 25] }) {
  const nS = srcPts.length / 3, nD = dstPts.length / 3;
  const stS = Math.max(1, Math.floor(nS / 20000)), stD = Math.max(1, Math.floor(nD / 40000));
  const out = [];
  const perp = (a) => { const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; const c = [a[1] * t[2] - a[2] * t[1], a[2] * t[0] - a[0] * t[2], a[0] * t[1] - a[1] * t[0]]; const l = Math.hypot(...c); return c.map((x) => x / l); };
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  for (const fd of frontDsts) {
    const sideD = cross3(fd, upDst);
    // dst：最前点（前方の上位 0.5% の平均）と、横・上下の中心
    const projD = [];
    let cD = [0, 0, 0], k = 0;
    for (let i = 0; i < nD; i += stD) { const p = [dstPts[3 * i], dstPts[3 * i + 1], dstPts[3 * i + 2]]; projD.push(p[0] * fd[0] + p[1] * fd[1] + p[2] * fd[2]); cD = [cD[0] + p[0], cD[1] + p[1], cD[2] + p[2]]; k++; }
    cD = cD.map((x) => x / k);
    projD.sort((a, b) => b - a);
    const frontD = projD[Math.floor(projD.length * 0.005)];
    for (const sgn of [1, -1]) {
      const fs = frontSrc.map((x) => x * sgn);
      const u0 = perp(fs);
      for (let r = 0; r < rolls; r++) {
        const us = r3Apply3(r3Axis(fs, (2 * Math.PI * r) / rolls), u0);
        const ss = cross3(fs, us);
        // src 基底 (fs, us, ss) → dst 基底 (fd, upDst, sideD)
        const S = [fs, us, ss], D = [fd, upDst, sideD];
        const R = new Array(9).fill(0);
        for (let q = 0; q < 3; q++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i * 3 + j] += D[q][i] * S[q][j];
        let cS = [0, 0, 0], m = 0;
        const projS = [];
        for (let i = 0; i < nS; i += stS) {
          const p = r3Apply3(R, [srcPts[3 * i], srcPts[3 * i + 1], srcPts[3 * i + 2]]);
          cS = [cS[0] + p[0], cS[1] + p[1], cS[2] + p[2]]; m++;
          projS.push(p[0] * fd[0] + p[1] * fd[1] + p[2] * fd[2]);
        }
        cS = cS.map((x) => x / m);
        projS.sort((a, b) => b - a);
        const frontS = projS[Math.floor(projS.length * 0.005)];
        for (const vs of vshifts) {
          // 横・上下は重心、前後は最前点どうしをそろえる
          let t = [cD[0] - cS[0], cD[1] - cS[1], cD[2] - cS[2]];
          const along = t[0] * fd[0] + t[1] * fd[1] + t[2] * fd[2];
          const want = frontD - frontS;
          t = [t[0] + fd[0] * (want - along) + upDst[0] * vs, t[1] + fd[1] * (want - along) + upDst[1] * vs, t[2] + fd[2] * (want - along) + upDst[2] * vs];
          out.push(mFromRT(R, t));
        }
      }
    }
  }
  return out;
}
const r3Apply3 = (R, p) => [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];

/** 単位ベクトル a を b に重ねる回転（3x3 行優先） */
function rotateOnto(a, b) {
  const v = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const s = Math.hypot(...v);
  if (s < 1e-9) {
    if (c > 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    // 反対向き：a に垂直な軸で 180°
    const ax = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = [a[1] * ax[2] - a[2] * ax[1], a[2] * ax[0] - a[0] * ax[2], a[0] * ax[1] - a[1] * ax[0]];
    const l = Math.hypot(...u);
    return r3Axis(u.map((x) => x / l), Math.PI);
  }
  return r3Axis(v.map((x) => x / s), Math.atan2(s, c));
}

/**
 * 初期位置が分からない2つの点群の自動位置合わせ（大域探索＋ICP）
 *  - 「上方向」の候補（upSrc→upDst、反転も試す）× 鉛直軸まわりの回転 × 上下のずらし を初期値にして粗い ICP
 *  - 一致率の高い候補を細かい ICP で仕上げる
 * @returns { matrix: src→dst, rms, inlier: 0..1（0.5mm 以内の点の割合） }
 */
export function autoRegister(srcPts, dstPts, { upSrc, upDst, yawSteps = 12, tryFlip = true, shifts = [-6, 0, 6], onProgress, initial = null, coarse = [[8, 3], [4, 3], [2, 3]], fine = [[2, 6], [1, 6], [0.6, 8]], accept = null, dstNormals = null } = {}) {
  const nS = srcPts.length / 3;
  const pick = (count) => {
    const step = Math.max(1, Math.floor(nS / count));
    const out = [];
    for (let i = 0; i < nS; i += step) out.push([srcPts[3 * i], srcPts[3 * i + 1], srcPts[3 * i + 2]]);
    return out;
  };
  const coarsePts = pick(400), finePts = pick(3000);
  const gridF = new PointGrid(dstPts, 1.0).buildDistanceMap(Math.max(1.0, Math.cbrt(bboxVolume(dstPts) / 8e6)));
  // 粗い探索用には点を間引く（1セルあたりの点数を減らして高速化）
  const nD0 = dstPts.length / 3, stD = Math.max(1, Math.floor(nD0 / 40000));
  const sub = new Float32Array(Math.ceil(nD0 / stD) * 3);
  for (let i = 0, k = 0; i < nD0; i += stD, k++) { sub[3 * k] = dstPts[3 * i]; sub[3 * k + 1] = dstPts[3 * i + 1]; sub[3 * k + 2] = dstPts[3 * i + 2]; }
  // 探索距離に応じて格子の大きさを変える（遠い距離を探すときは粗い格子）
  const gridsC = new Map();
  const gridC = { forMD(md) { const c = Math.max(1.5, md / 3); if (!gridsC.has(c)) { const g = new PointGrid(sub, c); g.dm = gridF.dm; gridsC.set(c, g); } return gridsC.get(c); } };
  const cen = (arr) => arr.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((x) => x / arr.length);
  const cS = cen(finePts);
  let cD = [0, 0, 0];
  { const nD = dstPts.length / 3, st = Math.max(1, Math.floor(nD / 20000)); let k = 0; for (let i = 0; i < nD; i += st) { cD[0] += dstPts[3 * i]; cD[1] += dstPts[3 * i + 1]; cD[2] += dstPts[3 * i + 2]; k++; } cD = cD.map((x) => x / k); }
  const run = (pts, grid0, M, schedule) => {
    for (const [md, iters] of schedule) {
      const grid = grid0.forMD ? grid0.forMD(md) : grid0;
      for (let it = 0; it < iters; it++) {
        const A = [], B = [];
        for (const p of pts) {
          const q = grid.nearest(mApply(M, p), md);
          if (!q || q.dist > md) continue;
          A.push(p);
          B.push([grid.points[3 * q.index], grid.points[3 * q.index + 1], grid.points[3 * q.index + 2]]);
        }
        if (A.length < 12) return M;
        M = rigidFromPairs(A, B);
      }
    }
    return M;
  };
  // 点と面の距離を最小化する ICP（滑らかな面でも速く収束する）
  const runPlane = (pts, grid, M, schedule) => {
    for (const [md, iters] of schedule) {
      for (let it = 0; it < iters; it++) {
        const A = new Float64Array(36), b = new Float64Array(6);
        let n = 0;
        for (const p0 of pts) {
          const p = mApply(M, p0);
          const q = grid.nearest(p, md);
          if (!q || q.dist > md) continue;
          const j = 3 * q.index;
          const nn = [dstNormals[j], dstNormals[j + 1], dstNormals[j + 2]];
          const c = [p[1] * nn[2] - p[2] * nn[1], p[2] * nn[0] - p[0] * nn[2], p[0] * nn[1] - p[1] * nn[0]];
          const row = [c[0], c[1], c[2], nn[0], nn[1], nn[2]];
          const r = (grid.points[j] - p[0]) * nn[0] + (grid.points[j + 1] - p[1]) * nn[1] + (grid.points[j + 2] - p[2]) * nn[2];
          for (let a = 0; a < 6; a++) { b[a] += row[a] * r; for (let e = 0; e < 6; e++) A[a * 6 + e] += row[a] * row[e]; }
          n++;
        }
        if (n < 12) return M;
        for (let a = 0; a < 6; a++) A[a * 6 + a] += 1e-6 * n;
        const x = solve6(A, b);
        if (!x) return M;
        const w = Math.hypot(x[0], x[1], x[2]);
        const R = w > 1e-12 ? r3Axis([x[0] / w, x[1] / w, x[2] / w], w) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
        M = mMul(mFromRT(R, [x[3], x[4], x[5]]), M);
        if (w < 1e-6 && Math.hypot(x[3], x[4], x[5]) < 1e-4) break;
      }
    }
    return M;
  };
  const score = (pts, grid0, M, tol) => {
    const grid = grid0.forMD ? grid0.forMD(tol) : grid0;
    let n = 0, s = 0;
    for (const p of pts) {
      const q = grid.nearest(mApply(M, p), tol);
      if (q && q.dist <= tol) { n++; s += q.dist * q.dist; }
    }
    return { inlier: n / pts.length, rms: n ? Math.sqrt(s / n) : Infinity };
  };
  const cands = [];
  if (initial) {
    // 呼び出し側が初期姿勢の候補（src→dst の 4x4）を与える場合
    initial.forEach((M0, i) => {
      const M = run(coarsePts, gridC, M0, coarse);
      cands.push({ M, ...score(coarsePts, gridC, M, 1.0) });
      onProgress?.((i + 1) / initial.length);
    });
  }
  const ups = initial ? [] : tryFlip ? [upDst, upDst.map((x) => -x)] : [upDst];
  let done = 0;
  const total = ups.length * yawSteps * shifts.length;
  for (const up of ups) {
    const R0 = rotateOnto(upSrc, up);
    for (let y = 0; y < yawSteps; y++) {
      const R = r3Mul(r3Axis(up, (2 * Math.PI * y) / yawSteps), R0);
      const rc = [R[0] * cS[0] + R[1] * cS[1] + R[2] * cS[2], R[3] * cS[0] + R[4] * cS[1] + R[5] * cS[2], R[6] * cS[0] + R[7] * cS[1] + R[8] * cS[2]];
      for (const sh of shifts) {
        const t = [cD[0] - rc[0] + up[0] * sh, cD[1] - rc[1] + up[1] * sh, cD[2] - rc[2] + up[2] * sh];
        let M = mFromRT(R, t);
        M = run(coarsePts, gridC, M, coarse);
        cands.push({ M, ...score(coarsePts, gridC, M, 1.0) });
        onProgress?.(++done / total);
      }
    }
  }
  // 解剖学的にありえない姿勢は除外（呼び出し側の条件）
  const ok = accept ? cands.filter((c) => accept(c.M)) : cands;
  ok.sort((a, b) => b.inlier - a.inlier);
  let best = null;
  for (const c of ok.slice(0, 6)) {
    const M = dstNormals ? runPlane(finePts, gridF, c.M, fine) : run(finePts, gridF, c.M, fine);
    if (accept && !accept(M)) continue;
    const sc = score(finePts, gridF, M, 0.5);
    if (!best || sc.inlier > best.inlier) best = { matrix: M, ...sc };
  }
  return best;
}

/**
 * ICP：src 点群（Float32Array 3n）を dst 点群に合わせる。初期変換 M0 から。
 * 外れ値は maxDist で除外（反復ごとに縮める）。
 */
export function icp(srcPts, dstPts, M0, { iterations = 30, maxDist = 3, samples = 3000 } = {}) {
  const grid = new PointGrid(dstPts, Math.max(0.5, maxDist / 2));
  const n = srcPts.length / 3;
  const step = Math.max(1, Math.floor(n / samples));
  let M = M0.slice();
  let rms = Infinity;
  let md = maxDist;
  for (let it = 0; it < iterations; it++) {
    const A = [], B = [];
    let s = 0;
    for (let i = 0; i < n; i += step) {
      const p = mApply(M, [srcPts[3 * i], srcPts[3 * i + 1], srcPts[3 * i + 2]]);
      const q = grid.nearest(p, md);
      if (!q || q.dist > md) continue;
      A.push([srcPts[3 * i], srcPts[3 * i + 1], srcPts[3 * i + 2]]);
      B.push([dstPts[3 * q.index], dstPts[3 * q.index + 1], dstPts[3 * q.index + 2]]);
      s += q.dist * q.dist;
    }
    if (A.length < 10) break;
    const newRms = Math.sqrt(s / A.length);
    M = rigidFromPairs(A, B);
    if (Math.abs(rms - newRms) < 1e-4) { rms = newRms; break; }
    rms = newRms;
    md = Math.max(0.5, Math.min(md, rms * 3));
  }
  return { matrix: M, rms };
}
