// シェル生成を別スレッドで実行する Web Worker
import { generateShell } from '../geom/shell.js';
import { writeSTL } from '../io/stl.js';

self.onmessage = (e) => {
  const { id, input, wantSTL, name } = e.data;
  try {
    const r = generateShell(input, (p, msg) => self.postMessage({ id, progress: p, msg }));
    const out = { id, done: true, positions: r.mesh.positions, indices: r.mesh.indices, check: r.check, volume: r.volume, grid: r.grid };
    const transfer = [r.mesh.positions.buffer, r.mesh.indices.buffer];
    if (wantSTL) { out.stl = writeSTL(r.mesh, name); transfer.push(out.stl); }
    self.postMessage(out, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
