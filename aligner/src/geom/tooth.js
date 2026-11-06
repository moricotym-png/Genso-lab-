// 1本の歯のモデル：歯冠（スキャン由来）＋歯根（推定形状 or 調整）→ 閉じたメッシュ
// 歯の座標系：m=近心方向, b=頬側方向, z=咬合方向（歯軸）, CR=抵抗中心
import { Mesh, mergeMeshes } from '../core/mesh.js';
import {
  add, sub, scale, dot, cross, norm, orthoNorm, DEG, r3Axis, r3Mul, r3FromCols, r3T, r3ToZYX,
  r3FromZYX, mFromRT, mApply,
} from '../core/vec.js';
import { toothInfo } from '../plan/teeth.js';

/**
 * 歯を作る
 * @param crown  歯冠メッシュ（ワールド座標、開いた面）
 * @param fdi    FDI 番号
 * @param arch   { origin, ex, ey, ez, curve }  歯列座標系（ez=咬合方向）
 */
export function createTooth(crown, fdi, arch, opts = {}) {
  const info = toothInfo(fdi);
  const loops = crown.boundaryLoops();
  const t = {
    fdi,
    info,
    crown,
    marginLoop: loops[0] || [],
    holeLoops: loops.slice(1),
    rootLength: opts.rootLength ?? info.rootLength,
    rootScale: opts.rootScale ?? 1.0, // 歯根の太さ倍率
    crRatio: opts.crRatio ?? 0.4, // 歯頸部から根尖方向へ歯根長の何割の位置を抵抗中心とするか
    axisAdjust: opts.axisAdjust ?? { tip: 0, torque: 0 }, // 歯軸の補正（CBCTに合わせる）
    attachments: opts.attachments ?? [],
  };
  computeFrame(t, arch);
  buildRoot(t);
  return t;
}

/** 歯冠の重心・歯頸部中心・座標系を計算 */
export function computeFrame(t, arch) {
  const P = t.crown.positions;
  let c = [0, 0, 0];
  for (let i = 0; i < P.length; i += 3) { c[0] += P[i]; c[1] += P[i + 1]; c[2] += P[i + 2]; }
  c = scale(c, 3 / P.length);
  t.centroid = c;
  let cerv = [0, 0, 0];
  if (t.marginLoop.length) {
    for (const v of t.marginLoop) cerv = add(cerv, t.crown.p(v));
    cerv = scale(cerv, 1 / t.marginLoop.length);
  } else cerv = sub(c, scale(arch.ez, 4));
  // 歯軸：基本は歯列の咬合方向。歯冠が長い前歯は 歯頸部中心→歯冠重心 方向も加味
  let z = arch.ez.slice();
  const cz = sub(c, cerv);
  if (dot(cz, arch.ez) > 0.5) z = norm(add(scale(arch.ez, 0.6), scale(norm(cz), 0.4)));
  // 歯列弓の接線から近心方向
  const rel = sub(c, arch.origin);
  const x = dot(rel, arch.ex);
  const tan = arch.curve.tangent(x);
  const nrm = arch.curve.normal(x);
  let m = add(scale(arch.ex, tan[0]), scale(arch.ey, tan[1]));
  if (x > 0) m = scale(m, -1); // 正中へ向かう向き
  let b = add(scale(arch.ex, nrm[0]), scale(arch.ey, nrm[1]));
  // 歯軸補正（CBCTに合わせる）
  const adj = t.axisAdjust;
  if (adj.tip || adj.torque) {
    const Rt = r3Axis(norm(cross(z, orthoNorm(m, z))), adj.tip * DEG);
    z = norm(matVec(Rt, z));
    const Rq = r3Axis(norm(cross(z, orthoNorm(b, z))), adj.torque * DEG);
    z = norm(matVec(Rq, z));
  }
  m = orthoNorm(m, z);
  b = orthoNorm(sub(b, scale(m, dot(b, m))), z);
  const y = cross(z, m); // 右手系 (m, y, z)
  t.frame = { m, b, z, y, sb: Math.sign(dot(b, y)) || 1 };
  t.cervical = cerv;
  t.cr = sub(cerv, scale(z, t.rootLength * t.crRatio));
  t.apex = sub(cerv, scale(z, t.rootLength));
  // 歯冠の最も咬合側の点（レベリング用）と幅
  let top = -Infinity, mdMin = Infinity, mdMax = -Infinity, blMin = Infinity, blMax = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const d = [P[i] - cerv[0], P[i + 1] - cerv[1], P[i + 2] - cerv[2]];
    const h = dot(d, z), md = dot(d, m), bl = dot(d, b);
    if (h > top) top = h;
    if (md < mdMin) mdMin = md; if (md > mdMax) mdMax = md;
    if (bl < blMin) blMin = bl; if (bl > blMax) blMax = bl;
  }
  t.crownHeight = top;
  t.occlusalPoint = add(cerv, scale(z, top));
  t.width = mdMax - mdMin;
  t.depth = blMax - blMin;
  t.mdCenterOffset = (mdMax + mdMin) / 2;
}

