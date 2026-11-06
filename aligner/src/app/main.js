// Aligner Studio — 画面とワークフロー
import { Viewer, LABEL_COLORS, makeSliceMesh, meshToGeometry, THREE } from './viewer.js';
import { Mesh, mergeMeshes } from '../core/mesh.js';
import { mApply, mMul, mInvRigid, mTranslate, mIdentity, sub, add, scale, dot, norm } from '../core/vec.js';
import { parseSTL, writeSTL } from '../io/stl.js';
import { parseOBJ } from '../io/obj.js';
import { parseDicomFile, buildVolume, volumeMatrix, sampleVolume } from '../io/dicom.js';
import { makeZip, readZip } from '../io/zip.js';
import { rigidFromPairs, rmsError, icp, autoRegister } from '../geom/register.js';
import { volumeThresholds } from '../geom/volstats.js';
import { segmentTeeth, paintLabels } from '../geom/segment.js';
import { volumeIsosurface } from '../geom/isosurface.js';
import { poseMatrix, matrixToPose, attachmentMesh, buccalAnchor } from '../geom/tooth.js';
import { buildArch, morphGingiva, refreshTooth, shellInput } from '../plan/arch.js';
import { archOrder, toothInfo, POSE_KEYS, POSE_LABELS, zeroPose, DEFAULT_LIMITS, positionOf } from '../plan/teeth.js';
import { CEPH_LANDMARKS, CEPH_MEASURES, DEFAULT_TARGETS, measureCeph, cephToToothGoals } from '../plan/ceph.js';
import { autoSetup, DEFAULT_SETUP, overjetOverbite } from '../plan/setup.js';
import { autoStage, poseAt, posesAt, setKey, checkVelocities, stagingTable, contactReport, STRATEGIES, stagesNeeded } from '../plan/staging.js';
import { makeDemoJaw, makeDemoCBCT, DEMO_CEPH_POINTS } from '../demo/demoCase.js';

const $ = (id) => document.getElementById(id);
const JAWS = ['upper', 'lower'];
const JAW_JA = { upper: '上顎', lower: '下顎' };
const STORE_VERSION = 1;
export const APP_VERSION = 'v0.3（自動位置合わせ対応）';
$('appVersion').textContent = APP_VERSION;

// ------------------------------------------------------------------ 状態
const S = {
  scans: { upper: null, lower: null },
  scanBuf: { upper: null, lower: null },
  labels: { upper: null, lower: null },
  seeds: { upper: [], lower: [] },
  arches: { upper: null, lower: null },
  toothProps: {},
  cbct: null,
  face: null,
  ceph: { img: null, imgURL: null, points: {}, pxPerMm: null, targets: { ...DEFAULT_TARGETS }, calib: null, lm: 0, ojTarget: 2.5, obTarget: 2.0 },
  setupOpt: { upper: { ...DEFAULT_SETUP }, lower: { ...DEFAULT_SETUP } },
  setupReport: { upper: null, lower: null },
  plan: { upper: null, lower: null },
  stage: 0,
  sel: null,
  segJaw: 'upper',
  setJaw: 'upper',
  mode: null,
  seedFdi: 17,
  reg: { moving: [], fixed: [] },
  vis: { upper: true, lower: true, scan: true, gingiva: true, roots: false, iso: true, slices: false, face: true, shell: true },
};

const viewer = new Viewer($('view'));
const applyTheme = () => viewer.setTheme(getComputedStyle(document.documentElement).getPropertyValue('--view').trim() || '#e9edf3');
applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

const log = (msg, cls = '') => {
  const d = document.createElement('div');
  d.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
  if (cls) d.className = cls;
  $('log').prepend(d);
};
const busy = (on, msg = '処理中…', p = 0) => {
  $('busy').style.display = on ? 'flex' : 'none';
  $('busyMsg').textContent = msg;
  $('busyBar').value = p;
};
const tick = () => new Promise((r) => setTimeout(r, 30));
async function withBusy(msg, fn) {
  busy(true, msg);
  await tick();
  try { return await fn(); } catch (e) { console.error(e); log(`エラー: ${e.message}`, 'danger'); alert(e.message); } finally { busy(false); }
}
const download = (name, data, type = 'application/octet-stream') => {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
const readFile = (f, as = 'buffer') => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  if (as === 'text') r.readAsText(f); else if (as === 'url') r.readAsDataURL(f); else r.readAsArrayBuffer(f);
});
const num = (id) => parseFloat($(id).value);

// ------------------------------------------------------------------ タブ
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  for (const x of $('tabs').querySelectorAll('button')) x.classList.toggle('on', x === b);
  for (const s of document.querySelectorAll('.step')) s.classList.toggle('on', s.id === `step-${b.dataset.step}`);
  setMode(null);
  if (b.dataset.step === 'roots') updateRootPanel();
  if (b.dataset.step === 'ceph') drawCeph();
});

// ------------------------------------------------------------------ ツールバー
const TOOLBAR = [
  ['upper', '上顎'], ['lower', '下顎'], ['scan', 'スキャン'], ['gingiva', '歯肉'], ['roots', '歯根'],
  ['iso', 'CBCT 等値面'], ['slices', 'CBCT 断面'], ['face', '顔'], ['shell', 'アライナー'],
];
for (const [k, label] of TOOLBAR) {
  const b = document.createElement('button');
  b.textContent = label;
  b.classList.toggle('on', S.vis[k]);
  b.onclick = () => { S.vis[k] = !S.vis[k]; b.classList.toggle('on', S.vis[k]); applyVisibility(); };
  b.dataset.vis = k;
  $('toolbar').append(b);
}
for (const [v, label] of [['front', '正面'], ['top', '上'], ['bottom', '下'], ['right', '右'], ['left', '左']]) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => viewer.view(v);
  $('toolbar').append(b);
}
{ const b = document.createElement('button'); b.textContent = '全体'; b.onclick = () => viewer.fit(); $('toolbar').append(b); }

function applyVisibility() {
  for (const j of JAWS) {
    const show = S.vis[j];
    viewer.setVisible(`scan_${j}`, show && S.vis.scan);
    viewer.setVisible(`teeth_${j}`, show);
    viewer.setVisible(`ging_${j}`, show && S.vis.gingiva);
    viewer.setVisible(`shell_${j}`, show && S.vis.shell);
    for (const c of viewer.group(`teeth_${j}`).children) if (c.userData.root) c.visible = S.vis.roots;
  }
  viewer.setVisible('iso', S.vis.iso);
  viewer.setVisible('slices', S.vis.slices);
  viewer.setVisible('face', S.vis.face);
}
const setVis = (k, v) => { S.vis[k] = v; const b = document.querySelector(`[data-vis="${k}"]`); if (b) b.classList.toggle('on', v); applyVisibility(); };

// ------------------------------------------------------------------ 取込
async function loadScan(jaw, buf, name = '') {
  const mesh = parseSTL(buf);
  S.scans[jaw] = mesh;
  S.scanBuf[jaw] = buf;
  S.labels[jaw] = null;
  S.seeds[jaw] = [];
  S.arches[jaw] = null;
  S.plan[jaw] = null;
  drawScan(jaw);
  updateScanStatus();
  log(`${JAW_JA[jaw]}スキャン ${name} を読み込み（${mesh.nf.toLocaleString()} 面）`);
}
function updateScanStatus() {
  $('statusScan').textContent = JAWS.map((j) => `${JAW_JA[j]}: ${S.scans[j] ? `${S.scans[j].nf.toLocaleString()} 面` : '未読込'}`).join(' / ');
}
$('fileUpper').onchange = (e) => e.target.files[0] && withBusy('STL 読込中…', async () => { await loadScan('upper', await readFile(e.target.files[0]), e.target.files[0].name); viewer.fit(); });
$('fileLower').onchange = (e) => e.target.files[0] && withBusy('STL 読込中…', async () => { await loadScan('lower', await readFile(e.target.files[0]), e.target.files[0].name); viewer.fit(); });

async function loadDicomFiles(files, { autoAlign = true } = {}) {
  const list = [...files].filter((f) => !/\.(txt|xml|jpg|png|html?)$/i.test(f.name));
  const slices = [];
  let fails = 0, firstErr = null;
  for (let i = 0; i < list.length; i++) {
    if (i % 20 === 0) { busy(true, `DICOM 解析 ${i}/${list.length}`, i / list.length); await tick(); }
    try { const s = parseDicomFile(await readFile(list[i])); if (s) slices.push(s); } catch (e) { fails++; firstErr = firstErr || e; }
  }
  if (!slices.length) throw firstErr || new Error('画像を含む DICOM が見つかりません');
  busy(true, 'ボリューム構築中…', 0.9); await tick();
  await setVolume(buildVolume(slices), { autoAlign, fails });
}
async function setVolume(vol, { autoAlign = true, fails = 0 } = {}) {
  const Mv = volumeMatrix(vol);
  // 初期配置：CBCT の中心をスキャンの中心へ
  const c = mApply(Mv, vol.dims.map((d) => (d - 1) / 2));
  const sc = scanCenter();
  S.cbct = { vol, M: mTranslate(sub(sc, c)), iso: null, slice: [0.5, 0.5, 0.5] };
  $('statusCT').textContent = `${vol.dims.join('×')} ボクセル, ${vol.spacing.map((s) => s.toFixed(2)).join('×')} mm${vol.info.downsample > 1 ? `（1/${vol.info.downsample} に間引き）` : ''}${fails ? `, 読めないファイル ${fails}` : ''}`;
  log(`CBCT 読込: ${vol.info.slices} スライス`);
  // しきい値を自動で決めて、歯の等値面（立体）を表示
  const th = volumeThresholds(vol);
  S.cbct.thr = th;
  $('isoThr').value = Math.round(th.teeth);
  busy(true, 'CBCT の立体表示を作成中…', 0.95); await tick();
  buildIso();
  setVis('slices', false);
  setVis('iso', true);
  drawSlices();
  log(`しきい値（自動）: 歯 ${Math.round(th.teeth)} / 骨 ${Math.round(th.bone)} / 皮膚 ${Math.round(th.skin)}`);
  if (autoAlign && (S.scans.upper || S.scans.lower)) await autoAlignScanCbct();
  if (autoAlign && S.face) await autoAlignFace();
  viewer.fit();
}
function buildIso() {
  const vol = S.cbct.vol, Mv = volumeMatrix(vol);
  const n = vol.dims[0] * vol.dims[1] * vol.dims[2];
  const step = n > 24e6 ? 2 : 1;
  $('isoStep').value = String(step);
  S.cbct.iso = volumeIsosurface(vol, num('isoThr'), step, (i, j, k) => mApply(Mv, [i, j, k]));
  drawIso();
  log(`CBCT 等値面: ${S.cbct.iso.nf.toLocaleString()} 面（しきい値 ${num('isoThr')}）`);
}

