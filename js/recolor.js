// 換色：保留原本的織紋和光影，只把顏色換成新的線
// 做法：
// 1. 每個像素比這種線的平均亮多少、暗多少（光影）照樣搬過去
// 2. 光影的強弱調整成「新顏色的真實毛線大概會有的程度」
//    （用 EX991 色卡上 16 種真實毛線量過：中間色大約 6–8，接近白色時只有 3 左右）
//    白色線照片常常過曝、光影很淡，換成深色時要放大，才不會像平塗一層顏色
// 3. 最亮、最暗的地方柔和收邊；越亮越接近白色（反光），越暗彩度越低
import { hexToLab, labToRgb } from './color.js';
import { BG } from './segment.js';

// 每種線的亮度平均和起伏（標準差）
function lightnessStats(prep, labels) {
  const sum = new Float64Array(256), sum2 = new Float64Array(256), cnt = new Float64Array(256);
  const { n, lab } = prep;
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l === BG) continue;
    const L = lab[i * 3];
    sum[l] += L; sum2[l] += L * L; cnt[l]++;
  }
  const out = {};
  for (let l = 0; l < 256; l++) {
    if (!cnt[l]) continue;
    const mean = sum[l] / cnt[l];
    out[l] = { mean, sd: Math.sqrt(Math.max(0, sum2[l] / cnt[l] - mean * mean)) };
  }
  return out;
}

// 真實毛線照片在這個亮度下大概的光影起伏
function naturalTexture(L) {
  if (L > 90) return 7 - ((L - 90) / 10) * 4; // 越接近白色越淡
  if (L < 20) return 5.5 + (L / 20) * 1.5;
  return 7;
}

// 柔和收邊：超過 92 或低於 6 時慢慢靠近極限，不會切成一整片
function softClip(L) {
  if (L > 92) return 92 + 7.5 * (1 - Math.exp(-(L - 92) / 7.5));
  if (L < 6) return 6 * Math.exp((L - 6) / 6);
  return L;
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
    const k = Math.max(0.6, Math.min(2.5, naturalTexture(tL) / Math.max(1.5, st.sd)));
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
    const L2 = softClip(p.tL + (L - p.sL) * p.k);
    // 彩度：比平均暗的地方稍微降低；比平均亮的地方往白色靠
    let cs;
    if (L2 <= p.tL) cs = 0.8 + 0.2 * (L2 / Math.max(p.tL, 1));
    else cs = Math.max(0.25, (100 - L2) / Math.max(6, 100 - p.tL));
    if (cs > 1) cs = 1;
    // 原本的色偏只留一點點，而且有上限：不然原本是橘色的地方換成白色後會帶著橘色
    const da = Math.max(-4, Math.min(4, (a - p.sa) * 0.2));
    const db = Math.max(-4, Math.min(4, (b - p.sb) * 0.2));
    const [r, g, bb] = labToRgb(L2, p.ta * cs + da, p.tb * cs + db);
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
