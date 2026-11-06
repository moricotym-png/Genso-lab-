// 歯列弓の形：左右対称の偶数次多項式 y = c0 + c2 x^2 + c4 x^4（歯列座標系、x=左右, y=前方）

export class ArchCurve {
  constructor(c0, c2, c4) { this.c0 = c0; this.c2 = c2; this.c4 = c4; }
  y(x) { return this.c0 + this.c2 * x * x + this.c4 * x ** 4; }
  dy(x) { return 2 * this.c2 * x + 4 * this.c4 * x ** 3; }
  /** x=0 から x までの弧長（符号つき） */
  arcLength(x) {
    const n = 64, h = x / n;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const xm = (i + 0.5) * h;
      s += Math.sqrt(1 + this.dy(xm) ** 2) * h;
    }
    return s;
  }
  /** 弧長 s（符号つき）となる x */
  xAtArc(s) {
    let lo = 0, hi = Math.sign(s) * 80;
    if (s === 0) return 0;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (Math.abs(this.arcLength(mid)) < Math.abs(s)) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  point(x) { return [x, this.y(x)]; }
  /** 正規化接線（+x 方向） */
  tangent(x) { const d = this.dy(x), l = Math.hypot(1, d); return [1 / l, d / l]; }
  /** 外向き法線（頬側） */
  normal(x) { const d = this.dy(x), l = Math.hypot(1, d); return [-d / l, 1 / l]; }
  clone() { return new ArchCurve(this.c0, this.c2, this.c4); }
  toJSON() { return { c0: this.c0, c2: this.c2, c4: this.c4 }; }
}

/** 点列 [[x,y],...] に最小二乗でフィット（重み任意） */
export function fitArch(points, weights = null) {
  // 正規方程式 3x3
  const A = new Array(9).fill(0), b = [0, 0, 0];
  points.forEach(([x, y], i) => {
    const w = weights ? weights[i] : 1;
    const phi = [1, x * x, x ** 4];
    for (let r = 0; r < 3; r++) {
      b[r] += w * phi[r] * y;
      for (let c = 0; c < 3; c++) A[r * 3 + c] += w * phi[r] * phi[c];
    }
  });
  // 4次項の暴れを抑える小さな正則化
  A[8] += 1e-6 * (A[0] || 1);
  const sol = solve3(A, b);
  return new ArchCurve(sol[0], sol[1], sol[2]);
}

export function solve3(A, b) {
  const M = [A.slice(0, 3).concat(b[0]), A.slice(3, 6).concat(b[1]), A.slice(6, 9).concat(b[2])];
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / (M[0][0] || 1e-12), M[1][3] / (M[1][1] || 1e-12), M[2][3] / (M[2][2] || 1e-12)];
}

/** 典型的な歯列弓テンプレート（形のみ。大きさは臼歯幅に合わせて使う） */
export const ARCH_TEMPLATES = {
  current: '現状の形を維持',
  ovoid: 'オボイド',
  tapered: 'テーパー',
  square: 'スクエア',
};

/**
 * 臼歯点 (xm, ym) と前歯点 (0, y0) を通るテンプレート形状を作る
 * shape: 4次項の割合（0=放物線, 大きいほどスクエア）
 */
export function templateArch(kind, xm, ym, y0) {
  const k4 = { ovoid: 0.25, tapered: 0.0, square: 0.55 }[kind] ?? 0.25;
  // 前後差 D = ym - y0 を 2次項と4次項に配分（4次項が多いほど前歯部が平ら＝スクエア）
  const D = ym - y0;
  const c2 = ((1 - k4) * D) / (xm * xm);
  const c4 = (k4 * D) / xm ** 4;
  return new ArchCurve(y0, c2, c4);
}