// ---- 自動位置合わせ ----
const avg = (pts) => scale(pts.reduce((a, b) => add(a, b), [0, 0, 0]), 1 / pts.length);
function meshCentroid(m) { const P = m.positions; let c = [0, 0, 0]; for (let i = 0; i < P.length; i += 3) { c[0] += P[i]; c[1] += P[i + 1]; c[2] += P[i + 2]; } return scale(c, 3 / P.length); }
function meanNormal(m) { const N = m.vertexNormals(); let c = [0, 0, 0]; for (let i = 0; i < N.length; i += 3) { c[0] += N[i]; c[1] += N[i + 1]; c[2] += N[i + 2]; } return norm(c); }
/** スキャン座標での「上（頭側）」方向 */
function scanUp() {
  if (S.scans.upper && S.scans.lower) return norm(sub(meshCentroid(S.scans.upper), meshCentroid(S.scans.lower)));
  if (S.arches.lower) return S.arches.lower.frame.ez;
  if (S.arches.upper) return scale(S.arches.upper.frame.ez, -1);
  if (S.scans.lower) return meanNormal(S.scans.lower);
  return scale(meanNormal(S.scans.upper), -1);
}
/** 位置合わせに使う歯冠の点（分割済みなら歯のラベル、未分割なら咬合側の 45%） */
function crownPoints(up) {
  const out = [];
  for (const j of JAWS) {
    const m = S.scans[j];
    if (!m) continue;
    const P = m.positions, L = S.labels[j];
    const occl = j === 'lower' ? up : scale(up, -1);
    let cut = -Infinity;
    if (!L) {
      const hs = [];
      for (let i = 0; i < P.length; i += 30) hs.push(P[i] * occl[0] + P[i + 1] * occl[1] + P[i + 2] * occl[2]);
      hs.sort((a, b) => a - b);
      cut = hs[Math.floor(hs.length * 0.55)];
    }
    for (let i = 0; i < P.length / 3; i++) {
      if (L ? L[i] <= 0 : P[3 * i] * occl[0] + P[3 * i + 1] * occl[1] + P[3 * i + 2] * occl[2] < cut) continue;
      out.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
    }
  }
  return Float32Array.from(out);
}
async function autoAlignScanCbct() {
  if (!S.cbct?.iso) return;
  busy(true, 'スキャン ⇄ CBCT を自動で位置合わせ中…（数十秒かかることがあります）'); await tick();
  const up = scanUp();
  const r = autoRegister(crownPoints(up), S.cbct.iso.positions, { upSrc: up, upDst: [0, 0, 1], shifts: [-8, -4, 0, 4, 8] });
  if (!r) { log('自動位置合わせに失敗しました。対応点で合わせてください', 'warn'); return; }
  const newM = mInvRigid(r.matrix); // CBCT → スキャン
  if (S.face?.alignedToCbct) { S.face.M = mMul(newM, mMul(mInvRigid(S.cbct.M), S.face.M)); drawFace(); }
  S.cbct.M = newM;
  drawIso(); drawSlices();
  const msg = `スキャン⇄CBCT 自動位置合わせ: 一致率 ${(r.inlier * 100).toFixed(0)}%（0.5mm 以内）, 誤差 ${r.rms.toFixed(2)} mm`;
  $('regResult').textContent = msg;
  if (r.inlier < 0.35) {
    log(`${msg}。一致率が低いため結果を確認してください（ずれていれば「2 位置合わせ」で対応点を打つか、しきい値を変えて再実行）`, 'warn');
  } else log(msg, 'ok');
}
/** 顔スキャンの単位を mm にそろえる（m や cm で書き出された場合） */
function faceToMM(obj) {
  const P = obj.positions;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i + k]); mx[k] = Math.max(mx[k], P[i + k]); }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
  const f = diag < 2 ? 1000 : diag < 40 ? 10 : 1;
  if (f !== 1) { for (let i = 0; i < P.length; i++) P[i] *= f; log(`顔スキャンの単位を mm に変換しました（×${f}）`); }
}
async function autoAlignFace() {
  if (!S.face) return;
  if (!S.cbct) { log('顔の自動位置合わせには CBCT が必要です（皮膚の表面どうしで合わせます）', 'warn'); return; }
  busy(true, '顔 ⇄ CBCT（皮膚表面）を自動で位置合わせ中…'); await tick();
  if (!S.cbct.skin) {
    const vol = S.cbct.vol, Mv = volumeMatrix(vol);
    S.cbct.skin = volumeIsosurface(vol, S.cbct.thr?.skin ?? -400, 2, (i, j, k) => mApply(Mv, [i, j, k]));
  }
  const P = S.face.obj.positions;
  let best = null;
  // 顔スキャンの上下の向きは機器ごとに違うので、6 方向を試す
  for (const upSrc of [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]]) {
    busy(true, `顔 ⇄ CBCT を自動で位置合わせ中…（向き ${[[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]].findIndex((u) => u === upSrc) + 1}/6）`); await tick();
    const r = autoRegister(P, S.cbct.skin.positions, { upSrc, upDst: [0, 0, 1], tryFlip: false, shifts: [0] });
    if (r && (!best || r.inlier > best.inlier)) best = r;
  }
  if (!best) { log('顔の自動位置合わせに失敗しました。対応点で合わせてください', 'warn'); return; }
  S.face.M = mMul(S.cbct.M, best.matrix); // 顔 → CBCT → スキャン
  S.face.alignedToCbct = true;
  drawFace();
  const msg = `顔⇄CBCT 自動位置合わせ: 一致率 ${(best.inlier * 100).toFixed(0)}%, 誤差 ${best.rms.toFixed(2)} mm`;
  log(best.inlier < 0.2 ? `${msg}。一致率が低いため結果を確認してください` : msg, best.inlier < 0.2 ? 'warn' : 'ok');
}
$('autoRegScan').onclick = () => {
  if (!S.cbct) return alert('先に CBCT を読み込んでください');
  if (!S.scans.upper && !S.scans.lower) return alert('先に口腔内スキャンを読み込んでください');
  withBusy('自動位置合わせ中…', async () => { if (!S.cbct.iso) buildIso(); await autoAlignScanCbct(); });
};
$('autoRegFace').onclick = () => {
  if (!S.face) return alert('先に顔スキャンを読み込んでください');
  withBusy('自動位置合わせ中…', autoAlignFace);
};
function scanCenter() {
  const pts = [];
  for (const j of JAWS) if (S.scans[j]) { const b = S.scans[j].bbox(); pts.push(scale(add(b.min, b.max), 0.5)); }
  return pts.length ? scale(pts.reduce((a, b) => add(a, b), [0, 0, 0]), 1 / pts.length) : [0, 0, 0];
}
$('fileDicomDir').onchange = (e) => e.target.files.length && withBusy('DICOM 読込中…', () => loadDicomFiles(e.target.files));
$('fileDicom').onchange = (e) => e.target.files.length && withBusy('DICOM 読込中…', () => loadDicomFiles(e.target.files));

async function loadFace(text, texURL = null) {
  const obj = parseOBJ(text);
  faceToMM(obj);
  const sc = scanCenter();
  let c = [0, 0, 0];
  const P = obj.positions;
  for (let i = 0; i < P.length; i += 3) { c[0] += P[i]; c[1] += P[i + 1]; c[2] += P[i + 2]; }
  c = scale(c, 3 / Math.max(3, P.length));
  S.face = { obj, text, texURL, M: S.face?.M || mTranslate(sub(sc, c)) };
  drawFace();
  $('statusFace').textContent = `${(obj.indices.length / 3).toLocaleString()} 面${obj.uvs ? '（UVあり）' : ''}${texURL ? '・テクスチャあり' : ''}`;
  log('フェイススキャンを読み込み');
}
$('fileFace').onchange = (e) => e.target.files[0] && withBusy('OBJ 読込中…', async () => {
  S.face = null;
  await loadFace(await readFile(e.target.files[0], 'text'), S.pendingTex || null);
  if (S.cbct) await autoAlignFace();
});
$('fileFaceTex').onchange = (e) => e.target.files[0] && withBusy('画像読込中…', async () => {
  const url = await readFile(e.target.files[0], 'url');
  if (S.face) { S.face.texURL = url; drawFace(); } else S.pendingTex = url;
});

$('loadDemoCT').onclick = () => withBusy('デモ CBCT を生成中…', async () => {
  if (!S.scans.upper || !S.scans.lower) return alert('先に「デモ症例を読み込む」を押してください');
  const { vol } = makeDemoCBCT({ upper: makeDemoJaw('upper'), lower: makeDemoJaw('lower') });
  // 実際の CT と同じく、スキャンとは無関係な座標にしておく（自動位置合わせの確認用）
  const R = [Math.cos(0.6), -Math.sin(0.6), 0, Math.sin(0.6), Math.cos(0.6), 0, 0, 0, 1];
  vol.axes = vol.axes.map((a) => [R[0] * a[0] + R[1] * a[1], R[3] * a[0] + R[4] * a[1], a[2]]);
  vol.origin = [vol.origin[0] + 60, vol.origin[1] - 40, vol.origin[2] + 90];
  await setVolume(vol);
  log('デモ CBCT を読み込みました（スキャンとずれた座標から自動で位置合わせ）', 'ok');
});
$('loadDemo').onclick = () => withBusy('デモ症例を生成中…', async () => {
  for (const jaw of JAWS) {
    const { mesh, seeds } = makeDemoJaw(jaw);
    const buf = writeSTL(mesh, `demo_${jaw}`);
    await loadScan(jaw, buf, `demo_${jaw}.stl`);
    // デモはシードを自動で置く（実データでは手でクリック）
    const sm = S.scans[jaw];
    S.seeds[jaw] = [...seeds].map(([fdi, v]) => ({ label: fdi, vertex: nearestVertex(sm, mesh.p(v)) }));
    drawSeeds();
  }
  viewer.fit();
  viewer.view('front');
  log('デモ症例を読み込みました。「3 歯の分割」で分割を実行してください。', 'ok');
});
function nearestVertex(mesh, p) {
  let best = 0, bd = Infinity;
  const P = mesh.positions;
  for (let i = 0; i < P.length; i += 3) {
    const d = (P[i] - p[0]) ** 2 + (P[i + 1] - p[1]) ** 2 + (P[i + 2] - p[2]) ** 2;
    if (d < bd) { bd = d; best = i / 3; }
  }
  return best;
}

