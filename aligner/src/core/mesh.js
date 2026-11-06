// インデックス付き三角形メッシュ（three.js 非依存）
// positions: Float32Array(3*nv), indices: Uint32Array(3*nf)

export class Mesh {
  constructor(positions, indices) {
    this.positions = positions;
    this.indices = indices;
    this._adj = null;
    this._normals = null;
  }
  get nv() { return this.positions.length / 3; }
  get nf() { return this.indices.length / 3; }
  p(i) { const P = this.positions; return [P[3 * i], P[3 * i + 1], P[3 * i + 2]]; }

  clone() { return new Mesh(this.positions.slice(), this.indices.slice()); }

  bbox() {
    const P = this.positions;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (P[i + k] < mn[k]) mn[k] = P[i + k];
        if (P[i + k] > mx[k]) mx[k] = P[i + k];
      }
    }
    return { min: mn, max: mx };
  }

  /** 頂点隣接（CSR形式） */
  adjacency() {
    if (this._adj) return this._adj;
    const nv = this.nv, I = this.indices;
    const deg = new Uint32Array(nv + 1);
    for (let f = 0; f < I.length; f += 3) {
      deg[I[f]] += 2; deg[I[f + 1]] += 2; deg[I[f + 2]] += 2;
    }
    const off = new Uint32Array(nv + 1);
    for (let i = 0; i < nv; i++) off[i + 1] = off[i] + deg[i];
    const tmp = new Uint32Array(off[nv]);
    const cur = off.slice(0, nv);
    for (let f = 0; f < I.length; f += 3) {
      const a = I[f], b = I[f + 1], c = I[f + 2];
      tmp[cur[a]++] = b; tmp[cur[a]++] = c;
      tmp[cur[b]++] = a; tmp[cur[b]++] = c;
      tmp[cur[c]++] = a; tmp[cur[c]++] = b;
    }
    // 重複除去
    const off2 = new Uint32Array(nv + 1);
    const out = [];
    for (let i = 0; i < nv; i++) {
      const s = new Set();
      for (let k = off[i]; k < off[i + 1]; k++) s.add(tmp[k]);
      off2[i] = out.length;
      for (const v of s) out.push(v);
    }
    off2[nv] = out.length;
    this._adj = { off: off2, nbr: Uint32Array.from(out) };
    return this._adj;
  }

  /** 頂点→面（CSR） */
  vertexFaces() {
    if (this._vf) return this._vf;
    const nv = this.nv, I = this.indices;
    const cnt = new Uint32Array(nv + 1);
    for (let k = 0; k < I.length; k++) cnt[I[k] + 1]++;
    for (let i = 0; i < nv; i++) cnt[i + 1] += cnt[i];
    const cur = cnt.slice(0, nv);
    const faces = new Uint32Array(I.length);
    for (let k = 0; k < I.length; k++) faces[cur[I[k]]++] = (k / 3) | 0;
    this._vf = { off: cnt, faces };
    return this._vf;
  }

  faceNormal(f) {
    const I = this.indices, P = this.positions;
    const a = I[3 * f] * 3, b = I[3 * f + 1] * 3, c = I[3 * f + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]; // 面積×2 の重み付き
  }

  vertexNormals() {
    if (this._normals) return this._normals;
    const N = new Float32Array(this.positions.length);
    const I = this.indices;
    for (let f = 0; f < this.nf; f++) {
      const n = this.faceNormal(f);
      for (let k = 0; k < 3; k++) {
        const v = I[3 * f + k] * 3;
        N[v] += n[0]; N[v + 1] += n[1]; N[v + 2] += n[2];
      }
    }
    for (let i = 0; i < N.length; i += 3) {
      const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
      N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
    }
    this._normals = N;
    return N;
  }

  invalidate() { this._normals = null; }

  /** 頂点ごとの曲率の目安（正=凸, 負=凹） */
  curvature(smoothIter = 2) {
    const { off, nbr } = this.adjacency();
    const N = this.vertexNormals(), P = this.positions;
    const nv = this.nv;
    let K = new Float32Array(nv);
    for (let i = 0; i < nv; i++) {
      let s = 0, c = 0;
      for (let k = off[i]; k < off[i + 1]; k++) {
        const j = nbr[k];
        const dx = P[3 * j] - P[3 * i], dy = P[3 * j + 1] - P[3 * i + 1], dz = P[3 * j + 2] - P[3 * i + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-12) continue;
        const dn = (N[3 * j] - N[3 * i]) * dx + (N[3 * j + 1] - N[3 * i + 1]) * dy + (N[3 * j + 2] - N[3 * i + 2]) * dz;
        s += dn / d2; c++;
      }
      K[i] = c ? s / c : 0;
    }
    for (let it = 0; it < smoothIter; it++) {
      const K2 = new Float32Array(nv);
      for (let i = 0; i < nv; i++) {
        let s = K[i], c = 1;
        for (let k = off[i]; k < off[i + 1]; k++) { s += K[nbr[k]]; c++; }
        K2[i] = s / c;
      }
      K = K2;
    }
    return K;
  }

  /** 境界辺（向き付き a→b、その辺を持つ面は1枚だけ）を返す */
  boundaryHalfEdges(faceMask = null) {
    const I = this.indices;
    const map = new Map();
    const key = (a, b) => a * 4294967296 + b;
    for (let f = 0; f < this.nf; f++) {
      if (faceMask && !faceMask[f]) continue;
      for (let k = 0; k < 3; k++) {
        const a = I[3 * f + k], b = I[3 * f + ((k + 1) % 3)];
        map.set(key(a, b), [a, b]);
      }
    }
    const out = [];
    for (const [k, e] of map) {
      if (!map.has(key(e[1], e[0]))) out.push(e);
    }
    return out;
  }

  /** 境界ループ（頂点列、面の向きに沿う）を長い順に返す。辺単位でたどるので「8の字」の頂点でも途切れない */
  boundaryLoops(faceMask = null) {
    const edges = this.boundaryHalfEdges(faceMask);
    const next = new Map();
    for (const [a, b] of edges) {
      if (!next.has(a)) next.set(a, []);
      next.get(a).push(b);
    }
    const loops = [];
    for (const [a0] of edges) {
      const out0 = next.get(a0);
      if (!out0 || !out0.length) continue;
      const loop = [];
      let a = a0, guard = 0;
      while (guard++ < 1e7) {
        const nx = next.get(a);
        if (!nx || !nx.length) break;
        const b = nx.pop();
        loop.push(a);
        a = b;
        if (a === a0) break;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    loops.sort((x, y) => y.length - x.length);
    return loops;
  }

  /** 面マスクで部分メッシュを取り出す（頂点を詰め直す）。map: 新→旧 */
  submesh(faceMask) {
    const I = this.indices, P = this.positions;
    const remap = new Int32Array(this.nv).fill(-1);
    const newIdx = [];
    const old = [];
    for (let f = 0; f < this.nf; f++) {
      if (!faceMask[f]) continue;
      for (let k = 0; k < 3; k++) {
        const v = I[3 * f + k];
        if (remap[v] < 0) { remap[v] = old.length; old.push(v); }
        newIdx.push(remap[v]);
      }
    }
    const pos = new Float32Array(old.length * 3);
    old.forEach((v, i) => { pos[3 * i] = P[3 * v]; pos[3 * i + 1] = P[3 * v + 1]; pos[3 * i + 2] = P[3 * v + 2]; });
    const m = new Mesh(pos, Uint32Array.from(newIdx));
    m.fromOld = Uint32Array.from(old);
    m.toNew = remap;
    return m;
  }

  /** 4x4（列優先）で変換した新しいメッシュ */
  transformed(M) {
    const P = this.positions, out = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      out[i] = M[0] * x + M[4] * y + M[8] * z + M[12];
      out[i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
      out[i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
    }
    return new Mesh(out, this.indices.slice());
  }

  volume() {
    const I = this.indices, P = this.positions;
    let v = 0;
    for (let f = 0; f < I.length; f += 3) {
      const a = I[f] * 3, b = I[f + 1] * 3, c = I[f + 2] * 3;
      v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
        - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
        + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
    }
    return v / 6;
  }

  area() {
    let s = 0;
    for (let f = 0; f < this.nf; f++) { const n = this.faceNormal(f); s += Math.hypot(n[0], n[1], n[2]) / 2; }
    return s;
  }
}

/** 複数メッシュを1つに結合 */
export function mergeMeshes(meshes) {
  let nv = 0, ni = 0;
  for (const m of meshes) { nv += m.positions.length; ni += m.indices.length; }
  const P = new Float32Array(nv), I = new Uint32Array(ni);
  let po = 0, io = 0;
  for (const m of meshes) {
    P.set(m.positions, po);
    const base = po / 3;
    for (let k = 0; k < m.indices.length; k++) I[io + k] = m.indices[k] + base;
    po += m.positions.length; io += m.indices.length;
  }
  return new Mesh(P, I);
}

/** 三角形スープ（9 floats / 面）を頂点溶接してインデックスメッシュにする */
export function weldSoup(soup, tol = 1e-4) {
  const inv = 1 / tol;
  const map = new Map();
  const pos = [];
  const nf = soup.length / 9;
  const idx = new Uint32Array(nf * 3);
  let w = 0;
  const tri = [0, 0, 0];
  let kept = 0;
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const x = soup[9 * f + 3 * k], y = soup[9 * f + 3 * k + 1], z = soup[9 * f + 3 * k + 2];
      const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
      let id = map.get(key);
      if (id === undefined) { id = pos.length / 3; map.set(key, id); pos.push(x, y, z); }
      tri[k] = id;
    }
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue; // 退化三角形を除去
    idx[w++] = tri[0]; idx[w++] = tri[1]; idx[w++] = tri[2];
    kept++;
  }
  return new Mesh(Float32Array.from(pos), idx.slice(0, w));
}

