// 換色：保留原本的織紋和光影，只把顏色換成新的線
// 做法：
// 1. 先算出每個地方「附近的平均亮度」（只看同一種線、大約幾個針目的範圍）
//    像素比附近亮多少、暗多少，就是針目的紋理和光影
//    這樣即使一種線裡混了原本不同的顏色（例如白色花邊加棕色細圈），整片都會換成新顏色，不會白的還是白的
// 2. 紋理強弱調整成「新顏色的真實毛線大概會有的程度」
//    （用 EX991 色卡上 16 種真實毛線量過：中間色大約 6–8，接近白色時只有 3 左右）
// 3. 大範圍的明暗（光線方向、陰影）保留六成，看起來比較立體
// 4. 暗的地方（針目凹陷）顏色更深更飽和，不會變灰；只有最亮的地方往白色靠（反光）
import { hexToLab, labToRgb } from './color.js';
import { BG } from './segment.js';

// 方框模糊（先橫後直），用來算附近的平均
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// 某一種線在每個像素附近的平均亮度（不混到別種線）
function localMeanL(prep, labels, id, r) {
  const { w, h, n, lab } = prep;
  const val = new Float32Array(n);
  const msk = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (labels[i] === id) { val[i] = lab[i * 3]; msk[i] = 1; }
  }
  const sv = boxBlur(val, w, h, r);
  const sm = boxBlur(msk, w, h, r);
  for (let i = 0; i < n; i++) sv[i] = sm[i] > 0 ? sv[i] / sm[i] : 0;
  return sv;
}

// 真實毛線照片在這個亮度下大概的光影起伏
function naturalTexture(L) {
  if (L > 90) return 8 - ((L - 90) / 10) * 4.5; // 越接近白色越淡
  if (L < 20) return 6 + (L / 20) * 2;
  return 8;
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
  const r = Math.max(4, Math.round(Math.max(w, h) * 0.012));
  const plan = new Array(256).fill(null);
  const local = new Array(256).fill(null);
  for (const [key, t] of Object.entries(targets)) {
    const id = Number(key);
    if (!t || !t.hex || !t.srcLab) continue;
    const lm = localMeanL(prep, labels, id, r);
    // 紋理的起伏（像素和附近平均的差）、整體平均
    let s = 0, s2 = 0, sum = 0, c = 0;
    for (let i = 0; i < n; i++) {
      if (labels[i] !== id) continue;
      const d = lab[i * 3] - lm[i];
      s += d; s2 += d * d; sum += lm[i]; c++;
    }
    if (!c) continue;
    const sd = Math.sqrt(Math.max(0, s2 / c - (s / c) ** 2));
    const [tL, ta, tb] = hexToLab(t.hex);
    let k = Math.max(0.6, Math.min(3, naturalTexture(tL) / Math.max(1.2, sd)));
    // 幾乎沒有紋理的地方（背景、平滑的布）不要放大，不然會把照片雜訊放大成斑紋
    if (sd < 2.2) k = Math.min(k, 1.1);
    plan[id] = { tL, ta, tb, mean: sum / c, sa: t.srcLab[1], sb: t.srcLab[2], k };
    local[id] = lm;
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
    const lm = local[l][i];
    // 大範圍的明暗（陰影、光線方向）保留六成；有上限，避免原本不同顏色的部分換色後一塊亮一塊暗
    const shade = Math.max(-14, Math.min(10, (lm - p.mean) * 0.6));
    const L2 = softClip(p.tL + shade + (L - lm) * p.k);
    // 彩度：真的毛線在凹陷處顏色更深、更飽和，所以暗的地方不降低（深色時稍微加一點）；
    // 比平均亮的地方才往白色靠，像反光
    let cs;
    if (L2 <= p.tL) cs = 1 + 0.12 * Math.min(1, (p.tL - L2) / 25);
    else cs = Math.max(0.3, 1 - ((L2 - p.tL) / Math.max(8, 100 - p.tL)) * 0.85);
    // 原本的色偏只留一點點，而且有上限：不然原本是橘色的地方換成白色後會帶著橘色
    const da = Math.max(-4, Math.min(4, (a - p.sa) * 0.2));
    const db = Math.max(-4, Math.min(4, (b - p.sb) * 0.2));
    const [rr, g, bb] = labToRgb(L2, p.ta * cs + da, p.tb * cs + db);
    dst[o] = rr; dst[o + 1] = g; dst[o + 2] = bb; dst[o + 3] = 255;
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
