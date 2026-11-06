// DICOM 読み込み（非圧縮の Explicit/Implicit VR Little Endian）。CT/CBCT のシリーズ → ボリューム。
// 圧縮（JPEG/JPEG2000 等）は未対応：その場合は医用ビューワで「非圧縮」で書き出してください。

const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT', 'OV', 'SV', 'UV']);
const IMPLICIT = '1.2.840.10008.1.2';
const EXPLICIT_LE = '1.2.840.10008.1.2.1';
const DEFLATE = '1.2.840.10008.1.2.1.99';

// Implicit VR のときに数値型として解釈すべき主なタグ
const IMPLICIT_US = new Set(['00280010', '00280011', '00280100', '00280101', '00280102', '00280103', '00280002']);

const tagStr = (g, e) => g.toString(16).padStart(4, '0') + e.toString(16).padStart(4, '0');

function readString(bytes, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = bytes[off + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function parseDataset(dv, bytes, start, end, explicit, ds, stopAtDelim) {
  let o = start;
  while (o + 8 <= end) {
    const g = dv.getUint16(o, true), e = dv.getUint16(o + 2, true);
    const tag = tagStr(g, e);
    if (g === 0xfffe) {
      // アイテム/区切り
      const l = dv.getUint32(o + 4, true);
      if (e === 0xe00d || e === 0xe0dd) return o + 8;
      o += 8 + (l === 0xffffffff ? 0 : l);
      continue;
    }
    let vr = null, len, hdr;
    const useExplicit = explicit || g === 0x0002;
    if (useExplicit) {
      vr = String.fromCharCode(bytes[o + 4], bytes[o + 5]);
      if (LONG_VR.has(vr)) { len = dv.getUint32(o + 8, true); hdr = 12; }
      else { len = dv.getUint16(o + 6, true); hdr = 8; }
    } else {
      len = dv.getUint32(o + 4, true); hdr = 8;
      if (tag === '7fe00010') vr = 'OW';
    }
    const vo = o + hdr;
    const isSQ = vr === 'SQ' || (!useExplicit && len === 0xffffffff && tag !== '7fe00010');
    if (isSQ) {
      const items = [];
      let p = vo;
      const sqEnd = len === 0xffffffff ? end : vo + len;
      while (p + 8 <= sqEnd) {
        const ig = dv.getUint16(p, true), ie = dv.getUint16(p + 2, true);
        const il = dv.getUint32(p + 4, true);
        if (ig === 0xfffe && ie === 0xe0dd) { p += 8; break; }
        if (ig === 0xfffe && ie === 0xe000) {
          const item = {};
          if (il === 0xffffffff) p = parseDataset(dv, bytes, p + 8, sqEnd, explicit, item, true);
          else { parseDataset(dv, bytes, p + 8, p + 8 + il, explicit, item, false); p = p + 8 + il; }
          items.push(item);
        } else break;
      }
      ds[tag] = { vr: 'SQ', items };
      o = len === 0xffffffff ? p : vo + len;
      continue;
    }
    if (tag === '7fe00010') {
      if (len === 0xffffffff) { ds[tag] = { vr, encapsulated: true }; return end; }
      ds[tag] = { vr, offset: vo, length: len };
      o = vo + len;
      continue;
    }
    if (len === 0xffffffff) return end; // 想定外
    ds[tag] = { vr, offset: vo, length: len };
    o = vo + len;
  }
  return o;
}

function makeAccessor(dv, bytes, ds, explicit) {
  const get = (tag, d = ds) => d[tag];
  const str = (tag, d = ds) => { const el = get(tag, d); return el && el.offset !== undefined ? readString(bytes, el.offset, el.length) : null; };
  const nums = (tag, d = ds) => { const s = str(tag, d); return s ? s.split('\\').map(Number) : null; };
  const us = (tag, d = ds) => {
    const el = get(tag, d);
    if (!el || el.offset === undefined) return null;
    if (el.vr === 'US' || (!explicit && IMPLICIT_US.has(tag))) return dv.getUint16(el.offset, true);
    if (el.vr === 'IS') return parseInt(str(tag, d), 10);
    return dv.getUint16(el.offset, true);
  };
  return { get, str, nums, us };
}

/** 1ファイルを解析して、ボリューム構築に必要な情報を返す */
export function parseDicomFile(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let start = 0;
  if (bytes.length > 132 && readString(bytes, 128, 4) === 'DICM') start = 132;
  // メタ情報で転送構文を得る
  const meta = {};
  let o = start;
  while (o + 8 < bytes.length && dv.getUint16(o, true) === 0x0002) {
    const e = dv.getUint16(o + 2, true);
    const vr = String.fromCharCode(bytes[o + 4], bytes[o + 5]);
    let len, hdr;
    if (LONG_VR.has(vr)) { len = dv.getUint32(o + 8, true); hdr = 12; } else { len = dv.getUint16(o + 6, true); hdr = 8; }
    meta[tagStr(2, e)] = readString(bytes, o + hdr, len);
    o += hdr + len;
  }
  const ts = meta['00020010'] || (start === 0 ? IMPLICIT : EXPLICIT_LE);
  if (ts !== IMPLICIT && ts !== EXPLICIT_LE) {
    throw new Error(`未対応の転送構文です (${ts}${ts === DEFLATE ? ' Deflate' : ''})。非圧縮DICOMで書き出してください。`);
  }
  const explicit = ts !== IMPLICIT;
  const ds = {};
  parseDataset(dv, bytes, o, bytes.length, explicit, ds, false);
  const A = makeAccessor(dv, bytes, ds, explicit);
  const px = ds['7fe00010'];
  if (!px) return null; // 画像以外（DICOMDIR など）
  if (px.encapsulated) throw new Error('圧縮されたピクセルデータは未対応です。非圧縮で書き出してください。');

  const rows = A.us('00280010'), cols = A.us('00280011');
  const bits = A.us('00280100') || 16;
  const signed = A.us('00280103') === 1;
  const spp = A.us('00280002') || 1;
  const frames = parseInt(A.str('00280008') || '1', 10) || 1;
  let slope = A.nums('00281053')?.[0] ?? 1;
  let intercept = A.nums('00281052')?.[0] ?? 0;
  let ps = A.nums('00280030');
  let iop = A.nums('00200037');
  let ipp = A.nums('00200032');
  let thick = A.nums('00180050')?.[0];
  const between = A.nums('00180088')?.[0];
  const framePos = [];

  // Enhanced CT（マルチフレーム）の機能グループ
  const shared = ds['52009229']?.items?.[0];
  if (shared) {
    const pm = shared['00289110']?.items?.[0];
    if (pm) { ps = ps || A.nums('00280030', pm); thick = thick ?? A.nums('00180050', pm)?.[0]; }
    const po = shared['00209116']?.items?.[0];
    if (po) iop = iop || A.nums('00200037', po);
    const pv = shared['00289145']?.items?.[0];
    if (pv) { slope = A.nums('00281053', pv)?.[0] ?? slope; intercept = A.nums('00281052', pv)?.[0] ?? intercept; }
  }
  const perFrame = ds['52009230']?.items;
  if (perFrame) {
    for (const it of perFrame) {
      const pp = it['00209113']?.items?.[0];
      framePos.push(pp ? A.nums('00200032', pp) : null);
      if (!ps) { const pm = it['00289110']?.items?.[0]; if (pm) ps = A.nums('00280030', pm); }
      if (!iop) { const po = it['00209116']?.items?.[0]; if (po) iop = A.nums('00200037', po); }
    }
  }
  if (spp !== 1) throw new Error('カラー画像のDICOMは未対応です（CT/CBCTはモノクロ）。');

  const n = rows * cols;
  const pixels = [];
  const bpp = bits / 8;
  for (let f = 0; f < frames; f++) {
    const base = px.offset + f * n * bpp;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let raw;
      if (bits === 16) raw = signed ? dv.getInt16(base + 2 * i, true) : dv.getUint16(base + 2 * i, true);
      else if (bits === 8) raw = signed ? dv.getInt8(base + i) : bytes[base + i];
      else if (bits === 32) raw = signed ? dv.getInt32(base + 4 * i, true) : dv.getUint32(base + 4 * i, true);
      else throw new Error(`BitsAllocated=${bits} は未対応です`);
      out[i] = raw * slope + intercept;
    }
    pixels.push(out);
  }
  return {
    rows, cols, frames, pixels,
    pixelSpacing: ps || [1, 1],
    iop: iop || [1, 0, 0, 0, 1, 0],
    ipp: ipp || [0, 0, 0],
    framePos,
    sliceThickness: between || thick || 1,
    instance: parseInt(A.str('00200013') || '0', 10),
    series: A.str('0020000e') || 'series',
    modality: A.str('00080060') || '',
    patientName: A.str('00100010') || '',
  };
}

/**
 * 複数ファイル → ボリューム。maxVoxels を超える場合は2倍ずつ間引き平均する。
 * 戻り値 { dims, data(Int16Array), spacing, origin, axes:[row,col,slice], info }
 */
export function buildVolume(slicesIn, maxVoxels = 48e6) {
  // 最多シリーズを選ぶ
  const bySeries = new Map();
  for (const s of slicesIn) {
    if (!s) continue;
    if (!bySeries.has(s.series)) bySeries.set(s.series, []);
    bySeries.get(s.series).push(s);
  }
  const series = [...bySeries.values()].sort((a, b) => b.length - a.length)[0];
  if (!series) throw new Error('画像を含むDICOMがありません');
  const ref = series[0];
  const row = ref.iop.slice(0, 3), col = ref.iop.slice(3, 6);
  const nrm = [row[1] * col[2] - row[2] * col[1], row[2] * col[0] - row[0] * col[2], row[0] * col[1] - row[1] * col[0]];
  // フレームを展開
  const frames = [];
  for (const s of series) {
    for (let f = 0; f < s.frames; f++) {
      let pos = s.framePos[f] || null;
      if (!pos) {
        pos = s.frames > 1
          ? [s.ipp[0] + nrm[0] * f * s.sliceThickness, s.ipp[1] + nrm[1] * f * s.sliceThickness, s.ipp[2] + nrm[2] * f * s.sliceThickness]
          : s.ipp;
      }
      frames.push({ pos, data: s.pixels[f], inst: s.instance });
    }
  }
  const proj = (p) => p[0] * nrm[0] + p[1] * nrm[1] + p[2] * nrm[2];
  frames.sort((a, b) => proj(a.pos) - proj(b.pos) || a.inst - b.inst);
  let dz = ref.sliceThickness;
  if (frames.length > 1) {
    const d = (proj(frames[frames.length - 1].pos) - proj(frames[0].pos)) / (frames.length - 1);
    if (Math.abs(d) > 1e-6) dz = d;
  }
  let nx = ref.cols, ny = ref.rows, nz = frames.length;
  let sx = ref.pixelSpacing[1], sy = ref.pixelSpacing[0], sz = dz;
  let f = 1;
  while ((nx / f) * (ny / f) * (nz / f) > maxVoxels) f *= 2;
  const ox = Math.floor(nx / f), oy = Math.floor(ny / f), oz = Math.floor(nz / f);
  const data = new Int16Array(ox * oy * oz);
  for (let k = 0; k < oz; k++) {
    for (let j = 0; j < oy; j++) {
      for (let i = 0; i < ox; i++) {
        let s = 0;
        for (let kk = 0; kk < f; kk++) {
          const fr = frames[k * f + kk].data;
          for (let jj = 0; jj < f; jj++) {
            const rowOff = (j * f + jj) * nx;
            for (let ii = 0; ii < f; ii++) s += fr[rowOff + i * f + ii];
          }
        }
        const v = s / (f * f * f);
        data[(k * oy + j) * ox + i] = Math.max(-32768, Math.min(32767, Math.round(v)));
      }
    }
  }
  const origin = frames[0].pos.slice();
  // 間引き時はボクセル中心をずらす
  if (f > 1) {
    const h = (f - 1) / 2;
    for (let a = 0; a < 3; a++) origin[a] += row[a] * sx * h + col[a] * sy * h + nrm[a] * sz * h;
  }
  return {
    dims: [ox, oy, oz],
    data,
    spacing: [sx * f, sy * f, sz * f],
    origin,
    axes: [row, col, nrm],
    info: { modality: ref.modality, patientName: ref.patientName, downsample: f, slices: frames.length },
  };
}

/** ボリュームのインデックス(i,j,k) → 患者座標(mm) の 4x4（列優先） */
export function volumeMatrix(vol) {
  const [r, c, n] = vol.axes, [sx, sy, sz] = vol.spacing, o = vol.origin;
  return [r[0] * sx, r[1] * sx, r[2] * sx, 0, c[0] * sy, c[1] * sy, c[2] * sy, 0, n[0] * sz, n[1] * sz, n[2] * sz, 0, o[0], o[1], o[2], 1];
}

/** 患者座標 → 連続インデックス */
export function worldToIndex(vol, p) {
  const [r, c, n] = vol.axes, [sx, sy, sz] = vol.spacing, o = vol.origin;
  const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  return [
    (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / sx,
    (d[0] * c[0] + d[1] * c[1] + d[2] * c[2]) / sy,
    (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / sz,
  ];
}

/** 三線形補間でサンプル（範囲外は -1000） */
export function sampleVolume(vol, p) {
  const [x, y, z] = worldToIndex(vol, p);
  const [nx, ny, nz] = vol.dims;
  if (x < 0 || y < 0 || z < 0 || x > nx - 1 || y > ny - 1 || z > nz - 1) return -1000;
  const i = Math.min(nx - 2, Math.floor(x)), j = Math.min(ny - 2, Math.floor(y)), k = Math.min(nz - 2, Math.floor(z));
  const fx = x - i, fy = y - j, fz = z - k;
  const D = vol.data, sxy = nx * ny;
  const at = (a, b, c) => D[c * sxy + b * nx + a];
  const c00 = at(i, j, k) * (1 - fx) + at(i + 1, j, k) * fx;
  const c10 = at(i, j + 1, k) * (1 - fx) + at(i + 1, j + 1, k) * fx;
  const c01 = at(i, j, k + 1) * (1 - fx) + at(i + 1, j, k + 1) * fx;
  const c11 = at(i, j + 1, k + 1) * (1 - fx) + at(i + 1, j + 1, k + 1) * fx;
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
}

/** テスト・デモ用：非圧縮 Explicit VR LE の CT スライスを生成 */
export function writeDicomSlice({ rows, cols, pixels, pixelSpacing = [0.3, 0.3], ipp = [0, 0, 0], iop = [1, 0, 0, 0, 1, 0], instance = 1, series = '1.2.3', slope = 1, intercept = -1024 }) {
  const parts = [];
  const enc = new TextEncoder();
  const el = (g, e, vr, valueBytes) => {
    let v = valueBytes;
    if (v.length % 2) { const t = new Uint8Array(v.length + 1); t.set(v); t[v.length] = vr === 'UI' ? 0 : 0x20; v = t; }
    const long = LONG_VR.has(vr);
    const h = new Uint8Array(long ? 12 : 8);
    const d = new DataView(h.buffer);
    d.setUint16(0, g, true); d.setUint16(2, e, true);
    h[4] = vr.charCodeAt(0); h[5] = vr.charCodeAt(1);
    if (long) d.setUint32(8, v.length, true); else d.setUint16(6, v.length, true);
    parts.push(h, v);
  };
  const s = (g, e, vr, str) => el(g, e, vr, enc.encode(str));
  const u16 = (g, e, n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); el(g, e, 'US', b); };
  const pre = new Uint8Array(132); pre.set(enc.encode('DICM'), 128); parts.push(pre);
  s(0x0002, 0x0010, 'UI', EXPLICIT_LE);
  s(0x0008, 0x0060, 'CS', 'CT');
  s(0x0018, 0x0050, 'DS', String(pixelSpacing[0]));
  s(0x0020, 0x000e, 'UI', series);
  s(0x0020, 0x0013, 'IS', String(instance));
  s(0x0020, 0x0032, 'DS', ipp.join('\\'));
  s(0x0020, 0x0037, 'DS', iop.join('\\'));
  u16(0x0028, 0x0002, 1);
  u16(0x0028, 0x0010, rows);
  u16(0x0028, 0x0011, cols);
  s(0x0028, 0x0030, 'DS', pixelSpacing.join('\\'));
  u16(0x0028, 0x0100, 16);
  u16(0x0028, 0x0103, 1);
  s(0x0028, 0x1052, 'DS', String(intercept));
  s(0x0028, 0x1053, 'DS', String(slope));
  const px = new Uint8Array(rows * cols * 2);
  const pd = new DataView(px.buffer);
  for (let i = 0; i < rows * cols; i++) pd.setInt16(2 * i, Math.round((pixels[i] - intercept) / slope), true);
  el(0x7fe0, 0x0010, 'OW', px);
  let total = 0; for (const p of parts) total += p.length;
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}
