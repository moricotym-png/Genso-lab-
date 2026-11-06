// node --test test/  で実行
import test from 'node:test';
import assert from 'node:assert/strict';
import { Mesh, checkWatertight } from '../src/core/mesh.js';
import { r3Axis, mFromRT, mApply, DEG } from '../src/core/vec.js';
import { parseSTL, writeSTL } from '../src/io/stl.js';
import { parseDicomFile, buildVolume, writeDicomSlice, sampleVolume, volumeMatrix } from '../src/io/dicom.js';
import { makeZip, readZip } from '../src/io/zip.js';
import { parseOBJ } from '../src/io/obj.js';
import { rigidFromPairs, rmsError } from '../src/geom/register.js';
import { marchingTets } from '../src/geom/isosurface.js';
import { decimate } from '../src/core/decimate.js';
import { makeDemoJaw, DEMO_CEPH_POINTS } from '../src/demo/demoCase.js';
import { segmentTeeth } from '../src/geom/segment.js';
import { buildArch, shellInput } from '../src/plan/arch.js';
import { poseMatrix, matrixToPose } from '../src/geom/tooth.js';
import { autoSetup } from '../src/plan/setup.js';
import { autoStage, checkVelocities, poseAt, setKey } from '../src/plan/staging.js';
import { generateShell } from '../src/geom/shell.js';
import { measureCeph, cephToToothGoals } from '../src/plan/ceph.js';

const cube = () => new Mesh(
  Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]),
  Uint32Array.from([0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5]),
);

test('STL の書き出し→読み込みで形と体積が保たれる', () => {
  const m = cube();
  assert.ok(checkWatertight(m).watertight);
  assert.ok(Math.abs(m.volume() - 1) < 1e-9);
  const back = parseSTL(writeSTL(m));
  assert.equal(back.nf, 12);
  assert.equal(back.nv, 8);
  assert.ok(Math.abs(back.volume() - 1) < 1e-6);
});

test('ASCII STL を読める', () => {
  const txt = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n';
  const m = parseSTL(new TextEncoder().encode(txt).buffer);
  assert.equal(m.nf, 1);
});

test('OBJ（四角形面・UV）を三角形に分割して読む', () => {
  const o = parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nf 1/1 2/2 3/3 4/4\n');
  assert.equal(o.indices.length, 6);
  assert.ok(o.uvs);
});

test('DICOM（非圧縮）スライス列からボリュームを作り、座標で値を引ける', () => {
  const rows = 16, cols = 20, files = [];
  for (let k = 0; k < 10; k++) {
    const px = new Float32Array(rows * cols);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) px[i + cols * j] = i * 10 + j + k * 100;
    files.push(writeDicomSlice({ rows, cols, pixels: px, pixelSpacing: [0.5, 0.4], ipp: [10, 20, 30 + k * 0.6], instance: 10 - k }));
  }
  const vol = buildVolume(files.map(parseDicomFile).reverse());
  assert.deepEqual(vol.dims, [20, 16, 10]);
  assert.ok(Math.abs(vol.spacing[0] - 0.4) < 1e-6 && Math.abs(vol.spacing[1] - 0.5) < 1e-6 && Math.abs(vol.spacing[2] - 0.6) < 1e-6);
  // (i=3, j=2, k=4) → 位置 (10+3*0.4, 20+2*0.5, 30+4*0.6), 値 = 30+2+400
  const p = mApply(volumeMatrix(vol), [3, 2, 4]);
  assert.ok(Math.abs(p[0] - 11.2) < 1e-6 && Math.abs(p[2] - 32.4) < 1e-6);
  assert.ok(Math.abs(sampleVolume(vol, p) - 432) < 1e-3);
});

test('ZIP の書き出し→読み込み', () => {
  const z = makeZip([{ name: 'a.txt', data: 'こんにちは' }, { name: 'b/c.bin', data: new Uint8Array([1, 2, 3]) }]);
  const r = readZip(z);
  assert.equal(new TextDecoder().decode(r.get('a.txt')), 'こんにちは');
  assert.deepEqual([...r.get('b/c.bin')], [1, 2, 3]);
});

test('対応点の剛体位置合わせが既知の変換を復元する', () => {
  const R = r3Axis([0.3, 0.5, 0.81].map((x, _, a) => x / Math.hypot(...a)), 37 * DEG);
  const M = mFromRT(R, [5, -3, 12]);
  const src = [[0, 0, 0], [10, 0, 0], [0, 7, 0], [3, 4, 9], [-5, 2, 1]];
  const dst = src.map((p) => mApply(M, p));
  const est = rigidFromPairs(src, dst);
  assert.ok(rmsError(est, src, dst) < 1e-6);
});

test('マーチングテトラヘドラの出力は水密', () => {
  const n = 24, f = new Float32Array(n * n * n);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const r1 = Math.hypot(i - 9, j - 12, k - 12), r2 = Math.hypot(i - 15, j - 12, k - 12);
    f[i + n * (j + n * k)] = Math.min(r1, r2) - 6;
  }
  const m = marchingTets(f, [n, n, n], (i, j, k) => [i, j, k]);
  const c = checkWatertight(m);
  assert.ok(c.watertight, JSON.stringify(c));
  assert.ok(m.volume() > 0, '外向きの面');
  const d = decimate(m, { maxError: 0.05, targetRatio: 0.2 });
  assert.ok(checkWatertight(d).watertight);
  assert.ok(d.nf < m.nf);
  assert.ok(Math.abs(d.volume() - m.volume()) / m.volume() < 0.02);
});

