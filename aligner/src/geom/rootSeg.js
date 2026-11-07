// CBCT からの歯の自動抽出（歯根＋歯冠）
//
// 方針（1本ずつ）
//  1) 歯の座標系（m=近心, b=頬側, z=歯軸）に沿った局所グリッドへ CBCT を再サンプリング
//  2) しきい値を自動で決める：歯冠内部（歯の明るさ）と歯根周囲のリング（骨・軟組織）の中央値の間
//  3) 歯頸線の形を初期断面として、根尖方向へ1断面ずつ追跡（スライス単位の領域拡張）
//     - 前の断面から 1 ボクセルまでしか広がらない／急に面積が増えたら拡張しない（骨への漏れ防止）
//     - 隣の歯とはボロノイ分割（歯軸までの距離が近い方）で分ける
//     - 断面内の穴（歯髄腔）は埋める。分岐（複根）はそのまま追跡される
//  4) 抽出した領域を平滑化して等値面 → 閉じた歯根メッシュ。断面の重心列から歯軸、最下端から歯根長
import { marchingTets } from './isosurface.js';
import { Mesh, taubinSmooth } from '../core/mesh.js';
import { decimate } from '../core/decimate.js';
import { add, sub, scale, dot, cross, norm, mApply, mInvRigid, pca } from '../core/vec.js';
import { sampleVolume } from '../io/dicom.js';

const median = (a) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[Math.floor(s.length / 2)]; };

/** 点と直線（点 c, 方向 d）の距離 */
const lineDist = (p, c, d) => { const v = sub(p, c); const t = dot(v, d); return Math.hypot(v[0] - d[0] * t, v[1] - d[1] * t, v[2] - d[2] * t); };

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 2D: 8近傍の膨張 */
function dilate2(m, nu, nv) {
  const o = new Uint8Array(m.length);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    if (!m[i + nu * j]) continue;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b = j + dj;
      if (a >= 0 && b >= 0 && a < nu && b < nv) o[a + nu * b] = 1;
    }
  }
  return o;
}
/** 2D: 穴埋め（外周から届かない背景を前景にする） */
function fillHoles2(m, nu, nv) {
  const reach = new Uint8Array(m.length);
  const st = [];
  const push = (i, j) => { const k = i + nu * j; if (!m[k] && !reach[k]) { reach[k] = 1; st.push(k); } };
  for (let i = 0; i < nu; i++) { push(i, 0); push(i, nv - 1); }
  for (let j = 0; j < nv; j++) { push(0, j); push(nu - 1, j); }
  while (st.length) {
    const k = st.pop(), i = k % nu, j = (k / nu) | 0;
    if (i > 0) push(i - 1, j); if (i < nu - 1) push(i + 1, j);
    if (j > 0) push(i, j - 1); if (j < nv - 1) push(i, j + 1);
  }
  for (let k = 0; k < m.length; k++) if (!m[k] && !reach[k]) m[k] = 1;
  return m;
}
/** 2D: 8連結成分のうち、ref と重なるものだけ残す。戻り値: 残した成分数 */
function keepTouching(m, ref, nu, nv) {
  const lab = new Int32Array(m.length).fill(-1);
  let keepCount = 0;
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || lab[s] >= 0) continue;
    const comp = [s]; lab[s] = s;
    let touch = false;
    for (let q = 0; q < comp.length; q++) {
      const k = comp[q], i = k % nu, j = (k / nu) | 0;
      if (ref[k]) touch = true;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= nu || b >= nv) continue;
        const kk = a + nu * b;
        if (m[kk] && lab[kk] < 0) { lab[kk] = s; comp.push(kk); }
      }
    }
    if (!touch) for (const k of comp) m[k] = 0; else keepCount++;
  }
  return keepCount;
}
const area = (m) => { let s = 0; for (let k = 0; k < m.length; k++) s += m[k]; return s; };

/**
 * @param vol        buildVolume の戻り値
 * @param M          CBCT 座標 → スキャン座標（位置合わせ行列, 4x4 列優先）
 * @param t          歯（createTooth の戻り値。初期位置）
 * @param neighbors  [{ cervical, z }]  近くの歯（隣接歯の分離に使う）
 * @param opts       { voxel, k（しきい値の位置 0..1）, threshold（手動しきい値）}
 */
