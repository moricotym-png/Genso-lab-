// ポンティック：欠損部に置くダミーの歯冠（閉じた立体）。アライナーがこの形を覆う
import { Mesh } from '../core/mesh.js';
import { add, sub, scale, dot, cross, norm } from '../core/vec.js';

const sgnPow = (v, e) => Math.sign(v) * Math.abs(v) ** e;

/**
 * 角の丸い楕円体（スーパー楕円体）の歯冠
 * center: 中心, m: 近遠心方向, z: 咬合方向, 半径 a(近遠心)・b(頬舌)・c(高さ)
 */
export function ponticMesh(center, m, z, a, b, c, segU = 24, segV = 14) {
  const zz = norm(z), mm = norm(sub(m, scale(zz, dot(m, zz))));
  const bb = cross(zz, mm);
  const e = 0.55; // 小さいほど角張る
  const P = [], I = [];
  // 両極（上・下）
  const top = add(center, scale(zz, c)), bot = sub(center, scale(zz, c));
  P.push(...top);
  for (let i = 1; i < segV; i++) {
    const th = (Math.PI * i) / segV - Math.PI / 2; // -90..90（上から下へ）
    const cz = -sgnPow(Math.sin(th), e), cr = sgnPow(Math.cos(th), e);
    for (let j = 0; j < segU; j++) {
      const ph = (2 * Math.PI * j) / segU;
      const x = a * cr * sgnPow(Math.cos(ph), e), y = b * cr * sgnPow(Math.sin(ph), e);
      const p = add(add(add(center, scale(mm, x)), scale(bb, y)), scale(zz, c * cz));
      P.push(...p);
    }
  }
  P.push(...bot);
  const ring = (i) => 1 + (i - 1) * segU;
  const last = P.length / 3 - 1;
  for (let j = 0; j < segU; j++) I.push(0, ring(1) + j, ring(1) + ((j + 1) % segU));
  for (let i = 1; i < segV - 1; i++) {
    for (let j = 0; j < segU; j++) {
      const a0 = ring(i) + j, a1 = ring(i) + ((j + 1) % segU), b0 = ring(i + 1) + j, b1 = ring(i + 1) + ((j + 1) % segU);
      I.push(a0, b0, b1, a0, b1, a1);
    }
  }
  for (let j = 0; j < segU; j++) I.push(last, ring(segV - 1) + ((j + 1) % segU), ring(segV - 1) + j);
  const mesh = new Mesh(Float32Array.from(P), Uint32Array.from(I));
  if (mesh.volume() < 0) for (let f = 0; f < I.length; f += 3) { const t = mesh.indices[f + 1]; mesh.indices[f + 1] = mesh.indices[f + 2]; mesh.indices[f + 2] = t; }
  return mesh;
}
