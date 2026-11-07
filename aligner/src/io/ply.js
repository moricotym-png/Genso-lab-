// PLY 読み込み（ASCII / binary_little_endian / binary_big_endian）。頂点カラー（red/green/blue）に対応。
// 戻り値: { positions: Float32Array, indices: Uint32Array, colors: Float32Array | null (0..1) }

const SIZE = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

function reader(dv, little) {
  return {
    char: (o) => dv.getInt8(o), int8: (o) => dv.getInt8(o), uchar: (o) => dv.getUint8(o), uint8: (o) => dv.getUint8(o),
    short: (o) => dv.getInt16(o, little), int16: (o) => dv.getInt16(o, little), ushort: (o) => dv.getUint16(o, little), uint16: (o) => dv.getUint16(o, little),
    int: (o) => dv.getInt32(o, little), int32: (o) => dv.getInt32(o, little), uint: (o) => dv.getUint32(o, little), uint32: (o) => dv.getUint32(o, little),
    float: (o) => dv.getFloat32(o, little), float32: (o) => dv.getFloat32(o, little), double: (o) => dv.getFloat64(o, little), float64: (o) => dv.getFloat64(o, little),
  };
}

export function parsePLY(buffer) {
  const bytes = new Uint8Array(buffer);
  // ヘッダ
  let end = -1;
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const m = head.match(/end_header\r?\n/);
  if (!m) throw new Error('PLY のヘッダが読めません');
  end = m.index + m[0].length;
  const lines = head.slice(0, m.index).split(/\r?\n/);
  if (lines[0].trim() !== 'ply') throw new Error('PLY 形式ではありません');
  let format = 'ascii';
  const elements = [];
  for (const ln of lines) {
    const a = ln.trim().split(/\s+/);
    if (a[0] === 'format') format = a[1];
    else if (a[0] === 'element') elements.push({ name: a[1], count: +a[2], props: [] });
    else if (a[0] === 'property' && elements.length) {
      const el = elements[elements.length - 1];
      if (a[1] === 'list') el.props.push({ list: true, countType: a[2], type: a[3], name: a[4] });
      else el.props.push({ type: a[1], name: a[2] });
    }
  }
  const vEl = elements.find((e) => e.name === 'vertex');
  if (!vEl) throw new Error('PLY に頂点がありません');
  const nv = vEl.count;
  const positions = new Float32Array(nv * 3);
  const pn = vEl.props.map((p) => p.name);
  const hasColor = pn.includes('red') && pn.includes('green') && pn.includes('blue');
  const colors = hasColor ? new Float32Array(nv * 3) : null;
  const idx = [];
  const colorScale = (p) => (p.type === 'float' || p.type === 'float32' || p.type === 'double' ? 1 : p.type.includes('short') || p.type.includes('16') ? 1 / 65535 : 1 / 255);
  const setVertex = (i, name, v, p) => {
    if (name === 'x') positions[3 * i] = v; else if (name === 'y') positions[3 * i + 1] = v; else if (name === 'z') positions[3 * i + 2] = v;
    else if (colors && name === 'red') colors[3 * i] = v * colorScale(p);
    else if (colors && name === 'green') colors[3 * i + 1] = v * colorScale(p);
    else if (colors && name === 'blue') colors[3 * i + 2] = v * colorScale(p);
  };
  const addFace = (list) => { for (let k = 1; k + 1 < list.length; k++) idx.push(list[0], list[k], list[k + 1]); };

  if (format === 'ascii') {
    const text = new TextDecoder().decode(bytes.subarray(end));
    const tok = text.split(/\s+/).filter(Boolean);
    let t = 0;
    for (const el of elements) {
      for (let i = 0; i < el.count; i++) {
        for (const p of el.props) {
          if (p.list) {
            const n = +tok[t++];
            const list = [];
            for (let k = 0; k < n; k++) list.push(+tok[t++]);
            if (el.name === 'face' && /vertex_ind/.test(p.name)) addFace(list);
          } else {
            const v = +tok[t++];
            if (el.name === 'vertex') setVertex(i, p.name, v, p);
          }
        }
      }
    }
  } else {
    const little = format === 'binary_little_endian';
    const dv = new DataView(buffer);
    const R = reader(dv, little);
    let o = end;
    for (const el of elements) {
      for (let i = 0; i < el.count; i++) {
        for (const p of el.props) {
          if (p.list) {
            const n = R[p.countType](o); o += SIZE[p.countType];
            const list = new Array(n);
            for (let k = 0; k < n; k++) { list[k] = R[p.type](o); o += SIZE[p.type]; }
            if (el.name === 'face' && /vertex_ind/.test(p.name)) addFace(list);
          } else {
            const v = R[p.type](o); o += SIZE[p.type];
            if (el.name === 'vertex') setVertex(i, p.name, v, p);
          }
        }
      }
    }
  }
  return { positions, indices: Uint32Array.from(idx), colors };
}
