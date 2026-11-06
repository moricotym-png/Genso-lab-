// 歯の基本データ（FDI 番号）。数値は教科書的な平均値の目安で、症例ごとに編集できます。
// 歯根長の目安（mm）：Wheeler's Dental Anatomy 等の平均値を丸めたもの
const ROOT_LEN = {
  upper: { 1: 13, 2: 13, 3: 17, 4: 14, 5: 14, 6: 13, 7: 12, 8: 11 },
  lower: { 1: 12.5, 2: 14, 3: 16, 4: 14, 5: 14.5, 6: 14, 7: 13, 8: 11 },
};
// 歯冠近遠心幅の目安（mm）：デモ症例の生成と、計測できないときの初期値
const CROWN_W = {
  upper: { 1: 8.5, 2: 6.5, 3: 7.5, 4: 7.0, 5: 6.5, 6: 10.0, 7: 9.0, 8: 8.5 },
  lower: { 1: 5.0, 2: 5.5, 3: 7.0, 4: 7.0, 5: 7.0, 6: 11.0, 7: 10.5, 8: 10.0 },
};
const NAMES = { 1: '中切歯', 2: '側切歯', 3: '犬歯', 4: '第一小臼歯', 5: '第二小臼歯', 6: '第一大臼歯', 7: '第二大臼歯', 8: '第三大臼歯' };

export const quadrantOf = (fdi) => Math.floor(fdi / 10);
export const positionOf = (fdi) => fdi % 10;
export const isUpper = (fdi) => quadrantOf(fdi) === 1 || quadrantOf(fdi) === 2;
export const archOf = (fdi) => (isUpper(fdi) ? 'upper' : 'lower');
/** 患者の右側（1・4象限）なら -1、左側なら +1 */
export const sideOf = (fdi) => (quadrantOf(fdi) === 1 || quadrantOf(fdi) === 4 ? -1 : 1);

export function toothInfo(fdi) {
  const a = archOf(fdi), p = positionOf(fdi);
  return {
    fdi,
    arch: a,
    pos: p,
    name: `${a === 'upper' ? '上顎' : '下顎'}${sideOf(fdi) < 0 ? '右' : '左'}${NAMES[p]}`,
    type: p <= 2 ? 'incisor' : p === 3 ? 'canine' : p <= 5 ? 'premolar' : 'molar',
    rootLength: ROOT_LEN[a][p],
    crownWidth: CROWN_W[a][p],
    roots: a === 'upper' ? (p >= 6 ? 3 : p === 4 ? 2 : 1) : p >= 6 ? 2 : 1,
  };
}

/** 歯列の FDI 並び（右最後方 → 左最後方） */
export function archOrder(arch, includeThird = false) {
  const last = includeThird ? 8 : 7;
  const qR = arch === 'upper' ? 1 : 4, qL = arch === 'upper' ? 2 : 3;
  const right = [], left = [];
  for (let p = last; p >= 1; p--) right.push(qR * 10 + p);
  for (let p = 1; p <= last; p++) left.push(qL * 10 + p);
  return [...right, ...left];
}

/** 1ステージあたりの移動量上限の初期値（一般的に使われる目安。症例・材料に合わせて変更） */
export const DEFAULT_LIMITS = {
  translation: 0.25, // mm（近遠心・頬舌）
  extrusion: 0.15, // mm（挺出）
  intrusion: 0.20, // mm（圧下）
  tipTorque: 2.0, // 度（傾斜・トルク）
  rotation: 2.0, // 度（捻転）
  rotationCanPre: 1.5, // 度（犬歯・小臼歯の捻転）
};

export const POSE_KEYS = ['md', 'bl', 'ext', 'tip', 'torque', 'rot'];
export const POSE_LABELS = {
  md: '近遠心 (mm, +近心)',
  bl: '頬舌 (mm, +頬側)',
  ext: '挺出/圧下 (mm, +挺出)',
  tip: 'チップ (°, +歯冠近心)',
  torque: 'トルク (°, +歯冠頬側)',
  rot: '捻転 (°, +近心頬側回転)',
};
export const zeroPose = () => ({ md: 0, bl: 0, ext: 0, tip: 0, torque: 0, rot: 0 });