test('セファロ計測：デモ点で主要項目が計算できる', () => {
  const m = measureCeph(DEMO_CEPH_POINTS, 1);
  for (const k of ['SNA', 'SNB', 'ANB', 'FMA', 'U1SN', 'IMPA', 'II']) assert.ok(Number.isFinite(m[k]), k);
  assert.ok(Math.abs(m.ANB - (m.SNA - m.SNB)) < 1e-9);
  const g = cephToToothGoals(m, { U1SN: m.U1SN + 5, IMPA: m.IMPA - 3 });
  assert.ok(Math.abs(g.upperIncisorTorque - 5) < 1e-9 && Math.abs(g.lowerIncisorTorque + 3) < 1e-9);
});

// ---- デモ症例で一連の処理（少し時間がかかる） ----
const demo = (() => {
  let cache = null;
  return () => {
    if (cache) return cache;
    const { mesh, seeds } = makeDemoJaw('lower');
    const labels = segmentTeeth(mesh, [...seeds].map(([label, vertex]) => ({ label, vertex })));
    cache = buildArch('lower', mesh, labels);
    return cache;
  };
})();

test('デモ：14本に分割され、各歯（歯冠＋歯根）は閉じた立体', () => {
  const arch = demo();
  assert.equal(arch.teeth.size, 14);
  for (const [fdi, t] of arch.teeth) {
    assert.ok(checkWatertight(t.mesh).watertight, `tooth ${fdi}`);
    assert.ok(t.mesh.volume() > 50, `tooth ${fdi} volume`);
  }
});

test('姿勢パラメータ ⇄ 変換行列 が往復で一致する', () => {
  const arch = demo();
  for (const t of arch.teeth.values()) {
    const pose = { md: 0.7, bl: -0.4, ext: 0.3, tip: 4, torque: -6, rot: 9 };
    const back = matrixToPose(t, poseMatrix(t, pose));
    for (const k of Object.keys(pose)) assert.ok(Math.abs(back[k] - pose[k]) < 1e-6, `${t.fdi} ${k}`);
    // 符号の意味：トルク＋で歯冠が頬側へ
    const M = poseMatrix(t, { torque: 5 });
    const top = mApply(M, t.occlusalPoint);
    const d = [top[0] - t.occlusalPoint[0], top[1] - t.occlusalPoint[1], top[2] - t.occlusalPoint[2]];
    assert.ok(d[0] * t.frame.b[0] + d[1] * t.frame.b[1] + d[2] * t.frame.b[2] > 0, `${t.fdi} torque sign`);
  }
});

test('自動排列→ステージングが上限を守る', () => {
  const arch = demo();
  const { targets } = autoSetup(arch, {});
  const plan = autoStage(targets, {});
  assert.ok(plan.N > 0);
  assert.equal(checkVelocities(plan).length, 0);
  // 中間キーを入れても補間される
  const f = [...targets.keys()][3];
  const mid = Math.floor(plan.N / 2);
  setKey(plan, f, mid, { ...poseAt(plan, f, mid), md: 0 });
  assert.equal(poseAt(plan, f, mid).md, 0);
});

test('シェルは水密で、厚み相当の体積を持つ', () => {
  const arch = demo();
  const input = shellInput(arch, new Map(), { voxel: 0.35, thickness: 0.6, clearance: 0.05, decimateError: 0.02 }, () => 0.6);
  const r = generateShell(input);
  assert.ok(r.check.watertight, JSON.stringify(r.check));
  assert.ok(r.volume > 300, `volume ${r.volume}`);
});

test('自動位置合わせ：スキャンと無関係な座標の CBCT に歯冠を合わせられる', async () => {
  const { makeDemoCBCT } = await import('../src/demo/demoCase.js');
  const { volumeThresholds } = await import('../src/geom/volstats.js');
  const { volumeIsosurface } = await import('../src/geom/isosurface.js');
  const { autoRegister } = await import('../src/geom/register.js');
  const { mMul } = await import('../src/core/vec.js');
  const d = { lower: makeDemoJaw('lower'), upper: makeDemoJaw('upper') };
  const { vol } = makeDemoCBCT(d, { spacing: 0.5 });
  const th = volumeThresholds(vol);
  assert.ok(th.skin < th.bone && th.bone < th.teeth);
  const Mv = volumeMatrix(vol);
  const iso = volumeIsosurface(vol, th.teeth, 1, (i, j, k) => mApply(Mv, [i, j, k]));
  const Tk = mFromRT(r3Axis([0.2, 0.3, 0.93].map((x, _, a) => x / Math.hypot(...a)), 2.1), [40, -25, 13]); // 真の CT→スキャン
  const pts = [];
  for (const jaw of ['upper', 'lower']) {
    const P = d[jaw].mesh.positions, s = jaw === 'lower' ? 1 : -1;
    const hs = []; for (let i = 0; i < P.length; i += 3) hs.push(P[i + 2] * s);
    const cut = [...hs].sort((a, b) => a - b)[Math.floor(hs.length * 0.55)];
    for (let i = 0; i < P.length; i += 3) if (P[i + 2] * s > cut) pts.push(...mApply(Tk, [P[i], P[i + 1], P[i + 2]]));
  }
  const up = mApply(Tk, [0, 0, 1]).map((x, k) => x - mApply(Tk, [0, 0, 0])[k]);
  const r = autoRegister(Float32Array.from(pts), iso.positions, { upSrc: up, upDst: [0, 0, 1], shifts: [-8, -4, 0, 4, 8] });
  const E = mMul(r.matrix, Tk);
  for (const p of [[0, 0, 0], [20, -30, 5], [-20, -30, 5]]) {
    const q = mApply(E, p);
    assert.ok(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 0.3, `error at ${p}`);
  }
});
