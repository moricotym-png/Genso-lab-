// 3次元ベクトル・行列の小さなユーティリティ（three.js に依存しない純粋関数）
// ベクトルは [x, y, z]、4x4 行列は長さ16の配列（列優先 = three.js の Matrix4.elements と同じ）

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** a から b 方向成分を除いて正規化（直交化） */
export const orthoNorm = (a, b) => norm(sub(a, scale(b, dot(a, b))));

export const DEG = Math.PI / 180;

// ---------- 4x4 行列（列優先） ----------
export const mIdentity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mMul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

export const mTranslate = (t) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];

/** 3x3 回転（行優先の配列[9]）＋平行移動から 4x4 を作る */
export function mFromRT(R, t = [0, 0, 0]) {
  return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];
}

export function mApply(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
export function mApplyDir(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2],
  ];
}

/** 剛体変換（回転+並進）の逆行列 */
export function mInvRigid(m) {
  const R = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]; // 行優先
  const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  const t = [m[12], m[13], m[14]];
  const ti = [
    -(Rt[0] * t[0] + Rt[1] * t[1] + Rt[2] * t[2]),
    -(Rt[3] * t[0] + Rt[4] * t[1] + Rt[5] * t[2]),
    -(Rt[6] * t[0] + Rt[7] * t[1] + Rt[8] * t[2]),
  ];
  return mFromRT(Rt, ti);
}

/** 4x4 から 3x3 回転部分（行優先） */
export const mRot = (m) => [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];

// ---------- 3x3 行列（行優先） ----------
export function r3Mul(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}
export const r3T = (a) => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
export const r3Apply = (R, p) => [
  R[0] * p[0] + R[1] * p[1] + R[2] * p[2],
  R[3] * p[0] + R[4] * p[1] + R[5] * p[2],
  R[6] * p[0] + R[7] * p[1] + R[8] * p[2],
];

/** 軸 a（単位ベクトル）まわりに角度 th（ラジアン）回転する 3x3 */
export function r3Axis(a, th) {
  const [x, y, z] = a;
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

/** 列ベクトル e0,e1,e2 を並べた 3x3（行優先） */
export const r3FromCols = (e0, e1, e2) => [e0[0], e1[0], e2[0], e0[1], e1[1], e2[1], e0[2], e1[2], e2[2]];

/**
 * R = Rz(az) * Ry(ay) * Rx(ax) の分解（ラジアン）。
 */
export function r3ToZYX(R) {
  const ay = Math.asin(Math.max(-1, Math.min(1, -R[6])));
  const ax = Math.atan2(R[7], R[8]);
  const az = Math.atan2(R[3], R[0]);
  return [ax, ay, az];
}
export function r3FromZYX(ax, ay, az) {
  const Rx = r3Axis([1, 0, 0], ax), Ry = r3Axis([0, 1, 0], ay), Rz = r3Axis([0, 0, 1], az);
  return r3Mul(Rz, r3Mul(Ry, Rx));
}

// ---------- 対称行列の固有値分解（Jacobi法） ----------
/** n×n 対称行列 A（行優先配列）→ { values, vectors(列ベクトルの配列) } 降順 */
export function jacobiEigen(Ain, n) {
  const A = Ain.slice();
  const V = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p * n + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-30) continue;
        const app = A[p * n + p], aqq = A[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p], akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k], aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p], vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const idx = [...Array(n).keys()].sort((i, j) => A[j * n + j] - A[i * n + i]);
  return {
    values: idx.map((i) => A[i * n + i]),
    vectors: idx.map((i) => [...Array(n).keys()].map((k) => V[k * n + i])),
  };
}

/** 点群の重心と主成分（降順） */
export function pca(points) {
  const c = [0, 0, 0];
  for (const p of points) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  const n = points.length || 1;
  c[0] /= n; c[1] /= n; c[2] /= n;
  const C = new Array(9).fill(0);
  for (const p of points) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] += d[i] * d[j];
  }
  const e = jacobiEigen(C, 3);
  return { center: c, axes: e.vectors, values: e.values };
}
