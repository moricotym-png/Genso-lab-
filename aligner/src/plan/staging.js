// ステージング：各歯の移動を 1ステージあたりの上限以内に分割し、ステージごとの姿勢を補間する
import { POSE_KEYS, DEFAULT_LIMITS, positionOf, zeroPose } from './teeth.js';
import { poseMatrix } from '../geom/tooth.js';
import { mApply } from '../core/vec.js';

/** その歯・その成分の1ステージ上限 */
export function limitFor(fdi, key, delta, limits = DEFAULT_LIMITS) {
  const p = positionOf(fdi);
  switch (key) {
    case 'md': case 'bl': return limits.translation;
    case 'ext': return delta >= 0 ? limits.extrusion : limits.intrusion;
    case 'tip': case 'torque': return limits.tipTorque;
    case 'rot': return p >= 3 && p <= 5 ? limits.rotationCanPre : limits.rotation;
    default: return Infinity;
  }
}

/** 目標までに必要な最小ステージ数 */
export function stagesNeeded(fdi, from, to, limits) {
  let n = 0;
  for (const k of POSE_KEYS) {
    const d = (to[k] || 0) - (from[k] || 0);
    n = Math.max(n, Math.ceil(Math.abs(d) / limitFor(fdi, k, d, limits) - 1e-9));
  }
  return n;
}

export const STRATEGIES = {
  simultaneous: '同時に開始・同時に終了（滑らか）',
  asap: '同時に開始・最短で終了（歯ごとに最大速度）',
  posteriorFirst: '臼歯→小臼歯→前歯の順に開始（固定源を考慮）',
  anteriorFirst: '前歯から先に開始（叢生の解消を優先）',
};

/**
 * 自動ステージング
 * @param targets Map(fdi → pose)
 * @returns plan { N, teeth: { [fdi]: { target, start, end, keys: [] } } }
 */
export function autoStage(targets, { limits = DEFAULT_LIMITS, strategy = 'simultaneous', overlap = 0.5, minStages = 1 } = {}) {
  const need = new Map();
  for (const [fdi, tgt] of targets) need.set(fdi, stagesNeeded(fdi, zeroPose(), tgt, limits));
  const teeth = {};
  let N = minStages;
  if (strategy === 'simultaneous' || strategy === 'asap') {
    const maxN = Math.max(minStages, ...need.values());
    for (const [fdi, tgt] of targets) {
      const n = need.get(fdi);
      teeth[fdi] = { target: { ...tgt }, start: 0, end: n === 0 ? 0 : strategy === 'asap' ? n : maxN, keys: [] };
    }
    N = maxN;
  } else {
    // グループごとに開始をずらす
    const groupOf = (fdi) => { const p = positionOf(fdi); return p >= 6 ? 0 : p >= 4 ? 1 : 2; };
    const order = strategy === 'posteriorFirst' ? [0, 1, 2] : [2, 1, 0];
    let startAt = 0;
    for (const g of order) {
      let gmax = 0;
      for (const [fdi, tgt] of targets) {
        if (groupOf(fdi) !== g) continue;
        const n = need.get(fdi);
        gmax = Math.max(gmax, n);
        teeth[fdi] = { target: { ...tgt }, start: n ? startAt : 0, end: n ? startAt + n : 0, keys: [] };
      }
      if (gmax) startAt += Math.max(1, Math.round(gmax * (1 - overlap)));
    }
    N = Math.max(minStages, ...Object.values(teeth).map((t) => t.end));
  }
  return { N, teeth, limits, strategy };
}