// ------------------------------------------------------------------ 描画
function labelColors(jaw) {
  const mesh = S.scans[jaw], L = S.labels[jaw];
  const C = new Float32Array(mesh.nv * 3);
  for (let i = 0; i < mesh.nv; i++) {
    const c = L ? LABEL_COLORS.get(L[i]) || [0.8, 0.8, 0.8] : [0.88, 0.86, 0.82];
    C[3 * i] = c[0]; C[3 * i + 1] = c[1]; C[3 * i + 2] = c[2];
  }
  return C;
}
function drawScan(jaw) {
  viewer.clearGroup(`scan_${jaw}`);
  if (!S.scans[jaw]) return;
  viewer.addMesh(`scan_${jaw}`, S.scans[jaw], { colors: labelColors(jaw), userData: { scan: jaw } });
  applyVisibility();
}
function refreshScanColors(jaw) {
  const m = viewer.group(`scan_${jaw}`).children[0];
  if (!m) return drawScan(jaw);
  m.geometry.setAttribute('color', new THREE.BufferAttribute(labelColors(jaw), 3));
}
function drawSeeds() {
  viewer.clearMarkers();
  if (S.mode === 'regMoving' || S.mode === 'regFixed') return drawRegMarkers();
  for (const j of JAWS) {
    if (!S.scans[j] || j !== S.segJaw) continue;
    for (const s of S.seeds[j]) {
      const c = LABEL_COLORS.get(s.label) || [1, 0, 0];
      viewer.addMarker(S.scans[j].p(s.vertex), new THREE.Color(c[0] * 0.7, c[1] * 0.7, c[2] * 0.7).getHex(), 0.45);
    }
  }
}

const COL = { crown: 0xf4f0e4, crownSel: 0xffd36e, root: 0xd8c08a, ging: 0xe9a7a6, shell: 0x6fa8ff, att: 0x9fe0c0 };
function drawArch(jaw) {
  viewer.clearGroup(`teeth_${jaw}`);
  viewer.clearGroup(`ging_${jaw}`);
  const arch = S.arches[jaw];
  if (!arch) return;
  for (const [fdi, t] of arch.teeth) {
    const crown = viewer.addMesh(`teeth_${jaw}`, t.crown, { color: fdi === S.sel ? COL.crownSel : COL.crown, userData: { fdi, jaw } });
    crown.matrixAutoUpdate = false;
    const rootIdx = t.mesh.indices.subarray(t.rootFaceStart * 3);
    const root = viewer.addMesh(`teeth_${jaw}`, new Mesh(t.mesh.positions, rootIdx), { color: COL.root, opacity: 0.55, userData: { fdi, jaw, root: true } });
    root.matrixAutoUpdate = false;
    for (const att of t.attachments) {
      const a = viewer.addMesh(`teeth_${jaw}`, attachmentMesh(t, att), { color: COL.att, userData: { fdi, jaw, att: true } });
      a.matrixAutoUpdate = false;
    }
  }
  const g = viewer.addMesh(`ging_${jaw}`, arch.gingiva.mesh, { color: COL.ging, opacity: 0.85, doubleSide: true, userData: { ging: jaw } });
  g.userData.base = arch.gingiva.mesh;
  updatePoses();
  applyVisibility();
}

function currentPoses(jaw) {
  const plan = S.plan[jaw];
  if (!plan) return new Map();
  return posesAt(plan, S.stage);
}
function updatePoses() {
  for (const jaw of JAWS) {
    const arch = S.arches[jaw];
    if (!arch) continue;
    const poses = currentPoses(jaw);
    const mats = new Map();
    for (const [fdi, t] of arch.teeth) mats.set(fdi, poseMatrix(t, poses.get(fdi) || zeroPose()));
    for (const c of viewer.group(`teeth_${jaw}`).children) {
      const M = mats.get(c.userData.fdi);
      if (M) { c.matrix.fromArray(M); c.matrixWorldNeedsUpdate = true; }
      if (!c.userData.root && !c.userData.att) c.material.color.setHex(c.userData.fdi === S.sel ? COL.crownSel : COL.crown);
    }
    const gm = viewer.group(`ging_${jaw}`).children[0];
    if (gm) {
      const m = morphGingiva(arch.gingiva, mats);
      gm.geometry.attributes.position.array.set(m.positions);
      gm.geometry.attributes.position.needsUpdate = true;
      gm.geometry.computeVertexNormals();
    }
  }
  const N = maxStage();
  $('stage').max = N;
  $('stage').value = S.stage;
  $('stageLabel').textContent = `${S.stage} / ${N}${S.stage === 0 ? '（初期）' : S.stage === N ? '（最終）' : ''}`;
  updatePosePanel();
  syncGizmo();
}
const maxStage = () => Math.max(0, ...JAWS.map((j) => S.plan[j]?.N || 0));

function drawSlices() {
  viewer.clearGroup('slices');
  const c = S.cbct;
  if (!c) return;
  const vol = c.vol;
  const Mv = mMul(c.M, volumeMatrix(vol));
  const toW = (i, j, k) => mApply(Mv, [i, j, k]);
  const wl = num('winL'), ww = num('winW');
  const idx = [Math.round(c.slice[0] * (vol.dims[0] - 1)), Math.round(c.slice[1] * (vol.dims[1] - 1)), Math.round(c.slice[2] * (vol.dims[2] - 1))];
  for (const ax of [0, 1, 2]) viewer.group('slices').add(makeSliceMesh(vol, ax, idx[ax], wl, ww, toW));
  applyVisibility();
}
function drawIso() {
  viewer.clearGroup('iso');
  if (!S.cbct?.iso) return;
  viewer.addMesh('iso', S.cbct.iso, { color: 0xc9d4e8, opacity: 0.55, matrix: S.cbct.M, userData: { iso: true } });
  applyVisibility();
}
function drawFace() {
  viewer.clearGroup('face');
  if (!S.face) return;
  const o = S.face.obj;
  const m = new Mesh(o.positions, o.indices);
  let map = null;
  if (S.face.texURL && o.uvs) {
    map = new THREE.TextureLoader().load(S.face.texURL);
    map.colorSpace = THREE.SRGBColorSpace;
  }
  const mesh = viewer.addMesh('face', m, { color: map ? 0xffffff : 0xe8c8b0, colors: !map && o.colors ? o.colors : null, opacity: num('faceOpacity'), doubleSide: true, matrix: S.face.M, map, userData: { face: true } });
  if (o.uvs) mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(o.uvs, 2));
  applyVisibility();
}
$('faceOpacity').oninput = () => { const m = viewer.group('face').children[0]; if (m) { m.material.opacity = num('faceOpacity'); m.material.transparent = true; m.material.depthWrite = num('faceOpacity') >= 1; } };

// ------------------------------------------------------------------ 位置合わせ
for (const [id, k] of [['sliceX', 0], ['sliceY', 1], ['sliceZ', 2]]) $(id).oninput = () => { if (S.cbct) { S.cbct.slice[k] = num(id); drawSlices(); } };
$('winL').onchange = $('winW').onchange = drawSlices;
$('toggleSlices').onclick = () => setVis('slices', !S.vis.slices);
$('makeIso').onclick = () => {
  if (!S.cbct) return alert('先に CBCT を読み込んでください');
  withBusy('等値面を作成中…', async () => {
    const vol = S.cbct.vol, Mv = volumeMatrix(vol);
    S.cbct.iso = volumeIsosurface(vol, num('isoThr'), parseInt($('isoStep').value, 10), (i, j, k) => mApply(Mv, [i, j, k]));
    drawIso();
    setVis('iso', true);
    log(`CBCT 等値面: ${S.cbct.iso.nf.toLocaleString()} 面`);
  });
};
function movingObject() {
  const t = $('regTarget').value;
  return t === 'cbct' ? (S.cbct ? { M: S.cbct.M, objs: [viewer.group('iso'), viewer.group('slices')] } : null) : S.face ? { M: S.face.M, objs: [viewer.group('face')] } : null;
}
function drawRegMarkers() {
  viewer.clearMarkers();
  const mv = movingObject();
  for (const p of S.reg.moving) viewer.addMarker(mv ? mApply(mv.M, p) : p, 0xff4466, 0.5);
  for (const p of S.reg.fixed) viewer.addMarker(p, 0x22aa66, 0.5);
  $('regStatus').textContent = `点: 動かす側 ${S.reg.moving.length} / スキャン側 ${S.reg.fixed.length}（3点以上、同じ順番で）`;
}
$('pickMoving').onclick = () => setMode(S.mode === 'regMoving' ? null : 'regMoving');
$('pickFixed').onclick = () => setMode(S.mode === 'regFixed' ? null : 'regFixed');
$('regClear').onclick = () => { S.reg = { moving: [], fixed: [] }; drawRegMarkers(); };
$('regTarget').onchange = () => { S.reg = { moving: [], fixed: [] }; drawRegMarkers(); };
$('regSolve').onclick = () => {
  const n = Math.min(S.reg.moving.length, S.reg.fixed.length);
  if (n < 3) return alert('対応点が 3 組以上必要です');
  const M = rigidFromPairs(S.reg.moving.slice(0, n), S.reg.fixed.slice(0, n));
  const err = rmsError(M, S.reg.moving.slice(0, n), S.reg.fixed.slice(0, n));
  setMovingMatrix(M);
  $('regResult').textContent = `対応点の誤差 (RMS): ${err.toFixed(2)} mm`;
  log(`位置合わせ完了 RMS ${err.toFixed(2)} mm`);
  drawRegMarkers();
};
function setMovingMatrix(M) {
  if ($('regTarget').value === 'cbct') { S.cbct.M = M; drawIso(); drawSlices(); } else { S.face.M = M; drawFace(); }
}
$('regICP').onclick = () => {
  if (!S.cbct?.iso) return alert('先に CBCT の等値面を作成してください');
  withBusy('ICP 計算中…', async () => {
    // スキャン（歯冠を優先）→ CBCT 等値面 を合わせ、その逆を CBCT に適用
    const pts = [];
    for (const j of JAWS) {
      const sm = S.scans[j];
      if (!sm) continue;
      const L = S.labels[j];
      for (let i = 0; i < sm.nv; i++) if (!L || L[i] > 0) pts.push(sm.positions[3 * i], sm.positions[3 * i + 1], sm.positions[3 * i + 2]);
    }
    const iso = S.cbct.iso.transformed(S.cbct.M);
    const r = icp(Float32Array.from(pts), iso.positions, mIdentity(), { iterations: 40, maxDist: 2.5, samples: 4000 });
    S.cbct.M = mMul(mInvRigid(r.matrix), S.cbct.M);
    drawIso(); drawSlices();
    $('regResult').textContent = `ICP 誤差 (RMS): ${r.rms.toFixed(2)} mm`;
    log(`ICP 完了 RMS ${r.rms.toFixed(2)} mm`);
  });
};

