// 自動排列（セットアップ）：目標の歯列弓に沿って歯を並べ、捻転・レベリング・正中・前歯トルクを補正する
import { add, sub, scale, dot, cross, norm, DEG, r3Axis, r3Mul, mApply } from '../core/vec.js';
import { ArchCurve, fitArch, templateArch } from './archform.js';
import { toArchLocal, fromArchLocal } from './arch.js';
import { positionOf, sideOf, zeroPose, toothInfo } from './teeth.js';
import { rotationToAngles, poseMatrix } from '../geom/tooth.js';
import { contactReport } from './staging.js';
import { archOrder } from './teeth.js';
const archOrderOf = (arch) => archOrder(arch.jaw, true);

export const DEFAULT_SETUP = {
  archForm: 'current', // current | ovoid | tapered | square
  expansion: 0, // 小臼歯部の片側拡大量 (mm)
  anteriorAdvance: 0, // 前歯の前方移動量 (mm)（セファロ由来のトルク変化分は自動で加算）
  keepMolars: true, // 第一・第二大臼歯は動かさない（固定源）
  leveling: true, // 咬合平面にそろえる
  correctRotation: true, // 捻転を除く
  midline: true, // 正中を合わせる
  incisorTorque: 0, // 中切歯・側切歯のトルク変化（度、+唇側）
  iprMax: 0.3, // 1接触点あたりのIPR上限（mm）
  iprFromCanine: true, // IPR は 3-3 間を優先
  closeSpaces: true, // 空隙は前歯の後退で閉じる
  maxAutoAdvance: 1.5, // 叢生解消のために自動で許す前方拡大の上限 (mm)
  levelOffsets: {}, // 歯ごとの高さオフセット（mm, +咬合側）
  keepMissingSpace: true, // 欠損部のスペースを保持（インプラント・ブリッジ用）。false なら閉じる
  lockAdvance: false, // true: 前後位置は指定値のまま（OJ 合わせ用）。残る叢生・空隙は警告で示す
};

/** 歯の位置（重心）を歯列座標で */
const localOf = (arch, p) => toArchLocal(arch.frame, p);

/** 目標歯列弓を作る */
function targetCurve(arch, opt, advance) {
  const F = arch.frame;
  const cur = F.curve;
  const teeth = [...arch.teeth.values()];
  const molars = teeth.filter((t) => positionOf(t.fdi) === 6);
  const back = molars.length ? molars : teeth.filter((t) => positionOf(t.fdi) === Math.max(...teeth.map((q) => positionOf(q.fdi))));
  const xm = back.reduce((s, t) => s + Math.abs(localOf(arch, t.centroid)[0]), 0) / back.length;
  const ym = back.reduce((s, t) => s + localOf(arch, t.centroid)[1], 0) / back.length;
  const pm = teeth.filter((t) => positionOf(t.fdi) === 5);
  const xpm = pm.length ? pm.reduce((s, t) => s + Math.abs(localOf(arch, t.centroid)[0]), 0) / pm.length : xm * 0.75;
  const base = opt.archForm === 'current' || !opt.archForm ? cur : templateArch(opt.archForm, xm, ym, cur.y(0));
  const pts = [];
  for (let i = -40; i <= 40; i++) {
    let x = (i / 40) * (xm + 4);
    let y = base.y(x);
    const a = Math.abs(x);
    // 前方移動：正中で最大、臼歯で 0
    const wAdv = opt.keepMolars ? Math.max(0, 1 - (a / xm) ** 2) ** 1.5 : 1;
    y += advance * wAdv;
    // 拡大：小臼歯で最大
    let g = a <= xpm ? a / xpm : opt.keepMolars ? Math.max(0, 1 - (a - xpm) / Math.max(1, xm - xpm)) : 1;
    x += Math.sign(x) * opt.expansion * g;
    pts.push([x, y]);
  }
  return fitArch(pts);
}

