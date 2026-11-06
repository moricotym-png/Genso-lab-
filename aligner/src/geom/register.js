// 剛体位置合わせ：対応点（ランドマーク）による Horn 法、および ICP による微調整
import { jacobiEigen, mFromRT, mApply, r3Axis, r3Mul } from '../core/vec.js';
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
  buildDistanceMap(h = 1.0, pad = 12) {
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
export function autoRegister(srcPts, dstPts, { upSrc, upDst, yawSteps = 12, tryFlip = true, shifts = [-6, 0, 6], onProgress } = {}) {
  const nS = srcPts.length / 3;
  const pick = (count) => {
    const step = Math.max(1, Math.floor(nS / count));
    const out = [];
    for (let i = 0; i < nS; i += step) out.push([srcPts[3 * i], srcPts[3 * i + 1], srcPts[3 * i + 2]]);
    return out;
  };
  const coarsePts = pick(400), finePts = pick(3000);
  const gridF = new PointGrid(dstPts, 1.0).buildDistanceMap();
  // 粗い探索用には点を間引く（1セルあたりの点数を減らして高速化）
  const nD0 = dstPts.length / 3, stD = Math.max(1, Math.floor(nD0 / 40000));
  const sub = new Float32Array(Math.ceil(nD0 / stD) * 3);
  for (let i = 0, k = 0; i < nD0; i += stD, k++) { sub[3 * k] = dstPts[3 * i]; sub[3 * k + 1] = dstPts[3 * i + 1]; sub[3 * k + 2] = dstPts[3 * i + 2]; }
  const gridC = new PointGrid(sub, 1.5);
  gridC.dm = gridF.dm;
  const cen = (arr) => arr.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((x) => x / arr.length);
  const cS = cen(finePts);
  let cD = [0, 0, 0];
  { const nD = dstPts.length / 3, st = Math.max(1, Math.floor(nD / 20000)); let k = 0; for (let i = 0; i < nD; i += st) { cD[0] += dstPts[3 * i]; cD[1] += dstPts[3 * i + 1]; cD[2] += dstPts[3 * i + 2]; k++; } cD = cD.map((x) => x / k); }
  const run = (pts, grid, M, schedule) => {
    for (const [md, iters] of schedule) {
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
  const score = (pts, grid, M, tol) => {
    let n = 0, s = 0;
    for (const p of pts) {
      const q = grid.nearest(mApply(M, p), tol);
      if (q && q.dist <= tol) { n++; s += q.dist * q.dist; }
    }
    return { inlier: n / pts.length, rms: n ? Math.sqrt(s / n) : Infinity };
  };
  const cands = [];
  const ups = tryFlip ? [upDst, upDst.map((x) => -x)] : [upDst];
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
        M = run(coarsePts, gridC, M, [[8, 3], [4, 3], [2, 3]]);
        cands.push({ M, ...score(coarsePts, gridC, M, 1.0) });
        onProgress?.(++done / total);
      }
    }
  }
  cands.sort((a, b) => b.inlier - a.inlier);
  let best = null;
  for (const c of cands.slice(0, 4)) {
    const M = run(finePts, gridF, c.M, [[2, 6], [1, 6], [0.6, 8]]);
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