const matVec = (R, p) => [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];

/** 歯頸部ループから根尖まで先細りのロフトで歯根を作り、歯冠と合わせて閉じたメッシュにする */
export function buildRoot(t, rings = 10) {
  const crown = t.crown;
  const loop = t.marginLoop;
  const { z } = t.frame;
  const nv0 = crown.nv;
  const P = Array.from(crown.positions);
  const I = Array.from(crown.indices);
  if (loop.length < 3) { t.mesh = crown; t.rootMesh = new Mesh(new Float32Array(0), new Uint32Array(0)); return; }
  const cerv = t.cervical;
  const L = t.rootLength;
  const n = loop.length;
  // 各頸部点の、歯軸に垂直な成分（半径ベクトル）
  const radial = loop.map((v) => {
    const d = sub(crown.p(v), cerv);
    return { r: sub(d, scale(z, dot(d, z))), h: dot(d, z) };
  });
  let prev = loop.slice();
  const rootStart = I.length;
  // 歯頸部から真下に伸びる「カラー」（歯肉の穴を確実にふさぐため。シェル生成の内外判定で重要）
  const COLLAR = [0.6, 1.5, 3.0];
  const hMin = Math.min(...radial.map((q) => q.h));
  const steps = [];
  for (const c of COLLAR) steps.push({ collar: c });
  for (let k = 1; k <= rings; k++) steps.push({ s: k / (rings + 1) });
  for (const st of steps) {
    const ring = [];
    for (let i = 0; i < n; i++) {
      const { r, h } = radial[i];
      let p;
      if (st.collar !== undefined) {
        p = sub(crown.p(loop[i]), scale(z, st.collar));
      } else {
        const s = st.s;
        const rs = Math.pow(1 - s, 0.65) * (1 - 0.1 * s) * (1 + (t.rootScale - 1) * Math.min(1, s * 4));
        const top = Math.min(h, hMin) - COLLAR[COLLAR.length - 1];
        p = add(add(cerv, scale(z, top * (1 - s) - L * s)), scale(r, rs));
      }
      ring.push(P.length / 3);
      P.push(p[0], p[1], p[2]);
    }
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      I.push(prev[i1], prev[i], ring[i]);
      I.push(prev[i1], ring[i], ring[i1]);
    }
    prev = ring;
  }
  const apexId = P.length / 3;
  const apex = sub(cerv, scale(z, L));
  P.push(apex[0], apex[1], apex[2]);
  for (let i = 0; i < n; i++) I.push(prev[(i + 1) % n], prev[i], apexId);
  // 歯冠内の小さな穴はふさぐ
  for (const h of t.holeLoops) {
    let c = [0, 0, 0];
    for (const v of h) c = add(c, crown.p(v));
    c = scale(c, 1 / h.length);
    const cid = P.length / 3; P.push(c[0], c[1], c[2]);
    for (let i = 0; i < h.length; i++) I.push(h[(i + 1) % h.length], h[i], cid);
  }
  t.mesh = new Mesh(Float32Array.from(P), Uint32Array.from(I));
  t.rootFaceStart = rootStart / 3;
  t.crownFaceCount = crown.nf;
  t.crownVertexCount = nv0;
}

/** 姿勢パラメータ → ワールド変換行列（4x4 列優先）。初期位置からの相対移動。 */
export function poseMatrix(t, pose) {
  const { m, b, z, sb } = t.frame;
  const A1 = cross(z, b), A2 = cross(z, m), A3 = cross(m, b);
  let R = r3Axis(norm(A1), (pose.torque || 0) * DEG);
  R = r3Mul(r3Axis(norm(A2), (pose.tip || 0) * DEG), R);
  R = r3Mul(r3Axis(norm(A3), (pose.rot || 0) * DEG), R);
  const d = add(add(scale(m, pose.md || 0), scale(b, pose.bl || 0)), scale(z, pose.ext || 0));
  const cr = t.cr;
  const Rc = matVec(R, cr);
  const tr = [cr[0] + d[0] - Rc[0], cr[1] + d[1] - Rc[1], cr[2] + d[2] - Rc[2]];
  return mFromRT(R, tr);
}

