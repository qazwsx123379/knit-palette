// 換色：保留原本的織紋和陰影，只把顏色換成新的線
import { hexToLab, labToRgb } from './color.js';
import { BG } from './segment.js';

// 每種線的亮度分布（平均、最暗 2%、最亮 2%），用來決定紋理要保留多少
function lightnessStats(prep, labels) {
  const hist = new Map();
  const { n, lab } = prep;
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l === BG) continue;
    let hh = hist.get(l);
    if (!hh) { hh = new Float64Array(101); hist.set(l, hh); }
    hh[Math.max(0, Math.min(100, Math.round(lab[i * 3])))]++;
  }
  const out = {};
  for (const [l, hh] of hist) {
    let total = 0, sum = 0;
    for (let v = 0; v <= 100; v++) { total += hh[v]; sum += v * hh[v]; }
    let acc = 0, p2 = 0, p98 = 100;
    for (let v = 0; v <= 100; v++) { acc += hh[v]; if (acc >= total * 0.02) { p2 = v; break; } }
    acc = 0;
    for (let v = 100; v >= 0; v--) { acc += hh[v]; if (acc >= total * 0.02) { p98 = v; break; } }
    out[l] = { mean: sum / total, p2, p98 };
  }
  return out;
}

// targets: { [labelId]: { srcLab, hex } }，沒有指定的線維持原色
export function recolor(prep, labels, targets, out) {
  const { n, w, h, lab, rgba } = prep;
  const dst = out.data;
  const stats = lightnessStats(prep, labels);
  const plan = new Array(256).fill(null);
  for (const [id, t] of Object.entries(targets)) {
    if (!t || !t.hex || !t.srcLab || !stats[id]) continue;
    const [tL, ta, tb] = hexToLab(t.hex);
    const st = stats[id];
    // 紋理（亮暗差）照原樣搬過去；新顏色太亮或太暗放不下時才等比例壓縮，避免亮部變成一片白
    const up = Math.max(1, st.p98 - st.mean), down = Math.max(1, st.mean - st.p2);
    let k = Math.min(1, (99 - tL) / up, (tL - 3) / down);
    k = Math.max(0.45, k);
    plan[id] = { tL, ta, tb, sL: st.mean, sa: t.srcLab[1], sb: t.srcLab[2], k };
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
    let L2 = p.tL + (L - p.sL) * p.k;
    if (L2 > 99.5) L2 = 99.5 - (L2 - 99.5) * 0.1;
    if (L2 < 1) L2 = 1;
    // 越暗的地方彩度稍微低一點，看起來比較自然；保留一點原本的色偏變化
    let cs = 0.8 + 0.2 * (L2 / Math.max(p.tL, 1));
    if (cs > 1.1) cs = 1.1;
    // 原本的色偏只留一點點，而且有上限：不然原本是橘色的地方換成白色後會帶著橘色
    const da = Math.max(-4, Math.min(4, (a - p.sa) * 0.2));
    const db = Math.max(-4, Math.min(4, (b - p.sb) * 0.2));
    const a2 = p.ta * cs + da;
    const b2 = p.tb * cs + db;
    const [r, g, bb] = labToRgb(L2, a2, b2);
    dst[o] = r; dst[o + 1] = g; dst[o + 2] = bb; dst[o + 3] = 255;
  }
  smoothEdges(labels, w, h, dst, plan);
  return out;
}

// 交界處柔化：兩種線交界的像素取周圍平均，邊緣就不會有鋸齒
function smoothEdges(labels, w, h, dst, plan) {
  const src = new Uint8ClampedArray(dst);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = labels[i];
      if (labels[i - 1] === l && labels[i + 1] === l && labels[i - w] === l && labels[i + w] === l) continue;
      // 兩邊都沒換色就不用處理
      if (!plan[l] && !plan[labels[i - 1]] && !plan[labels[i + 1]] && !plan[labels[i - w]] && !plan[labels[i + w]]) continue;
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += src[((y + dy) * w + x + dx) * 4 + c] * (dx === 0 && dy === 0 ? 2 : 1);
        dst[i * 4 + c] = s / 10;
      }
    }
  }
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