// ------------------------------------------------------------------ 歯の分割
function buildFdiGrid() {
  const g = $('fdiGrid');
  g.innerHTML = '';
  const order = archOrder(S.segJaw);
  for (const fdi of order) {
    const b = document.createElement('button');
    b.textContent = fdi;
    const c = LABEL_COLORS.get(fdi);
    b.style.borderBottom = `3px solid rgb(${c.map((x) => Math.round(x * 255)).join(',')})`;
    b.classList.toggle('on', fdi === S.seedFdi);
    if (S.seeds[S.segJaw].some((s) => s.label === fdi)) b.style.fontWeight = '700';
    b.onclick = () => { S.seedFdi = fdi; setMode('seed'); buildFdiGrid(); };
    g.append(b);
  }
  const sel = $('brushLabel');
  sel.innerHTML = '<option value="0">歯肉 (0)</option>' + order.map((f) => `<option value="${f}">${f}</option>`).join('');
}
function setSegJaw(j) {
  S.segJaw = j;
  $('segUpper').classList.toggle('on', j === 'upper');
  $('segLower').classList.toggle('on', j === 'lower');
  if (!archOrder(j).includes(S.seedFdi)) S.seedFdi = archOrder(j)[0];
  buildFdiGrid();
  drawSeeds();
}
$('segUpper').onclick = () => setSegJaw('upper');
$('segLower').onclick = () => setSegJaw('lower');
$('seedMode').onclick = () => setMode(S.mode === 'seed' ? null : 'seed');
$('gumSeedMode').onclick = () => setMode(S.mode === 'gumseed' ? null : 'gumseed');
$('brushMode').onclick = () => setMode(S.mode === 'brush' ? null : 'brush');
$('seedClear').onclick = () => { S.seeds[S.segJaw] = []; drawSeeds(); buildFdiGrid(); };
$('segRun').onclick = () => {
  const j = S.segJaw;
  if (!S.scans[j]) return alert(`${JAW_JA[j]}のスキャンがありません`);
  if (!S.seeds[j].some((s) => s.label > 0)) return alert('歯冠にシードを置いてください');
  withBusy('分割中…', async () => {
    S.labels[j] = segmentTeeth(S.scans[j], S.seeds[j], { concavityWeight: num('segWeight') });
    refreshScanColors(j);
    setVis('scan', true);
    const n = new Set(S.labels[j]).size - 1;
    $('segStatus').textContent = `${JAW_JA[j]}: ${n} 本に分割。必要ならブラシで修正し「歯を作成」へ。`;
    log(`${JAW_JA[j]} 分割: ${n} 本`);
  });
};
$('buildTeeth').onclick = () => {
  const j = S.segJaw;
  if (!S.labels[j]) return alert('先に分割を実行してください');
  withBusy('歯モデルを作成中…', async () => buildTeethFor(j));
};
function buildTeethFor(j) {
  const prev = { teeth: new Map(Object.entries(S.toothProps).map(([k, v]) => [+k, v])) };
  S.arches[j] = buildArch(j, S.scans[j], S.labels[j], prev);
  for (const [fdi, t] of S.arches[j].teeth) saveToothProps(t);
  drawArch(j);
  setVis('scan', false);
  $('segStatus').textContent = `${JAW_JA[j]}: 歯 ${S.arches[j].teeth.size} 本を作成（歯根は平均的な長さで推定。「4 歯軸・歯根」で調整）`;
  log(`${JAW_JA[j]} 歯モデル作成`, 'ok');
}
function saveToothProps(t) {
  S.toothProps[t.fdi] = { rootLength: t.rootLength, rootScale: t.rootScale, crRatio: t.crRatio, axisAdjust: { ...t.axisAdjust }, attachments: t.attachments.map((a) => ({ ...a })) };
}

