// CT ボリュームのしきい値を自動で決める（多段の大津法）
//   t1: 空気 / 軟組織（皮膚表面）  t2: 軟組織 / 骨  t3: 骨 / 歯（エナメル・象牙質）

function histogram(vol, bins = 512, maxSamples = 2e6) {
  const D = vol.data;
  const step = Math.max(1, Math.floor(D.length / maxSamples));
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < D.length; i += step) { const v = D[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const H = new Float64Array(bins);
  const w = (hi - lo) / bins || 1;
  for (let i = 0; i < D.length; i += step) H[Math.min(bins - 1, Math.floor((D[i] - lo) / w))]++;
  return { H, lo, w };
}

/** 範囲 [a, b) のビンで大津のしきい値（ビン番号） */
function otsu(H, a, b) {
  let tot = 0, sum = 0;
  for (let i = a; i < b; i++) { tot += H[i]; sum += i * H[i]; }
  let wB = 0, sB = 0, best = a, bv = -1;
  for (let i = a; i < b - 1; i++) {
    wB += H[i]; sB += i * H[i];
    const wF = tot - wB;
    if (wB === 0 || wF === 0) continue;
    const mB = sB / wB, mF = (sum - sB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > bv) { bv = v; best = i + 1; }
  }
  return best;
}

export function volumeThresholds(vol) {
  const { H, lo, w } = histogram(vol);
  const n = H.length;
  const b1 = otsu(H, 0, n);
  const b2 = otsu(H, b1, n);
  const b3 = otsu(H, b2, n);
  const val = (b) => lo + b * w;
  return { skin: val(b1), bone: val(b2), teeth: val(b3) };
}
