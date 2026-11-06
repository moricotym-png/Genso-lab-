// ダイレクトプリント用アライナーのシェル生成
//  1) 模型（歯＝閉じた立体、歯肉＝下側が開いたシート、アタッチメント＝閉じた立体）を咬合方向の座標系へ
//  2) 柱（咬合方向のレイ）ごとの交差の偶奇で内外判定（各グループの和集合）
//  3) 表面からの正確な距離を狭帯域で計算 → 符号付き距離
//  4) シェル = { 隙間 c ≦ 距離 ≦ c + 厚み t } ∩ { トリムラインより咬合側 }
//  5) マーチングテトラヘドラで水密メッシュ化 → 平滑化
import { marchingTets } from './isosurface.js';
import { Mesh, taubinSmooth, checkWatertight, faceComponents } from '../core/mesh.js';
import { decimate } from '../core/decimate.js';

/** 点 p と三角形 abc の距離の2乗（Ericson, Real-Time Collision Detection） */
function pointTriDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = apx - v * abx, qy = apy - v * aby, qz = apz - v * abz;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = apx - w * acx, qy = apy - w * acy, qz = apz - w * acz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const qx = px - (bx + w * (cx - bx)), qy = py - (by + w * (cy - by)), qz = pz - (bz + w * (cz - bz));
    return qx * qx + qy * qy + qz * qz;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const qx = ax + abx * v + acx * w - px, qy = ay + aby * v + acy * w - py, qz = az + abz * v + acz * w - pz;
  return qx * qx + qy * qy + qz * qz;
}

/** 1次元の二乗距離変換（Felzenszwalb & Huttenlocher） */
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; }
}
/** 3次元ユークリッド距離変換（occupied=1 のボクセル中心までの距離、ボクセル単位） */
export function edt3d(occ, nx, ny, nz) {
  const INF = 1e20;
  const g = new Float64Array(nx * ny * nz);
  for (let i = 0; i < g.length; i++) g[i] = occ[i] ? 0 : INF;
  const mx = Math.max(nx, ny, nz);
  const f = new Float64Array(mx), d = new Float64Array(mx), v = new Int32Array(mx), z = new Float64Array(mx + 1);
  const pass = (n, stride, outer) => {
    for (const base of outer) {
      for (let q = 0; q < n; q++) f[q] = g[base + q * stride];
      edt1d(f, n, d, v, z);
      for (let q = 0; q < n; q++) g[base + q * stride] = d[q];
    }
  };
  function* bases(a, b, sa, sb) { for (let j = 0; j < b; j++) for (let i = 0; i < a; i++) yield i * sa + j * sb; }
  pass(nx, 1, bases(ny, nz, nx, nx * ny));
  pass(ny, nx, bases(nx, nz, 1, nx * ny));
  pass(nz, nx * ny, bases(nx, ny, 1, nx));
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = Math.sqrt(g[i]);
  return out;
}

/**
 * @param input {
 *   groups: [{ positions: Float32Array, indices: Uint32Array }]  ワールド座標
 *   frame: { origin, ex, ey, ez }  ez = 咬合方向（アライナーの着脱方向）
 *   margins: Float32Array 3n  歯頸線の点（ワールド）
 *   teeth: [{ center:[x,y,z], thickness }]  部位別厚みの基準点
 *   params: { voxel, clearance, thickness, trimOffset, blockout, smooth, decimateError }
 * }
 */