// ------------------------------------------------------------------ ピック処理
function setMode(m) {
  S.mode = m;
  $('seedMode').classList.toggle('on', m === 'seed');
  $('gumSeedMode').classList.toggle('on', m === 'gumseed');
  $('brushMode').classList.toggle('on', m === 'brush');
  $('pickMoving').classList.toggle('on', m === 'regMoving');
  $('pickFixed').classList.toggle('on', m === 'regFixed');
  viewer.controls.enableRotate = m !== 'brush';
  const hints = {
    seed: `歯 ${S.seedFdi} の歯冠をクリック`, gumseed: '歯肉をクリック（境界がうまく出ない所に）', brush: 'ドラッグで塗る（回転は無効）',
    regMoving: '動かす側（CBCT 等値面／顔）の点をクリック', regFixed: '口腔内スキャン上の対応する点をクリック',
  };
  $('hint').textContent = hints[m] || '左ドラッグ: 回転 / 右ドラッグ: 平行移動 / ホイール: 拡大 / 歯をクリックで選択';
  if (m === 'regMoving' || m === 'regFixed') drawRegMarkers(); else drawSeeds();
}
function hitVertex(hit) {
  const f = hit.face;
  const P = hit.object.geometry.attributes.position.array;
  let best = f.a, bd = Infinity;
  for (const v of [f.a, f.b, f.c]) {
    const d = (P[3 * v] - hit.point.x) ** 2 + (P[3 * v + 1] - hit.point.y) ** 2 + (P[3 * v + 2] - hit.point.z) ** 2;
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}
const scanObjs = (j) => [viewer.group(`scan_${j}`)];
viewer.pickHandler = (e) => {
  const m = S.mode;
  if (m === 'seed' || m === 'gumseed') {
    const j = S.segJaw;
    const hit = viewer.pick(e, scanObjs(j));
    if (!hit) return;
    const v = hitVertex(hit);
    const label = m === 'gumseed' ? 0 : S.seedFdi;
    if (label > 0) S.seeds[j] = S.seeds[j].filter((s) => s.label !== label);
    S.seeds[j].push({ vertex: v, label });
    if (m === 'seed') {
      const order = archOrder(j);
      const i = order.indexOf(S.seedFdi);
      if (i >= 0 && i < order.length - 1) S.seedFdi = order[i + 1];
      setMode('seed');
    }
    buildFdiGrid();
    drawSeeds();
    return;
  }
  if (m === 'brush') return brushAt(e);
  if (m === 'regMoving') {
    const mv = movingObject();
    if (!mv) return alert('動かすデータがありません');
    const hit = viewer.pick(e, mv.objs);
    if (!hit) return;
    S.reg.moving.push(mApply(mInvRigid(mv.M), [hit.point.x, hit.point.y, hit.point.z]));
    drawRegMarkers();
    return;
  }
  if (m === 'regFixed') {
    const objs = [];
    for (const j of JAWS) objs.push(viewer.group(`scan_${j}`), viewer.group(`teeth_${j}`));
    const hit = viewer.pick(e, objs);
    if (!hit) return;
    S.reg.fixed.push([hit.point.x, hit.point.y, hit.point.z]);
    drawRegMarkers();
    return;
  }
  // 歯の選択
  const hit = viewer.pick(e, JAWS.map((j) => viewer.group(`teeth_${j}`)));
  if (hit && hit.object.userData.fdi) selectTooth(hit.object.userData.fdi);
};
function brushAt(e) {
  const j = S.segJaw;
  if (!S.labels[j]) return;
  const hit = viewer.pick(e, scanObjs(j));
  if (!hit) return;
  paintLabels(S.scans[j], S.labels[j], hitVertex(hit), num('brushR'), parseInt($('brushLabel').value, 10));
  refreshScanColors(j);
}
viewer.moveHandler = (e) => { if (S.mode === 'brush') brushAt(e); };

// ------------------------------------------------------------------ 歯の選択・姿勢編集
const archOfFdi = (fdi) => (Math.floor(fdi / 10) <= 2 ? 'upper' : 'lower');
const toothOf = (fdi) => S.arches[archOfFdi(fdi)]?.teeth.get(fdi) || null;
function selectTooth(fdi) {
  S.sel = fdi;
  updatePoses();
  updateRootPanel();
}
const STEP = { md: 0.1, bl: 0.1, ext: 0.1, tip: 0.5, torque: 0.5, rot: 0.5 };
function updatePosePanel() {
  const fdi = S.sel, t = fdi ? toothOf(fdi) : null;
  const box = $('poseEditor');
  if (!t) { $('toothTitle').textContent = 'なし（ビューで歯をクリック）'; box.innerHTML = ''; $('toothTotals').innerHTML = ''; return; }
  const jaw = archOfFdi(fdi);
  const plan = S.plan[jaw];
  const N = plan?.N || 0;
  const editable = plan && S.stage > 0;
  $('toothTitle').textContent = `${fdi} ${t.info.name}｜ステージ ${S.stage}${!plan ? '（セットアップ未実行）' : S.stage === 0 ? '（初期位置は編集不可）' : S.stage >= N ? '（最終＝目標位置）' : '（中間キー）'}`;
  const pose = plan ? poseAt(plan, fdi, S.stage) : zeroPose();
  box.innerHTML = '';
  for (const k of POSE_KEYS) {
    const row = document.createElement('div');
    row.className = 'pose-row';
    row.innerHTML = `<span>${POSE_LABELS[k]}</span><input type="number" step="${STEP[k]}" value="${pose[k].toFixed(2)}" ${editable ? '' : 'disabled'}><button ${editable ? '' : 'disabled'}>−</button><button ${editable ? '' : 'disabled'}>＋</button>`;
    const inp = row.querySelector('input');
    const [bm, bp] = row.querySelectorAll('button');
    const commit = (v) => { const p = poseAt(plan, fdi, S.stage); p[k] = v; editPose(fdi, p); };
    inp.onchange = () => commit(parseFloat(inp.value) || 0);
    bm.onclick = () => commit(pose[k] - STEP[k]);
    bp.onclick = () => commit(pose[k] + STEP[k]);
    box.append(row);
  }
  const tgt = plan?.teeth[fdi]?.target || zeroPose();
  const tp = plan?.teeth[fdi];
  $('toothTotals').innerHTML = POSE_KEYS.map((k) => `<span>${POSE_LABELS[k]}</span><span>${tgt[k].toFixed(2)}</span>`).join('')
    + (tp ? `<span>移動ステージ</span><span>${tp.start} → ${tp.end}</span><span>必要最小ステージ数</span><span>${stagesNeeded(fdi, zeroPose(), tgt, plan.limits)}</span>` : '');
}
function editPose(fdi, pose) {
  const jaw = archOfFdi(fdi);
  const plan = S.plan[jaw];
  if (!plan || S.stage === 0) return;
  if (S.stage >= plan.N || S.stage >= (plan.teeth[fdi]?.end ?? 0)) {
    const tp = plan.teeth[fdi] || (plan.teeth[fdi] = { target: zeroPose(), start: 0, end: 0, keys: [] });
    tp.target = { ...pose };
    if (tp.end === 0) tp.end = Math.max(1, S.stage);
  } else setKey(plan, fdi, S.stage, pose);
  updatePoses();
  renderStageTable();
}
$('poseReset').onclick = () => {
  const fdi = S.sel; if (!fdi) return;
  const plan = S.plan[archOfFdi(fdi)]; if (!plan?.teeth[fdi]) return;
  plan.teeth[fdi] = { target: zeroPose(), start: 0, end: 0, keys: [] };
  updatePoses(); renderStageTable();
};

// ギズモ
const pivot = new THREE.Object3D();
pivot.matrixAutoUpdate = true;
viewer.scene.add(pivot);
let gizmoStart = null;
function syncGizmo() {
  const t = S.sel ? toothOf(S.sel) : null;
  const plan = t ? S.plan[archOfFdi(S.sel)] : null;
  if (!t || !plan || S.stage === 0 || !viewer.gizmo.mode || !S.gizmoOn) { viewer.gizmo.detach(); return; }
  const M = poseMatrix(t, poseAt(plan, t.fdi, S.stage));
  const cr = mApply(M, t.cr);
  const R = new THREE.Matrix4().fromArray(M);
  const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...t.frame.m), new THREE.Vector3(...t.frame.y), new THREE.Vector3(...t.frame.z));
  const rot = new THREE.Matrix4().extractRotation(R).multiply(basis);
  pivot.position.set(cr[0], cr[1], cr[2]);
  pivot.quaternion.setFromRotationMatrix(rot);
  pivot.updateMatrixWorld(true);
  viewer.gizmo.attach(pivot);
}
viewer.gizmo.addEventListener('mouseDown', () => {
  const t = toothOf(S.sel);
  const plan = S.plan[archOfFdi(S.sel)];
  gizmoStart = { M: poseMatrix(t, poseAt(plan, t.fdi, S.stage)), P: pivot.matrixWorld.clone() };
});
viewer.gizmo.addEventListener('objectChange', () => {
  if (!gizmoStart) return;
  const t = toothOf(S.sel);
  pivot.updateMatrixWorld(true);
  const delta = pivot.matrixWorld.clone().multiply(gizmoStart.P.clone().invert());
  const Mnew = delta.multiply(new THREE.Matrix4().fromArray(gizmoStart.M));
  const pose = matrixToPose(t, Mnew.elements);
  const jaw = archOfFdi(S.sel);
  // 位置だけ更新（ギズモの再配置はしない）
  const plan = S.plan[jaw];
  if (S.stage >= plan.N || S.stage >= (plan.teeth[t.fdi]?.end ?? 0)) { const tp = plan.teeth[t.fdi]; tp.target = pose; if (tp.end === 0) tp.end = Math.max(1, S.stage); }
  else setKey(plan, t.fdi, S.stage, pose);
  const g = viewer.group(`teeth_${jaw}`);
  for (const c of g.children) if (c.userData.fdi === t.fdi) { c.matrix.copy(Mnew); c.matrixWorldNeedsUpdate = true; }
});
viewer.gizmo.addEventListener('mouseUp', () => { gizmoStart = null; updatePoses(); renderStageTable(); });
const gizmoMode = (m) => { S.gizmoOn = !!m; if (m) viewer.gizmo.setMode(m); syncGizmo(); };
$('gizmoT').onclick = () => gizmoMode('translate');
$('gizmoR').onclick = () => gizmoMode('rotate');
$('gizmoOff').onclick = () => gizmoMode(null);
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'g' || e.key === 'G') gizmoMode('translate');
  else if (e.key === 'r' || e.key === 'R') gizmoMode('rotate');
  else if (e.key === 'Escape') { gizmoMode(null); setMode(null); }
  else if (e.key === 'ArrowRight') setStage(Math.min(maxStage(), S.stage + 1));
  else if (e.key === 'ArrowLeft') setStage(Math.max(0, S.stage - 1));
});

// ------------------------------------------------------------------ 歯軸・歯根
function updateRootPanel() {
  const t = S.sel ? toothOf(S.sel) : null;
  if (!t) { $('rootSel').textContent = 'ビューで歯をクリックして選択'; return; }
  $('rootSel').textContent = `${t.fdi} ${t.info.name}（歯冠幅 ${t.width.toFixed(1)} mm, 歯冠高 ${t.crownHeight.toFixed(1)} mm）`;
  $('rootLen').value = t.rootLength;
  $('rootScale').value = t.rootScale;
  $('crRatio').value = t.crRatio;
  $('axTip').value = t.axisAdjust.tip;
  $('axTorque').value = t.axisAdjust.torque;
  drawSections(t);
}
$('rootApply').onclick = () => {
  const t = S.sel ? toothOf(S.sel) : null;
  if (!t) return;
  t.rootLength = num('rootLen'); t.rootScale = num('rootScale'); t.crRatio = num('crRatio');
  t.axisAdjust = { tip: num('axTip'), torque: num('axTorque') };
  const jaw = archOfFdi(t.fdi);
  refreshTooth(S.arches[jaw], t);
  saveToothProps(t);
  drawArch(jaw);
  drawSections(t);
  log(`${t.fdi} の歯根・歯軸を更新（歯軸を変えた場合、移動量の基準軸も変わります）`);
};
function drawSections(t) {
  for (const [id, axis] of [['secBL', 'b'], ['secMD', 'm']]) {
    const cv = $(id), ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, res = 0.1;
    const img = ctx.createImageData(W, H);
    const { z } = t.frame;
    const u = t.frame[axis];
    const top = t.crownHeight + 3;
    if (S.cbct) {
      const inv = mInvRigid(S.cbct.M);
      const wl = num('winL'), ww = num('winW'), lo = wl - ww / 2;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const h = top - y * res, s = (x - W / 2) * res;
        const p = add(add(t.cervical, scale(z, h)), scale(u, s));
        const v = sampleVolume(S.cbct.vol, mApply(inv, p));
        const g = Math.max(0, Math.min(255, ((v - lo) / ww) * 255));
        const o = 4 * (x + W * y);
        img.data[o] = img.data[o + 1] = img.data[o + 2] = g; img.data[o + 3] = 255;
      }
    } else for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);
    // 歯の輪郭（断面と三角形の交線）
    const nrm = axis === 'b' ? t.frame.m : t.frame.b;
    const P = t.mesh.positions, I = t.mesh.indices;
    ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 1.2; ctx.beginPath();
    const toPx = (p) => { const d = sub(p, t.cervical); return [W / 2 + dot(d, u) / res, (top - dot(d, z)) / res]; };
    for (let f = 0; f < I.length; f += 3) {
      const vs = [0, 1, 2].map((k) => [P[3 * I[f + k]], P[3 * I[f + k] + 1], P[3 * I[f + k] + 2]]);
      const ds = vs.map((p) => dot(sub(p, t.cervical), nrm));
      const pts = [];
      for (let k = 0; k < 3; k++) {
        const a = k, b = (k + 1) % 3;
        if ((ds[a] > 0) !== (ds[b] > 0)) { const s = ds[a] / (ds[a] - ds[b]); pts.push(add(vs[a], scale(sub(vs[b], vs[a]), s))); }
      }
      if (pts.length === 2) { const a = toPx(pts[0]), b = toPx(pts[1]); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    }
    ctx.stroke();
    // 歯軸と抵抗中心
    ctx.strokeStyle = '#4cc3ff'; ctx.beginPath();
    const a = toPx(t.occlusalPoint), b = toPx(t.apex); ctx.moveTo(W / 2, a[1]); ctx.lineTo(W / 2, b[1]); ctx.stroke();
    const c = toPx(t.cr); ctx.fillStyle = '#ff4d6d'; ctx.beginPath(); ctx.arc(c[0], c[1], 3, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '11px sans-serif';
    ctx.fillText(axis === 'b' ? '頬舌断（右=頬側）' : '近遠心断（右=近心）', 6, 14);
    if (!S.cbct) ctx.fillText('CBCT 未読込', 6, 28);
  }
}

