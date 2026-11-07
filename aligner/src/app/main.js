// Aligner Studio — 画面とワークフロー
import { Viewer, LABEL_COLORS, makeSliceMesh, meshToGeometry, makeVolumeMesh, THREE } from './viewer.js';
import { Mesh, mergeMeshes, weldIndexed } from '../core/mesh.js';
import { parsePLY } from '../io/ply.js';
import { mApply, mMul, mInvRigid, mTranslate, mIdentity, sub, add, scale, dot, norm, cross } from '../core/vec.js';
import { parseSTL, writeSTL } from '../io/stl.js';
import { parseOBJ } from '../io/obj.js';
import { parseDicomFile, buildVolume, volumeMatrix, sampleVolume } from '../io/dicom.js';
import { makeZip, readZip } from '../io/zip.js';
import { rigidFromPairs, rmsError, icp, autoRegister, frontFacingCandidates, PointGrid } from '../geom/register.js';
import { volumeThresholds, findDentalROI, cropVolume, dentalThresholds } from '../geom/volstats.js';
import { segmentTeeth, paintLabels, fillRegion, concavity, labelCounts, relabelFromCT } from '../geom/segment.js';
import { extractRoot } from '../geom/rootSeg.js';
import { volumeIsosurface, smoothVolume, removeSmallParts } from '../geom/isosurface.js';
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
export const APP_VERSION = 'v0.12（CT の歯冠・歯根を活用）';
$('appVersion').textContent = APP_VERSION;

// ------------------------------------------------------------------ 状態
const S = {
  scans: { upper: null, lower: null },
  scanBuf: { upper: null, lower: null },
  scanExt: { upper: 'stl', lower: 'stl' },
  scanColors: { upper: null, lower: null },
  scanShade: { upper: null, lower: null },
  labels: { upper: null, lower: null },
  seeds: { upper: [], lower: [] },
  missing: { upper: [], lower: [] },
  arches: { upper: null, lower: null },
  toothProps: {},
  cbctRoots: {},
  cbctTeeth: {},
  cbctCrowns: {},
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
  vis: { upper: true, lower: true, scan: true, gingiva: true, roots: false, iso: false, bone: false, skin: false, vr: true, cbct3d: true, slices: false, face: true, shell: true },
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
  ['cbct3d', 'CBCT 立体'], ['slices', 'CBCT 断面'], ['face', '顔'], ['shell', 'アライナー'],
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
  viewer.setVisible('iso', S.vis.cbct3d && S.vis.iso);
  viewer.setVisible('bone', S.vis.cbct3d && !!S.vis.bone);
  viewer.setVisible('skin', S.vis.cbct3d && !!S.vis.skin);
  viewer.setVisible('vr', S.vis.cbct3d && !!S.vis.vr);
  viewer.setVisible('slices', S.vis.slices);
  viewer.setVisible('face', S.vis.face);
}
const setVis = (k, v) => { S.vis[k] = v; const b = document.querySelector(`[data-vis="${k}"]`); if (b) b.classList.toggle('on', v); applyVisibility(); };

// ------------------------------------------------------------------ 取込
async function loadScan(jaw, buf, name = '') {
  const ext = (name.match(/\.(\w+)$/)?.[1] || 'stl').toLowerCase();
  let mesh, colors = null;
  if (ext === 'ply') { const r = parsePLY(buf); ({ mesh, colors } = weldIndexed(r.positions, r.indices, r.colors)); }
  else if (ext === 'obj') { const r = parseOBJ(new TextDecoder().decode(new Uint8Array(buf))); ({ mesh, colors } = weldIndexed(r.positions, r.indices, r.colors)); }
  else mesh = parseSTL(buf);
  S.scans[jaw] = mesh;
  S.scanBuf[jaw] = buf;
  S.scanExt[jaw] = ext;
  S.scanColors[jaw] = colors;
  S.scanShade[jaw] = curvatureShade(mesh);
  S.labels[jaw] = null;
  S.seeds[jaw] = [];
  S.arches[jaw] = null;
  S.plan[jaw] = null;
  drawScan(jaw);
  updateScanStatus();
  log(`${JAW_JA[jaw]}スキャン ${name} を読み込み（${mesh.nf.toLocaleString()} 面${colors ? '・色あり' : ''}）`);
}
function updateScanStatus() {
  $('statusScan').textContent = JAWS.map((j) => `${JAW_JA[j]}: ${S.scans[j] ? `${S.scans[j].nf.toLocaleString()} 面` : '未読込'}`).join(' / ');
}
$('fileUpper').onchange = (e) => e.target.files[0] && withBusy('スキャン読込中…', async () => { await loadScan('upper', await readFile(e.target.files[0]), e.target.files[0].name); viewer.fit(); });
$('fileLower').onchange = (e) => e.target.files[0] && withBusy('スキャン読込中…', async () => { await loadScan('lower', await readFile(e.target.files[0]), e.target.files[0].name); viewer.fit(); });