export function extractRoot(vol, M, t, neighbors = [], opts = {}) {
  const h = opts.voxel ?? 0.25;
  const kThr = opts.k ?? 0.5;
  const invM = mInvRigid(M);
  const { m, b, z } = t.frame;
  const cerv = t.cervical;
  const S = (p) => sampleVolume(vol, mApply(invM, p));
  const toW = (u, v, w) => add(add(add(cerv, scale(m, u)), scale(b, v)), scale(z, w));

  // 歯頸線（局所座標）
  const marg = t.marginLoop.map((vi) => { const d = sub(t.crown.p(vi), cerv); return [dot(d, m), dot(d, b), dot(d, z)]; });
  if (marg.length < 3) return { error: '歯頸線がありません' };
  const hs = marg.map((q) => q[2]).sort((x, y) => x - y);
  const hStart = hs[Math.floor(hs.length * 0.1)] - 0.3;
  const R = Math.min(9, Math.max(t.width, t.depth) / 2 + 3);
  const lenMax = Math.min(34, (t.info?.rootLength ?? 14) * 1.9);
  const nu = Math.ceil((2 * R) / h) + 1, nv = nu;
  const nw = Math.ceil((lenMax + hStart + 2) / h) + 1;
  const u0 = -R, v0 = -R;
  const nSl = nu * nv;

  // ---- しきい値 ----
  const tooth = [], low = [];
  for (let hh = 1; hh <= Math.max(1.5, t.crownHeight - 1.2); hh += 0.4) {
    for (const [du, dv] of [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]]) tooth.push(S(toW(du, dv, hh)));
  }
  const ringR = Math.max(t.width, t.depth) / 2 + 2.5;
  for (let d = 3; d <= 9; d += 1.5) for (let a = 0; a < 24; a++) {
    const th = (a / 24) * Math.PI * 2;
    low.push(S(toW(ringR * Math.cos(th), ringR * Math.sin(th), hStart - d)));
  }
  const iTooth = median(tooth), iLow = median(low);
  if (!(iTooth - iLow > 150)) return { error: `歯と周囲のコントラストが不足しています（歯 ${iTooth.toFixed(0)} / 周囲 ${iLow.toFixed(0)}）。位置合わせを確認してください`, iTooth, iLow };
  const T = opts.threshold ?? iLow + kThr * (iTooth - iLow);

  // ---- 再サンプリングと隣接歯の分離 ----
  const nb = neighbors.filter((n) => Math.hypot(...sub(n.cervical, cerv)) < 16);
  /** 高さ w の断面を再サンプリング（隣の歯側はボロノイ分割で除外） */
  const sampleSlice = (w) => {
    const Is = new Float32Array(nSl), As = new Uint8Array(nSl);
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const u = u0 + i * h, v = v0 + j * h;
      if (u * u + v * v > R * R) continue;
      const p = toW(u, v, w);
      const dOwn = Math.hypot(u, v);
      let ok = true;
      for (const n of nb) if (lineDist(p, n.cervical, n.z) < dOwn) { ok = false; break; }
      if (!ok) continue;
      As[i + nu * j] = 1; Is[i + nu * j] = S(p);
    }
    return { Is, As };
  };
  const I = new Float32Array(nSl * nw);
  const allowed = new Uint8Array(nSl * nw);
  for (let k = 0; k < nw; k++) {
    const w = hStart - k * h;
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const u = u0 + i * h, v = v0 + j * h;
      if (u * u + v * v > R * R) continue;
      const p = toW(u, v, w);
      const id = i + nu * j + nSl * k;
      const dOwn = Math.hypot(u, v);
      let ok = true;
      for (const n of nb) if (lineDist(p, n.cervical, n.z) < dOwn) { ok = false; break; }
      if (!ok) continue;
      allowed[id] = 1;
      I[id] = S(p);
    }
  }

  // ---- 初期断面：歯頸線の内側 ----
  const cu = marg.reduce((s, q) => s + q[0], 0) / marg.length, cv = marg.reduce((s, q) => s + q[1], 0) / marg.length;
  const poly = marg.map((q) => [cu + (q[0] - cu) * 0.85, cv + (q[1] - cv) * 0.85]);
  const mask = new Uint8Array(nSl * nw);
  let prev = new Uint8Array(nSl);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const k = i + nu * j;
    if (allowed[k] && I[k] > T && pointInPoly(u0 + i * h, v0 + j * h, poly)) prev[k] = 1;
  }
  fillHoles2(prev, nu, nv);
  let prevArea = area(prev);
  if (prevArea < 8) return { error: '歯頸部で歯の領域が見つかりません（しきい値または位置合わせを確認）', iTooth, iLow, threshold: T };
  mask.set(prev, 0);
  const centroids = [];
  let last = 0, maxRoots = 1;
  const rootsAt = [];
  // 断面ごとに「歯根の明るさ」と「周囲（骨）の明るさ」を測ってしきい値を決める（深さで骨の濃さが変わるため）
  const Tfloor = iLow + 0.2 * (iTooth - iLow);
  const smooth2 = (src) => {
    const o = new Float32Array(nSl);
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      let s0 = 0, c0 = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, b2 = j + dj;
        if (a < 0 || b2 < 0 || a >= nu || b2 >= nv) continue;
        s0 += src[a + nu * b2]; c0++;
      }
      o[i + nu * j] = s0 / c0;
    }
    return o;
  };
  const medianOf = (vals) => { if (!vals.length) return NaN; vals.sort((x, y) => x - y); return vals[vals.length >> 1]; };
  for (let k = 1; k < nw; k++) {
    const off = nSl * k;
    const Iv = smooth2(I.subarray(off, off + nSl));
    const grow = dilate2(prev, nu, nv);
    const ringOuter = dilate2(dilate2(dilate2(prev, nu, nv), nu, nv), nu, nv);
    const inV = [], outV = [];
    for (let q = 0; q < nSl; q++) {
      if (!allowed[off + q]) continue;
      if (prev[q]) inV.push(Iv[q]); else if (ringOuter[q] && !grow[q]) outV.push(Iv[q]);
    }
    const inside = medianOf(inV), outside = medianOf(outV);
    // 歯根と周囲の差がなくなったら根尖とみなす
    if (!(inside - outside > 0.12 * (iTooth - iLow))) break;
    let Tk = Math.max(Tfloor, outside + kThr * (inside - outside));
    let cur, a;
    const make = () => {
      cur = new Uint8Array(nSl);
      for (let q = 0; q < nSl; q++) cur[q] = grow[q] && allowed[off + q] && Iv[q] > Tk ? 1 : 0;
      keepTouching(cur, prev, nu, nv);
      fillHoles2(cur, nu, nv);
      a = area(cur);
    };
    make();
    // 急に広がるのは骨への漏れ：しきい値を少しずつ上げて抑える（根が横へ開く動きは残す）
    for (let tries = 0; tries < 6 && a > prevArea * 1.15 + 3; tries++) { Tk += 0.1 * (inside - outside); make(); }
    if (a > prevArea * 1.15 + 3) { for (let q = 0; q < nSl; q++) cur[q] = cur[q] && prev[q]; a = area(cur); }
    if (a < 3) break;
    const comps = keepTouching(cur, cur, nu, nv);
    rootsAt.push(comps);
    mask.set(cur, off);
    let su = 0, sv = 0;
    for (let q = 0; q < nSl; q++) if (cur[q]) { su += u0 + (q % nu) * h; sv += v0 + ((q / nu) | 0) * h; }
    centroids.push({ p: [su / a, sv / a, hStart - k * h], a });
    prev = cur; prevArea = a; last = k;
  }
  if (last * h < 3) return { error: '歯根を追跡できませんでした（3 mm 未満で途切れました）', iTooth, iLow, threshold: T };
  // 複根の数：3 断面以上続いた最大の成分数
  for (let q = 0; q + 2 < rootsAt.length; q++) maxRoots = Math.max(maxRoots, Math.min(rootsAt[q], rootsAt[q + 1], rootsAt[q + 2]));

  // ---- 歯冠方向へもたどる（CT の歯冠） ----
  const crownTop = Math.max(t.crownHeight || 0, 6) + 1.0;
  const upMasks = [];
  {
    let pu = mask.slice(0, nSl);
    const area0 = area(pu);
    for (let w = hStart + h; w <= crownTop; w += h) {
      const { Is, As } = sampleSlice(w);
      const grow = dilate2(pu, nu, nv);
      const cur = new Uint8Array(nSl);
      for (let q = 0; q < nSl; q++) cur[q] = grow[q] && As[q] && Is[q] > T ? 1 : 0;
      keepTouching(cur, pu, nu, nv);
      fillHoles2(cur, nu, nv);
      const a2 = area(cur);
      if (a2 < 3 || a2 > area0 * 4 + 20) break; // 途切れた／対合歯や隣へ漏れた
      upMasks.push(cur); pu = cur;
    }
  }

  // ---- メッシュ化（1ボクセルぼかして 0.5 の等値面） ----
  // slices: 上から順の断面マスク、wTop: 先頭の高さ
  const meshFrom = (slices, wTop, dec = true) => {
    const pad = 2, n = slices.length;
    const gu = nu + 2 * pad, gv = nv + 2 * pad, gw = n + 2 * pad;
    const F = new Float32Array(gu * gv * gw).fill(0.5);
    const at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nu || j >= nv || k >= n ? 0 : slices[k][i + nu * j]);
    for (let k = 0; k < gw; k++) for (let j = 0; j < gv; j++) for (let i = 0; i < gu; i++) {
      const ii = i - pad, jj = j - pad, kk = k - pad;
      let s0 = 0;
      for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s0 += at(ii + di, jj + dj, kk + dk);
      F[i + gu * (j + gv * k)] = 0.5 - s0 / 27 + 1e-4;
    }
    let ms = marchingTets(F, [gu, gv, gw], (i, j, k) => toW(u0 + (i - pad) * h, v0 + (j - pad) * h, wTop - (k - pad) * h));
    taubinSmooth(ms, 6);
    return dec ? decimate(ms, { maxError: 0.02, targetRatio: 0.05 }) : ms;
  };
  if (opts.noMesh) {
    // 歯軸・歯根長だけ欲しいとき（後で向きを合わせて抽出し直す場合）はメッシュを作らない
    const pts0 = centroids.map((c) => c.p);
    const pc0 = pca(pts0);
    let d0 = pc0.axes[0]; if (d0[2] < 0) d0 = scale(d0, -1);
    const ax0 = norm(add(add(scale(m, d0[0]), scale(b, d0[1])), scale(z, d0[2])));
    const rl0 = -(hStart - last * h), ex0 = t.info?.rootLength ?? 14;
    if (rl0 > ex0 * 1.6 || rl0 < ex0 * 0.4) return { error: `歯根の長さが不自然です（${rl0.toFixed(1)} mm）`, threshold: T };
    return { rootLength: rl0, axis: ax0, threshold: T, iTooth, iLow, tipDeg: (Math.atan2(dot(ax0, m), dot(ax0, z)) * 180) / Math.PI, torqueDeg: (Math.atan2(dot(ax0, b), dot(ax0, z)) * 180) / Math.PI };
  }
  const rootSlices = [];
  for (let k = 0; k <= last; k++) rootSlices.push(mask.subarray(nSl * k, nSl * (k + 1)));
  const mesh = meshFrom(rootSlices, hStart);
  const allSlices = [...upMasks].reverse().concat(rootSlices);
  const wTop = hStart + upMasks.length * h;
  const toothMesh = meshFrom(allSlices, wTop);
  // 歯頸部のくびれ（断面積が最小）を CT から求め、それより上を CT の歯冠とする
  const i0 = upMasks.length; // hStart の断面の位置
  let cej = i0, minA = Infinity;
  for (let i = Math.max(0, i0 - Math.round(3 / h)); i <= Math.min(allSlices.length - 1, i0 + Math.round(3 / h)); i++) {
    const a3 = area(allSlices[i]);
    if (a3 > 3 && a3 < minA) { minA = a3; cej = i; }
  }
  const crownMesh = cej > 2 ? meshFrom(allSlices.slice(0, cej + 1), wTop, false) : null; // 補正に使うので間引かない
  const cejHeight = wTop - cej * h; // 歯頸部中心からの高さ
  const crownReach = upMasks.length * h - hStart; // 歯頸部中心から CT で追えた歯冠の高さの目安

  // ---- 歯軸（断面重心の主成分）と歯根長 ----
  const pts = centroids.map((c) => c.p);
  const pc = pca(pts);
  let dl = pc.axes[0];
  if (dl[2] < 0) dl = scale(dl, -1);
  const axis = norm(add(add(scale(m, dl[0]), scale(b, dl[1])), scale(z, dl[2])));
  const rootLength = -(hStart - last * h);
  // 信頼性の確認：平均的な歯根長から大きく外れる場合は骨への漏れ・途切れとみなす
  const expect = t.info?.rootLength ?? 14;
  if (rootLength > expect * 1.6) return { error: `歯根が骨と区別できませんでした（${rootLength.toFixed(1)} mm まで伸びたため不採用）。しきい値の位置を上げて再試行してください`, iTooth, iLow, threshold: T };
  if (rootLength < expect * 0.4) return { error: `歯根を途中までしか追跡できませんでした（${rootLength.toFixed(1)} mm）。しきい値の位置を下げて再試行してください`, iTooth, iLow, threshold: T };
  return {
    mesh, toothMesh, crownMesh, cejHeight, crownReach, crownSliceCount: upMasks.length, rootLength, axis, roots: maxRoots, threshold: T, iTooth, iLow,
    tipDeg: (Math.atan2(dot(axis, m), dot(axis, z)) * 180) / Math.PI,
    torqueDeg: (Math.atan2(dot(axis, b), dot(axis, z)) * 180) / Math.PI,
  };
}

export { cross };
