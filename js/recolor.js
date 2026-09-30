// 換色：保留原本的織紋和陰影，只把顏色換成新的線
import { hexToLab, labToRgb, lToY, yToL } from './color.js';
import { BG } from './segment.js';

// targets: { [labelId]: { srcLab, hex } }，沒有指定的線維持原色
export function recolor(prep, labels, targets, out) {
  const { n, lab, rgba } = prep;
  const dst = out.data;
  const plan = new Array(256).fill(null);
  for (const [id, t] of Object.entries(targets)) {
    if (!t || !t.hex || !t.srcLab) continue;
    const tLab = hexToLab(t.hex);
    plan[id] = {
      tL: tLab[0], ta: tLab[1], tb: tLab[2],
      tY: lToY(tLab[0]),
      sY: Math.max(0.004, lToY(t.srcLab[0])),
      sa: t.srcLab[1], sb: t.srcLab[2],
    };
  }
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    const p = l === BG ? null : plan[l];
    const o = i * 4;
    if (!p) {
      dst[o] = rgba[o]; dst[o + 1] = rgba[o + 1]; dst[o + 2] = rgba[o + 2]; dst[o + 3] = 255;
      continue;
    }
    const L = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2];
    // 亮度用比例換算：原本暗 30% 的陰影，換色後也暗 30%
    let f = lToY(L) / p.sY;
    if (f > 3) f = 3;
    let Y = p.tY * f;
    if (Y > 1) Y = 1;
    const L2 = yToL(Y);
    // 越暗的地方彩度越低，看起來才自然
    let s = Math.sqrt(L2 / Math.max(p.tL, 1));
    if (s > 1.15) s = 1.15;
    const a2 = p.ta * s + (a - p.sa) * 0.3;
    const b2 = p.tb * s + (b - p.sb) * 0.3;
    const [r, g, bb] = labToRgb(L2, a2, b2);
    dst[o] = r; dst[o + 1] = g; dst[o + 2] = bb; dst[o + 3] = 255;
  }
  return out;
}

// 平面色塊（調整辨識時看區域用）
export function paintRegions(prep, labels, colors, out, alpha = 0.72) {
  const { n, rgba } = prep;
  const dst = out.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const c = colors[labels[i]];
    if (!c) {
      // 背景：變成淡灰色
      const g = (rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3;
      dst[o] = dst[o + 1] = dst[o + 2] = 200 + g * 0.2;
      dst[o + 3] = 255;
      continue;
    }
    dst[o] = rgba[o] * (1 - alpha) + c[0] * alpha;
    dst[o + 1] = rgba[o + 1] * (1 - alpha) + c[1] * alpha;
    dst[o + 2] = rgba[o + 2] * (1 - alpha) + c[2] * alpha;
    dst[o + 3] = 255;
  }
  return out;
}
