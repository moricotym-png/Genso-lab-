// 剛体位置合わせ：対応点（ランドマーク）による Horn 法、および ICP による微調整
import { jacobiEigen, mFromRT, mApply } from '../core/vec.js';

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

/** 一様グリッドによる最近傍探索 */
export class PointGrid {
  constructor(points, cell = 1.0) {
    this.cell = cell;
    this.points = points; // Float32Array 3n
    this.map = new Map();
    for (let i = 0; i < points.length / 3; i++) {
      const k = this.key(points[3 * i], points[3 * i + 1], points[3 * i + 2]);
      let a = this.map.get(k); if (!a) { a = []; this.map.set(k, a); }
      a.push(i);
    }
  }
  key(x, y, z) {
    const c = this.cell;
    return `${Math.floor(x / c)},${Math.floor(y / c)},${Math.floor(z / c)}`;
  }
  nearest(p, maxR = 5) {
    const c = this.cell, P = this.points;
    const ix = Math.floor(p[0] / c), iy = Math.floor(p[1] / c), iz = Math.floor(p[2] / c);
    let best = -1, bd = Infinity;
    const rings = Math.ceil(maxR / c);
    for (let r = 0; r <= rings; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        const a = this.map.get(`${ix + dx},${iy + dy},${iz + dz}`);
        if (!a) continue;
        for (const i of a) {
          const d = (P[3 * i] - p[0]) ** 2 + (P[3 * i + 1] - p[1]) ** 2 + (P[3 * i + 2] - p[2]) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best >= 0 && Math.sqrt(bd) <= r * c) break;
    }
    return best < 0 ? null : { index: best, dist: Math.sqrt(bd) };
  }
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