// ------------------------------------------------------------------ セファロ
const cephSel = $('cephLm');
cephSel.innerHTML = CEPH_LANDMARKS.map((l, i) => `<option value="${i}">${l.name}</option>`).join('');
cephSel.onchange = () => { S.ceph.lm = +cephSel.value; S.ceph.calib = null; };
$('fileCeph').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const url = await readFile(f, 'url');
  loadCephImage(url);
};
function loadCephImage(url) {
  const img = new Image();
  img.onload = () => { S.ceph.img = img; S.ceph.imgURL = url; drawCeph(); };
  img.src = url;
}
$('cephDemo').onclick = () => {
  S.ceph.points = JSON.parse(JSON.stringify(DEMO_CEPH_POINTS));
  S.ceph.pxPerMm = 1;
  S.ceph.img = null; S.ceph.imgURL = null;
  $('cephScale').textContent = '倍率: 1 px = 1 mm（デモ）';
  drawCeph();
};
function cephGeom() {
  const cv = $('cephCanvas');
  const iw = S.ceph.img ? S.ceph.img.naturalWidth : 200, ih = S.ceph.img ? S.ceph.img.naturalHeight : 220;
  const s = Math.min(cv.width / iw, cv.height / ih);
  return { s, ox: (cv.width - iw * s) / 2, oy: (cv.height - ih * s) / 2 };
}
function drawCeph() {
  const cv = $('cephCanvas'), ctx = cv.getContext('2d');
  ctx.fillStyle = '#222'; ctx.fillRect(0, 0, cv.width, cv.height);
  const g = cephGeom();
  if (S.ceph.img) ctx.drawImage(S.ceph.img, g.ox, g.oy, S.ceph.img.naturalWidth * g.s, S.ceph.img.naturalHeight * g.s);
  const P = S.ceph.points;
  const toC = (p) => [g.ox + p[0] * g.s, g.oy + p[1] * g.s];
  const line = (a, b, col) => { if (!P[a] || !P[b]) return; const A = toC(P[a]), B = toC(P[b]); ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(...A); ctx.lineTo(...B); ctx.stroke(); };
  ctx.lineWidth = 1.2;
  line('S', 'N', '#7fd1ff'); line('Po', 'Or', '#9be38b'); line('Go', 'Me', '#ffb86b'); line('U1A', 'U1E', '#ff6b9a'); line('L1A', 'L1E', '#ff6b9a'); line('ANS', 'PNS', '#c7a0ff'); line('A', 'Pog', '#e6e6e6');
  for (const lm of CEPH_LANDMARKS) {
    const p = P[lm.key]; if (!p) continue;
    const c = toC(p);
    ctx.fillStyle = '#ffd400'; ctx.beginPath(); ctx.arc(c[0], c[1], 3.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '11px sans-serif'; ctx.fillText(lm.key, c[0] + 5, c[1] - 4);
  }
  renderCephTable();
}
$('cephCanvas').addEventListener('click', (e) => {
  const cv = $('cephCanvas'), r = cv.getBoundingClientRect();
  const g = cephGeom();
  const x = ((e.clientX - r.left) * (cv.width / r.width) - g.ox) / g.s, y = ((e.clientY - r.top) * (cv.height / r.height) - g.oy) / g.s;
  if (S.ceph.calib) {
    S.ceph.calib.push([x, y]);
    if (S.ceph.calib.length === 2) {
      const d = Math.hypot(S.ceph.calib[0][0] - S.ceph.calib[1][0], S.ceph.calib[0][1] - S.ceph.calib[1][1]);
      S.ceph.pxPerMm = d / num('cephCalibMm');
      $('cephScale').textContent = `倍率: ${S.ceph.pxPerMm.toFixed(2)} px/mm`;
      S.ceph.calib = null;
      $('cephCalib').classList.remove('on');
      drawCeph();
    }
    return;
  }
  const lm = CEPH_LANDMARKS[S.ceph.lm];
  S.ceph.points[lm.key] = [x, y];
  S.ceph.lm = Math.min(CEPH_LANDMARKS.length - 1, S.ceph.lm + 1);
  cephSel.value = S.ceph.lm;
  drawCeph();
});
$('cephCalib').onclick = () => { S.ceph.calib = []; $('cephCalib').classList.add('on'); };
function renderCephTable() {
  const m = measureCeph(S.ceph.points, S.ceph.pxPerMm || 1);
  S.ceph.measured = m;
  const rows = CEPH_MEASURES.map((q) => {
    const v = m[q.key];
    const t = S.ceph.targets[q.key];
    const d = v != null && t !== '' && t != null ? (+t - v) : null;
    const unit = q.linear && !S.ceph.pxPerMm ? 'px' : q.unit;
    return `<tr><td>${q.name}</td><td>${v == null ? '—' : v.toFixed(1) + unit}</td><td><input data-k="${q.key}" type="number" step="0.5" value="${t ?? ''}"></td><td>${d == null ? '' : (d > 0 ? '+' : '') + d.toFixed(1)}</td></tr>`;
  });
  $('cephTable').innerHTML = `<tr><th>項目</th><th>計測</th><th>目標</th><th>差</th></tr>${rows.join('')}`;
  for (const inp of $('cephTable').querySelectorAll('input')) inp.onchange = () => { S.ceph.targets[inp.dataset.k] = inp.value === '' ? null : +inp.value; renderCephTable(); };
}
$('cephApply').onclick = () => {
  const goals = cephToToothGoals(S.ceph.measured || measureCeph(S.ceph.points, S.ceph.pxPerMm || 1), S.ceph.targets);
  S.setupOpt.upper.incisorTorque = +goals.upperIncisorTorque.toFixed(1);
  S.setupOpt.lower.incisorTorque = +goals.lowerIncisorTorque.toFixed(1);
  S.ceph.ojTarget = num('tgtOJ'); S.ceph.obTarget = num('tgtOB');
  loadSetupForm();
  $('cephApplied').textContent = `上顎切歯トルク ${S.setupOpt.upper.incisorTorque > 0 ? '+' : ''}${S.setupOpt.upper.incisorTorque}°（${goals.basis.upper || '計測なし'}）、下顎切歯トルク ${S.setupOpt.lower.incisorTorque > 0 ? '+' : ''}${S.setupOpt.lower.incisorTorque}°（${goals.basis.lower || '計測なし'}）。OJ ${S.ceph.ojTarget} / OB ${S.ceph.obTarget} mm を目標に設定。`;
  log('セファロの目標をセットアップ条件に反映しました', 'ok');
};

// ------------------------------------------------------------------ セットアップ
const OPT_FIELDS = [['optArch', 'archForm', 'sel'], ['optExp', 'expansion'], ['optAdv', 'anteriorAdvance'], ['optTorque', 'incisorTorque'], ['optIpr', 'iprMax'], ['optMaxAdv', 'maxAutoAdvance'],
  ['optMolar', 'keepMolars', 'chk'], ['optLevel', 'leveling', 'chk'], ['optRot', 'correctRotation', 'chk'], ['optMid', 'midline', 'chk'], ['optClose', 'closeSpaces', 'chk']];
function loadSetupForm() {
  const o = S.setupOpt[S.setJaw];
  for (const [id, k, t] of OPT_FIELDS) { if (t === 'chk') $(id).checked = !!o[k]; else $(id).value = o[k]; }
}
function readSetupForm() {
  const o = S.setupOpt[S.setJaw];
  for (const [id, k, t] of OPT_FIELDS) o[k] = t === 'chk' ? $(id).checked : t === 'sel' ? $(id).value : parseFloat($(id).value) || 0;
}
for (const [id] of OPT_FIELDS) $(id).addEventListener('change', readSetupForm);
const setSetJaw = (j) => { S.setJaw = j; $('setUpper').classList.toggle('on', j === 'upper'); $('setLower').classList.toggle('on', j === 'lower'); loadSetupForm(); renderSetupReport(); };
$('setUpper').onclick = () => setSetJaw('upper');
$('setLower').onclick = () => setSetJaw('lower');
function readLimits() {
  return { translation: num('limT'), extrusion: num('limE'), intrusion: num('limI'), tipTorque: num('limA'), rotation: num('limR'), rotationCanPre: num('limR2') };
}
function runSetupFor(j) {
  const arch = S.arches[j];
  if (!arch) { log(`${JAW_JA[j]}の歯モデルがありません`, 'warn'); return false; }
  const r = autoSetup(arch, S.setupOpt[j]);
  S.setupReport[j] = r.report;
  S.plan[j] = autoStage(r.targets, { limits: readLimits(), strategy: $('stStrategy').value });
  return true;
}
$('runSetup').onclick = () => withBusy('自動排列中…', async () => {
  readSetupForm();
  if (runSetupFor(S.setJaw)) afterPlanChange(true);
});
$('runSetupBoth').onclick = () => withBusy('自動排列中…', async () => {
  readSetupForm();
  let ok = false;
  for (const j of JAWS) ok = runSetupFor(j) || ok;
  if (ok) afterPlanChange(true);
});
$('fitOJOB').onclick = () => withBusy('OJ/OB を調整中…', async () => {
  if (!S.arches.upper || !S.arches.lower) return alert('上下顎の歯モデルが必要です');
  if (!S.plan.upper) runSetupFor('upper');
  if (!S.plan.lower) runSetupFor('lower');
  const oj = S.ceph.ojTarget ?? num('tgtOJ'), ob = S.ceph.obTarget ?? num('tgtOB');
  const o = S.setupOpt.upper;
  o.levelOffsets = { ...(o.levelOffsets || {}) };
  for (let it = 0; it < 4; it++) {
    const cur = overjetOverbite(S.arches.upper, S.arches.lower, posesAt(S.plan.upper, S.plan.upper.N), posesAt(S.plan.lower, S.plan.lower.N));
    if (!cur) break;
    const dOJ = oj - cur.overjet, dOB = ob - cur.overbite;
    if (Math.abs(dOJ) < 0.1 && Math.abs(dOB) < 0.1) break;
    o.anteriorAdvance = Math.max(-4, Math.min(4, (o.anteriorAdvance || 0) + dOJ));
    for (const f of [11, 21, 12, 22]) o.levelOffsets[f] = (o.levelOffsets[f] ?? (f % 10 === 2 ? -0.5 : 0)) + dOB;
    o.leveling = true;
    o.lockAdvance = true; // OJ を優先し、前後位置を自動で変えない
    runSetupFor('upper');
  }
  const fin = overjetOverbite(S.arches.upper, S.arches.lower, posesAt(S.plan.upper, S.plan.upper.N), posesAt(S.plan.lower, S.plan.lower.N));
  log(`OJ/OB 調整後: OJ ${fin.overjet.toFixed(1)} mm / OB ${fin.overbite.toFixed(1)} mm（目標 ${oj} / ${ob}）`, 'ok');
  if (S.setJaw === 'upper') loadSetupForm();
  afterPlanChange(true);
});
function renderSetupReport() {
  const r = S.setupReport[S.setJaw];
  const box = $('setupReport');
  if (!r) { box.innerHTML = ''; return; }
  let html = `<div class="kv">
    <span>叢生量の概算（歯冠幅の合計, 右/左）</span><span>${r.discrepancyBefore.right.toFixed(1)} / ${r.discrepancyBefore.left.toFixed(1)} mm</span>
    <span>排列後の残り（右/左, +叢生 −空隙）</span><span>${r.residual.right.toFixed(2)} / ${r.residual.left.toFixed(2)} mm</span>
    <span>前歯部の前後移動（自動）</span><span>${r.autoAdvance.toFixed(2)} mm</span>
    <span>トルク由来の前方移動</span><span>${r.torqueAdvance.toFixed(2)} mm</span></div>`;
  if (r.ipr.length) html += `<p class="note">IPR 計画: ${r.ipr.map((q) => `${q.contact}: ${q.mm.toFixed(2)}mm`).join('、')}</p>`;
  for (const w of r.warnings) html += `<div class="warn">${w}</div>`;
  if (S.arches.upper && S.arches.lower && S.plan.upper && S.plan.lower) {
    const a = overjetOverbite(S.arches.upper, S.arches.lower, new Map(), new Map());
    const b = overjetOverbite(S.arches.upper, S.arches.lower, posesAt(S.plan.upper, S.plan.upper.N), posesAt(S.plan.lower, S.plan.lower.N));
    if (a && b) html += `<div class="kv"><span>OJ 初期→最終</span><span>${a.overjet.toFixed(1)} → ${b.overjet.toFixed(1)} mm</span><span>OB 初期→最終</span><span>${a.overbite.toFixed(1)} → ${b.overbite.toFixed(1)} mm</span></div><p class="note">OJ/OB は中切歯切縁点どうしの概算です。</p>`;
  }
  box.innerHTML = html;
}

// ------------------------------------------------------------------ ステージング
$('stStrategy').innerHTML = Object.entries(STRATEGIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$('runStaging').onclick = () => {
  let any = false;
  for (const j of JAWS) {
    const p = S.plan[j];
    if (!p) continue;
    const targets = new Map(Object.entries(p.teeth).map(([f, q]) => [+f, q.target]));
    S.plan[j] = autoStage(targets, { limits: readLimits(), strategy: $('stStrategy').value });
    any = true;
  }
  if (!any) return alert('先にセットアップを実行してください');
  afterPlanChange(false);
  log('ステージングを再計算しました');
};
function afterPlanChange(goFinal) {
  const N = maxStage();
  S.stage = goFinal ? N : Math.min(S.stage, N);
  $('shTo').value = N;
  updatePoses();
  renderSetupReport();
  renderStageTable();
}
function renderStageTable() {
  const rows = [];
  const issues = [];
  for (const j of JAWS) {
    const p = S.plan[j];
    if (!p) continue;
    issues.push(...checkVelocities(p));
    for (const fdi of archOrder(j)) {
      const tp = p.teeth[fdi];
      if (!tp) continue;
      const need = stagesNeeded(fdi, zeroPose(), tp.target, p.limits);
      rows.push(`<tr><td>${fdi}</td><td><input data-j="${j}" data-f="${fdi}" data-k="start" type="number" min="0" value="${tp.start}"></td><td><input data-j="${j}" data-f="${fdi}" data-k="end" type="number" min="0" value="${tp.end}"></td><td>${need}</td><td>${tp.keys.length || ''}</td></tr>`);
    }
  }
  $('stageTable').innerHTML = rows.length ? `<tr><th>歯</th><th>開始</th><th>終了</th><th>最小</th><th>中間キー</th></tr>${rows.join('')}` : '';
  for (const inp of $('stageTable').querySelectorAll('input')) {
    inp.onchange = () => {
      const p = S.plan[inp.dataset.j], tp = p.teeth[inp.dataset.f];
      tp[inp.dataset.k] = Math.max(0, parseInt(inp.value, 10) || 0);
      if (tp.end < tp.start) tp.end = tp.start;
      p.N = Math.max(...Object.values(p.teeth).map((q) => q.end), 1);
      afterPlanChange(false);
    };
  }
  const N = maxStage();
  let html = `<div class="kv"><span>アライナー枚数（上顎/下顎）</span><span>${S.plan.upper?.N ?? '—'} / ${S.plan.lower?.N ?? '—'}</span><span>全体ステージ数</span><span>${N}</span></div>`;
  if (issues.length) {
    const byTooth = new Map();
    for (const q of issues) byTooth.set(q.fdi, (byTooth.get(q.fdi) || 0) + 1);
    html += `<div class="warn">1ステージの上限を超える移動: ${[...byTooth].map(([f, n]) => `${f}（${n}件）`).join('、')}。終了ステージを延ばすか、自動ステージングを再実行してください。</div>`;
  } else if (N) html += '<p class="note ok">全ステージで移動量は上限内です。</p>';
  if (S.iprSched) html += `<p class="note">IPR の時期: ${S.iprSched.length ? S.iprSched.map((c) => `${c.contact}: 最大 ${c.max.toFixed(2)}mm（ステージ ${c.firstStage} より前に）`).join('、') : '重なりなし'}</p>`;
  $('stagingReport').innerHTML = html;
}
$('checkIPR').onclick = () => withBusy('全ステージの接触を計算中…', async () => {
  // ステージごとに接触を計算（進捗表示のため1ステージずつ）
  const acc = new Map();
  for (const j of JAWS) {
    if (!S.plan[j] || !S.arches[j]) continue;
    for (let k = 0; k <= S.plan[j].N; k++) {
      busy(true, `${JAW_JA[j]} ステージ ${k}/${S.plan[j].N} の接触`, k / S.plan[j].N); await tick();
      for (const c of contactReport(S.arches[j], posesAt(S.plan[j], k), archOrder(j))) {
        const key = `${c.a}-${c.b}`;
        const cur = acc.get(key) || { contact: key, firstStage: null, max: 0 };
        if (c.overlap > 0.05 && cur.firstStage === null) cur.firstStage = k;
        cur.max = Math.max(cur.max, c.overlap);
        acc.set(key, cur);
      }
    }
  }
  S.iprSched = [...acc.values()].filter((c) => c.max > 0.05);
  renderStageTable();
});
$('calcContacts').onclick = () => withBusy('接触を計算中…', async () => {
  const parts = [];
  for (const j of JAWS) {
    if (!S.arches[j]) continue;
    const rep = contactReport(S.arches[j], currentPoses(j), archOrder(j));
    parts.push(`<b>${JAW_JA[j]}</b> ` + rep.map((c) => c.overlap > 0.02 ? `<span class="danger">${c.a}-${c.b} 重なり ${c.overlap.toFixed(2)}</span>` : `${c.a}-${c.b} ${c.gap == null ? '—' : c.gap < 0.05 ? '接触' : `すき間 ${c.gap.toFixed(2)}`}`).join('、'));
  }
  $('contactInfo').innerHTML = parts.join('<br>') || '歯モデルがありません';
});
$('attAdd').onclick = () => {
  const t = S.sel ? toothOf(S.sel) : null;
  if (!t) return alert('歯を選択してください');
  const anchor = buccalAnchor(t);
  t.attachments.push({ anchor, normal: t.frame.b.slice(), width: num('attW'), height: num('attH'), depth: num('attD') });
  saveToothProps(t);
  drawArch(archOfFdi(t.fdi));
  log(`${t.fdi} にアタッチメントを追加`);
};
$('attClear').onclick = () => {
  const t = S.sel ? toothOf(S.sel) : null;
  if (!t) return;
  t.attachments = [];
  saveToothProps(t);
  drawArch(archOfFdi(t.fdi));
};
$('exportCSV').onclick = () => {
  const lines = [];
  for (const j of JAWS) if (S.plan[j]) {
    const rows = stagingTable(S.plan[j]);
    lines.push(...rows.map((r, i) => (i === 0 ? ['jaw', ...r] : [j, ...r]).join(',')).filter((_, i) => i > 0 || lines.length === 0));
  }
  if (!lines.length) return alert('計画がありません');
  download(`${$('caseId').value}_staging.csv`, '﻿' + lines.join('\n'), 'text/csv');
};

// ステージのスライダー・再生
function setStage(k) { S.stage = k; updatePoses(); }
$('stage').oninput = () => setStage(parseInt($('stage').value, 10));
let playTimer = null;
$('play').onclick = () => {
  if (playTimer) { clearInterval(playTimer); playTimer = null; $('play').textContent = '▶'; return; }
  $('play').textContent = '■';
  if (S.stage >= maxStage()) setStage(0);
  playTimer = setInterval(() => {
    if (S.stage >= maxStage()) { clearInterval(playTimer); playTimer = null; $('play').textContent = '▶'; return; }
    setStage(S.stage + 1);
  }, 350);
};

// ------------------------------------------------------------------ アライナー出力
function shellParams() {
  return { voxel: num('shVoxel'), clearance: num('shGap'), thickness: num('shT'), trimOffset: num('shTrim'), blockout: $('shBlock').checked, smooth: parseInt($('shSmooth').value, 10) || 0, decimateError: num('shDec') || 0 };
}
function toothThickness(fdi) {
  if ($('shMode').value !== 'zone') return num('shT');
  const p = positionOf(fdi);
  return p <= 3 ? num('shT') : p <= 5 ? num('shTP') : num('shTM');
}
let worker = null, jobId = 0;
const jobs = new Map();
function runShell(input, wantSTL, name, onProgress) {
  if (!worker) {
    worker = new Worker(new URL('./shell.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const d = e.data, j = jobs.get(d.id);
      if (!j) return;
      if (d.progress !== undefined) { j.onProgress?.(d.progress, d.msg); return; }
      jobs.delete(d.id);
      if (d.error) j.reject(new Error(d.error)); else j.resolve(d);
    };
    worker.onerror = (e) => { for (const j of jobs.values()) j.reject(new Error(e.message || 'Worker エラー')); jobs.clear(); worker = null; };
  }
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, input, wantSTL, name });
  });
}
function posesForStage(jaw, k) { return S.plan[jaw] ? posesAt(S.plan[jaw], Math.min(k, S.plan[jaw].N)) : new Map(); }
$('shPreview').onclick = async () => {
  const jaw = $('shJaw').value;
  const arch = S.arches[jaw];
  if (!arch) return alert(`${JAW_JA[jaw]}の歯モデルがありません`);
  busy(true, 'シェルを生成中…');
  try {
    const input = shellInput(arch, posesForStage(jaw, S.stage), shellParams(), toothThickness);
    const t0 = performance.now();
    const r = await runShell(input, false, '', (p, msg) => busy(true, `シェル生成: ${msg}`, p));
    viewer.clearGroup(`shell_${jaw}`);
    viewer.addMesh(`shell_${jaw}`, new Mesh(r.positions, r.indices), { color: COL.shell, opacity: 0.5, userData: { shell: jaw } });
    setVis('shell', true);
    const wt = r.check.watertight ? '<span class="ok">水密 OK</span>' : `<span class="danger">開いた辺 ${r.check.openEdges}・非多様体 ${r.check.nonManifoldEdges}</span>`;
    $('shStatus').innerHTML = `${JAW_JA[jaw]} ステージ ${S.stage}: ${(r.indices.length / 3).toLocaleString()} 面, 体積 ${r.volume.toFixed(0)} mm³, ${wt}（${((performance.now() - t0) / 1000).toFixed(1)} 秒）`;
  } catch (e) { alert(e.message); log(e.message, 'danger'); } finally { busy(false); }
};
$('shExport').onclick = async () => {
  const from = parseInt($('shFrom').value, 10) || 0, to = parseInt($('shTo').value, 10) || 0;
  const jaws = JAWS.filter((j) => (j === 'upper' ? $('shUp').checked : $('shLo').checked) && S.arches[j]);
  if (!jaws.length) return alert('出力できる顎がありません');
  const id = $('caseId').value.replace(/[^\w-]/g, '_') || 'CASE';
  const files = [];
  const report = [`Aligner Studio export`, `case: ${id}`, `date: ${new Date().toISOString()}`, `params: ${JSON.stringify(shellParams())}`, `thickness mode: ${$('shMode').value} (${num('shT')}/${num('shTP')}/${num('shTM')} mm)`, ''];
  const total = jaws.length * (to - from + 1);
  let n = 0, bad = 0;
  busy(true, '書き出し中…');
  try {
    for (const jaw of jaws) {
      for (let k = from; k <= to; k++) {
        const name = `${id}_${jaw === 'upper' ? 'U' : 'L'}_S${String(k).padStart(2, '0')}`;
        const input = shellInput(S.arches[jaw], posesForStage(jaw, k), shellParams(), toothThickness);
        const r = await runShell(input, true, name, (p, msg) => busy(true, `${name}: ${msg}（${n + 1}/${total}）`, (n + p) / total));
        files.push({ name: `${name}.stl`, data: r.stl });
        if (!r.check.watertight) bad++;
        report.push(`${name}.stl  faces=${r.indices.length / 3}  volume=${r.volume.toFixed(1)}mm3  watertight=${r.check.watertight}`);
        if ($('shModels').checked) files.push({ name: `models/${name}_model.stl`, data: writeSTL(posedModel(jaw, k), `${name}_model`) });
        n++;
      }
    }
    for (const j of JAWS) if (S.plan[j]) files.push({ name: `${id}_${j}_staging.csv`, data: '﻿' + stagingTable(S.plan[j]).map((r) => r.join(',')).join('\n') });
    files.push({ name: `${id}_report.txt`, data: report.join('\n') });
    download(`${id}_aligners.zip`, makeZip(files), 'application/zip');
    $('shExportStatus').innerHTML = `${n} 個の STL を書き出しました${bad ? `<span class="danger">（水密でないもの ${bad} 個）</span>` : '<span class="ok">（すべて水密）</span>'}`;
    log(`ZIP 書き出し完了（${n} 個）`, 'ok');
  } catch (e) { alert(e.message); log(e.message, 'danger'); } finally { busy(false); }
};
function posedModel(jaw, k) {
  const arch = S.arches[jaw];
  const poses = posesForStage(jaw, k);
  const mats = new Map();
  const parts = [];
  for (const [fdi, t] of arch.teeth) { const M = poseMatrix(t, poses.get(fdi) || zeroPose()); mats.set(fdi, M); parts.push(t.mesh.transformed(M)); for (const a of t.attachments) parts.push(attachmentMesh(t, a).transformed(M)); }
  parts.push(morphGingiva(arch.gingiva, mats));
  return mergeMeshes(parts);
}