/**
 * 1顎のセットアップを計算
 * @returns { targets: Map(fdi→pose), report }
 */
export function autoSetup(arch, options = {}) {
  const opt = { ...DEFAULT_SETUP, ...options };
  const teeth = arch.teeth;
  const report = { warnings: [], ipr: [], sides: {} };
  // 前歯トルク変化による歯冠の前方移動を見込む
  const inc = [...teeth.values()].filter((t) => positionOf(t.fdi) === 1);
  let torqueAdv = 0;
  if (opt.incisorTorque && inc.length) {
    const hh = inc.reduce((s, t) => s + dot(sub(t.centroid, t.cr), t.frame.z), 0) / inc.length;
    torqueAdv = hh * Math.sin(opt.incisorTorque * DEG);
  }
  const sides = [-1, 1];
  const bySide = (s) => [...teeth.values()].filter((t) => sideOf(t.fdi) === s).sort((a, b) => positionOf(a.fdi) - positionOf(b.fdi));
  const width = (t) => t.width;
  // 欠損部の幅：同じ側で、2本の歯の間（または正中との間）に抜けている歯の標準的な歯冠幅の合計
  const quadOf = (s) => (arch.jaw === 'upper' ? (s < 0 ? 1 : 2) : (s < 0 ? 4 : 3));
  const gapWidth = (s, posFrom, posTo) => {
    if (!opt.keepMissingSpace) return 0;
    let w = 0;
    for (let p = posFrom + 1; p < posTo; p++) { const f = quadOf(s) * 10 + p; if (!teeth.has(f)) w += toothInfo(f).crownWidth; }
    return w;
  };
  const missingList = [];
  for (const s of sides) {
    const ex = bySide(s).map((t) => positionOf(t.fdi));
    const maxP = Math.max(0, ...ex);
    for (let p = 1; p < maxP; p++) if (!ex.includes(p)) missingList.push(quadOf(s) * 10 + p);
  }
  report.missing = missingList;

  // 必要量と利用可能量の差（叢生量）を計算
  const evalD = (adv) => {
    const curve = targetCurve(arch, opt, opt.anteriorAdvance + torqueAdv + adv);
    const res = {};
    for (const s of sides) {
      const list = bySide(s);
      const anchors = opt.keepMolars ? list.filter((t) => positionOf(t.fdi) >= 6) : [];
      const movable = list.filter((t) => !anchors.includes(t));
      let req = movable.reduce((a, t) => a + width(t), 0);
      const posList = movable.map((t) => positionOf(t.fdi));
      let prevP = 0;
      for (const p of posList) { req += gapWidth(s, prevP, p); prevP = p; }
      if (anchors[0]) req += gapWidth(s, prevP, positionOf(anchors[0].fdi));
      let avail = Infinity;
      if (anchors.length) {
        const a0 = anchors[0];
        const xa = localOf(arch, a0.centroid)[0];
        avail = Math.abs(curve.arcLength(xa)) - width(a0) / 2;
      }
      res[s] = { req, avail, D: avail === Infinity ? 0 : req - avail, movable, anchors };
    }
    return { curve, res };
  };
  let adv = 0;
  const ev0 = evalD(0);
  report.discrepancyBefore = { right: ev0.res[-1].D, left: ev0.res[1].D }; // 歯冠幅の合計による概算
  const iprPlan = new Map(); // "a-b" → mm（実際の接触で並べたあとに決める）
  report.torqueAdvance = torqueAdv;

  // 歯列座標の x の符号と患者の左右の対応（データから決める）
  const xSign = {};
  for (const s of sides) {
    const l = bySide(s);
    const mx = l.reduce((a, t) => a + localOf(arch, t.centroid)[0], 0);
    xSign[s] = mx === 0 ? s : Math.sign(mx);
  }
  const centrals = [...teeth.values()].filter((t) => positionOf(t.fdi) === 1);
  const iprAt = (a, b) => (a && b ? iprPlan.get(`${a.fdi}-${b.fdi}`) || 0 : 0);
  const order = archOrderOf(arch);
  const errOf = (err, a, b) => err.get(`${a.fdi}-${b.fdi}`) ?? err.get(`${b.fdi}-${a.fdi}`) ?? 0;

  /** 前後位置 adv で並べ、実際の歯冠形状で接触を詰める。残りの叢生(+)/空隙(-)を返す */
  const arrange = (advance) => {
    const e = evalD(advance);
    const curve = e.curve;
    let midX = 0;
    if (!opt.midline && centrals.length === 2) midX = (localOf(arch, centrals[0].centroid)[0] + localOf(arch, centrals[1].centroid)[0]) / 2;
    const sMid = curve.arcLength(midX);
    const targets = new Map();
    const sPos = new Map(); // 歯の中心の弧長位置（符号つき）
    for (const s of sides) {
      const { movable, anchors } = e.res[s];
      let sAcc = 0;
      movable.forEach((t, i) => {
        sAcc += gapWidth(s, i > 0 ? positionOf(movable[i - 1].fdi) : 0, positionOf(t.fdi)); // 欠損部のスペース
        const w = width(t) - iprAt(t, movable[i + 1] || anchors[0]) / 2 - (i > 0 ? iprAt(movable[i - 1], t) / 2 : 0);
        sPos.set(t.fdi, sMid + xSign[s] * (sAcc + w / 2));
        sAcc += w;
        targets.set(t.fdi, placeTooth(arch, t, curve, curve.xAtArc(sPos.get(t.fdi)), opt));
      });
      for (const t of anchors) {
        targets.set(t.fdi, opt.leveling || opt.correctRotation ? placeTooth(arch, t, curve, null, { ...opt, correctRotation: false, keepXY: true }) : zeroPose());
      }
    }
    const sPos0 = new Map(sPos);
    // 接触の詰め：隣接歯との重なり・すき間を測って弧長位置を補正（正中から遠心へ）
    let err = new Map();
    for (let it = 0; it <= (opt.contactIterations ?? 4); it++) {
      err = new Map(contactReport(arch, targets, order).map((c) => [`${c.a}-${c.b}`, c.overlap - (c.gap ?? 0)]));
      if (it === (opt.contactIterations ?? 4)) break;
      let changed = false;
      for (const s of sides) {
        const { movable } = e.res[s];
        let shift = 0;
        const c1 = movable[0], other = centrals.find((t) => t !== c1);
        if (c1 && other && positionOf(c1.fdi) === 1) shift += errOf(err, c1, other) / 2; // 正中の接触は左右で半分ずつ
        movable.forEach((t, i) => {
          if (i > 0) shift += errOf(err, movable[i - 1], t) - iprAt(movable[i - 1], t) + gapWidth(s, positionOf(movable[i - 1].fdi), positionOf(t.fdi));
          if (Math.abs(shift) > 0.02) {
            // 1回の補正量を制限（形状が特殊な歯で補正が暴走しないように）
            const st = Math.max(-3, Math.min(3, shift * 0.8));
            const base = sPos0.get(t.fdi);
            let nv = sPos.get(t.fdi) + xSign[s] * st;
            if (Math.abs(nv - base) > 8) nv = base + Math.sign(nv - base) * 8; // 最初の位置から 8mm まで
            sPos.set(t.fdi, nv);
            targets.set(t.fdi, placeTooth(arch, t, curve, curve.xAtArc(sPos.get(t.fdi)), opt));
            changed = true;
          }
        });
      }
      if (!changed) break;
    }
    // 固定源（大臼歯）との接触に残る量 = 残りの叢生(+)/空隙(-)
    const residual = {};
    for (const s of sides) {
      const { movable, anchors } = e.res[s];
      const last = movable[movable.length - 1];
      residual[s] = last && anchors[0] ? errOf(err, last, anchors[0]) - iprAt(last, anchors[0]) + gapWidth(s, positionOf(last.fdi), positionOf(anchors[0].fdi)) : 0;
    }
    return { targets, curve, residual, ev: e };
  };

  // 1) 前後位置を実際の接触にもとづいて決める（割線法）。叢生が残る場合は上限まで前方へ
  const meanR = (r) => (r.residual[-1] + r.residual[1]) / 2;
  const solveAdvance = (start, lo, hi) => {
    let best = arrange(start), bestA = start;
    let a0 = start, r0 = meanR(best);
    let a1 = Math.max(lo, Math.min(hi, start + (r0 > 0 ? 1 : -1) * Math.min(2, Math.abs(r0)) * 0.5 || 0.5));
    for (let it = 0; it < 6 && Math.abs(r0) > 0.08 && a1 !== a0; it++) {
      const res1 = arrange(a1);
      const r1 = meanR(res1);
      if (Math.abs(r1) < Math.abs(meanR(best))) { best = res1; bestA = a1; }
      const slope = (r1 - r0) / (a1 - a0);
      if (Math.abs(slope) < 1e-3) break;
      const a2 = Math.max(lo, Math.min(hi, a1 - r1 / slope));
      a0 = a1; r0 = r1; a1 = a2;
    }
    return { res: best, adv: bestA };
  };
  let res;
  if (opt.lockAdvance) res = arrange(0);
  else ({ res, adv } = solveAdvance(0, opt.closeSpaces ? -4 : 0, Math.max(0, opt.maxAutoAdvance)));
  // 2) まだ叢生が残る側は IPR で解消（3-3 間を優先、1接触あたり上限 iprMax）
  let needIpr = false;
  for (const s of sides) {
    let need = res.residual[s];
    if (need <= 0.08) continue;
    const { movable, anchors } = res.ev.res[s];
    const cs = movable.map((t, i) => [t, movable[i + 1] || anchors[0]]).filter((c) => c[1]);
    const pri = opt.iprFromCanine ? cs.filter((c) => positionOf(c[0].fdi) <= 2).concat(cs.filter((c) => positionOf(c[0].fdi) > 2)) : cs;
    for (const [x, y] of pri) {
      if (need <= 0.02) break;
      const v = Math.min(opt.iprMax, Math.ceil(need * 20) / 20);
      iprPlan.set(`${x.fdi}-${y.fdi}`, +v.toFixed(2));
      need -= v;
      needIpr = true;
    }
  }
  if (needIpr) res = arrange(adv);
  report.autoAdvance = adv;
  report.residual = { right: res.residual[-1], left: res.residual[1] };
  for (const [s, name] of [[-1, '右側'], [1, '左側']]) {
    const r = res.residual[s];
    if (r > 0.15) report.warnings.push(`${name}: 叢生が約 ${r.toFixed(1)} mm 残ります（IPR 増量・拡大・遠心移動・抜歯を検討）。`);
    else if (r < -0.15) report.warnings.push(`${name}: 大臼歯の近心に約 ${(-r).toFixed(1)} mm の空隙が残ります。`);
  }
  for (const s of sides) report.sides[s < 0 ? 'right' : 'left'] = { required: res.ev.res[s].req, available: res.ev.res[s].avail, discrepancy: res.ev.res[s].D };
  const targets = res.targets;
  const curve = res.curve;
  report.curve = curve.toJSON();
  report.contacts = contactReport(arch, targets, order);
  // 結果の妥当性チェック：ありえないほど大きな移動を知らせる
  for (const [fdi, p] of targets) {
    const tr = Math.hypot(p.md, p.bl, p.ext);
    const big = [];
    if (tr > 6) big.push(`移動 ${tr.toFixed(1)} mm`);
    if (Math.abs(p.rot) > 35) big.push(`捻転 ${p.rot.toFixed(0)}°`);
    if (Math.abs(p.tip) > 20 || Math.abs(p.torque) > 20) big.push(`傾斜 ${p.tip.toFixed(0)}°/${p.torque.toFixed(0)}°`);
    if (big.length) report.warnings.push(`${fdi}: 移動量が非常に大きい（${big.join('、')}）。歯の分割・歯番号・歯冠幅を確認してください`);
  }
  if (arch.warnings?.length) report.warnings.unshift(...arch.warnings);
  report.ipr = [...iprPlan.entries()].map(([k, v]) => ({ contact: k, mm: v }));
  return { targets, report, curve };
}

