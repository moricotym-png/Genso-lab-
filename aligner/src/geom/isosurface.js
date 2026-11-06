// 等値面抽出：マーチングテトラヘドラ（Kuhn 6分割）。表が小さく、隣接セル間で必ず整合するため
// 出力は閉じた多様体（グリッド境界で値が正なら水密）になる。
// f[i + nx*(j + ny*k)] < 0 が「内側」
import { Mesh } from '../core/mesh.js';

// Kuhn 分割：軸の並べ替え 6 通り
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const UNIT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const TETS = PERMS.map((p) => {
  const v = [[0, 0, 0]];
  let c = [0, 0, 0];
  for (const a of p) { c = c.slice(); c[a] += 1; v.push(c); }
  return v;
});

/**
 * @param f      Float32Array 値
 * @param dims   [nx, ny, nz]
 * @param toWorld (i, j, k) 連続インデックス → [x,y,z]
 */
export function marchingTets(f, dims, toWorld) {
  const [nx, ny, nz] = dims;
  const sxy = nx * ny;
  const edgeMap = new Map();
  const pos = [];
  const idx = [];
  const idxOf = (i, j, k) => i + nx * (j + ny * k);
  const vertexOn = (a, b) => {
    // a, b は [i,j,k]、b-a は {0,1}^3（a が小さい側）
    const d = (b[0] - a[0]) | ((b[1] - a[1]) << 1) | ((b[2] - a[2]) << 2);
    const key = idxOf(a[0], a[1], a[2]) * 7 + (d - 1);
    let id = edgeMap.get(key);
    if (id !== undefined) return id;
    const fa = f[idxOf(a[0], a[1], a[2])], fb = f[idxOf(b[0], b[1], b[2])];
    let t = fa / (fa - fb);
    if (!isFinite(t)) t = 0.5;
    t = Math.min(1 - 1e-4, Math.max(1e-4, t));
    const p = toWorld(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
    id = pos.length / 3;
    pos.push(p[0], p[1], p[2]);
    edgeMap.set(key, id);
    return id;
  };
  const corner = new Array(4);
  const val = new Float64Array(4);
  const emit = (ids, inside, outside, cs) => {
    // 向き：内側→外側を法線にする
    const P = (id) => [pos[3 * id], pos[3 * id + 1], pos[3 * id + 2]];
    const [a, b, c] = ids.map(P);
    const n = [
      (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    ];
    const ci = [0, 0, 0], co = [0, 0, 0];
    for (const q of inside) { const w = toWorld(...cs[q]); ci[0] += w[0] / inside.length; ci[1] += w[1] / inside.length; ci[2] += w[2] / inside.length; }
    for (const q of outside) { const w = toWorld(...cs[q]); co[0] += w[0] / outside.length; co[1] += w[1] / outside.length; co[2] += w[2] / outside.length; }
    const s = n[0] * (co[0] - ci[0]) + n[1] * (co[1] - ci[1]) + n[2] * (co[2] - ci[2]);
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) return;
    if (s >= 0) idx.push(ids[0], ids[1], ids[2]); else idx.push(ids[0], ids[2], ids[1]);
  };
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const o = i + nx * j + sxy * k;
        // 8隅すべて同符号ならスキップ
        const v0 = f[o] < 0, v1 = f[o + 1] < 0, v2 = f[o + nx] < 0, v3 = f[o + nx + 1] < 0;
        const v4 = f[o + sxy] < 0, v5 = f[o + sxy + 1] < 0, v6 = f[o + sxy + nx] < 0, v7 = f[o + sxy + nx + 1] < 0;
        const cnt = v0 + v1 + v2 + v3 + v4 + v5 + v6 + v7;
        if (cnt === 0 || cnt === 8) continue;
        for (const tet of TETS) {
          const cs = tet.map((c) => [i + c[0], j + c[1], k + c[2]]);
          const ins = [], outs = [];
          for (let q = 0; q < 4; q++) {
            val[q] = f[idxOf(cs[q][0], cs[q][1], cs[q][2])];
            (val[q] < 0 ? ins : outs).push(q);
          }
          if (ins.length === 0 || ins.length === 4) continue;
          // 辺の頂点：tet の頂点は経路順に並ぶので、番号の小さい方が a
          const E = (p, q) => (p < q ? vertexOn(cs[p], cs[q]) : vertexOn(cs[q], cs[p]));
          if (ins.length === 1 || ins.length === 3) {
            const lone = ins.length === 1 ? ins[0] : outs[0];
            const others = [0, 1, 2, 3].filter((q) => q !== lone);
            emit(others.map((q) => E(lone, q)), ins, outs, cs);
          } else {
            const [a, b] = ins, [c, d] = outs;
            const ac = E(a, c), ad = E(a, d), bd = E(b, d), bc = E(b, c);
            emit([ac, ad, bd], ins, outs, cs);
            emit([ac, bd, bc], ins, outs, cs);
          }
        }
      }
    }
  }
  return new Mesh(Float32Array.from(pos), Uint32Array.from(idx));
}

/**
 * ボリューム（CT）から等値面を作る（表示・位置合わせ用）。step で間引き。
 */
export function volumeIsosurface(vol, threshold, step = 2, toWorldIndex) {
  const [nx, ny, nz] = vol.dims;
  const mx = Math.floor((nx - 1) / step) + 3, my = Math.floor((ny - 1) / step) + 3, mz = Math.floor((nz - 1) / step) + 3;
  const f = new Float32Array(mx * my * mz).fill(1);
  const D = vol.data;
  for (let k = 1; k < mz - 1; k++) for (let j = 1; j < my - 1; j++) for (let i = 1; i < mx - 1; i++) {
    const ii = Math.min(nx - 1, (i - 1) * step), jj = Math.min(ny - 1, (j - 1) * step), kk = Math.min(nz - 1, (k - 1) * step);
    const v = D[ii + nx * (jj + ny * kk)];
    f[i + mx * (j + my * k)] = threshold - v + 0.01;
  }
  return marchingTets(f, [mx, my, mz], (i, j, k) => toWorldIndex((i - 1) * step, (j - 1) * step, (k - 1) * step));
}
