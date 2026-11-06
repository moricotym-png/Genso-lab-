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
  return { mesh, seeds, teeth: tframes, curve };
}

/** デモ用の側面セファロ計測点（画像なしで計測値だけ試す用、mm） */
export const DEMO_CEPH_POINTS = {
  S: [60, 60], N: [128, 72], Or: [118, 92], Po: [45, 88], A: [125, 120], B: [118, 158],
  Pog: [119, 170], Me: [112, 178], Go: [58, 150], U1E: [129, 140], U1A: [116, 112], L1E: [125, 138], L1A: [112, 163],
  ANS: [132, 112], PNS: [80, 112],
};

/**
 * デモ用の合成 CBCT。各歯に「真の」歯根（長さ・傾きを少し変えたもの、大臼歯は複根）を置き、
 * 歯槽骨・歯根膜腔（暗い隙間）・歯髄腔・ノイズを付ける。座標はデモのスキャンと同じ（位置合わせ不要）
 * 戻り値 { vol, truth: Map(fdi → { rootLength, tipDeg }) }
 */
export function makeDemoCBCT(jaws, opts = {}) {
  const sp = opts.spacing ?? 0.4;
  const x0 = -34, y0 = -46, z0 = -24;
  const nx = Math.round(68 / sp), ny = Math.round(66 / sp), nz = Math.round(68 / sp);
  const data = new Int16Array(nx * ny * nz).fill(-1000);
  const rand = rng(11);
  const truth = new Map();
  // 歯のモデル（顎の局所座標：z=咬合方向、歯肉の高さ ≈ 1）
  const models = [];
  for (const [jaw, d] of Object.entries(jaws)) {
    if (!d) continue;
    for (const t of d.teeth) {
      const L = t.info.rootLength * (0.9 + 0.3 * rand());
      const tip = (rand() - 0.5) * 16; // 近遠心的な傾き（度）
      const nRoots = t.info.type === 'molar' ? (jaw === 'upper' ? 3 : 2) : 1;
      truth.set(t.fdi, { rootLength: L + 1.0, tipDeg: tip, roots: nRoots });
      models.push({ jaw, t, L, tan: Math.tan((tip * Math.PI) / 180), nRoots });
    }
  }
  const toJaw = (jaw, x, y, z) => (jaw === 'upper' ? [x, y - 3.0, 19.5 - z] : [x, y, z]);
  // 歯槽骨の範囲（歯列弓からの水平距離）：列ごとに前計算
  const boneCol = { upper: new Uint8Array(nx * ny), lower: new Uint8Array(nx * ny) };
  for (const [jaw, d] of Object.entries(jaws)) {
    if (!d) continue;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const [x, y] = toJaw(jaw, x0 + i * sp, y0 + j * sp, 0);
      let dm = Infinity;
      for (let q = -32; q <= 32; q += 0.5) dm = Math.min(dm, Math.hypot(x - q, y - d.curve.y(q)));
      if (dm < 7 && d.curve.y(Math.max(-32, Math.min(32, x))) > -40) boneCol[jaw][i + nx * j] = 1;
    }
  }
  // 歯の内外：0=外, 1=歯根膜腔(0.25mm 以内), 2=象牙質, 3=歯髄, 4=エナメル
  const toothVal = (mdl, x, y, z) => {
    const t = mdl.t;
    const dx = x - t.cx, dy = y - t.cy;
    const u = dx * t.m[0] + dy * t.m[1];
    const v = -dx * t.m[1] + dy * t.m[0];
    const a = t.w / 2, b = t.depth / 2;
    if (z > 0.6) {
      const r = Math.pow(Math.abs(u / a) ** 2.6 + Math.abs(v / b) ** 2.6, 1 / 2.6);
      if (r >= 1) return 0;
      let hgt = t.H * Math.pow(1 - r ** 3, 0.6) + 0.4 + t.dz;
      if (t.info.type === 'incisor') hgt -= 2.2 * Math.abs(v / b) ** 1.5;
      return z < hgt ? (z > 1.5 ? 4 : 2) : 0;
    }
    // 歯根：深さ s∈[0,1]、軸は近遠心方向に傾く
    const dep = 0.6 - z;
    const s = dep / mdl.L;
    if (s > 1) return 0;
    let best = 0;
    for (let r = 0; r < mdl.nRoots; r++) {
      const off = mdl.nRoots === 1 ? 0 : mdl.nRoots === 2 ? (r ? 1 : -1) * a * 0.45 : [[-0.45, -0.2], [0.45, -0.2], [0, 0.45]][r][0] * a;
      const offV = mdl.nRoots === 3 ? [[-0.45, -0.2], [0.45, -0.2], [0, 0.45]][r][1] * b : 0;
      const spread = mdl.nRoots > 1 ? s * 0.35 : 0; // 根の開き
      const cu = mdl.tan * dep + off * (Math.min(1, s * 3) + spread), cvv = offV * (Math.min(1, s * 3) + spread);
      const scaleR = (mdl.nRoots > 1 ? 0.55 : 0.85) * Math.pow(1 - s, 0.7);
      const ra = a * scaleR, rb = b * scaleR * 0.95;
      if (ra < 0.05) continue;
      const q = Math.hypot((u - cu) / ra, (v - cvv) / rb);
      const pdl = 0.25 / Math.min(ra, rb);
      if (q < 0.28) best = Math.max(best, 3);
      else if (q < 1) best = Math.max(best, 2);
      else if (q < 1 + pdl) best = Math.max(best, 1);
    }
    return best;
  };
  const VAL = [0, 120, 1900, 400, 2600];
  for (let k = 0; k < nz; k++) {
    const zw = z0 + k * sp;
    for (let j = 0; j < ny; j++) {
      const yw = y0 + j * sp;
      for (let i = 0; i < nx; i++) {
        const xw = x0 + i * sp;
        let val = -1000;
        for (const jaw of ['lower', 'upper']) {
          if (!jaws[jaw]) continue;
          const [x, y, z] = toJaw(jaw, xw, yw, zw);
          if (z > 14 || z < -26) continue;
          let tv = 0;
          for (const mdl of models) {
            if (mdl.jaw !== jaw) continue;
            if (Math.abs(x - mdl.t.cx) > 8 || Math.abs(y - mdl.t.cy) > 8) continue;
            const q = toothVal(mdl, x, y, z);
            if (q > tv) tv = q;
          }
          if (tv >= 2) { val = VAL[tv]; break; }
          if (z < 0 && z > -24 && boneCol[jaw][i + nx * j]) { val = tv === 1 ? VAL[1] : 1000; break; }
          if (z < 2 && z > -26 && boneCol[jaw][i + nx * j]) val = Math.max(val, 60);
        }
        data[i + nx * (j + ny * k)] = Math.round(val + (rand() - 0.5) * 160);
      }
    }
  }
  const vol = { dims: [nx, ny, nz], data, spacing: [sp, sp, sp], origin: [x0, y0, z0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], info: { modality: 'CT', patientName: 'DEMO', downsample: 1, slices: nz } };
  return { vol, truth };
}