/** 1本の歯の目標姿勢 */
function placeTooth(arch, t, curve, xTarget, opt) {
  const F = arch.frame;
  const cL = localOf(arch, t.centroid);
  let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // 捻転除去：近心方向を歯列弓の接線にそろえる（咬合方向まわりの回転）
  if (opt.correctRotation && xTarget !== null) {
    const tan = curve.tangent(xTarget);
    let mT = add(scale(F.ex, tan[0]), scale(F.ey, tan[1]));
    if (xTarget > 0) mT = scale(mT, -1);
    const mCur = norm(sub(t.frame.m, scale(F.ez, dot(t.frame.m, F.ez))));
    const ang = Math.atan2(dot(cross(mCur, mT), F.ez), dot(mCur, mT));
    R = r3Axis(F.ez, ang);
  }
  // 前歯トルク（中切歯・側切歯）
  const pos = positionOf(t.fdi);
  if (opt.incisorTorque && pos <= 2) {
    const zb = t.frame.b; // トルク軸 = z × b
    const ax = norm(cross(t.frame.z, zb));
    R = r3Mul(r3Axis(ax, opt.incisorTorque * DEG), R);
  }
  const rotA = rotationToAngles(t, R);
  // 回転だけ適用したときの位置
  const M0 = poseMatrix(t, { ...zeroPose(), ...rotA });
  const cRot = localOf(arch, mApply(M0, t.centroid));
  const oRot = localOf(arch, mApply(M0, t.occlusalPoint));
  let target = cRot.slice();
  if (xTarget !== null && !opt.keepXY) { target[0] = xTarget; target[1] = curve.y(xTarget); }
  if (opt.leveling) {
    const off = (opt.levelOffsets && opt.levelOffsets[t.fdi]) || defaultLevelOffset(t.fdi);
    target[2] = cRot[2] + (off - oRot[2]);
  }
  const dW = sub(fromArchLocal(F, target), fromArchLocal(F, cRot));
  const { m, b, z } = t.frame;
  return { md: dot(dW, m), bl: dot(dW, b), ext: dot(dW, z), tip: rotA.tip, torque: rotA.torque, rot: rotA.rot };
}

/** 咬合平面からの高さの初期値：上顎側切歯は 0.5mm 短く */
export function defaultLevelOffset(fdi) {
  const p = fdi % 10, q = Math.floor(fdi / 10);
  if ((q === 1 || q === 2) && p === 2) return -0.5;
  return 0;
}

/** 切縁点（中切歯の最咬合点平均）を姿勢込みで */
export function incisalPoint(arch, poses) {
  const c = [...arch.teeth.values()].filter((t) => positionOf(t.fdi) === 1);
  if (!c.length) return null;
  let s = [0, 0, 0];
  for (const t of c) s = add(s, mApply(poseMatrix(t, poses.get(t.fdi) || zeroPose()), t.occlusalPoint));
  return scale(s, 1 / c.length);
}

/** オーバージェット・オーバーバイト（上顎の歯列座標で、切縁点どうし） */
export function overjetOverbite(upper, lower, upPoses, loPoses) {
  const u = incisalPoint(upper, upPoses), l = incisalPoint(lower, loPoses);
  if (!u || !l) return null;
  const F = upper.frame;
  const d = sub(u, l);
  return { overjet: dot(d, F.ey), overbite: dot(d, F.ez) };
}

export { ArchCurve };