// ------------------------------------------------------------------ プロジェクト保存・読込
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
$('saveProject').onclick = () => {
  const files = [];
  const plans = {};
  for (const j of JAWS) plans[j] = S.plan[j];
  const proj = {
    version: STORE_VERSION,
    caseId: $('caseId').value,
    seeds: S.seeds, toothProps: S.toothProps, setupOpt: S.setupOpt, plan: plans,
    ceph: { points: S.ceph.points, pxPerMm: S.ceph.pxPerMm, targets: S.ceph.targets, ojTarget: S.ceph.ojTarget, obTarget: S.ceph.obTarget, imgURL: S.ceph.imgURL },
    cbctMatrix: S.cbct?.M || null,
    faceMatrix: S.face?.M || null, faceTex: S.face?.texURL || null,
    hasTeeth: { upper: !!S.arches.upper, lower: !!S.arches.lower },
    limits: readLimits(), shell: shellParams(),
  };
  files.push({ name: 'project.json', data: JSON.stringify(proj) });
  for (const j of JAWS) {
    if (S.scanBuf[j]) files.push({ name: `${j}.stl`, data: S.scanBuf[j] });
    if (S.labels[j]) files.push({ name: `labels_${j}.bin`, data: new Uint8Array(S.labels[j].buffer.slice(0)) });
  }
  if (S.face) files.push({ name: 'face.obj', data: S.face.text });
  download(`${$('caseId').value || 'case'}.alnproj.zip`, makeZip(files), 'application/zip');
  log('プロジェクトを保存しました（CBCT 本体は含まれません。開くときに DICOM を読み直してください）');
};
$('openProject').onchange = (e) => e.target.files[0] && withBusy('プロジェクトを開いています…', async () => {
  const zip = readZip(await readFile(e.target.files[0]));
  const proj = JSON.parse(new TextDecoder().decode(zip.get('project.json')));
  if (proj.version !== STORE_VERSION) log('プロジェクトのバージョンが異なります。読み込めない項目があるかもしれません', 'warn');
  S.toothProps = proj.toothProps || {};
  for (const j of JAWS) {
    const stl = zip.get(`${j}.stl`);
    if (!stl) continue;
    await loadScan(j, stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength), `${j}.stl`);
    S.seeds[j] = proj.seeds?.[j] || [];
    const lb = zip.get(`labels_${j}.bin`);
    if (lb) { S.labels[j] = new Int32Array(lb.buffer.slice(lb.byteOffset, lb.byteOffset + lb.byteLength)); refreshScanColors(j); }
    if (proj.hasTeeth?.[j] && S.labels[j]) buildTeethFor(j);
    S.plan[j] = proj.plan?.[j] || null;
  }
  S.setupOpt = { upper: { ...DEFAULT_SETUP, ...proj.setupOpt?.upper }, lower: { ...DEFAULT_SETUP, ...proj.setupOpt?.lower } };
  Object.assign(S.ceph, proj.ceph || {});
  if (S.ceph.imgURL) loadCephImage(S.ceph.imgURL);
  if (zip.get('face.obj')) { S.face = { M: proj.faceMatrix }; await loadFace(new TextDecoder().decode(zip.get('face.obj')), proj.faceTex); }
  if (proj.cbctMatrix) { S.pendingCbctMatrix = proj.cbctMatrix; log('CBCT の位置合わせ情報があります。DICOM を読み込むと復元されます'); }
  if (proj.caseId) $('caseId').value = proj.caseId;
  loadSetupForm();
  afterPlanChange(true);
  viewer.fit();
  log('プロジェクトを開きました', 'ok');
});
// CBCT 読込時に保存済みの位置合わせを復元
const _loadDicom = loadDicomFiles;
async function loadDicomWithRestore(files) {
  await _loadDicom(files, { autoAlign: !S.pendingCbctMatrix });
  if (S.pendingCbctMatrix && S.cbct) { S.cbct.M = S.pendingCbctMatrix; S.pendingCbctMatrix = null; drawSlices(); log('CBCT の位置合わせを復元しました'); }
}
$('fileDicomDir').onchange = (e) => e.target.files.length && withBusy('DICOM 読込中…', () => loadDicomWithRestore(e.target.files));
$('fileDicom').onchange = (e) => e.target.files.length && withBusy('DICOM 読込中…', () => loadDicomWithRestore(e.target.files));

// ------------------------------------------------------------------ 初期化
setSegJaw('upper');
loadSetupForm();
updatePoses();
renderCephTable();
log(`準備完了（${APP_VERSION}）。「1 取込」でデータを読み込むか、デモ症例を試してください。`);
window.__S = S; // デバッグ用