/** 計画からステージ k の姿勢 */
export function poseAt(plan, fdi, k) {
  const tp = plan.teeth[fdi];
  if (!tp) return zeroPose();
  const keys = [{ stage: tp.start, pose: zeroPose() }, ...tp.keys.filter((q) => q.stage > tp.start && q.stage < tp.end), { stage: tp.end, pose: tp.target }]
    .sort((a, b) => a.stage - b.stage);
  if (k <= keys[0].stage) return { ...keys[0].pose };
  if (k >= keys[keys.length - 1].stage) return { ...keys[keys.length - 1].pose };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (k >= a.stage && k <= b.stage) {
      const t = b.stage === a.stage ? 1 : (k - a.stage) / (b.stage - a.stage);
      const o = {};
      for (const key of POSE_KEYS) o[key] = (a.pose[key] || 0) + ((b.pose[key] || 0) - (a.pose[key] || 0)) * t;
      return o;
    }
  }
  return { ...tp.target };
}

export function posesAt(plan, k) {
  const m = new Map();
  for (const fdi of Object.keys(plan.teeth)) m.set(+fdi, poseAt(plan, +fdi, k));
  return m;
}

/** ステージ k に中間キーを置く（ステージングの細かな手修正） */
export function setKey(plan, fdi, k, pose) {
  const tp = plan.teeth[fdi];
  if (!tp) return;
  if (k >= tp.end || tp.end === 0) { tp.target = { ...pose }; if (k > tp.end) tp.end = k; return; }
  if (k <= tp.start) return;
  const ex = tp.keys.find((q) => q.stage === k);
  if (ex) ex.pose = { ...pose }; else tp.keys.push({ stage: k, pose: { ...pose } });
}

/** 速度チェック：上限を超えるステージを列挙 */
export function checkVelocities(plan) {
  const issues = [];
  for (const fdi of Object.keys(plan.teeth).map(Number)) {
    let prev = poseAt(plan, fdi, 0);
    for (let k = 1; k <= plan.N; k++) {
      const cur = poseAt(plan, fdi, k);
      for (const key of POSE_KEYS) {
        const d = cur[key] - prev[key];
        const lim = limitFor(fdi, key, d, plan.limits || DEFAULT_LIMITS);
        if (Math.abs(d) > lim + 1e-6) issues.push({ fdi, stage: k, key, value: d, limit: lim });
      }
      prev = cur;
    }
  }
  return issues;
}

/** 計画を移動量の表（CSV 用）に */
export function stagingTable(plan) {
  const rows = [['stage', 'fdi', ...POSE_KEYS]];
  for (let k = 0; k <= plan.N; k++) {
    for (const fdi of Object.keys(plan.teeth).map(Number).sort((a, b) => a - b)) {
      const p = poseAt(plan, fdi, k);
      rows.push([k, fdi, ...POSE_KEYS.map((q) => p[q].toFixed(3))]);
    }
  }
  return rows;
}

// ---------------- 隣接歯の接触・重なり（IPR の目安） ----------------
/**
 * 隣接する歯どうしの「歯列方向の重なり量」（mm）とすき間（mm）
 * 2本を結ぶ方向 u に沿って、断面の小区画ごとに 近心歯の最遠心点 と 遠心歯の最近心点 を比べ、
 * 遠心歯を u 方向にどれだけ動かせば接触だけになるか（＝IPR やスペースの必要量）を求める
 */
export function contactReport(arch, poses, order, cell = 0.5) {
  // 初期状態（同じスキャン面から切り出した歯は本来重ならない）での見かけの重なりを基準値として差し引く
  if (poses.size && !arch._contactBase) arch._contactBase = new Map(contactReportRaw(arch, new Map(), order, cell).map((c) => [`${c.a}-${c.b}`, c.sep]));
  const base = arch._contactBase;
  return contactReportRaw(arch, poses, order, cell).map((c) => {
    const b0 = base ? Math.max(0, base.get(`${c.a}-${c.b}`) ?? 0) : Math.max(0, c.sep);
    if (c.sep === null) return { a: c.a, b: c.b, overlap: 0, gap: null };
    const sep = c.sep - b0;
    return { a: c.a, b: c.b, overlap: Math.max(0, sep), gap: sep < 0 ? -sep : 0 };
  });
}

