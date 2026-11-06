// CT ボリュームのしきい値を自動で決める（多段の大津法）と、歯のある範囲の自動検出
//   t1: 空気 / 軟組織（皮膚表面）  t2: 軟組織 / 骨  t3: 骨 / 歯（エナメル・象牙質）
//
// 実際の CBCT では、撮影範囲（円筒）の外側が -32768 や -2000 などの「埋め値」になっていることが多く、
// そのまま大津法にかけると推定が大きく外れる。埋め値と金属のような極端な値を除いてから推定する。

/** 間引いた値のサンプル（埋め値を除く）。昇順に並べた Float32Array */
function samples(D, maxSamples = 1.5e6) {
  const step = Math.max(1, Math.floor(D.length / maxSamples));
  let mn = Infinity;
  for (let i = 0; i < D.length; i += step) if (D[i] < mn) mn = D[i];
  // 最小値が大量にある（1% 超）なら埋め値とみなして除外
  let cntMin = 0, n = 0;
  for (let i = 0; i < D.length; i += step) { n++; if (D[i] === mn) cntMin++; }
  const dropMin = cntMin > n * 0.01;
  const out = [];
  for (let i = 0; i < D.length; i += step) {
    const v = D[i];
    if (dropMin && v === mn) continue;
    if (v < -1200 && mn < -1200) continue; // 空気(-1000)より明らかに低い値も埋め値扱い
    out.push(v);
  }
  return Float32Array.from(out).sort();
}
const pct = (s, q) => s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)))];

function otsuRange(sorted, a, b, bins = 256) {
  // 値の範囲 [a, b] で大津のしきい値（値で返す）
  const H = new Float64Array(bins);
  const w = (b - a) / bins || 1;
  for (const v of sorted) if (v >= a && v <= b) H[Math.min(bins - 1, Math.floor((v - a) / w))]++;
  let tot = 0, sum = 0;
  for (let i = 0; i < bins; i++) { tot += H[i]; sum += i * H[i]; }
  let wB = 0, sB = 0, best = 0, bv = -1;
  for (let i = 0; i < bins - 1; i++) {
    wB += H[i]; sB += i * H[i];
    const wF = tot - wB;
    if (wB === 0 || wF === 0) continue;
    const v = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (v > bv) { bv = v; best = i + 1; }
  }
  return a + best * w;
}

function thresholdsFromSamples(s) {
  const lo = pct(s, 0.001), hi = pct(s, 0.9999); // 金属などの極端な値は上限で切る
  const t1 = otsuRange(s, lo, hi);
  const t2 = otsuRange(s, t1, hi);
  const t3 = otsuRange(s, t2, hi);
  // 皮膚の面は「空気の代表値」と「軟組織の代表値」の中間に置く（ノイズの影響を受けにくい）
  const medIn = (a, b) => { let i0 = 0, i1 = s.length; while (i0 < s.length && s[i0] < a) i0++; i1 = i0; while (i1 < s.length && s[i1] < b) i1++; return i1 > i0 ? s[(i0 + i1) >> 1] : (a + b) / 2; };
  const air = medIn(lo, t1), soft = medIn(t1, t2);
  return { skin: (air + soft) / 2, bone: t2, teeth: t3, max: hi };
}

export function volumeThresholds(vol) {
  return thresholdsFromSamples(samples(vol.data));
}

/**
 * 歯のある範囲を見つける：最も明るいボクセル（エナメル質・補綴物）の集まりの中心
 * 戻り値: インデックス座標の範囲 { i0,i1,j0,j1,k0,k1 }
 */
export function findDentalROI(vol, { halfMM = [42, 42, 34] } = {}) {
  const [nx, ny, nz] = vol.dims, D = vol.data;
  const s = samples(D, 1e6);
  const q = pct(s, 0.997);
  const pts = [];
  const step = Math.max(1, Math.round(Math.cbrt((nx * ny * nz) / 4e6)));
  for (let k = 0; k < nz; k += step) for (let j = 0; j < ny; j += step) for (let i = 0; i < nx; i += step) {
    if (D[i + nx * (j + ny * k)] >= q) pts.push([i, j, k]);
  }
  if (pts.length < 20) return { i0: 0, i1: nx - 1, j0: 0, j1: ny - 1, k0: 0, k1: nz - 1, found: false };
  const med = (arr, a) => { const v = arr.map((p) => p[a]).sort((x, y) => x - y); return v[v.length >> 1]; };
  let c = [med(pts, 0), med(pts, 1), med(pts, 2)];
  const sp = vol.spacing;
  // 中心の近く（半径 35mm）の点だけで中心を取り直す（耳の錐体骨など離れた高吸収域を除く）
  for (let it = 0; it < 4; it++) {
    const near = pts.filter((p) => Math.hypot((p[0] - c[0]) * sp[0], (p[1] - c[1]) * sp[1], (p[2] - c[2]) * sp[2]) < 35);
    if (near.length < 20) break;
    c = [med(near, 0), med(near, 1), med(near, 2)];
  }
  const h = halfMM.map((m, a) => Math.round(m / sp[a]));
  const clamp = (v, n) => Math.max(0, Math.min(n - 1, v));
  return {
    i0: clamp(c[0] - h[0], nx), i1: clamp(c[0] + h[0], nx),
    j0: clamp(c[1] - h[1], ny), j1: clamp(c[1] + h[1], ny),
    k0: clamp(c[2] - h[2], nz), k1: clamp(c[2] + h[2], nz),
    found: true,
  };
}

/** ボリュームの一部を切り出す（同じ座標系のまま） */
export function cropVolume(vol, r) {
  const [nx, ny] = vol.dims;
  const ox = r.i1 - r.i0 + 1, oy = r.j1 - r.j0 + 1, oz = r.k1 - r.k0 + 1;
  const data = new Int16Array(ox * oy * oz);
  for (let k = 0; k < oz; k++) for (let j = 0; j < oy; j++) {
    const src = r.i0 + nx * (r.j0 + j + ny * (r.k0 + k));
    data.set(vol.data.subarray(src, src + ox), ox * (j + oy * k));
  }
  const [a, b, c] = vol.axes, sp = vol.spacing;
  const origin = [0, 1, 2].map((q) => vol.origin[q] + a[q] * sp[0] * r.i0 + b[q] * sp[1] * r.j0 + c[q] * sp[2] * r.k0);
  return { ...vol, dims: [ox, oy, oz], data, origin };
}

/** 切り出した歯の範囲でしきい値を求め直す */
export function dentalThresholds(sub) {
  return thresholdsFromSamples(samples(sub.data));
}
