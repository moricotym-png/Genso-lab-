// デモ症例：叢生のある上下顎の「口腔内スキャン風」メッシュを合成する（実データなしで全工程を試すため）
// 高さ場 z = max(歯肉の堤, 各歯冠のふくらみ) を三角形化。歯と歯肉の境界に凹みができるので分割アルゴリズムも試せる。
import { Mesh } from '../core/mesh.js';
import { archOrder, toothInfo, positionOf } from '../plan/teeth.js';
import { ArchCurve } from '../plan/archform.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** 1顎分の高さ場メッシュと、各歯の頂点シード位置 */
export function makeDemoJaw(jaw, opts = {}) {
  const res = opts.res ?? 0.3;
  const rand = rng(jaw === 'upper' ? 7 : 3);
  const order = archOrder(jaw);
  const scaleW = jaw === 'upper' ? 1 : 0.98;
  // 歯列弓（y=前方、x=左右）
  const curve = jaw === 'upper' ? new ArchCurve(0, -0.034, -0.000012) : new ArchCurve(-1.5, -0.04, -0.000016);
  // 歯の配置：正中から弧長で並べ、叢生のぶんだけ前歯に乱れを与える
  const teeth = [];
  for (const side of [-1, 1]) {
    let s = 0;
    const list = order.filter((f) => (side < 0 ? Math.floor(f / 10) % 2 === 1 : Math.floor(f / 10) % 2 === 0));
    list.sort((a, b) => positionOf(a) - positionOf(b));
    for (const fdi of list) {
      const info = toothInfo(fdi);
      const w = info.crownWidth * scaleW;
      const crowd = positionOf(fdi) <= 3 ? 0.88 : 0.97; // 前歯は詰まって並ぶ（叢生）
      const sc = s + (w / 2) * crowd;
      s += w * crowd;
      const x = curve.xAtArc(side * sc);
      const p = positionOf(fdi);
      const jit = p <= 3 ? 1 : 0.3;
      teeth.push({
        fdi, info, w, x, y: curve.y(x),
        rot: (rand() - 0.5) * 30 * jit, // 捻転（度）
        bl: (rand() - 0.5) * 2.2 * jit, // 唇舌的なずれ
        dz: (rand() - 0.5) * 1.0 * jit, // 高さのずれ
      });
    }
  }
  const xmax = 32, ymin = -42, ymax = 12;
  const nx = Math.round((2 * xmax) / res) + 1, ny = Math.round((ymax - ymin) / res) + 1;
  const Z = new Float32Array(nx * ny);
  const keep = new Uint8Array(nx * ny);
  const seeds = new Map();
  // 歯の局所座標
  const tframes = teeth.map((t) => {
    const tg = curve.tangent(t.x), nm = curve.normal(t.x);
    const a = (t.rot * Math.PI) / 180;
    const m = [tg[0] * Math.cos(a) - tg[1] * Math.sin(a), tg[0] * Math.sin(a) + tg[1] * Math.cos(a)];
    const cx = t.x + nm[0] * t.bl, cy = t.y + nm[1] * t.bl;
    const type = t.info.type;
    const depth = type === 'incisor' ? (jaw === 'upper' ? 7 : 6) : type === 'canine' ? 8 : type === 'premolar' ? 8.5 : 10.5;
    const H = type === 'incisor' ? 9 : type === 'canine' ? 9.5 : type === 'premolar' ? 7.5 : 6.5;
    return { ...t, m, cx, cy, depth, H };
  });
  for (let j = 0; j < ny; j++) {
    const y = ymin + j * res;
    for (let i = 0; i < nx; i++) {
      const x = -xmax + i * res;
      // 歯列弓までの距離（粗い探索）
      let dmin = Infinity, xb = 0;
      for (let q = -32; q <= 32; q += 0.5) {
        const d = Math.hypot(x - q, y - curve.y(q));
        if (d < dmin) { dmin = d; xb = q; }
      }
      if (dmin > 11 || curve.y(xb) < -40) continue;
      keep[i + nx * j] = 1;
      // 歯肉の堤（歯列弓上が高い）
      let z = 1.5 * Math.exp(-(dmin * dmin) / (2 * 4.5 * 4.5)) - 0.04 * dmin * dmin;
      for (const t of tframes) {
        const dx = x - t.cx, dy = y - t.cy;
        const u = dx * t.m[0] + dy * t.m[1];
        const v = -dx * t.m[1] + dy * t.m[0];
        const a = t.w / 2, b = t.depth / 2;
        const r = Math.pow(Math.abs(u / a) ** 2.6 + Math.abs(v / b) ** 2.6, 1 / 2.6);
        if (r >= 1) continue;
        let h = t.H * Math.pow(1 - r ** 3, 0.6) + 0.4 + t.dz;
        if (t.info.type === 'incisor') h -= 2.2 * Math.abs(v / b) ** 1.5; // 切縁を薄く
        if (t.info.type === 'molar' || t.info.type === 'premolar') {
          const cusp = Math.cos((u / a) * Math.PI * (t.info.type === 'molar' ? 1 : 0.5)) * Math.cos((v / b) * Math.PI);
          h += 0.7 * cusp * (1 - r);
        }
        if (h > z) z = h;
      }
      Z[i + nx * j] = z;
    }
  }
  // 三角形化
  const id = new Int32Array(nx * ny).fill(-1);
  const P = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = i + nx * j;
    if (!keep[k]) continue;
    id[k] = P.length / 3;
    P.push(-xmax + i * res, ymin + j * res, Z[k]);
  }
  const I = [];
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = id[i + nx * j], b = id[i + 1 + nx * j], c = id[i + nx * (j + 1)], d = id[i + 1 + nx * (j + 1)];
    if (a < 0 || b < 0 || c < 0 || d < 0) continue;
    I.push(a, b, d, a, d, c);
  }
  let pos = Float32Array.from(P);
  let idx = Uint32Array.from(I);
  // 上顎：上下反転して咬合位に置く（前方へオーバージェット分ずらす）
  if (jaw === 'upper') {
    for (let k = 0; k < pos.length; k += 3) { pos[k + 2] = 19.5 - pos[k + 2]; pos[k + 1] += 3.0; }
    for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
  }
  const mesh = new Mesh(pos, idx);
  // シード：各歯の中心に最も近い頂点
  for (const t of tframes) {
    let best = -1, bd = Infinity;
    const cy = t.cy + (jaw === 'upper' ? 3.0 : 0);
    for (let v = 0; v < mesh.nv; v++) {
      const d = (pos[3 * v] - t.cx) ** 2 + (pos[3 * v + 1] - cy) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    seeds.set(t.fdi, best);
  }
  return { mesh, seeds };
}

/** デモ用の側面セファロ計測点（画像なしで計測値だけ試す用、mm） */
export const DEMO_CEPH_POINTS = {
  S: [60, 60], N: [128, 72], Or: [118, 92], Po: [45, 88], A: [125, 120], B: [118, 158],
  Pog: [119, 170], Me: [112, 178], Go: [58, 150], U1E: [129, 140], U1A: [116, 112], L1E: [125, 138], L1A: [112, 163],
  ANS: [132, 112], PNS: [80, 112],
};