function contactReportRaw(arch, poses, order, cell) {
  const list = order.filter((f) => arch.teeth.has(f));
  const posed = new Map();
  for (const fdi of list) {
    const t = arch.teeth.get(fdi);
    const M = poseMatrix(t, poses.get(fdi) || zeroPose());
    const P = t.crown.positions;
    const out = new Float32Array(P.length);
    let c = [0, 0, 0];
    for (let i = 0; i < P.length; i += 3) {
      const q = mApply(M, [P[i], P[i + 1], P[i + 2]]);
      out[i] = q[0]; out[i + 1] = q[1]; out[i + 2] = q[2];
      c[0] += q[0]; c[1] += q[1]; c[2] += q[2];
    }
    c = c.map((x) => x / (P.length / 3));
    const z = [M[0] * t.frame.z[0] + M[4] * t.frame.z[1] + M[8] * t.frame.z[2], M[1] * t.frame.z[0] + M[5] * t.frame.z[1] + M[9] * t.frame.z[2], M[2] * t.frame.z[0] + M[6] * t.frame.z[1] + M[10] * t.frame.z[2]];
    posed.set(fdi, { P: out, c, z });
  }
  const res = [];
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    // 正中をまたぐのは中切歯どうしのみ（例: 11-21）
    if (Math.floor(a / 10) !== Math.floor(b / 10) && !(a % 10 === 1 && b % 10 === 1)) continue;
    const A = posed.get(a), B = posed.get(b);
    let z = [A.z[0] + B.z[0], A.z[1] + B.z[1], A.z[2] + B.z[2]];
    const zl = Math.hypot(...z); z = z.map((x) => x / zl);
    let u = [B.c[0] - A.c[0], B.c[1] - A.c[1], B.c[2] - A.c[2]];
    const uz = u[0] * z[0] + u[1] * z[1] + u[2] * z[2];
    u = [u[0] - uz * z[0], u[1] - uz * z[1], u[2] - uz * z[2]];
    const ul = Math.hypot(...u) || 1; u = u.map((x) => x / ul);
    const w = [u[1] * z[2] - u[2] * z[1], u[2] * z[0] - u[0] * z[2], u[0] * z[1] - u[1] * z[0]];
    const mid = [(A.c[0] + B.c[0]) / 2, (A.c[1] + B.c[1]) / 2, (A.c[2] + B.c[2]) / 2];
    const proj = (X, sign) => {
      const m = new Map();
      for (let v = 0; v < X.P.length; v += 3) {
        const d = [X.P[v] - mid[0], X.P[v + 1] - mid[1], X.P[v + 2] - mid[2]];
        const pu = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
        const k = `${Math.floor((d[0] * w[0] + d[1] * w[1] + d[2] * w[2]) / cell)},${Math.floor((d[0] * z[0] + d[1] * z[1] + d[2] * z[2]) / cell)}`;
        const cur = m.get(k);
        if (cur === undefined || sign * pu > sign * cur) m.set(k, pu);
      }
      return m;
    };
    const aMax = proj(A, 1), bMin = proj(B, -1);
    let sep = -Infinity;
    for (const [k, va] of aMax) { const vb = bMin.get(k); if (vb !== undefined) sep = Math.max(sep, va - vb); }
    res.push({ a, b, sep: sep === -Infinity ? null : sep });
  }
  return res;
}

/** 全ステージを通した IPR 計画：最初に重なりが出るステージと最大量 */
export function iprSchedule(arch, plan, order, threshold = 0.05) {
  const out = new Map();
  for (let k = 0; k <= plan.N; k++) {
    const rep = contactReport(arch, posesAt(plan, k), order);
    for (const c of rep) {
      const key = `${c.a}-${c.b}`;
      const cur = out.get(key) || { contact: key, firstStage: null, max: 0 };
      if (c.overlap > threshold && cur.firstStage === null) cur.firstStage = k;
      cur.max = Math.max(cur.max, c.overlap);
      out.set(key, cur);
    }
  }
  return [...out.values()].filter((c) => c.max > threshold);
}