async function loadDicomFiles(files, { autoAlign = false } = {}) {
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
async function setVolume(vol, { autoAlign = false, fails = 0 } = {}) {
  const Mv = volumeMatrix(vol);
  // 初期配置：CBCT の中心をスキャンの中心へ
  const c = mApply(Mv, vol.dims.map((d) => (d - 1) / 2));
  const sc = scanCenter();
  S.cbct = { vol, M: mTranslate(sub(sc, c)), iso: null, slice: [0.5, 0.5, 0.5] };
  $('statusCT').textContent = `${vol.dims.join('×')} ボクセル, ${vol.spacing.map((s) => s.toFixed(2)).join('×')} mm${vol.info.downsample > 1 ? `（1/${vol.info.downsample} に間引き）` : ''}${fails ? `, 読めないファイル ${fails}` : ''}`;
  log(`CBCT 読込: ${vol.info.slices} スライス`);
  // しきい値を自動で決める（撮影範囲外の埋め値を除外）
  const th = volumeThresholds(vol);
  S.cbct.thr = th;
  // 歯のある範囲（最も明るい部分の集まり）を見つけ、その周辺だけを立体化する
  busy(true, '歯の範囲を探しています…', 0.93); await tick();
  const roi = findDentalROI(vol);
  S.cbct.roi = roi;
  S.cbct.sub = cropVolume(vol, roi);
  const dth = dentalThresholds(S.cbct.sub);
  S.cbct.dthr = dth;
  $('isoThr').value = Math.round(dth.teeth);
  busy(true, 'CBCT の立体表示を作成中…', 0.95); await tick();
  buildIso();
  setVis('slices', false);
  setVis('iso', true);
  drawSlices();
  log(`しきい値（自動）: 歯 ${Math.round(dth.teeth)} / 骨 ${Math.round(dth.bone)} / 皮膚 ${Math.round(th.skin)}${roi.found ? '（歯の範囲を自動検出）' : '（歯の範囲が見つからず全体を使用）'}`);
  if (autoAlign && (S.scans.upper || S.scans.lower)) await autoAlignScanCbct();
  if (autoAlign && S.face) await autoAlignFace();
  S.cbct.bone = null; S.cbct.skin = null;
  $('boneThr').value = Math.round(th.bone);
  $('skinThr').value = Math.round(th.skin);
  S.cbct.thr.range = th.max - th.skin;
  // CT 全体をボリュームレンダリングで表示（しきい値はスライダーで即時に変えられる）
  busy(true, 'ボリューム表示を準備中…', 0.97); await tick();
  buildVR(th);
  S.vis.iso = false; S.vis.bone = false; S.vis.vr = true; setVis('cbct3d', true);
  redrawCbctExtras();
  renderLmTables();
  if (!autoAlign) log('CBCT を読み込みました。「2 位置合わせ」で基準点を打って合わせてください', 'ok');
  viewer.fit();
}
/** 歯の範囲（切り出し済み）の等値面を作る */
function buildIso(thr = num('isoThr')) {
  const sub = S.cbct.sub || S.cbct.vol, Mv = volumeMatrix(sub);
  const n = sub.dims[0] * sub.dims[1] * sub.dims[2];
  const step = n > 24e6 ? 2 : 1;
  $('isoStep').value = String(step);
  S.cbct.iso = volumeIsosurface(sub, thr, step, (i, j, k) => mApply(Mv, [i, j, k]));
  S.cbct.isoThrUsed = thr;
  drawIso();
  log(`CBCT 等値面（歯の周囲）: ${S.cbct.iso.nf.toLocaleString()} 面（しきい値 ${Math.round(thr)}）`);
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
  const up = scanUp();
  const pts = crownPoints(up);
  // しきい値を変えて最大 2 回試し、一致率の高い方を採用
  const t0 = num('isoThr');
  const tries = [t0];
  if (S.cbct.dthr) tries.push((S.cbct.dthr.bone + S.cbct.dthr.teeth) / 2);
  let best = null;
  for (let i = 0; i < tries.length; i++) {
    if (i > 0) { if (best.inlier >= 0.35) break; busy(true, `しきい値 ${Math.round(tries[i])} で再計算中…`); await tick(); buildIso(tries[i]); }
    busy(true, `スキャン ⇄ CBCT を自動で位置合わせ中…（${i + 1}/${tries.length}、数十秒かかることがあります）`); await tick();
    const r = autoRegister(pts, S.cbct.iso.positions, { upSrc: up, upDst: [0, 0, 1], shifts: [-8, -4, 0, 4, 8], dstNormals: S.cbct.iso.vertexNormals() });
    if (r && (!best || r.inlier > best.inlier)) best = { ...r, thr: tries[i] };
  }
  if (!best) { log('自動位置合わせに失敗しました。対応点で合わせてください', 'warn'); return; }
  if (S.cbct.isoThrUsed !== best.thr) buildIso(best.thr);
  $('isoThr').value = Math.round(best.thr);
  const newM = mInvRigid(best.matrix); // CBCT → スキャン
  if (S.face?.alignedToCbct) { S.face.M = mMul(newM, mMul(mInvRigid(S.cbct.M), S.face.M)); drawFace(); }
  S.cbct.M = newM;
  drawIso(); drawSlices();
  const msg = `スキャン⇄CBCT 自動位置合わせ: 一致率 ${(best.inlier * 100).toFixed(0)}%（0.5mm 以内）, 誤差 ${best.rms.toFixed(2)} mm, しきい値 ${Math.round(best.thr)}`;
  $('regResult').textContent = msg;
  if (best.inlier < 0.35) log(`${msg}。一致率が低いため結果を確認してください（ずれていれば「2 位置合わせ」で対応点を打つか、しきい値を変えて再実行）`, 'warn');
  else log(msg, 'ok');
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
  busy(true, 'CBCT の皮膚表面を作成中…'); await tick();
  if (!S.cbct.skin) {
    // 撮影範囲外の埋め値は空気として扱う（しきい値より低いので自然に空気側になる）
    const vol = S.cbct.vol, Mv = volumeMatrix(vol);
    const step = vol.dims[0] * vol.dims[1] * vol.dims[2] > 8e6 ? 2 : 1;
    S.cbct.skin = volumeIsosurface(vol, S.cbct.thr.skin, step, (i, j, k) => mApply(Mv, [i, j, k]));
  }
  const fm = new Mesh(S.face.obj.positions, S.face.obj.indices);
  const front = meanNormal(fm);
  const P = S.face.obj.positions;
  busy(true, '顔 ⇄ CBCT を自動で位置合わせ中…（正面の向きをそろえてから細かく合わせます）'); await tick();
  // CT（DICOM の患者座標）では上 = +z、前 = −y。保存の向きが違う CT のために +y も試す
  const init = frontFacingCandidates(P, S.cbct.skin.positions, { frontSrc: front, frontDsts: [[0, -1, 0], [0, 1, 0]], upDst: [0, 0, 1] });
  // 顔の正面が CT の前後方向（±y）を向いている姿勢だけを採用
  const faceOk = (M) => Math.abs(M[1] * front[0] + M[5] * front[1] + M[9] * front[2]) > Math.cos((35 * Math.PI) / 180);
  const best = autoRegister(P, S.cbct.skin.positions, {
    initial: init, accept: faceOk, dstNormals: S.cbct.skin.vertexNormals(),
    coarse: [[20, 3], [10, 3], [5, 3], [3, 3]], fine: [[6, 10], [3, 10], [1.5, 10], [0.8, 10]],
  });
  if (!best) { log('顔の自動位置合わせに失敗しました。対応点で合わせてください', 'warn'); return; }
  S.face.M = mMul(S.cbct.M, best.matrix); // 顔 → CBCT → スキャン
  S.face.alignedToCbct = true;
  drawFace();
  const msg = `顔⇄CBCT 自動位置合わせ: 一致率 ${(best.inlier * 100).toFixed(0)}%, 誤差 ${best.rms.toFixed(2)} mm`;
  log(best.inlier < 0.2 ? `${msg}。一致率が低いため結果を確認してください（顔スキャンは撮影範囲外の部分も含むため、一致率は低めに出ます）` : msg, best.inlier < 0.2 ? 'warn' : 'ok');
}
$('autoRegScan').onclick = () => {
  if (!S.cbct) return alert('先に CBCT を読み込んでください');
  if (!S.scans.upper && !S.scans.lower) return alert('先に口腔内スキャンを読み込んでください');
  withBusy('自動位置合わせ中…', async () => { if (!S.cbct.iso) buildIso(); await autoAlignScanCbct(); redrawCbctExtras(); renderLmTables(); });
};
$('autoRegFace').onclick = () => {
  if (!S.face) return alert('先に顔スキャンを読み込んでください');
  withBusy('自動位置合わせ中…', async () => { await autoAlignFace(); renderLmTables(); });
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
  renderLmTables();
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
  await setVolume(vol, { autoAlign: true });
  redrawCbctExtras(); renderLmTables();
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
/** 曲率による陰影係数（くぼみを暗く、とがりを少し明るく）。裂溝・咬頭・歯頸線が見やすくなる */
function curvatureShade(mesh) {
  const K = mesh.curvature(1);
  const a = [];
  for (let i = 0; i < K.length; i += Math.max(1, Math.floor(K.length / 20000))) a.push(Math.abs(K[i]));
  a.sort((x, y) => x - y);
  const sc = a[Math.floor(a.length * 0.9)] || 1;
  const f = new Float32Array(K.length);
  for (let i = 0; i < K.length; i++) f[i] = Math.max(0.45, Math.min(1.15, 1 + 0.4 * (K[i] / sc)));
  return f;
}
const IVORY = [0.93, 0.91, 0.86], GUM = [0.88, 0.6, 0.6];
/** スキャンの頂点 i の基本色（色付きスキャンならその色） */
const scanBase = (jaw, i, fallback = IVORY) => { const C = S.scanColors[jaw]; return C ? [C[3 * i], C[3 * i + 1], C[3 * i + 2]] : fallback; };
function labelColors(jaw) {
  const mesh = S.scans[jaw], L = S.labels[jaw], sh = S.scanShade[jaw];
  const C = new Float32Array(mesh.nv * 3);
  const hasCol = !!S.scanColors[jaw];
  for (let i = 0; i < mesh.nv; i++) {
    let c = scanBase(jaw, i);
    if (L) { const lc = LABEL_COLORS.get(L[i]) || [0.8, 0.8, 0.8]; c = hasCol ? c.map((x, k) => x * 0.45 + lc[k] * 0.55) : lc; }
    const f = sh ? sh[i] : 1;
    C[3 * i] = c[0] * f; C[3 * i + 1] = c[1] * f; C[3 * i + 2] = c[2] * f;
  }
  return C;
}
/** 部分メッシュ（歯冠・歯肉）の頂点色：元のスキャンの色と陰影を引き継ぐ */
function subColors(jaw, fromOld, fallback) {
  const sh = S.scanShade[jaw];
  const C = new Float32Array(fromOld.length * 3);
  for (let i = 0; i < fromOld.length; i++) {
    const o = fromOld[i], c = scanBase(jaw, o, fallback), f = sh ? sh[o] : 1;
    C[3 * i] = c[0] * f; C[3 * i + 1] = c[1] * f; C[3 * i + 2] = c[2] * f;
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
  for (const j of JAWS) {
    if (!S.scans[j] || j !== S.segJaw) continue;
    for (const s of S.seeds[j]) {
      const c = LABEL_COLORS.get(s.label) || [1, 0, 0];
      viewer.addMarker(S.scans[j].p(s.vertex), new THREE.Color(c[0] * 0.7, c[1] * 0.7, c[2] * 0.7).getHex(), 0.45);
    }
  }
}

const COL = { crown: 0xf4f0e4, crownSel: 0xffd36e, root: 0xd8c08a, cbctRoot: 0x7cc9b4, ging: 0xe9a7a6, shell: 0x6fa8ff, att: 0x9fe0c0 };
function drawArch(jaw) {
  viewer.clearGroup(`teeth_${jaw}`);
  viewer.clearGroup(`ging_${jaw}`);
  const arch = S.arches[jaw];
  if (!arch) return;
  for (const [fdi, t] of arch.teeth) {
    const crown = viewer.addMesh(`teeth_${jaw}`, t.crown, { color: fdi === S.sel ? COL.crownSel : 0xffffff, colors: t.crown.fromOld ? subColors(jaw, t.crown.fromOld, IVORY) : null, userData: { fdi, jaw, vc: !!t.crown.fromOld } });
    crown.matrixAutoUpdate = false;
    const rootIdx = t.mesh.indices.subarray(t.rootFaceStart * 3);
    const showFull = $('showCtTooth')?.checked && t.cbctTooth;
    const root = showFull
      ? viewer.addMesh(`teeth_${jaw}`, t.cbctTooth, { color: COL.cbctRoot, opacity: 0.5, userData: { fdi, jaw, root: true } })
      : t.cbctRoot
      ? viewer.addMesh(`teeth_${jaw}`, t.cbctRoot, { color: COL.cbctRoot, opacity: 0.8, userData: { fdi, jaw, root: true } })
      : viewer.addMesh(`teeth_${jaw}`, new Mesh(t.mesh.positions, rootIdx), { color: COL.root, opacity: 0.55, userData: { fdi, jaw, root: true } });
    root.matrixAutoUpdate = false;
    for (const att of t.attachments) {
      const a = viewer.addMesh(`teeth_${jaw}`, attachmentMesh(t, att), { color: COL.att, userData: { fdi, jaw, att: true } });
      a.matrixAutoUpdate = false;
    }
  }
  const g = viewer.addMesh(`ging_${jaw}`, arch.gingiva.mesh, { color: 0xffffff, colors: arch.gingiva.fromOld ? subColors(jaw, arch.gingiva.fromOld, GUM) : null, opacity: 0.9, doubleSide: true, userData: { ging: jaw } });
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
      if (!c.userData.root && !c.userData.att) c.material.color.setHex(c.userData.fdi === S.sel ? COL.crownSel : c.userData.vc ? 0xffffff : COL.crown);
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
  withBusy('等値面を作成中…', async () => { buildIso(); setVis('iso', true); });
};
// ---- 基準点（ランドマーク） ----
// CBCT の点は CBCT 自身の座標（位置合わせ行列をかける前）、スキャンの点はスキャン座標、顔の点は顔スキャン自身の座標で保存する
const REF_POINTS = [
  { key: 'ANS', name: 'ANS（前鼻棘）' },
  { key: 'REAM', name: '右 外耳道中央' },
  { key: 'LEAM', name: '左 外耳道中央' },
  { key: 'N', name: 'N（ナジオン）' },
];
const SCAN_PRESETS = {
  upper: ['右上6 近心頬側咬頭頂', '右上3 尖頭', '上顎中切歯間 切縁', '左上3 尖頭', '左上6 近心頬側咬頭頂'],
  lower: ['右下6 近心頬側咬頭頂', '右下3 尖頭', '下顎中切歯間 切縁', '左下3 尖頭', '左下6 近心頬側咬頭頂'],
  both: ['右上6 近心頬側咬頭頂', '上顎中切歯間 切縁', '左上6 近心頬側咬頭頂', '右下6 近心頬側咬頭頂', '下顎中切歯間 切縁', '左下6 近心頬側咬頭頂'],
};
const FACE_POINTS = ['軟組織ナジオン', '鼻尖', '右 外眼角', '左 外眼角', '軟組織ポゴニオン'];
const FACE_SCAN_POINTS = ['右上3 尖頭', '12|11 歯間（切縁側）', '11|21 歯間（正中・切縁側）', '21|22 歯間（切縁側）', '左上3 尖頭'];
// 各セットの点がどのデータに打たれるか
const LM_SIDES = { scan: ['cbct', 'scan'], face: ['cbct', 'face'], faceScan: ['scan', 'face'] };
S.lm = {
  ref: {},
  scan: SCAN_PRESETS.upper.map((name) => ({ name, cbct: null, scan: null })),
  face: FACE_POINTS.map((name) => ({ name, cbct: null, face: null })),
  faceScan: FACE_SCAN_POINTS.map((name) => ({ name, scan: null, face: null })),
  faceMode: 'scan',
  showPlanes: true, useFrame: false,
};
S.lmTarget = null; // { set: 'ref'|'scan'|'face', idx|key, side: 'cbct'|'scan'|'face' }

const cbctToWorld = (p) => mApply(S.cbct.M, p);
const fmt = (p) => (p ? '✓' : '—');
function lmCell(set, idx, side, p) {
  const on = S.lmTarget && S.lmTarget.set === set && S.lmTarget.idx === idx && S.lmTarget.side === side;
  return `<td><button data-set="${set}" data-idx="${idx}" data-side="${side}" class="${on ? 'on' : ''}" style="min-width:52px">${on ? '打つ…' : fmt(p)}</button></td>`;
}
function renderLmTables() {
  // 基準平面
  $('refTable').innerHTML = '<tr><th>点</th><th>CBCT</th></tr>' + REF_POINTS.map((r) => `<tr><td>${r.name}</td>${lmCell('ref', r.key, 'cbct', S.lm.ref[r.key])}</tr>`).join('');
  const err = S.lm.scanErr || [];
  $('scanLmTable').innerHTML = '<tr><th>#</th><th>点</th><th>CBCT</th><th>スキャン</th><th>誤差</th></tr>' + S.lm.scan.map((q, i) =>
    `<tr><td>${i + 1}</td><td>${q.name}</td>${lmCell('scan', i, 'cbct', q.cbct)}${lmCell('scan', i, 'scan', q.scan)}<td>${err[i] != null ? err[i].toFixed(2) : ''}</td></tr>`).join('');
  const fset = faceSet();
  const ferr = (fset === 'faceScan' ? S.lm.faceScanErr : S.lm.faceErr) || [];
  const fOther = fset === 'faceScan' ? 'scan' : 'cbct';
  $('faceTarget').value = S.lm.faceMode;
  $('faceLmTable').innerHTML = `<tr><th>#</th><th>点</th><th>${fset === 'faceScan' ? 'スキャン' : 'CBCT'}</th><th>顔</th><th>誤差</th></tr>` + S.lm[fset].map((q, i) =>
    `<tr><td>${i + 1}</td><td>${q.name}</td>${lmCell(fset, i, fOther, q[fOther])}${lmCell(fset, i, 'face', q.face)}<td>${ferr[i] != null ? ferr[i].toFixed(2) : ''}</td></tr>`).join('');
  for (const tb of ['refTable', 'scanLmTable', 'faceLmTable']) for (const b of $(tb).querySelectorAll('button')) {
    b.onclick = () => {
      const idx = b.dataset.set === 'ref' ? b.dataset.idx : +b.dataset.idx;
      const t = { set: b.dataset.set, idx, side: b.dataset.side };
      if (S.lmTarget && S.lmTarget.set === t.set && S.lmTarget.idx === t.idx && S.lmTarget.side === t.side) { S.lmTarget = null; setMode(null); }
      else { S.lmTarget = t; setMode('lm'); }
      renderLmTables();
    };
  }
  drawLmMarkers();
  updateRefFrame();
}
const faceSet = () => (S.lm.faceMode === 'cbct' ? 'face' : 'faceScan');
$('faceTarget').onchange = () => {
  S.lm.faceMode = $('faceTarget').value;
  $('faceTargetNote').textContent = S.lm.faceMode === 'cbct'
    ? '軟組織の点（鼻尖・外眼角など）を、CBCT の顔貌（ボリューム表示の顔貌プリセット）と顔スキャンの両方に打ちます。'
    : 'スマイルで見えている前歯の歯間（切縁側の鼓形空隙の頂点）や犬歯の尖頭を、顔スキャンと口腔内スキャンの両方に同じ順で打ちます。';
  S.lmTarget = null; setMode(null); renderLmTables();
};
function lmName(t) {
  if (t.set === 'ref') return REF_POINTS.find((r) => r.key === t.idx).name;
  return `${t.idx + 1}. ${S.lm[t.set][t.idx].name}`;
}
function drawLmMarkers() {
  viewer.clearMarkers();
  const tab = document.querySelector('#tabs button.on')?.dataset.step;
  viewer.setVisible('refplanes', tab === 'register'); // 基準平面は位置合わせのタブでだけ表示
  if (tab !== 'register') return drawSeeds();
  if (S.cbct) for (const r of REF_POINTS) {
    const p = S.lm.ref[r.key];
    if (!p) continue;
    const w = cbctToWorld(p);
    viewer.addMarker(w, 0x3b82f6, 0.8); viewer.addLabel(w, r.key, '#9cc3ff');
  }
  S.lm.scan.forEach((q, i) => {
    if (q.cbct && S.cbct) { const w = cbctToWorld(q.cbct); viewer.addMarker(w, 0xff4466, 0.55); viewer.addLabel(w, `${i + 1}`, '#ff8fa6'); }
    if (q.scan) { viewer.addMarker(q.scan, 0x22aa66, 0.55); viewer.addLabel(q.scan, `${i + 1}`, '#7ee2a8'); }
  });
  if (faceSet() === 'face') S.lm.face.forEach((q, i) => {
    if (q.cbct && S.cbct) { const w = cbctToWorld(q.cbct); viewer.addMarker(w, 0xff9f1c, 0.7); viewer.addLabel(w, `F${i + 1}`, '#ffc46b'); }
    if (q.face && S.face) { const w = mApply(S.face.M, q.face); viewer.addMarker(w, 0xb36bff, 0.7); viewer.addLabel(w, `F${i + 1}`, '#d4a8ff'); }
  });
  if (faceSet() === 'faceScan') S.lm.faceScan.forEach((q, i) => {
    if (q.scan) { viewer.addMarker(q.scan, 0x14b8a6, 0.4); viewer.addLabel(q.scan, `S${i + 1}`, '#5eead4'); }
    if (q.face && S.face) { const w = mApply(S.face.M, q.face); viewer.addMarker(w, 0xb36bff, 0.4); viewer.addLabel(w, `S${i + 1}`, '#d4a8ff'); }
  });
}
/** 次に打つ欄へ進む（同じ側の次の点。全部埋まったら反対側の最初の空き） */
function advanceLm() {
  const t = S.lmTarget;
  if (!t) return;
  if (t.set === 'ref') {
    const i = REF_POINTS.findIndex((r) => r.key === t.idx);
    const nxt = REF_POINTS.slice(i + 1).find((r) => !S.lm.ref[r.key]);
    S.lmTarget = nxt ? { ...t, idx: nxt.key } : null;
  } else {
    const list = S.lm[t.set];
    const other = LM_SIDES[t.set].find((x) => x !== t.side);
    let j = list.findIndex((q, k) => k > t.idx && !q[t.side]);
    if (j >= 0) S.lmTarget = { ...t, idx: j };
    else { j = list.findIndex((q) => !q[other]); S.lmTarget = j >= 0 ? { ...t, side: other, idx: j } : null; }
  }
  if (!S.lmTarget) setMode(null); else setMode('lm');
}
function lmPick(e) {
  const t = S.lmTarget;
  if (!t) return;
  if (t.side === 'cbct') {
    if (!S.cbct) return alert('先に CBCT を読み込んでください');
    const hit = viewer.pick(e, ['iso', 'bone', 'skin', 'slices'].map((g) => viewer.group(g)));
    const vh = pickVolume(e);
    let p = hit ? mApply(mInvRigid(S.cbct.M), [hit.point.x, hit.point.y, hit.point.z]) : null;
    if (vh && (!hit || vh.dist < hit.distance)) p = vh.cbct;
    if (!p) return;
    if (t.set === 'ref') S.lm.ref[t.idx] = p; else S.lm[t.set][t.idx].cbct = p;
  } else if (t.side === 'scan') {
    const hit = viewer.pick(e, JAWS.flatMap((j) => [viewer.group(`scan_${j}`), viewer.group(`teeth_${j}`)]));
    if (!hit) return;
    S.lm[t.set][t.idx].scan = [hit.point.x, hit.point.y, hit.point.z];
  } else {
    if (!S.face) return alert('先に顔スキャンを読み込んでください');
    const hit = viewer.pick(e, [viewer.group('face')]);
    if (!hit) return;
    S.lm[t.set][t.idx].face = mApply(mInvRigid(S.face.M), [hit.point.x, hit.point.y, hit.point.z]);
  }
  advanceLm();
  renderLmTables();
}

// 基準平面（カンペル平面・正中矢状面）と患者座標系
function refFrame() {
  const r = S.lm.ref;
  if (!S.cbct || !r.ANS || !r.REAM || !r.LEAM) return null;
  const A = cbctToWorld(r.ANS), R = cbctToWorld(r.REAM), L = cbctToWorld(r.LEAM);
  const earMid = scale(add(R, L), 0.5);
  let z = norm(cross(sub(L, A), sub(R, A)));
  // 上向き：N があれば N 側、なければ CT の頭側
  const upHint = r.N ? sub(cbctToWorld(r.N), A) : sub(mApply(S.cbct.M, [0, 0, 100]), mApply(S.cbct.M, [0, 0, 0]));
  if (dot(z, upHint) < 0) z = scale(z, -1);
  const midRef = r.N ? cbctToWorld(r.N) : earMid;
  // 正中矢状面：カンペル平面の法線と、ANS→（N または外耳道中点）を含む面。その法線を左右軸にする
  let x = norm(cross(sub(midRef, A), z));
  if (dot(x, sub(L, R)) < 0) x = scale(x, -1); // x = 患者の左
  const y = cross(z, x); // 後方（LPS 右手系）
  const F = [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, A[0], A[1], A[2], 1];
  const angle = (u, v) => (Math.acos(Math.max(-1, Math.min(1, dot(norm(u), norm(v))))) * 180) / Math.PI;
  return { F, A, R, L, x, y, z, earMid, earDist: Math.hypot(...sub(L, R)), asym: Math.abs(dot(sub(R, A), x) + dot(sub(L, A), x)) / 2, tilt: angle(z, upHint) };
}
function updateRefFrame() {
  viewer.clearGroup('refplanes');
  const f = refFrame();
  if (!f) {
    $('refStatus').textContent = 'ANS・左右外耳道中央の3点を打つとカンペル平面ができます。';
    if (S.lm.useFrame) { S.lm.useFrame = false; viewer.setDisplayFrame(null); }
    $('useRefFrame').classList.remove('on');
    return;
  }
  if (S.lm.showPlanes) {
    const size = Math.max(90, f.earDist * 1.3);
    const cC = add(scale(add(f.A, f.earMid), 0.5), [0, 0, 0]);
    viewer.addPlane('refplanes', cC, f.z, size, 0x3b82f6, f.x);
    viewer.addPlane('refplanes', cC, f.x, size, 0xef4444, f.y);
  }
  $('showRefPlanes').classList.toggle('on', S.lm.showPlanes);
  $('useRefFrame').classList.toggle('on', S.lm.useFrame);
  if (S.lm.useFrame) viewer.setDisplayFrame(f.F);
  $('refStatus').innerHTML = `カンペル平面（青）・正中矢状面（赤）を設定。外耳道中央の間隔 ${f.earDist.toFixed(1)} mm、正中からの左右差 ${f.asym.toFixed(1)} mm${S.lm.ref.N ? '' : '（N 未設定：外耳道の中点を正中に使用）'}`;
}
$('showRefPlanes').onclick = () => { S.lm.showPlanes = !S.lm.showPlanes; updateRefFrame(); };
$('useRefFrame').onclick = () => {
  if (!refFrame()) return alert('ANS と左右外耳道中央を先に指定してください');
  S.lm.useFrame = !S.lm.useFrame;
  if (!S.lm.useFrame) viewer.setDisplayFrame(null);
  updateRefFrame();
  viewer.fit();
  viewer.view('front');
};

// 対応点で合わせる
function pairs(list, a, b) { return list.filter((q) => q[a] && q[b]); }
$('scanLmSolve').onclick = () => {
  if (!S.cbct) return alert('先に CBCT を読み込んでください');
  const ps = pairs(S.lm.scan, 'cbct', 'scan');
  if (ps.length < 3) return alert('CBCT とスキャンの両方に打った点が 3 組以上必要です');
  const M = rigidFromPairs(ps.map((q) => q.cbct), ps.map((q) => q.scan)); // CBCT → スキャン
  setCbctMatrix(M, '対応点');
};
function setCbctMatrix(M, how) {
  S.lm.prevM = S.cbct.M;
  if (S.face?.alignedToCbct) { S.face.M = mMul(M, mMul(mInvRigid(S.cbct.M), S.face.M)); drawFace(); }
  S.cbct.M = M;
  drawIso(); drawSlices(); redrawCbctExtras();
  const ps = pairs(S.lm.scan, 'cbct', 'scan');
  S.lm.scanErr = S.lm.scan.map((q) => (q.cbct && q.scan ? Math.hypot(...sub(mApply(M, q.cbct), q.scan)) : null));
  const rms = ps.length ? Math.sqrt(ps.reduce((s0, q) => s0 + Math.hypot(...sub(mApply(M, q.cbct), q.scan)) ** 2, 0) / ps.length) : NaN;
  const msg = `スキャン⇄CBCT（${how}）: 対応点の誤差 RMS ${isFinite(rms) ? rms.toFixed(2) : '—'} mm（${ps.length} 点）`;
  $('regResult').textContent = msg;
  log(msg, isFinite(rms) && rms > 1.5 ? 'warn' : 'ok');
  if (isFinite(rms) && rms > 1.5) log('誤差が大きい点（表の「誤差」列）を打ち直してください', 'warn');
  renderLmTables();
}
$('scanLmUndo').onclick = () => { if (S.lm.prevM) { const m = S.lm.prevM; setCbctMatrix(m, '元に戻す'); S.lm.prevM = null; } };
$('scanLmRefine').onclick = () => {
  if (!S.cbct?.iso) return alert('先に CBCT を読み込んでください');
  withBusy('表面で微調整中…', async () => {
    const up = scanUp();
    const pts = crownPoints(up);
    // 現在位置の近くだけを探す（大きく外れない）。スキャン→CBCT で ICP し、逆をかける
    const r = icp(pts, S.cbct.iso.positions, mInvRigid(S.cbct.M), { iterations: 40, maxDist: 1.5, samples: 5000 });
    const before = S.cbct.M;
    const M = mInvRigid(r.matrix);
    // 対応点の誤差が大きく悪化したら採用しない
    const ps = pairs(S.lm.scan, 'cbct', 'scan');
    const e = (MM) => (ps.length ? Math.sqrt(ps.reduce((s0, q) => s0 + Math.hypot(...sub(mApply(MM, q.cbct), q.scan)) ** 2, 0) / ps.length) : 0);
    if (ps.length >= 3 && e(M) > e(before) + 1.0) { log(`微調整で対応点の誤差が ${e(before).toFixed(2)} → ${e(M).toFixed(2)} mm に悪化したため、採用しませんでした`, 'warn'); return; }
    setCbctMatrix(M, `表面で微調整, 表面の誤差 ${r.rms.toFixed(2)} mm`);
  });
};
$('scanLmAdd').onclick = () => { S.lm.scan.push({ name: `追加点 ${S.lm.scan.length + 1}`, cbct: null, scan: null }); renderLmTables(); };
$('scanLmClear').onclick = () => { if (!confirm('スキャン⇄CBCT の点をすべて消しますか？')) return; S.lm.scan = SCAN_PRESETS[$('scanPreset').value].map((name) => ({ name, cbct: null, scan: null })); S.lm.scanErr = null; renderLmTables(); };
$('scanPresetApply').onclick = () => {
  if (S.lm.scan.some((q) => q.cbct || q.scan) && !confirm('打った点は消えます。よろしいですか？')) return;
  S.lm.scan = SCAN_PRESETS[$('scanPreset').value].map((name) => ({ name, cbct: null, scan: null })); S.lm.scanErr = null; renderLmTables();
};
$('faceLmSolve').onclick = () => {
  if (faceSet() === 'faceScan') {
    if (!S.face) return alert('先に顔スキャンを読み込んでください');
    const ps = pairs(S.lm.faceScan, 'scan', 'face');
    if (ps.length < 3) return alert('口腔内スキャンと顔の両方に打った点が 3 組以上必要です');
    return setFaceToScan(rigidFromPairs(ps.map((q) => q.face), ps.map((q) => q.scan)), '対応点');
  }
  if (!S.cbct || !S.face) return alert('CBCT と顔スキャンの両方が必要です');
  const ps = pairs(S.lm.face, 'cbct', 'face');
  if (ps.length < 3) return alert('CBCT と顔の両方に打った点が 3 組以上必要です');
  const T = rigidFromPairs(ps.map((q) => q.face), ps.map((q) => q.cbct)); // 顔 → CBCT
  setFaceToCbct(T, '対応点');
};
/** 顔 → 口腔内スキャン の変換をそのまま顔の表示行列にする */
function setFaceToScan(M, how) {
  S.face.M = M;
  S.face.alignedToCbct = false;
  drawFace();
  const ps = pairs(S.lm.faceScan, 'scan', 'face');
  S.lm.faceScanErr = S.lm.faceScan.map((q) => (q.scan && q.face ? Math.hypot(...sub(mApply(M, q.face), q.scan)) : null));
  const rms = ps.length ? Math.sqrt(ps.reduce((s0, q) => s0 + Math.hypot(...sub(mApply(M, q.face), q.scan)) ** 2, 0) / ps.length) : NaN;
  const msg = `顔⇄口腔内スキャン（${how}）: 対応点の誤差 RMS ${isFinite(rms) ? rms.toFixed(2) : '—'} mm（${ps.length} 点）`;
  $('faceRegResult').textContent = msg;
  log(msg, isFinite(rms) && rms > 1.5 ? 'warn' : 'ok');
  renderLmTables();
}
function setFaceToCbct(T, how) {
  S.face.M = mMul(S.cbct.M, T);
  S.face.alignedToCbct = true;
  drawFace();
  const ps = pairs(S.lm.face, 'cbct', 'face');
  S.lm.faceErr = S.lm.face.map((q) => (q.cbct && q.face ? Math.hypot(...sub(mApply(T, q.face), q.cbct)) : null));
  const rms = ps.length ? Math.sqrt(ps.reduce((s0, q) => s0 + Math.hypot(...sub(mApply(T, q.face), q.cbct)) ** 2, 0) / ps.length) : NaN;
  const msg = `顔⇄CBCT（${how}）: 対応点の誤差 RMS ${isFinite(rms) ? rms.toFixed(2) : '—'} mm（${ps.length} 点）`;
  $('faceRegResult').textContent = msg;
  log(msg, isFinite(rms) && rms > 2.5 ? 'warn' : 'ok');
  renderLmTables();
}
$('faceLmRefine').onclick = () => {
  if (faceSet() === 'faceScan') {
    if (!S.face) return;
    return withBusy('顔の歯の部分を口腔内スキャンで微調整中…', async () => {
      // 顔スキャンのうち、いま口腔内スキャンの歯の近く（3mm 以内）にある点だけで ICP（唇や頬は使わない）
      const crowns = crownPoints(scanUp());
      const grid = new PointGrid(crowns, 1.0);
      const P = S.face.obj.positions, near = [];
      for (let i = 0; i < P.length; i += 3) {
        const w = mApply(S.face.M, [P[i], P[i + 1], P[i + 2]]);
        const q = grid.nearest(w, 3);
        if (q && q.dist < 3) near.push(P[i], P[i + 1], P[i + 2]);
      }
      if (near.length < 300) { log('顔スキャンの歯の部分が口腔内スキャンの近くに見つかりません。先に対応点で合わせてください', 'warn'); return; }
      const before = S.face.M;
      const r = icp(Float32Array.from(near), crowns, S.face.M, { iterations: 40, maxDist: 1.5, samples: 4000 });
      const ps = pairs(S.lm.faceScan, 'scan', 'face');
      const e = (MM) => (ps.length ? Math.sqrt(ps.reduce((s0, q) => s0 + Math.hypot(...sub(mApply(MM, q.face), q.scan)) ** 2, 0) / ps.length) : 0);
      if (ps.length >= 3 && e(r.matrix) > e(before) + 1.0) { log(`微調整で対応点の誤差が ${e(before).toFixed(2)} → ${e(r.matrix).toFixed(2)} mm に悪化したため、採用しませんでした`, 'warn'); return; }
      setFaceToScan(r.matrix, `歯の表面で微調整（${near.length / 3} 点）, 表面の誤差 ${r.rms.toFixed(2)} mm`);
    });
  }
  if (!S.cbct || !S.face) return;
  withBusy('顔を皮膚表面で微調整中…', async () => {
    ensureSkin();
    const T0 = mMul(mInvRigid(S.cbct.M), S.face.M); // 顔 → CBCT
    const r = icp(S.face.obj.positions, S.cbct.skin.positions, T0, { iterations: 40, maxDist: 3, samples: 6000 });
    setFaceToCbct(r.matrix, `皮膚表面で微調整, 表面の誤差 ${r.rms.toFixed(2)} mm`);
  });
};
$('faceLmAdd').onclick = () => {
  const set = faceSet();
  S.lm[set].push(set === 'faceScan' ? { name: `追加点 ${S.lm[set].length + 1}`, scan: null, face: null } : { name: `追加点 ${S.lm[set].length + 1}`, cbct: null, face: null });
  renderLmTables();
};
$('faceLmClear').onclick = () => {
  if (!confirm('顔の対応点をすべて消しますか？')) return;
  if (faceSet() === 'faceScan') { S.lm.faceScan = FACE_SCAN_POINTS.map((name) => ({ name, scan: null, face: null })); S.lm.faceScanErr = null; }
  else { S.lm.face = FACE_POINTS.map((name) => ({ name, cbct: null, face: null })); S.lm.faceErr = null; }
  renderLmTables();
};

// 点を打つための CBCT 表示（骨・皮膚の立体）
function wholeIso(thr) {
  // 表示用：平滑化した CT から作り、ノイズの粒を除く
  if (!S.cbct.smooth) S.cbct.smooth = smoothVolume(S.cbct.vol);
  const vol = S.cbct.smooth, Mv = volumeMatrix(vol);
  let step = vol.dims[0] * vol.dims[1] * vol.dims[2] > 8e6 ? 2 : 1;
  let m = volumeIsosurface(vol, thr, step, (i, j, k) => mApply(Mv, [i, j, k]));
  // 面が多すぎると画面が固まるので、粗くして作り直す
  while (m.nf > 2.5e6 && step < 4) {
    step *= 2;
    m = volumeIsosurface(vol, thr, step, (i, j, k) => mApply(Mv, [i, j, k]));
    log(`面が多すぎるため、間引きを ${step} にして作り直しました（しきい値が骨と軟組織の境目に近い可能性があります）`, 'warn');
  }
  return removeSmallParts(m, 400);
}
function ensureSkin() { if (!S.cbct.skin) { S.cbct.skin = wholeIso(num('skinThr')); log(`皮膚の立体: しきい値 ${num('skinThr')}`); } }
function ensureBone() { if (!S.cbct.bone) { S.cbct.bone = wholeIso(num('boneThr')); log(`骨の立体: しきい値 ${num('boneThr')}（${S.cbct.bone.nf.toLocaleString()} 面）`); } }
function redrawCbctExtras() {
  updateVRMatrix();
  $('vrToggle').classList.toggle('on', !!S.vis.vr);
  for (const [g, key, color, op] of [['bone', 'bone', 0xeee6d2, num('boneOpacity')], ['skin', 'skin', 0xf0c8b0, num('skinOpacity')]]) {
    viewer.clearGroup(g);
    if (S.cbct?.[key]) viewer.addMesh(g, S.cbct[key], { color, opacity: op, matrix: S.cbct.M, doubleSide: true });
  }
  applyVisibility();
  $('showBone').classList.toggle('on', !!S.vis.bone);
  $('showSkin').classList.toggle('on', !!S.vis.skin);
  $('toggleSlices').classList.toggle('on', !!S.vis.slices);
  $('showTeethIso').classList.toggle('on', !!S.vis.iso);
}
// ---- ボリューム表示 ----
function buildVR(th) {
  if (S.cbct.vrObj) { viewer.clearGroup('vr'); S.cbct.vrObj.dispose(); }
  const range = { lo: th.min, hi: th.max };
  S.cbct.vrObj = makeVolumeMesh(S.cbct.vol, range);
  viewer.group('vr').add(S.cbct.vrObj.mesh);
  const sl = $('vrThr');
  sl.min = Math.floor(range.lo); sl.max = Math.ceil(range.hi); sl.step = Math.max(1, Math.round((range.hi - range.lo) / 400));
  S.cbct.presets = {
    bone: { thr: th.soft + 0.5 * (th.bone - th.soft), width: Math.max(50, (th.bone - th.soft) * 0.6), opacity: 0.6 },
    skin: { thr: th.skin, width: Math.max(50, (th.soft - th.air) * 0.3), opacity: 0.35 },
  };
  applyVRPreset('bone');
}
function applyVRPreset(name) {
  const p = S.cbct?.presets?.[name];
  if (!p) return;
  $('vrThr').value = Math.round(p.thr); $('vrWidth').max = Math.ceil((S.cbct.thr.max - S.cbct.thr.min) / 2); $('vrWidth').value = Math.round(p.width); $('vrOpacity').value = p.opacity;
  S.cbct.vrPreset = name;
  updateVRParams();
}
function updateVRParams() {
  const o = S.cbct?.vrObj;
  if (!o) return;
  o.uniforms.uThr.value = num('vrThr'); o.uniforms.uWidth.value = num('vrWidth'); o.uniforms.uOpacity.value = num('vrOpacity');
  $('vrThrVal').textContent = Math.round(num('vrThr'));
  const skin = S.cbct.vrPreset === 'skin';
  o.uniforms.uColLow.value.set(skin ? 0xe8b9a0 : 0xd9c7a8); o.uniforms.uColHigh.value.set(skin ? 0xf4d7c4 : 0xfbf7ee);
}
function updateVRMatrix() { if (S.cbct?.vrObj) S.cbct.vrObj.setMatrix(mMul(S.cbct.M, volumeMatrix(S.cbct.vol))); }
for (const id of ['vrThr', 'vrWidth', 'vrOpacity']) $(id).oninput = updateVRParams;
$('vrBone').onclick = () => { applyVRPreset('bone'); S.vis.vr = true; setVis('cbct3d', true); redrawCbctExtras(); };
$('vrSkin').onclick = () => { applyVRPreset('skin'); S.vis.vr = true; setVis('cbct3d', true); redrawCbctExtras(); };
$('vrToggle').onclick = () => { S.vis.vr = !S.vis.vr; if (S.vis.vr) setVis('cbct3d', true); redrawCbctExtras(); };
/** ボリューム表示へのピック：視線に沿って CT をたどり、表示のしきい値（下端）を最初に超えた点 */
function pickVolume(e) {
  if (!S.cbct?.vrObj || !S.vis.vr || !S.vis.cbct3d) return null;
  const r = viewer.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  viewer.raycaster.setFromCamera(ndc, viewer.camera);
  viewer.root.updateMatrixWorld(true);
  const toData = viewer.root.matrixWorld.clone().invert();
  const o = viewer.raycaster.ray.origin.clone().applyMatrix4(toData);
  const o2 = viewer.raycaster.ray.origin.clone().add(viewer.raycaster.ray.direction).applyMatrix4(toData);
  const inv = mInvRigid(S.cbct.M);
  const oc = mApply(inv, [o.x, o.y, o.z]), oc2 = mApply(inv, [o2.x, o2.y, o2.z]);
  const d = norm(sub(oc2, oc));
  const vol = S.cbct.vol, Mv = volumeMatrix(vol);
  const lim = num('vrThr') - 0.25 * num('vrWidth');
  // ボリュームの外接球の範囲だけ進む
  const c = mApply(Mv, vol.dims.map((n) => (n - 1) / 2));
  const R = Math.hypot(...vol.dims.map((n, a) => n * vol.spacing[a])) / 2;
  const tc = dot(sub(c, oc), d);
  const step = Math.min(...vol.spacing) * 0.5;
  for (let t = Math.max(0, tc - R); t < tc + R; t += step) {
    const p = add(oc, scale(d, t));
    if (sampleVolume(vol, p) >= lim) return { cbct: p, dist: t };
  }
  return null;
}
$('showBone').onclick = () => {
  if (!S.cbct) return alert('先に CBCT を読み込んでください');
  withBusy('骨の立体を作成中…', async () => { ensureBone(); S.vis.bone = !S.vis.bone; setVis('cbct3d', true); redrawCbctExtras(); });
};
$('showSkin').onclick = () => {
  if (!S.cbct) return alert('先に CBCT を読み込んでください');
  withBusy('皮膚の立体を作成中…', async () => { ensureSkin(); S.vis.skin = !S.vis.skin; setVis('cbct3d', true); redrawCbctExtras(); });
};
$('toggleSlices').onclick = () => { setVis('slices', !S.vis.slices); redrawCbctExtras(); };
$('showTeethIso').onclick = () => { setVis('iso', !S.vis.iso); setVis('cbct3d', true); redrawCbctExtras(); };
// しきい値を変えて作り直す
$('boneRebuild').onclick = () => { if (!S.cbct) return; withBusy('骨の立体を作り直し中…', async () => { S.cbct.bone = null; ensureBone(); S.vis.bone = true; setVis('cbct3d', true); redrawCbctExtras(); }); };
$('skinRebuild').onclick = () => { if (!S.cbct) return; withBusy('皮膚の立体を作り直し中…', async () => { S.cbct.skin = null; ensureSkin(); S.vis.skin = true; setVis('cbct3d', true); redrawCbctExtras(); }); };
for (const [id, step] of [['boneThr', 1], ['skinThr', 1]]) {
  for (const [sfx, f] of [['Minus', -1], ['Plus', 1]]) $(id + sfx).onclick = () => { $(id).value = Math.round(num(id) + f * Math.max(10, Math.abs(S.cbct?.thr?.range || 1000) * 0.03)); $(id === 'boneThr' ? 'boneRebuild' : 'skinRebuild').click(); };
}
$('boneOpacity').oninput = $('skinOpacity').oninput = () => { for (const [g, id] of [['bone', 'boneOpacity'], ['skin', 'skinOpacity']]) for (const c of viewer.group(g).children) { c.material.opacity = num(id); c.material.transparent = num(id) < 1; c.material.depthWrite = num(id) >= 1; c.material.needsUpdate = true; } };

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
    const cnt = S.labelCount?.[S.segJaw]?.get(fdi) || 0;
    if (cnt > 0) { b.style.background = `rgba(${c.map((x) => Math.round(x * 255)).join(',')},0.55)`; b.title = `${cnt.toLocaleString()} 点`; }
    if ((S.mode === 'brush' || S.mode === 'fill') && S.paintLabel === fdi) b.style.outline = '2px solid var(--accent)';
    const miss = S.missing[S.segJaw].includes(fdi);
    if (miss) { b.style.textDecoration = 'line-through'; b.style.opacity = '0.4'; b.title = '欠損'; }
    b.onclick = () => {
      if (S.missingMode) {
        const L = S.missing[S.segJaw];
        if (miss) L.splice(L.indexOf(fdi), 1); else { L.push(fdi); S.seeds[S.segJaw] = S.seeds[S.segJaw].filter((q) => q.label !== fdi); drawSeeds(); }
        buildFdiGrid();
        return;
      }
      if (miss) return;
      S.seedFdi = fdi;
      S.paintLabel = fdi;
      if (S.mode === 'brush' || S.mode === 'fill') setMode(S.mode); else if (S.mode === 'erase') setMode('brush'); else setMode('seed');
      buildFdiGrid();
    };
    g.append(b);
  }
  $('missingList').textContent = S.missing[S.segJaw].length ? `欠損: ${[...S.missing[S.segJaw]].sort((a, b) => a - b).join(', ')}` : '';
  $('missingMode').classList.toggle('on', !!S.missingMode);
  $('paintStatus').textContent = S.mode === 'erase' ? '消しゴム（歯肉に戻す）' : S.paintLabel ? `塗る番号: ${S.paintLabel}` : '塗る番号: —（上の番号を押す）';
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
$('missingMode').onclick = () => { S.missingMode = !S.missingMode; if (S.missingMode) setMode(null); buildFdiGrid(); };
$('gumSeedMode').onclick = () => setMode(S.mode === 'gumseed' ? null : 'gumseed');
$('brushMode').onclick = () => setMode(S.mode === 'brush' ? null : 'brush');
$('seedClear').onclick = () => { S.seeds[S.segJaw] = []; drawSeeds(); buildFdiGrid(); };
$('segRun').onclick = () => {
  const j = S.segJaw;
  if (!S.scans[j]) return alert(`${JAW_JA[j]}のスキャンがありません`);
  if (!S.seeds[j].some((s) => s.label > 0)) return alert('歯冠にシードを置いてください');
  withBusy('分割中…', async () => {
    if (S.labels[j]) pushUndo(j);
    S.labels[j] = segmentTeeth(S.scans[j], S.seeds[j], { concavityWeight: num('segWeight') });
    refreshScanColors(j);
    afterPaint(j);
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
  for (const [fdi, t] of S.arches[j].teeth) { saveToothProps(t); if (S.cbctRoots[fdi]) t.cbctRoot = S.cbctRoots[fdi]; if (S.cbctTeeth[fdi]) t.cbctTooth = S.cbctTeeth[fdi]; }
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
  $('fillMode').classList.toggle('on', m === 'fill');
  $('eraseMode').classList.toggle('on', m === 'erase');
  // 塗るときは左ドラッグを塗りに使い、回転は右ドラッグ・移動は中ボタンへ
  const painting = m === 'brush' || m === 'erase';
  viewer.controls.enableRotate = true;
  viewer.controls.mouseButtons = painting ? { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  if (!painting) brushCursor.visible = false;
  if ((painting || m === 'fill') && S.scans[S.segJaw]) { ensureLabels(S.segJaw); setVis('scan', true); }
  const hints = {
    seed: `歯 ${S.seedFdi} の歯冠をクリック`, gumseed: '歯肉をクリック（境界がうまく出ない所に）',
    brush: `歯 ${S.paintLabel ?? '—'} を左ドラッグで塗る（右ドラッグ: 回転 / ホイール: 拡大 / Esc: 終了）`,
    erase: '左ドラッグで歯肉に戻す（右ドラッグ: 回転 / Esc: 終了）',
    fill: `歯 ${S.paintLabel ?? '—'} の歯冠をクリックすると、くぼみで囲まれた範囲を塗りつぶし`,
    lm: S.lmTarget ? `「${lmName(S.lmTarget)}」を ${S.lmTarget.side === 'cbct' ? 'CBCT（立体または断面）' : S.lmTarget.side === 'scan' ? '口腔内スキャン' : '顔スキャン'} 上でクリック（Esc で中止）` : '',
  };
  $('hint').textContent = hints[m] || '左ドラッグ: 回転 / 右ドラッグ: 平行移動 / ホイール: 拡大 / 歯をクリックで選択';
  if (m !== 'lm' && S.lmTarget) { S.lmTarget = null; renderLmTables(); }
  drawLmMarkers();
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
      let k = i + 1;
      while (k < order.length && S.missing[j].includes(order[k])) k++; // 欠損歯は飛ばす
      if (k < order.length) S.seedFdi = order[k];
      setMode('seed');
    }
    buildFdiGrid();
    drawSeeds();
    return;
  }
  if (m === 'brush' || m === 'erase') return;
  if (m === 'fill') return fillAt(e);
  if (m === 'lm') return lmPick(e);
  // 歯の選択
  const hit = viewer.pick(e, JAWS.map((j) => viewer.group(`teeth_${j}`)));
  if (hit && hit.object.userData.fdi) selectTooth(hit.object.userData.fdi);
};
// ---- 手で塗る ----
S.paintLabel = null; // 塗る番号（0 = 歯肉）
S.paintUndo = { upper: [], lower: [] };
function ensureLabels(j) {
  if (!S.labels[j]) { S.labels[j] = new Int32Array(S.scans[j].nv); refreshScanColors(j); }
  if (!S.scanConcav) S.scanConcav = {};
  if (!S.scanConcav[j] || S.scanConcav[j].length !== S.scans[j].nv) S.scanConcav[j] = concavity(S.scans[j]);
}
function pushUndo(j) {
  const u = S.paintUndo[j];
  u.push(S.labels[j].slice());
  if (u.length > 20) u.shift();
}
function paintOpts(j) {
  return { barrier: $('brushBarrier').checked ? S.scanConcav[j] : null, barrierThr: num('brushBarrierThr'), protect: $('brushProtect').checked };
}
/** 塗り替えた頂点だけ色を更新 */
function updateColorsAt(j, idx) {
  const m = viewer.group(`scan_${j}`).children[0];
  if (!m || !idx.length) return;
  const attr = m.geometry.attributes.color;
  const L = S.labels[j], sh = S.scanShade[j], hasCol = !!S.scanColors[j];
  for (const i of idx) {
    let c = scanBase(j, i);
    const lc = L[i] ? LABEL_COLORS.get(L[i]) || [0.8, 0.8, 0.8] : null;
    if (lc) c = hasCol ? c.map((x, k) => x * 0.45 + lc[k] * 0.55) : lc;
    else if (!hasCol) c = LABEL_COLORS.get(0);
    const f = sh ? sh[i] : 1;
    attr.array[3 * i] = c[0] * f; attr.array[3 * i + 1] = c[1] * f; attr.array[3 * i + 2] = c[2] * f;
  }
  attr.needsUpdate = true;
}
function paintLabelNow() { return S.mode === 'erase' ? 0 : S.paintLabel; }
function brushAt(e) {
  const j = S.segJaw;
  if (!S.scans[j]) return;
  const lab = paintLabelNow();
  if (lab === null || lab === undefined) { $('paintStatus').textContent = '先に上の番号を押してください'; return; }
  const hit = viewer.pick(e, scanObjs(j));
  if (!hit) return;
  ensureLabels(j);
  const changed = paintLabels(S.scans[j], S.labels[j], hitVertex(hit), num('brushR'), lab, paintOpts(j));
  updateColorsAt(j, changed);
}
function fillAt(e) {
  const j = S.segJaw;
  if (!S.scans[j]) return;
  const lab = S.paintLabel;
  if (lab === null || lab === undefined) { $('paintStatus').textContent = '先に上の番号を押してください'; return; }
  const hit = viewer.pick(e, scanObjs(j));
  if (!hit) return;
  ensureLabels(j);
  pushUndo(j);
  const o = paintOpts(j);
  const changed = fillRegion(S.scans[j], S.labels[j], hitVertex(hit), lab, { barrier: S.scanConcav[j], barrierThr: o.barrierThr, protect: o.protect, maxRadius: 7 });
  updateColorsAt(j, changed);
  afterPaint(j);
}
function afterPaint(j) {
  const cnt = labelCounts(S.labels[j]);
  S.labelCount = S.labelCount || {};
  S.labelCount[j] = cnt;
  buildFdiGrid();
}
// ストロークの開始・終了（元に戻す用の記録と、本数の更新）
viewer.canvas.addEventListener('pointerdown', (e) => {
  if ((S.mode === 'brush' || S.mode === 'erase') && e.button === 0 && S.scans[S.segJaw]) {
    ensureLabels(S.segJaw); pushUndo(S.segJaw); S.painting = true; brushAt(e);
  }
});
window.addEventListener('pointerup', () => { if (S.painting) { S.painting = false; afterPaint(S.segJaw); } });
let moveQueued = null;
viewer.moveHandler = (e) => {
  if (!(S.mode === 'brush' || S.mode === 'erase') || !S.painting) return;
  // 重いピック処理を描画フレームごとに 1 回に間引く
  if (moveQueued) { moveQueued = e; return; }
  moveQueued = e;
  requestAnimationFrame(() => { const ev = moveQueued; moveQueued = null; brushAt(ev); });
};
// ブラシの大きさを示す丸（カーソル）
const brushCursor = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthTest: false }));
brushCursor.visible = false; brushCursor.renderOrder = 12;
viewer.root.add(brushCursor);
let hoverQueued = false;
viewer.canvas.addEventListener('pointermove', (e) => {
  if (!(S.mode === 'brush' || S.mode === 'erase') || e.buttons !== 0) { if (!S.painting) brushCursor.visible = false; return; }
  if (hoverQueued) return;
  hoverQueued = true;
  requestAnimationFrame(() => {
    hoverQueued = false;
    const hit = S.scans[S.segJaw] ? viewer.pick(e, scanObjs(S.segJaw)) : null;
    brushCursor.visible = !!hit;
    if (hit) { brushCursor.position.copy(hit.point); brushCursor.scale.setScalar(num('brushR')); brushCursor.material.color.setHex(S.mode === 'erase' ? 0xff6666 : 0xffffff); }
  });
});
$('brushRSlider').oninput = () => { $('brushR').value = $('brushRSlider').value; };
$('brushR').onchange = () => { $('brushRSlider').value = $('brushR').value; };
$('fillMode').onclick = () => setMode(S.mode === 'fill' ? null : 'fill');
$('eraseMode').onclick = () => setMode(S.mode === 'erase' ? null : 'erase');
$('paintUndo').onclick = () => {
  const j = S.segJaw, u = S.paintUndo[j];
  if (!u.length) return;
  S.labels[j] = u.pop();
  refreshScanColors(j);
  afterPaint(j);
};
$('toothErase').onclick = () => {
  const j = S.segJaw, lab = S.paintLabel;
  if (!S.labels[j] || !lab) return alert('消す歯の番号を押してください');
  pushUndo(j);
  const L = S.labels[j], ch = [];
  for (let i = 0; i < L.length; i++) if (L[i] === lab) { L[i] = 0; ch.push(i); }
  updateColorsAt(j, ch);
  afterPaint(j);
};

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
viewer.root.add(pivot); // データ座標で扱う
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
  pivot.updateMatrix();
  gizmoStart = { M: poseMatrix(t, poseAt(plan, t.fdi, S.stage)), P: pivot.matrix.clone() };
});
viewer.gizmo.addEventListener('objectChange', () => {
  if (!gizmoStart) return;
  const t = toothOf(S.sel);
  pivot.updateMatrix();
  const delta = pivot.matrix.clone().multiply(gizmoStart.P.clone().invert());
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
// ---- CBCT からの歯根の自動抽出 ----
/**
 * 歯1本ごとに、スキャンの歯冠を CT の歯の面に合わせ直す（全体の位置合わせの小さなずれを吸収）
 * 戻り値: { M: この歯用の CBCT→スキャン行列, before, after: 歯冠と CT の歯の平均距離 mm, used: 補正を使ったか }
 */
function localToothFit(t) {
  if (!S.cbct.iso) return { M: S.cbct.M, before: NaN, after: NaN, used: false };
  if (!S.cbct.isoGrid || S.cbct.isoGridSrc !== S.cbct.iso) { S.cbct.isoGrid = new PointGrid(S.cbct.iso.positions, 1.0); S.cbct.isoGridSrc = S.cbct.iso; }
  const grid = S.cbct.isoGrid;
  const inv = mInvRigid(S.cbct.M);
  const P = t.crown.positions, step = Math.max(1, Math.floor(P.length / 3 / 1500));
  const src = [];
  for (let i = 0; i < P.length / 3; i += step) src.push(mApply(inv, [P[3 * i], P[3 * i + 1], P[3 * i + 2]]));
  const misfit = (D, md = 3) => { let s0 = 0, n = 0; for (const p of src) { const q = grid.nearest(mApply(D, p), md); s0 += q ? Math.min(q.dist, md) : md; n++; } return s0 / n; };
  let D = mIdentity();
  const before = misfit(D);
  for (const md of [3, 3, 2, 1.5, 1, 1, 0.7, 0.7, 0.5, 0.5]) {
    const A = [], B = [];
    for (const p of src) {
      const q = grid.nearest(mApply(D, p), md);
      if (!q || q.dist > md) continue;
      A.push(p); B.push([grid.points[3 * q.index], grid.points[3 * q.index + 1], grid.points[3 * q.index + 2]]);
    }
    if (A.length < 30) break;
    D = rigidFromPairs(A, B);
  }
  const after = misfit(D);
  // 補正が大きすぎる（4mm / 10° 超）か、かえって悪くなるなら使わない
  const c = mApply(D, src[0]), tr = Math.hypot(...sub(c, src[0]));
  const ang = Math.acos(Math.max(-1, Math.min(1, (D[0] + D[5] + D[10] - 1) / 2))) * 180 / Math.PI;
  if (tr > 4 || ang > 10 || !(after < before)) return { M: S.cbct.M, before, after: before, used: false };
  return { M: mMul(S.cbct.M, mInvRigid(D)), before, after, used: true };
}
async function autoRoots(teeth) {
  if (!S.cbct) return alert('先に CBCT を読み込み、「2 位置合わせ」でスキャンと合わせてください');
  const alignAxis = $('autoRootAxis').checked;
  const k0 = num('autoRootK') || 0.4;
  const ok = [], ng = [];
  const fits = [];
  for (let i = 0; i < teeth.length; i++) {
    const t = teeth[i];
    busy(true, `歯根を抽出中… ${t.fdi}（${i + 1}/${teeth.length}）`, i / teeth.length); await tick();
    const arch = S.arches[archOfFdi(t.fdi)];
    const nb = () => [...arch.teeth.values()].filter((o) => o !== t).map((o) => ({ cervical: o.cervical, z: o.frame.z }));
    // まず歯冠を CT の歯に合わせ直す
    const fit = localToothFit(t);
    fits.push(fit);
    const Mt = fit.M;
    const nm = { noMesh: alignAxis }; // 歯軸を合わせる場合は、合わせたあとの抽出でだけメッシュを作る
    let r = extractRoot(S.cbct.vol, Mt, t, nb(), { k: k0, ...nm });
    if (r.error) r = extractRoot(S.cbct.vol, Mt, t, nb(), { k: Math.min(0.85, k0 + 0.15), ...nm }); // 骨へ漏れたらしきい値を上げて再試行
    if (r.error) r = extractRoot(S.cbct.vol, Mt, t, nb(), { k: Math.max(0.2, k0 - 0.15), ...nm }); // 途切れたら下げて再試行
    if (r.error && isFinite(fit.after) && fit.after > 1.0) r.error += `（歯冠と CT の歯のずれ 平均 ${fit.after.toFixed(1)} mm。位置合わせを見直してください）`;
    if (r.error) { ng.push(`${t.fdi}: ${r.error}`); continue; }
    if (alignAxis) {
      t.axisAdjust = { tip: +(t.axisAdjust.tip + r.tipDeg).toFixed(1), torque: +(t.axisAdjust.torque + r.torqueDeg).toFixed(1) };
      t.rootLength = +r.rootLength.toFixed(1);
      refreshTooth(arch, t);
      // 合わせた歯軸でもう一度抽出（断面の向きが歯根に沿うので形がきれいになる）
      const r2 = extractRoot(S.cbct.vol, Mt, t, nb(), { k: r.k ?? k0, threshold: r.threshold });
      if (!r2.error) r = r2;
      else { const r3 = extractRoot(S.cbct.vol, Mt, t, nb(), { k: k0 }); if (r3.error) { ng.push(`${t.fdi}: ${r2.error}`); continue; } r = r3; }
    }
    t.rootLength = +r.rootLength.toFixed(1);
    refreshTooth(arch, t);
    t.cbctRoot = r.mesh;
    S.cbctRoots[t.fdi] = r.mesh;
    t.cbctTooth = r.toothMesh;
    S.cbctTeeth[t.fdi] = r.toothMesh;
    t.cbctCrown = r.crownMesh;
    S.cbctCrowns[t.fdi] = r.crownMesh;
    saveToothProps(t);
    ok.push(`${t.fdi}（${t.rootLength} mm${r.roots > 1 && r.roots <= 3 ? `・${r.roots}根` : ''}）`);
  }
  for (const j of JAWS) if (S.arches[j]) drawArch(j);
  setVis('roots', true);
  updateRootPanel();
  const planned = JAWS.some((j) => S.plan[j]);
  const fb = fits.filter((f) => isFinite(f.before)).map((f) => f.before).sort((a, b) => a - b);
  const medBefore = fb.length ? fb[fb.length >> 1] : NaN;
  $('autoRootStatus').innerHTML = `抽出できた歯: ${ok.length} 本${ng.length ? `<br><span class="danger">抽出できなかった歯（推定の歯根のまま）: ${ng.map((x) => x.split(':')[0]).join(', ')}（理由はログ）</span>` : ''}`
    + (isFinite(medBefore) ? `<br>歯冠と CT の歯のずれ（合わせ直す前の中央値）: ${medBefore.toFixed(2)} mm${medBefore > 1.0 ? ' <span class="danger">— 全体の位置合わせが大きくずれています。「2 位置合わせ」で点を打ち直し「表面で微調整」をしてください</span>' : ''}` : '');
  log(`歯根の自動抽出: 成功 ${ok.length} 本 ${ok.join('、')}`, 'ok');
  for (const m of ng) log(m, 'warn');
  if (planned && alignAxis) log('歯軸が変わったので、「6 セットアップ」の自動排列をやり直してください（移動量は歯軸を基準にしています）', 'warn');
}
$('autoRootSel').onclick = () => {
  const t = S.sel ? toothOf(S.sel) : null;
  if (!t) return alert('ビューで歯をクリックして選択してください');
  withBusy('歯根を抽出中…', () => autoRoots([t]));
};
$('autoRootAll').onclick = () => {
  const list = JAWS.flatMap((j) => (S.arches[j] ? [...S.arches[j].teeth.values()] : []));
  if (!list.length) return alert('先に「3 歯の分割」で歯を作成してください');
  withBusy('歯根を抽出中…', () => autoRoots(list));
};
$('showCtTooth').onchange = () => { for (const j of JAWS) if (S.arches[j]) drawArch(j); setVis('roots', true); };
$('ctRelabel').onclick = () => {
  // CT の歯冠（歯頸部のくびれより上）だけを使う：歯肉の下の部分で歯肉を歯と誤認しないように
  const list = JAWS.flatMap((j) => (S.arches[j] ? [...S.arches[j].teeth.values()].map((t) => ({ j, fdi: t.fdi, mesh: S.cbctCrowns[t.fdi] })).filter((q) => q.mesh) : []));
  if (!list.length) return alert('先に「全ての歯」で CT から歯を抽出してください');
  withBusy('CT の歯冠でスキャンの歯冠を補正中…', async () => {
    const msgs = [];
    for (const j of JAWS) {
      if (!S.labels[j] || !S.arches[j]) continue;
      const teeth = list.filter((q) => q.j === j);
      if (!teeth.length) continue;
      busy(true, `${JAW_JA[j]}：CT の歯冠でスキャンの歯冠を補正中…`); await tick();
      pushUndo(j);
      const r = relabelFromCT(S.scans[j], S.labels[j], teeth, PointGrid, num('ctRelabelTol'));
      S.labels[j] = r.labels;
      refreshScanColors(j);
      afterPaint(j);
      buildTeethFor(j);
      msgs.push(`${JAW_JA[j]}: 歯に追加 ${r.added.toLocaleString()} 点・歯肉に戻した ${r.removed.toLocaleString()} 点${r.skipped.length ? `（CT の歯冠がずれているため見送り: ${r.skipped.join(', ')}）` : ''}`);
    }
    $('ctRelabelStatus').textContent = msgs.join(' / ') + '。歯を作り直しました（「3 歯の分割」の「元に戻す」で取り消せます）。';
    log(`CT で歯冠を補正: ${msgs.join(' / ')}`, 'ok');
    if (JAWS.some((j) => S.plan[j])) log('歯冠が変わったので、自動排列をやり直してください', 'warn');
  });
};
$('autoRootClear').onclick = () => {
  for (const j of JAWS) if (S.arches[j]) for (const t of S.arches[j].teeth.values()) { t.cbctRoot = null; t.cbctTooth = null; }
  S.cbctRoots = {}; S.cbctTeeth = {}; S.cbctCrowns = {};
  for (const j of JAWS) if (S.arches[j]) drawArch(j);
  updateRootPanel();
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
    const toPx = (p) => { const d = sub(p, t.cervical); return [W / 2 + dot(d, u) / res, (top - dot(d, z)) / res]; };
    const outline = (mesh, color) => {
      const P = mesh.positions, I = mesh.indices;
      ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
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
    };
    outline(t.cbctRoot ? t.crown : t.mesh, '#ffd400');
    if (t.cbctRoot) outline(t.cbctRoot, '#3ee6b4');
    // 歯軸と抵抗中心
    ctx.strokeStyle = '#4cc3ff'; ctx.beginPath();
    const a = toPx(t.occlusalPoint), b = toPx(t.apex); ctx.moveTo(W / 2, a[1]); ctx.lineTo(W / 2, b[1]); ctx.stroke();
    const c = toPx(t.cr); ctx.fillStyle = '#ff4d6d'; ctx.beginPath(); ctx.arc(c[0], c[1], 3, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '11px sans-serif';
    ctx.fillText(axis === 'b' ? '頬舌断（右=頬側）' : '近遠心断（右=近心）', 6, 14);
    if (t.cbctRoot) { ctx.fillStyle = '#3ee6b4'; ctx.fillText('緑：CBCT から抽出した歯根', 6, H - 8); }
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
  ['optMolar', 'keepMolars', 'chk'], ['optLevel', 'leveling', 'chk'], ['optRot', 'correctRotation', 'chk'], ['optMid', 'midline', 'chk'], ['optClose', 'closeSpaces', 'chk'], ['optKeepMissing', 'keepMissingSpace', 'chk']];
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
  if (r.missing?.length) html += `<p class="note">欠損: ${r.missing.join(', ')}（スペースを${S.setupOpt[S.setJaw].keepMissingSpace ? '保持' : '閉鎖'}）</p>`;
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
  for (const [fdi, t] of arch.teeth) { const M = poseMatrix(t, poses.get(fdi) || zeroPose()); mats.set(fdi, M); parts.push(t.mesh.transformed(M)); if (t.cbctRoot) parts.push(t.cbctRoot.transformed(M)); for (const a of t.attachments) parts.push(attachmentMesh(t, a).transformed(M)); }
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
    seeds: S.seeds, missing: S.missing, toothProps: S.toothProps, setupOpt: S.setupOpt, plan: plans,
    ceph: { points: S.ceph.points, pxPerMm: S.ceph.pxPerMm, targets: S.ceph.targets, ojTarget: S.ceph.ojTarget, obTarget: S.ceph.obTarget, imgURL: S.ceph.imgURL },
    cbctMatrix: S.cbct?.M || null,
    faceMatrix: S.face?.M || null, faceTex: S.face?.texURL || null,
    hasTeeth: { upper: !!S.arches.upper, lower: !!S.arches.lower },
    limits: readLimits(), shell: shellParams(),
    landmarks: { ref: S.lm.ref, scan: S.lm.scan, face: S.lm.face, faceScan: S.lm.faceScan, faceMode: S.lm.faceMode, useFrame: S.lm.useFrame, showPlanes: S.lm.showPlanes },
  };
  files.push({ name: 'project.json', data: JSON.stringify(proj) });
  for (const j of JAWS) {
    if (S.scanBuf[j]) files.push({ name: `${j}.${S.scanExt[j] || 'stl'}`, data: S.scanBuf[j] });
    if (S.labels[j]) files.push({ name: `labels_${j}.bin`, data: new Uint8Array(S.labels[j].buffer.slice(0)) });
  }
  if (S.face) files.push({ name: 'face.obj', data: S.face.text });
  for (const [fdi, m] of Object.entries(S.cbctRoots)) files.push({ name: `roots/${fdi}.stl`, data: writeSTL(m, `root_${fdi}`) });
  for (const [fdi, m] of Object.entries(S.cbctTeeth)) files.push({ name: `ctteeth/${fdi}.stl`, data: writeSTL(m, `cttooth_${fdi}`) });
  for (const [fdi, m] of Object.entries(S.cbctCrowns)) if (m) files.push({ name: `ctcrowns/${fdi}.stl`, data: writeSTL(m, `ctcrown_${fdi}`) });
  download(`${$('caseId').value || 'case'}.alnproj.zip`, makeZip(files), 'application/zip');
  log('プロジェクトを保存しました（CBCT 本体は含まれません。開くときに DICOM を読み直してください）');
};
$('openProject').onchange = (e) => e.target.files[0] && withBusy('プロジェクトを開いています…', async () => {
  const zip = readZip(await readFile(e.target.files[0]));
  const proj = JSON.parse(new TextDecoder().decode(zip.get('project.json')));
  if (proj.version !== STORE_VERSION) log('プロジェクトのバージョンが異なります。読み込めない項目があるかもしれません', 'warn');
  S.toothProps = proj.toothProps || {};
  S.missing = proj.missing || { upper: [], lower: [] };
  S.cbctRoots = {};
  S.cbctTeeth = {}; S.cbctCrowns = {};
  for (const [name, data] of zip) {
    const mm = name.match(/^roots\/(\d+)\.stl$/); if (mm) S.cbctRoots[+mm[1]] = parseSTL(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    const mt = name.match(/^ctteeth\/(\d+)\.stl$/); if (mt) S.cbctTeeth[+mt[1]] = parseSTL(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    const mc = name.match(/^ctcrowns\/(\d+)\.stl$/); if (mc) S.cbctCrowns[+mc[1]] = parseSTL(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  for (const j of JAWS) {
    const ext = ['stl', 'ply', 'obj'].find((x) => zip.get(`${j}.${x}`));
    if (!ext) continue;
    const stl = zip.get(`${j}.${ext}`);
    await loadScan(j, stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength), `${j}.${ext}`);
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
  if (proj.landmarks) { Object.assign(S.lm, proj.landmarks); renderLmTables(); }
  loadSetupForm();
  afterPlanChange(true);
  viewer.fit();
  log('プロジェクトを開きました', 'ok');
});
// CBCT 読込時に保存済みの位置合わせを復元
const _loadDicom = loadDicomFiles;
async function loadDicomWithRestore(files) {
  await _loadDicom(files, { autoAlign: false });
  if (S.pendingCbctMatrix && S.cbct) { S.cbct.M = S.pendingCbctMatrix; S.pendingCbctMatrix = null; drawIso(); drawSlices(); redrawCbctExtras(); renderLmTables(); log('CBCT の位置合わせを復元しました'); }
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
