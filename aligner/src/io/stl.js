// STL 読み込み（バイナリ/ASCII）と書き出し（バイナリ）
import { weldSoup } from '../core/mesh.js';

export function parseSTL(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let soup;
  const isBinary = (() => {
    if (bytes.length < 84) return false;
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === bytes.length) return true;
    const head = new TextDecoder().decode(bytes.subarray(0, Math.min(512, bytes.length)));
    return !/^\s*solid[\s\S]*facet/i.test(head);
  })();
  if (isBinary) {
    const n = dv.getUint32(80, true);
    soup = new Float32Array(n * 9);
    let o = 84;
    for (let f = 0; f < n; f++) {
      o += 12; // 法線は使わない
      for (let k = 0; k < 9; k++) { soup[f * 9 + k] = dv.getFloat32(o, true); o += 4; }
      o += 2;
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
    const vals = [];
    let m;
    while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
    soup = Float32Array.from(vals.slice(0, Math.floor(vals.length / 9) * 9));
  }
  return weldSoup(soup, 1e-4);
}

export function writeSTL(mesh, name = 'aligner') {
  const nf = mesh.nf;
  const buf = new ArrayBuffer(84 + nf * 50);
  const dv = new DataView(buf);
  const head = new TextEncoder().encode(`binary STL ${name} (units: mm)`.slice(0, 79));
  new Uint8Array(buf).set(head, 0);
  dv.setUint32(80, nf, true);
  const P = mesh.positions, I = mesh.indices;
  let o = 84;
  for (let f = 0; f < nf; f++) {
    const a = I[3 * f] * 3, b = I[3 * f + 1] * 3, c = I[3 * f + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
    o += 12;
    for (const v of [a, b, c]) {
      dv.setFloat32(o, P[v], true); dv.setFloat32(o + 4, P[v + 1], true); dv.setFloat32(o + 8, P[v + 2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true); o += 2;
  }
  return buf;
}