export function generateShell(input, progress = () => {}) {
  const { groups, frame, margins, teeth } = input;
  const prm = Object.assign({ voxel: 0.2, clearance: 0.05, thickness: 0.6, trimOffset: 1.0, blockout: false, smooth: 4, decimateError: 0.01 }, input.params || {});
  const { origin: O, ex, ey, ez } = frame;
  const toL = (x, y, z) => {
    const dx = x - O[0], dy = y - O[1], dz = z - O[2];
    return [dx * ex[0] + dy * ex[1] + dz * ex[2], dx * ey[0] + dy * ey[1] + dz * ey[2], dx * ez[0] + dy * ez[1] + dz * ez[2]];
  };
  const toW = (u, v, w) => [O[0] + u * ex[0] + v * ey[0] + w * ez[0], O[1] + u * ex[1] + v * ey[1] + w * ez[1], O[2] + u * ex[2] + v * ey[2] + w * ez[2]];

  // 歯頸線（ローカル）
  const nm = margins.length / 3;
  const ML = new Float32Array(margins.length);
  for (let i = 0; i < nm; i++) { const l = toL(margins[3 * i], margins[3 * i + 1], margins[3 * i + 2]); ML.set(l, 3 * i); }
  let wMarginMin = Infinity;
  for (let i = 0; i < nm; i++) wMarginMin = Math.min(wMarginMin, ML[3 * i + 2]);
  const tMax = Math.max(prm.thickness, ...teeth.map((t) => t.thickness || 0));
  const band = prm.clearance + tMax + 2 * prm.voxel;
  const wLow = wMarginMin - prm.trimOffset - 2 * prm.voxel - 0.5;

  // 三角形をローカル座標へ（下すぎるものは除外）
  const tris = []; // 各グループ: Float32Array 9n
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity, wmax = -Infinity;
  for (const g of groups) {
    const P = g.positions, I = g.indices;
    const out = [];
    for (let f = 0; f < I.length; f += 3) {
      const a = toL(P[3 * I[f]], P[3 * I[f] + 1], P[3 * I[f] + 2]);
      const b = toL(P[3 * I[f + 1]], P[3 * I[f + 1] + 1], P[3 * I[f + 1] + 2]);
      const c = toL(P[3 * I[f + 2]], P[3 * I[f + 2] + 1], P[3 * I[f + 2] + 2]);
      out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      if (Math.max(a[2], b[2], c[2]) > wLow) {
        for (const p of [a, b, c]) {
          if (p[0] < umin) umin = p[0]; if (p[0] > umax) umax = p[0];
          if (p[1] < vmin) vmin = p[1]; if (p[1] > vmax) vmax = p[1];
          if (p[2] > wmax) wmax = p[2];
        }
      }
    }
    tris.push(Float32Array.from(out));
  }
  const h = prm.voxel;
  const pad = band + 2 * h;
  const u0 = umin - pad, v0 = vmin - pad, w0 = wLow;
  const nx = Math.ceil((umax + pad - u0) / h) + 1;
  const ny = Math.ceil((vmax + pad - v0) / h) + 1;
  const nz = Math.ceil((wmax + pad - w0) / h) + 1;
  const N = nx * ny * nz;
  if (N > 120e6) throw new Error(`ボクセル数が多すぎます (${(N / 1e6).toFixed(0)}M)。ボクセルサイズを大きくしてください。`);
  progress(0.05, `グリッド ${nx}×${ny}×${nz}`);
  const JU = 1.234567e-4, JV = 2.345678e-4; // 柱の位置を僅かにずらしてレイが辺に当たるのを防ぐ
  const colU = (i) => u0 + i * h + JU, colV = (j) => v0 + j * h + JV;
  const nCol = nx * ny;

  // ---- 1) 柱ごとの交差リスト（グループ別） ----
  const inside = new Uint8Array(N);
  const topW = new Float32Array(nCol).fill(-Infinity);
  for (let gi = 0; gi < tris.length; gi++) {
    const T = tris[gi];
    const count = new Uint32Array(nCol + 1);
    const forEachHit = (cb) => {
      for (let f = 0; f < T.length; f += 9) {
        const ax = T[f], ay = T[f + 1], bx = T[f + 3], by = T[f + 4], cx = T[f + 6], cy = T[f + 7];
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(area) < 1e-12) continue;
        const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - u0 - JU) / h));
        const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - u0 - JU) / h));
        const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - v0 - JV) / h));
        const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - v0 - JV) / h));
        for (let j = j0; j <= j1; j++) {
          const py = colV(j);
          for (let i = i0; i <= i1; i++) {
            const px = colU(i);
            const w0b = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
            const w1b = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
            const w2b = 1 - w0b - w1b;
            if (w0b < 0 || w1b < 0 || w2b < 0) continue;
            cb(i + nx * j, w0b * T[f + 2] + w1b * T[f + 5] + w2b * T[f + 8]);
          }
        }
      }
    };
    forEachHit((c) => { count[c + 1]++; });
    for (let c = 0; c < nCol; c++) count[c + 1] += count[c];
    const hits = new Float32Array(count[nCol]);
    const cur = count.slice(0, nCol);
    forEachHit((c, w) => { hits[cur[c]++] = w; });
    for (let c = 0; c < nCol; c++) {
      const s = count[c], e = count[c + 1];
      if (s === e) continue;
      const arr = Array.from(hits.subarray(s, e)).sort((a, b) => b - a); // 上から
      if (arr[0] > topW[c]) topW[c] = arr[0];
      const i = c % nx, j = (c / nx) | 0;
      let q = 0;
      for (let k = nz - 1; k >= 0; k--) {
        const w = w0 + k * h;
        while (q < arr.length && arr[q] > w) q++;
        if (q & 1) inside[i + nx * j + nCol * k] = 1;
      }
    }
    progress(0.05 + 0.15 * (gi + 1) / tris.length, '内外判定');
  }
  if (prm.blockout) {
    // アンダーカットを着脱方向に沿って完全にブロックアウト（最上面より下はすべて内側）
    for (let c = 0; c < nCol; c++) {
      if (topW[c] === -Infinity) continue;
      const i = c % nx, j = (c / nx) | 0;
      for (let k = 0; k < nz; k++) if (w0 + k * h < topW[c]) inside[i + nx * j + nCol * k] = 1;
    }
  }

  // ---- 2) 狭帯域の正確な距離 ----
  const D2 = new Float32Array(N).fill(band * band);
  for (const T of tris) {
    for (let f = 0; f < T.length; f += 9) {
      const ax = T[f], ay = T[f + 1], az = T[f + 2], bx = T[f + 3], by = T[f + 4], bz = T[f + 5], cx = T[f + 6], cy = T[f + 7], cz = T[f + 8];
      if (Math.max(az, bz, cz) < w0 - band) continue;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - band - u0) / h));
      const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) + band - u0) / h));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - band - v0) / h));
      const j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by, cy) + band - v0) / h));
      const k0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - band - w0) / h));
      const k1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) + band - w0) / h));
      if (k0 > k1) continue;
      // 平面距離による早期除外
      const nxp = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const nyp = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nzp = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const nl = Math.hypot(nxp, nyp, nzp) || 1;
      for (let k = k0; k <= k1; k++) {
        const pz = w0 + k * h;
        for (let j = j0; j <= j1; j++) {
          const py = v0 + j * h;
          for (let i = i0; i <= i1; i++) {
            const px = u0 + i * h;
            const pd = Math.abs((px - ax) * nxp + (py - ay) * nyp + (pz - az) * nzp) / nl;
            if (pd >= band) continue;
            const id = i + nx * j + nCol * k;
            if (pd * pd >= D2[id]) continue;
            const d2 = pointTriDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz);
            if (d2 < D2[id]) D2[id] = d2;
          }
        }
      }
    }
  }
  progress(0.55, '距離場');
  let edtBlocked = null;
  if (prm.blockout) edtBlocked = edt3d(inside, nx, ny, nz);

  // ---- 3) 部位別の厚みとトリム高さ（柱ごと） ----
  const thick = new Float32Array(nCol);
  const trimW = new Float32Array(nCol);
  // 歯頸線点の 2D ハッシュ
  const cell = 2.0;
  const mh = new Map();
  for (let q = 0; q < nm; q++) {
    const key = `${Math.floor(ML[3 * q] / cell)},${Math.floor(ML[3 * q + 1] / cell)}`;
    let a = mh.get(key); if (!a) { a = []; mh.set(key, a); } a.push(q);
  }
  const TL = teeth.map((t) => ({ c: toL(...t.center), t: t.thickness || prm.thickness }));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const u = u0 + i * h, v = v0 + j * h;
      // 厚み：歯の中心からの逆距離重み（4乗）で滑らかに配分
      let ws = 0, ts = 0;
      for (const t of TL) {
        const d2 = (t.c[0] - u) ** 2 + (t.c[1] - v) ** 2 + 0.01;
        const w = 1 / (d2 * d2);
        ws += w; ts += w * t.t;
      }
      thick[i + nx * j] = TL.length ? ts / ws : prm.thickness;
      // トリム：近い歯頸線点の高さのソフト最小（ガウス重み平均）
      const ci = Math.floor(u / cell), cj = Math.floor(v / cell);
      let best = Infinity, sw = 0, sh = 0;
      const cand = [];
      for (let r = 0; r <= 6 && (best === Infinity || r <= 2); r++) {
        for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const a = mh.get(`${ci + di},${cj + dj}`);
          if (!a) continue;
          for (const q of a) {
            const d2 = (ML[3 * q] - u) ** 2 + (ML[3 * q + 1] - v) ** 2;
            cand.push([d2, ML[3 * q + 2]]);
            if (d2 < best) best = d2;
          }
        }
      }
      if (best === Infinity) { trimW[i + nx * j] = 1e3; continue; }
      const sig2 = 0.8 * 0.8;
      for (const [d2, w] of cand) {
        const g = Math.exp(-(d2 - best) / (2 * sig2));
        sw += g; sh += g * w;
      }
      trimW[i + nx * j] = sh / sw - prm.trimOffset;
    }
  }
  progress(0.65, 'トリムライン');

  // ---- 4) シェルの陰関数 ----
  const F = new Float32Array(N);
  const c0 = prm.clearance;
  for (let k = 0; k < nz; k++) {
    const w = w0 + k * h;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const col = i + nx * j, id = col + nCol * k;
        if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) { F[id] = 1; continue; }
        let d = Math.sqrt(D2[id]);
        if (edtBlocked && !inside[id]) d = Math.min(d, Math.max(0, edtBlocked[id] * h - 0.5 * h));
        const sd = inside[id] ? -d : d;
        const t = thick[col];
        let fv = Math.max(c0 - sd, sd - (c0 + t));
        fv = Math.max(fv, trimW[col] - w);
        if (fv === 0) fv = 1e-6;
        F[id] = fv;
      }
    }
  }
  progress(0.7, '等値面抽出');
  let mesh = marchingTets(F, [nx, ny, nz], (i, j, k) => toW(u0 + i * h, v0 + j * h, w0 + k * h));
  // スキャンの穴などで生じた小さな破片を除去（最大成分の 2% 未満）
  {
    const { comp, count } = faceComponents(mesh);
    if (count > 1) {
      const sizes = new Uint32Array(count);
      for (let f = 0; f < comp.length; f++) sizes[comp[f]]++;
      const maxS = Math.max(...sizes);
      const keep = new Uint8Array(mesh.nf);
      for (let f = 0; f < comp.length; f++) keep[f] = sizes[comp[f]] >= maxS * 0.02 ? 1 : 0;
      const sub = mesh.submesh(keep);
      mesh = new Mesh(sub.positions, sub.indices);
    }
  }
  progress(0.9, '平滑化');
  if (prm.smooth > 0) taubinSmooth(mesh, prm.smooth);
  if (prm.decimateError > 0) {
    progress(0.93, '間引き');
    mesh = decimate(mesh, { maxError: prm.decimateError, targetRatio: 0.02 });
  }
  const check = checkWatertight(mesh);
  progress(1, '完了');
  return { mesh, check, grid: [nx, ny, nz], volume: Math.abs(mesh.volume()) };
}