/** ワールド変換（初期位置からの相対）→ 姿勢パラメータ */
export function matrixToPose(t, M) {
  const { m, b, z, y, sb } = t.frame;
  const R = [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]];
  const F = r3FromCols(m, y, z);
  const Rl = r3Mul(r3T(F), r3Mul(R, F));
  const [ax, ay, az] = r3ToZYX(Rl);
  const crNew = mApply(M, t.cr);
  const d = sub(crNew, t.cr);
  return {
    md: dot(d, m), bl: dot(d, b), ext: dot(d, z),
    tip: ay / DEG, torque: (-ax * sb) / DEG, rot: (az * sb) / DEG,
  };
}

/** 回転行列（ワールド, 行優先 3x3）から姿勢の回転成分だけ得る */
export function rotationToAngles(t, R) {
  const { m, y, z, sb } = t.frame;
  const F = r3FromCols(m, y, z);
  const Rl = r3Mul(r3T(F), r3Mul(R, F));
  const [ax, ay, az] = r3ToZYX(Rl);
  return { tip: ay / DEG, torque: (-ax * sb) / DEG, rot: (az * sb) / DEG };
}

/** 角度 → 回転行列（ワールド, 行優先） */
export function anglesToRotation(t, { tip = 0, torque = 0, rot = 0 }) {
  const { m, y, z, sb } = t.frame;
  const F = r3FromCols(m, y, z);
  const Rl = r3FromZYX(-sb * torque * DEG, tip * DEG, sb * rot * DEG);
  return r3Mul(F, r3Mul(Rl, r3T(F)));
}

/** アタッチメント（直方体）メッシュを歯の初期座標で作る */
export function attachmentMesh(t, att) {
  const { m, b, z } = t.frame;
  const w = att.width ?? 3, h = att.height ?? 2, d = att.depth ?? 1;
  // 中心：歯冠頬側面上の点（att.anchor）。歯面に 0.5mm 埋め込む
  const c = add(att.anchor, scale(att.normal || b, d / 2 - 0.5));
  const ax = scale(m, w / 2), ay = scale(z, h / 2), az = scale(att.normal || b, d / 2);
  const corners = [];
  for (const sz of [-1, 1]) for (const sy of [-1, 1]) for (const sx of [-1, 1]) {
    corners.push(add(add(add(c, scale(ax, sx)), scale(ay, sy)), scale(az, sz)));
  }
  const P = new Float32Array(corners.flat());
  // 立方体の12三角形（外向き）。インデックス: bit0=x, bit1=y, bit2=z
  const F = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5];
  const mesh = new Mesh(P, Uint32Array.from(F));
  if (mesh.volume() < 0) { // 座標系の向きで反転していたら面を裏返す
    for (let i = 0; i < F.length; i += 3) { const tmp = mesh.indices[i + 1]; mesh.indices[i + 1] = mesh.indices[i + 2]; mesh.indices[i + 2] = tmp; }
  }
  return mesh;
}

/** 歯冠の頬側面の点を探す（重心から頬側方向に最も遠い付近の点） */
export function buccalAnchor(t, heightRatio = 0.55) {
  const { b, z } = t.frame;
  const P = t.crown.positions;
  const target = t.crownHeight * heightRatio;
  let best = null, bs = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const p = [P[i], P[i + 1], P[i + 2]];
    const d = sub(p, t.cervical);
    const h = dot(d, z);
    if (Math.abs(h - target) > 1.2) continue;
    const md = dot(d, t.frame.m) - t.mdCenterOffset;
    const s = dot(d, b) - Math.abs(md) * 0.8;
    if (s > bs) { bs = s; best = p; }
  }
  return best || add(t.centroid, scale(b, t.depth / 2));
}

export function toothSummary(t) {
  return { fdi: t.fdi, width: t.width, depth: t.depth, crownHeight: t.crownHeight, rootLength: t.rootLength };
}

export { mergeMeshes };