/** 閉じた多様体かどうか（全辺がちょうど2面で共有、向きが一貫） */
export function checkWatertight(mesh) {
  const I = mesh.indices;
  const map = new Map();
  const key = (a, b) => a * 4294967296 + b;
  let dup = 0;
  for (let f = 0; f < mesh.nf; f++) {
    for (let k = 0; k < 3; k++) {
      const a = I[3 * f + k], b = I[3 * f + ((k + 1) % 3)];
      const kk = key(a, b);
      if (map.has(kk)) dup++;
      map.set(kk, (map.get(kk) || 0) + 1);
    }
  }
  let open = 0;
  for (const [kk] of map) {
    const a = Math.floor(kk / 4294967296), b = kk % 4294967296;
    if (!map.has(key(b, a))) open++;
  }
  return { watertight: open === 0 && dup === 0, openEdges: open, nonManifoldEdges: dup };
}

/** 連結成分ごとに面を分ける。戻り値: 各面の成分番号と成分数 */
export function faceComponents(mesh) {
  const vf = mesh.vertexFaces();
  const I = mesh.indices;
  const comp = new Int32Array(mesh.nf).fill(-1);
  let n = 0;
  const stack = [];
  for (let f0 = 0; f0 < mesh.nf; f0++) {
    if (comp[f0] >= 0) continue;
    comp[f0] = n; stack.push(f0);
    while (stack.length) {
      const f = stack.pop();
      for (let k = 0; k < 3; k++) {
        const v = I[3 * f + k];
        for (let q = vf.off[v]; q < vf.off[v + 1]; q++) {
          const g = vf.faces[q];
          if (comp[g] < 0) { comp[g] = n; stack.push(g); }
        }
      }
    }
    n++;
  }
  return { comp, count: n };
}

