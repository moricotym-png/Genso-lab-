// OBJ 読み込み（フェイススキャン用）。テクスチャ座標・頂点カラーに対応。
// 戻り値: { positions, indices, uvs(or null), colors(or null), mtlTexture(名前 or null) }

export function parseOBJ(text) {
  const v = [], vt = [], vc = [];
  const outP = [], outUV = [], outC = [], outI = [];
  const cache = new Map();
  let hasColor = false, texName = null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('v ')) {
      const a = line.trim().split(/\s+/);
      v.push([+a[1], +a[2], +a[3]]);
      if (a.length >= 7) { vc.push([+a[4], +a[5], +a[6]]); hasColor = true; } else vc.push(null);
    } else if (line.startsWith('vt ')) {
      const a = line.trim().split(/\s+/);
      vt.push([+a[1], +a[2]]);
    } else if (line.startsWith('f ')) {
      const a = line.trim().split(/\s+/).slice(1);
      const ids = a.map((tok) => {
        let got = cache.get(tok);
        if (got !== undefined) return got;
        const [pi, ti] = tok.split('/');
        let p = parseInt(pi, 10); p = p < 0 ? v.length + p : p - 1;
        let t = ti ? parseInt(ti, 10) : NaN; if (!isNaN(t)) t = t < 0 ? vt.length + t : t - 1;
        const id = outP.length / 3;
        outP.push(...v[p]);
        outUV.push(...(isNaN(t) || !vt[t] ? [0, 0] : vt[t]));
        const c = vc[p] || [0.8, 0.8, 0.8];
        outC.push(...(c[0] > 1 || c[1] > 1 || c[2] > 1 ? c.map((x) => x / 255) : c));
        cache.set(tok, id);
        return id;
      });
      for (let k = 1; k + 1 < ids.length; k++) outI.push(ids[0], ids[k], ids[k + 1]);
    } else if (line.startsWith('usemtl ')) {
      texName = texName || line.slice(7).trim();
    }
  }
  return {
    positions: Float32Array.from(outP),
    indices: Uint32Array.from(outI),
    uvs: vt.length ? Float32Array.from(outUV) : null,
    colors: hasColor ? Float32Array.from(outC) : null,
    material: texName,
  };
}
