// 顏色換算與比較：sRGB、CIE Lab、LCh、色差 (CIEDE2000)

const D65 = [0.95047, 1.0, 1.08883];

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

// 查表加速：0–255 的線性值
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i);

function fLab(t) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function fLabInv(t) {
  const t3 = t * t * t;
  return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
}

export function rgbToLab(r, g, b) {
  const lr = LIN[r], lg = LIN[g], lb = LIN[b];
  const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / D65[0];
  const y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175;
  const z = (lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041) / D65[2];
  const fx = fLab(x), fy = fLab(y), fz = fLab(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = fLabInv(fx) * D65[0];
  const y = fLabInv(fy);
  const z = fLabInv(fz) * D65[2];
  const lr = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const lg = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const lb = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}

// L (0–100) 與相對亮度 Y (0–1) 互換，用來保留陰影比例
export function lToY(L) {
  return fLabInv((L + 16) / 116);
}

export function yToL(Y) {
  return 116 * fLab(Y) - 16;
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function hexToLab(hex) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToLab(r, g, b);
}

export function labToHex(L, a, b) {
  const [r, g, b2] = labToRgb(L, a, b);
  return rgbToHex(r, g, b2);
}

export function labToLch([L, a, b]) {
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, C, h];
}

export function lchToLab([L, C, h]) {
  const r = (h * Math.PI) / 180;
  return [L, C * Math.cos(r), C * Math.sin(r)];
}

// CIEDE2000 色差，數字越小越像
export function deltaE(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) / rad + 360) % 360;
  const h2p = (Math.atan2(b2, a2p) / rad + 360) % 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    else hbp = (h1p + h2p) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * rad) +
    0.24 * Math.cos(2 * hbp * rad) +
    0.32 * Math.cos((3 * hbp + 6) * rad) -
    0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(
    Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh)
  );
}

// 深色背景上該用白字還是黑字
export function readableTextOn(hex) {
  const [L] = hexToLab(hex);
  return L > 60 ? '#1d2322' : '#ffffff';
}

// 從線材清單裡找出相近色與互補色
export function recommend(baseHex, yarns, { count = 6, excludeId = null } = {}) {
  if (!baseHex || !yarns.length) return { similar: [], complement: [] };
  const base = hexToLab(baseHex);
  const [L, C, h] = labToLch(base);
  // 互補色：色相轉 180 度；原色太灰時給一點彩度，才找得到有顏色的線
  const compTarget = lchToLab([L, Math.max(C, 25), (h + 180) % 360]);
  const pool = yarns.filter((y) => y.id !== excludeId && y.hex);
  const withLab = pool.map((y) => ({ y, lab: hexToLab(y.hex) }));
  const similar = withLab
    .map((o) => ({ y: o.y, d: deltaE(base, o.lab) }))
    .filter((o) => o.d > 0.5)
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map((o) => o.y);
  const complement = withLab
    .map((o) => ({ y: o.y, d: deltaE(compTarget, o.lab) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map((o) => o.y);
  return { similar, complement };
}