/** Taubin 平滑化（体積の縮みを抑える） */
export function taubinSmooth(mesh, iterations = 5, lambda = 0.5, mu = -0.53, fixed = null) {
  const { off, nbr } = mesh.adjacency();
  const P = mesh.positions;
  const nv = mesh.nv;
  const tmp = new Float32Array(P.length);
  const step = (f) => {
    for (let i = 0; i < nv; i++) {
      const s = off[i], e = off[i + 1];
      if ((fixed && fixed[i]) || e === s) { tmp[3 * i] = P[3 * i]; tmp[3 * i + 1] = P[3 * i + 1]; tmp[3 * i + 2] = P[3 * i + 2]; continue; }
      let x = 0, y = 0, z = 0;
      for (let k = s; k < e; k++) { const j = nbr[k]; x += P[3 * j]; y += P[3 * j + 1]; z += P[3 * j + 2]; }
      const c = e - s;
      tmp[3 * i] = P[3 * i] + f * (x / c - P[3 * i]);
      tmp[3 * i + 1] = P[3 * i + 1] + f * (y / c - P[3 * i + 1]);
      tmp[3 * i + 2] = P[3 * i + 2] + f * (z / c - P[3 * i + 2]);
    }
    P.set(tmp);
  };
  for (let it = 0; it < iterations; it++) { step(lambda); step(mu); }
  mesh.invalidate();
  return mesh;
}
