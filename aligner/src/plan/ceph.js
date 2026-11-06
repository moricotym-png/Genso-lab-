// 側面セファロ分析：計測点（2D）→ 角度・距離。目標値（初期値は目安、症例ごとに編集）
export const CEPH_LANDMARKS = [
  { key: 'S', name: 'S（セラ）' },
  { key: 'N', name: 'N（ナジオン）' },
  { key: 'Or', name: 'Or（眼窩点）' },
  { key: 'Po', name: 'Po（ポリオン）' },
  { key: 'ANS', name: 'ANS（前鼻棘）' },
  { key: 'PNS', name: 'PNS（後鼻棘）' },
  { key: 'A', name: 'A点' },
  { key: 'B', name: 'B点' },
  { key: 'Pog', name: 'Pog（ポゴニオン）' },
  { key: 'Me', name: 'Me（メントン）' },
  { key: 'Go', name: 'Go（ゴニオン）' },
  { key: 'U1E', name: '上顎中切歯 切端' },
  { key: 'U1A', name: '上顎中切歯 根尖' },
  { key: 'L1E', name: '下顎中切歯 切端' },
  { key: 'L1A', name: '下顎中切歯 根尖' },
];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const angleBetween = (u, v) => {
  const c = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};
const lineAcute = (u, v) => { const a = angleBetween(u, v); return a > 90 ? 180 - a : a; };
/** 点 p から直線 ab までの符号付き距離（前方=正 になるよう N 側を基準に符号を決める） */
const pointLine = (p, a, b, front) => {
  const d = sub(b, a);
  const n = [-d[1], d[0]];
  const l = Math.hypot(...n);
  let s = ((p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1]) / l;
  if (front) {
    const sf = (front[0] - a[0]) * n[0] + (front[1] - a[1]) * n[1];
    if (sf < 0) s = -s;
  }
  return s;
};

/** 計測項目：need=必要な計測点, f=計算, unit */
export const CEPH_MEASURES = [
  { key: 'SNA', name: 'SNA', unit: '°', need: ['S', 'N', 'A'], f: (P) => angleBetween(sub(P.S, P.N), sub(P.A, P.N)) },
  { key: 'SNB', name: 'SNB', unit: '°', need: ['S', 'N', 'B'], f: (P) => angleBetween(sub(P.S, P.N), sub(P.B, P.N)) },
  { key: 'ANB', name: 'ANB', unit: '°', need: ['S', 'N', 'A', 'B'], f: (P) => angleBetween(sub(P.S, P.N), sub(P.A, P.N)) - angleBetween(sub(P.S, P.N), sub(P.B, P.N)) },
  { key: 'FMA', name: 'FMA (FH-MP)', unit: '°', need: ['Po', 'Or', 'Go', 'Me'], f: (P) => lineAcute(sub(P.Or, P.Po), sub(P.Me, P.Go)) },
  { key: 'SNMP', name: 'SN-MP', unit: '°', need: ['S', 'N', 'Go', 'Me'], f: (P) => lineAcute(sub(P.N, P.S), sub(P.Me, P.Go)) },
  { key: 'U1SN', name: 'U1-SN', unit: '°', need: ['S', 'N', 'U1E', 'U1A'], f: (P) => angleBetween(sub(P.U1E, P.U1A), sub(P.S, P.N)) },
  { key: 'U1FH', name: 'U1-FH', unit: '°', need: ['Po', 'Or', 'U1E', 'U1A'], f: (P) => angleBetween(sub(P.U1E, P.U1A), sub(P.Po, P.Or)) },
  { key: 'U1PP', name: 'U1-PP', unit: '°', need: ['ANS', 'PNS', 'U1E', 'U1A'], f: (P) => angleBetween(sub(P.U1E, P.U1A), sub(P.PNS, P.ANS)) },
  { key: 'IMPA', name: 'IMPA (L1-MP)', unit: '°', need: ['Go', 'Me', 'L1E', 'L1A'], f: (P) => angleBetween(sub(P.L1E, P.L1A), sub(P.Go, P.Me)) },
  { key: 'II', name: '上下中切歯軸角', unit: '°', need: ['U1E', 'U1A', 'L1E', 'L1A'], f: (P) => angleBetween(sub(P.U1A, P.U1E), sub(P.L1A, P.L1E)) },
  { key: 'U1APog', name: 'U1 to A-Pog', unit: 'mm', linear: true, need: ['A', 'Pog', 'U1E', 'S', 'N'], f: (P) => pointLine(P.U1E, P.A, P.Pog, [P.A[0] + P.N[0] - P.S[0], P.A[1] + P.N[1] - P.S[1]]) },
  { key: 'L1APog', name: 'L1 to A-Pog', unit: 'mm', linear: true, need: ['A', 'Pog', 'L1E', 'S', 'N'], f: (P) => pointLine(P.L1E, P.A, P.Pog, [P.A[0] + P.N[0] - P.S[0], P.A[1] + P.N[1] - P.S[1]]) },
];

/** 目標値の初期値（日本人成人の平均的な値を参考にした目安。必ず症例・術者基準で確認・編集すること） */
export const DEFAULT_TARGETS = {
  SNA: 82, SNB: 79, ANB: 3, FMA: 27, SNMP: 34, U1SN: 105, U1FH: 112, U1PP: 113, IMPA: 95, II: 124, U1APog: 6, L1APog: 2,
};

/** 計測点 → 計測値（足りない項目は null）。pxPerMm は直線計測用の倍率 */
export function measureCeph(points, pxPerMm = 1) {
  const out = {};
  for (const m of CEPH_MEASURES) {
    if (!m.need.every((k) => points[k])) { out[m.key] = null; continue; }
    const v = m.f(points);
    out[m.key] = m.linear ? v / pxPerMm : v;
  }
  return out;
}

/**
 * 計測値と目標値から、歯の移動目標（歯列セットアップへの入力）を作る
 *  - 上顎中切歯のトルク変化 = U1-SN（なければ U1-FH, U1-PP）の目標 − 現在
 *  - 下顎中切歯のトルク変化 = IMPA の目標 − 現在
 *  （角度が増える＝唇側傾斜＝歯冠唇側トルク）
 */
export function cephToToothGoals(measured, targets) {
  const pick = (keys) => {
    for (const k of keys) if (measured[k] != null && targets[k] != null && targets[k] !== '') return { key: k, delta: +targets[k] - measured[k] };
    return null;
  };
  const u = pick(['U1SN', 'U1FH', 'U1PP']);
  const l = pick(['IMPA']);
  return {
    upperIncisorTorque: u ? u.delta : 0,
    lowerIncisorTorque: l ? l.delta : 0,
    basis: { upper: u?.key || null, lower: l?.key || null },
  };
}
