// 作品圖片分析：把像素分成幾種線、標出每種線的位置、合併與拆分
import { rgbToLab } from './color.js';

export const BG = 255; // 背景（不換色）

// 簡單可重現的亂數，確保同一張圖每次辨識結果一樣
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 先把整張圖轉成 Lab，之後辨識和換色都用這份資料
export function prepareImage(imageData) {
  const { width: w, height: h, data } = imageData;
  const n = w * h;
  const lab = new Float32Array(n * 3);
  // 相同顏色很多，用快取省時間
  const cache = new Map();
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let v = cache.get(key);
    if (!v) {
      v = rgbToLab(r, g, b);
      if (cache.size < 200000) cache.set(key, v);
    }
    lab[i * 3] = v[0];
    lab[i * 3 + 1] = v[1];
    lab[i * 3 + 2] = v[2];
  }
  return { w, h, n, lab, rgba: data };
}

function dist2(lab, i, c, wL = 1) {
  const dL = (lab[i * 3] - c[0]) * wL;
  const da = lab[i * 3 + 1] - c[1];
  const db = lab[i * 3 + 2] - c[2];
  return dL * dL + da * da + db * db;
}

// k-means：在指定的像素裡分出 k 群
function kmeans(lab, indices, k, { iters = 14, seed = 7, wL = 1 } = {}) {
  const rand = rng(seed);
  const m = indices.length;
  if (m === 0) return { centers: [], assign: new Uint8Array(0) };
  k = Math.min(k, m);
  // k-means++ 初始化
  const centers = [];
  const first = indices[Math.floor(rand() * m)];
  centers.push([lab[first * 3], lab[first * 3 + 1], lab[first * 3 + 2]]);
  const d = new Float64Array(m).fill(Infinity);
  while (centers.length < k) {
    const c = centers[centers.length - 1];
    let sum = 0;
    for (let j = 0; j < m; j++) {
      const v = dist2(lab, indices[j], c, wL);
      if (v < d[j]) d[j] = v;
      sum += d[j];
    }
    if (sum === 0) break;
    let r = rand() * sum;
    let pick = m - 1;
    for (let j = 0; j < m; j++) {
      r -= d[j];
      if (r <= 0) { pick = j; break; }
    }
    const p = indices[pick];
    centers.push([lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2]]);
  }
  const K = centers.length;
  const assign = new Uint8Array(m);
  for (let it = 0; it < iters; it++) {
    const sums = new Float64Array(K * 3);
    const counts = new Float64Array(K);
    let changed = 0;
    for (let j = 0; j < m; j++) {
      const i = indices[j];
      let best = 0, bd = Infinity;
      for (let c = 0; c < K; c++) {
        const v = dist2(lab, i, centers[c], wL);
        if (v < bd) { bd = v; best = c; }
      }
      if (assign[j] !== best) changed++;
      assign[j] = best;
      sums[best * 3] += lab[i * 3];
      sums[best * 3 + 1] += lab[i * 3 + 1];
      sums[best * 3 + 2] += lab[i * 3 + 2];
      counts[best]++;
    }
    for (let c = 0; c < K; c++) {
      if (counts[c] > 0) centers[c] = [sums[c * 3] / counts[c], sums[c * 3 + 1] / counts[c], sums[c * 3 + 2] / counts[c]];
    }
    if (it > 2 && changed < m * 0.002) break;
  }
  return { centers, assign };
}

// 第一步：把圖分成很多小色群（之後再依敏感度合併）
export function clusterImage(prep, k = 12) {
  const { n, lab } = prep;
  const step = Math.max(1, Math.floor(n / 40000));
  const sample = [];
  for (let i = 0; i < n; i += step) sample.push(i);
  const { centers } = kmeans(lab, sample, k);
  const sub = new Uint8Array(n);
  const counts = new Float64Array(centers.length);
  for (let i = 0; i < n; i++) {
    let best = 0, bd = Infinity;
    for (let c = 0; c < centers.length; c++) {
      const v = dist2(lab, i, centers[c]);
      if (v < bd) { bd = v; best = c; }
    }
    sub[i] = best;
    counts[best]++;
  }
  return { sub, centers, counts: Array.from(counts) };
}

// 敏感度 0–100 → 合併門檻。敏感度越高，分出的線越多
export function thresholdFor(sensitivity) {
  const s = Math.max(0, Math.min(100, sensitivity)) / 100;
  return 42 - s * 36; // 42（很粗）到 6（很細）
}

// 合併距離時亮度的權重較低：同一種線的亮面和陰影比較容易被視為同一種
const MERGE_WL = 0.55;

function mergeDist(a, b) {
  const dL = (a[0] - b[0]) * MERGE_WL;
  return Math.sqrt(dL * dL + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

// 第二步：依敏感度把小色群合併成「線」
export function groupClusters(cluster, sensitivity) {
  const T = thresholdFor(sensitivity);
  const total = cluster.counts.reduce((a, b) => a + b, 0);
  let groups = cluster.centers
    .map((c, i) => ({ members: [i], lab: c.slice(), count: cluster.counts[i] }))
    .filter((g) => g.count > 0);
  const merge = (i, j) => {
    const a = groups[i], b = groups[j];
    const cnt = a.count + b.count;
    a.lab = a.lab.map((v, t) => (v * a.count + b.lab[t] * b.count) / cnt);
    a.count = cnt;
    a.members.push(...b.members);
    groups.splice(j, 1);
  };
  // 依距離由近到遠合併
  for (;;) {
    let bi = -1, bj = -1, bd = Infinity;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const d = mergeDist(groups[i].lab, groups[j].lab);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    }
    if (bi < 0 || bd > T) break;
    merge(bi, bj);
  }
  // 太小的群（雜點）併到最接近的群
  const minCount = total * 0.012;
  for (;;) {
    if (groups.length <= 1) break;
    const idx = groups.findIndex((g) => g.count < minCount);
    if (idx < 0) break;
    let bj = -1, bd = Infinity;
    for (let j = 0; j < groups.length; j++) {
      if (j === idx) continue;
      const d = mergeDist(groups[idx].lab, groups[j].lab);
      if (d < bd) { bd = d; bj = j; }
    }
    const [keep, drop] = groups[bj].count >= groups[idx].count ? [bj, idx] : [idx, bj];
    merge(keep, drop);
  }
  groups.sort((a, b) => b.count - a.count);
  const mapping = new Uint8Array(cluster.centers.length);
  groups.forEach((g, gi) => g.members.forEach((m) => (mapping[m] = gi)));
  return { mapping, count: groups.length };
}

export function labelsFromMapping(sub, mapping) {
  const labels = new Uint8Array(sub.length);
  for (let i = 0; i < sub.length; i++) labels[i] = mapping[sub[i]];
  return labels;
}

// 去掉零星雜點：3×3 範圍內多數決
export function smoothLabels(labels, w, h, passes = 2) {
  let src = labels;
  for (let p = 0; p < passes; p++) {
    const out = new Uint8Array(src);
    const vals = new Uint8Array(9);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const row = (y + dy) * w;
          for (let dx = -1; dx <= 1; dx++) vals[k++] = src[row + x + dx];
        }
        const self = src[y * w + x];
        let best = self, bestCount = 0;
        for (let a = 0; a < 9; a++) {
          let c = 0;
          for (let b = 0; b < 9; b++) if (vals[b] === vals[a]) c++;
          if (c > bestCount) { bestCount = c; best = vals[a]; }
        }
        if (best !== self && bestCount >= 5) out[y * w + x] = best;
      }
    }
    src = out;
  }
  return src;
}

// 每種線的平均顏色與像素數
export function groupStats(prep, labels) {
  const sums = new Float64Array(256 * 3);
  const counts = new Float64Array(256);
  const { lab, n } = prep;
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    sums[l * 3] += lab[i * 3];
    sums[l * 3 + 1] += lab[i * 3 + 1];
    sums[l * 3 + 2] += lab[i * 3 + 2];
    counts[l]++;
  }
  const stats = {};
  for (let l = 0; l < 256; l++) {
    if (counts[l] > 0) stats[l] = { count: counts[l], lab: [sums[l * 3] / counts[l], sums[l * 3 + 1] / counts[l], sums[l * 3 + 2] / counts[l]] };
  }
  return stats;
}

// 拆分：把一種線用 k-means 再分成兩種（這次亮度也算進去）
export function splitGroup(prep, labels, id, newId) {
  const idx = [];
  for (let i = 0; i < labels.length; i++) if (labels[i] === id) idx.push(i);
  if (idx.length < 20) return false;
  const step = Math.max(1, Math.floor(idx.length / 20000));
  const sample = idx.filter((_, j) => j % step === 0);
  const { centers } = kmeans(prep.lab, sample, 2, { seed: 11 });
  if (centers.length < 2) return false;
  let moved = 0;
  for (const i of idx) {
    if (dist2(prep.lab, i, centers[1]) < dist2(prep.lab, i, centers[0])) {
      labels[i] = newId;
      moved++;
    }
  }
  return moved > 0 && moved < idx.length;
}

// 筆刷：把圓形範圍內的像素改成指定的線
export function paintCircle(labels, w, h, cx, cy, r, value) {
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) labels[y * w + x] = value;
    }
  }
}

// 顏色距離。亮度也要算：白色線和淺灰背景主要就差在亮度
function toolDist(lab, i, seed) {
  const dL = (lab[i * 3] - seed[0]) * 0.9;
  const da = lab[i * 3 + 1] - seed[1];
  const db = lab[i * 3 + 2] - seed[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

// 取某一點附近的平均顏色（當作智慧筆刷、魔術棒的基準色）
export function sampleLab(prep, x, y, r = 2) {
  const { w, h, lab } = prep;
  let L = 0, a = 0, b = 0, c = 0;
  for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
      const i = yy * w + xx;
      L += lab[i * 3]; a += lab[i * 3 + 1]; b += lab[i * 3 + 2]; c++;
    }
  }
  return [L / c, a / c, b / c];
}

// 智慧筆刷：圓形範圍內，只塗跟基準色相近的像素
export function paintCircleSmart(labels, prep, cx, cy, r, value, seed, tol) {
  const { w, h, lab } = prep;
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy > r2) continue;
      const i = y * w + x;
      if (toolDist(lab, i, seed) <= tol) labels[i] = value;
    }
  }
}

// 魔術棒：從點下去的地方開始，把相連、顏色相近的整片改成指定的線
export function floodSelect(labels, prep, sx, sy, value, tol) {
  const { w, h, lab } = prep;
  const seed = sampleLab(prep, sx, sy);
  const seen = new Uint8Array(w * h);
  const stack = [sy * w + sx];
  seen[stack[0]] = 1;
  let count = 0;
  while (stack.length) {
    const i = stack.pop();
    if (toolDist(lab, i, seed) > tol) continue;
    labels[i] = value;
    count++;
    const x = i % w;
    if (x > 0 && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
    if (i >= w && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
    if (i < w * (h - 1) && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
  }
  fillHoles(labels, w, h, value);
  return count;
}

// 補洞：周圍大多是指定的線、自己卻不是的零星像素，也改成指定的線（陰影、雜點造成的小洞）
export function fillHoles(labels, w, h, value, passes = 3) {
  for (let p = 0; p < passes; p++) {
    const flip = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (labels[i] === value) continue;
        let c = 0;
        if (labels[i - 1] === value) c++;
        if (labels[i + 1] === value) c++;
        if (labels[i - w] === value) c++;
        if (labels[i + w] === value) c++;
        if (labels[i - w - 1] === value) c++;
        if (labels[i - w + 1] === value) c++;
        if (labels[i + w - 1] === value) c++;
        if (labels[i + w + 1] === value) c++;
        if (c >= 5) flip.push(i);
      }
    }
    if (!flip.length) break;
    for (const i of flip) labels[i] = value;
  }
}

// 自動分開背景：同一種顏色裡，「平滑又大片」的是背景（桌面、地板），「有針目紋理」的是毛線
// 白色作品放在淺色桌面上時，兩者顏色一樣，只能靠紋理分開
// 回傳變成背景的像素數
const TEX_SMOOTH = 0.22; // 細紋理平均起伏小於這個值算平滑（項圈照片量過：背景、陰影 0.0–0.2，毛線 0.3 以上）

export function separateBackground(prep, labels, id) {
  const { w, h, n, lab } = prep;
  const r = Math.max(3, Math.round(Math.max(w, h) * 0.006));
  // 每個像素附近的亮度起伏（紋理強弱）
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = lab[i * 3];
  const blur = (src) => blurR(src, r);
  // 方框模糊（半徑 rr）
  function blurR(src, rr) {
    const r = rr;
    const tmp = new Float32Array(n), out = new Float32Array(n), k = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let a = 0;
      for (let x = -r; x <= r; x++) a += src[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) { tmp[y * w + x] = a / k; a += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let y = -r; y <= r; y++) a += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) { out[y * w + x] = a / k; a += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
    }
    return out;
  }
  // 只看細小的起伏（針目），陰影這種慢慢變暗的漸層不算紋理
  const fine = blurR(L, 2);
  const hp = new Float32Array(n);
  for (let i = 0; i < n; i++) hp[i] = Math.abs(L[i] - fine[i]);
  const tex = blur(hp);
  const smooth = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (labels[i] === id && tex[i] < TEX_SMOOTH) smooth[i] = 1;
  // 平滑的連成一大片（超過整張圖 0.05%）才算背景；毛線上零星的平滑小點不算
  const minArea = n * 0.0005;
  const comp = new Int32Array(n).fill(-1);
  const bg = new Uint8Array(n);
  const stack = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (!smooth[s0] || comp[s0] >= 0) continue;
    const members = [];
    comp[s0] = s0;
    stack.push(s0);
    while (stack.length) {
      const i = stack.pop();
      members.push(i);
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || !smooth[j] || comp[j] >= 0) continue;
        comp[j] = s0;
        stack.push(j);
      }
    }
    if (members.length >= minArea) for (const i of members) bg[i] = 1;
  }
  // 背景的平均顏色
  const sumB = [0, 0, 0];
  let nb = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== id || !bg[i]) continue;
    sumB[0] += lab[i * 3]; sumB[1] += lab[i * 3 + 1]; sumB[2] += lab[i * 3 + 2];
    nb++;
  }
  if (!nb) return 0;
  const cb = sumB.map((v) => v / nb);
  // 交界附近（紋理是看一個範圍算的，會往外暈開幾個像素）：
  // 用更小的範圍重新看紋理，平滑的算背景；一圈一圈往外推，碰到毛線就停
  const tex2 = blurR(hp, 1);
  const bgL = cb[0];
  for (let pass = 0; pass < r * 3; pass++) {
    const grow = [];
    for (let i = 0; i < n; i++) {
      if (bg[i] || labels[i] !== id) continue;
      const x = i % w;
      if ((x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (i >= w && bg[i - w]) || (i + w < n && bg[i + w])) grow.push(i);
    }
    let added = 0;
    for (const i of grow) {
      // 很平滑（陰影漸層也算），或是平滑又跟背景差不多亮
      if (tex2[i] < TEX_SMOOTH * 1.2 || (tex2[i] < TEX_SMOOTH * 1.8 && Math.abs(lab[i * 3] - bgL) < 4)) { bg[i] = 1; added++; }
    }
    if (!added) break;
  }
  // 剩下的「毛線」裡，靠近圖片邊緣又很小塊的（浮水印、雜點）也算背景；作品中間的小點（裝飾針）保留
  const edge = Math.round(Math.min(w, h) * 0.04);
  const seen = new Uint8Array(n);
  for (let s0 = 0; s0 < n; s0++) {
    if (seen[s0] || bg[s0] || labels[s0] !== id) continue;
    const members = [];
    let nearEdge = false;
    seen[s0] = 1;
    stack.push(s0);
    while (stack.length) {
      const i = stack.pop();
      members.push(i);
      const x = i % w, y = (i / w) | 0;
      if (x < edge || y < edge || x >= w - edge || y >= h - edge) nearEdge = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || seen[j] || bg[j] || labels[j] !== id) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (members.length < n * 0.004 && nearEdge) for (const i of members) bg[i] = 1;
  }
  let moved = 0;
  for (let i = 0; i < n; i++) if (bg[i] && labels[i] === id) { labels[i] = BG; moved++; }
  return moved;
}

// 找出每種線要標數字的位置：每個大區塊裡「離邊界最遠」的點
export function labelPositions(labels, w, h, ids) {
  const scale = Math.min(1, 180 / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  const small = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < sw; x++) small[y * sw + x] = labels[sy * w + Math.min(w - 1, Math.floor(x / scale))];
  }
  // 到邊界的距離（chamfer 距離轉換）
  const INF = 1e9;
  const dt = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      const v = small[i];
      const edge = x === 0 || y === 0 || x === sw - 1 || y === sh - 1 ||
        small[i - 1] !== v || small[i + 1] !== v || small[i - sw] !== v || small[i + sw] !== v;
      dt[i] = edge ? 0 : INF;
    }
  }
  for (let y = 1; y < sh; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x;
      dt[i] = Math.min(dt[i], dt[i - 1] + 1, dt[i - sw] + 1, dt[i - sw - 1] + 1.4, dt[i - sw + 1] + 1.4);
    }
  }
  for (let y = sh - 2; y >= 0; y--) {
    for (let x = sw - 2; x >= 1; x--) {
      const i = y * sw + x;
      dt[i] = Math.min(dt[i], dt[i + 1] + 1, dt[i + sw] + 1, dt[i + sw + 1] + 1.4, dt[i + sw - 1] + 1.4);
    }
  }
  // 連通區塊
  const comp = new Int32Array(sw * sh).fill(-1);
  const comps = [];
  const stack = [];
  for (let s = 0; s < sw * sh; s++) {
    if (comp[s] >= 0) continue;
    const v = small[s];
    const c = { label: v, size: 0, best: s, bestD: -1, pixels: [] };
    comp[s] = comps.length;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      c.size++;
      c.pixels.push(i);
      const x = i % sw;
      const nb = [x > 0 ? i - 1 : -1, x < sw - 1 ? i + 1 : -1, i - sw, i + sw];
      for (const j of nb) {
        if (j < 0 || j >= sw * sh || comp[j] >= 0 || small[j] !== v) continue;
        comp[j] = comps.length;
        stack.push(j);
      }
    }
    // 離邊界最遠的點；一樣遠時選最靠近區塊中心的，數字才不會擠在邊邊
    let cx = 0, cy = 0;
    for (const i of c.pixels) { cx += i % sw; cy += (i / sw) | 0; }
    cx /= c.size; cy /= c.size;
    let bestScore = -Infinity;
    for (const i of c.pixels) {
      const score = Math.min(dt[i], 6) * 1000 + dt[i] - Math.hypot((i % sw) - cx, ((i / sw) | 0) - cy);
      if (score > bestScore) { bestScore = score; c.best = i; }
    }
    c.pixels = null;
    comps.push(c);
  }
  const total = sw * sh;
  const out = {};
  for (const id of ids) {
    const mine = comps.filter((c) => c.label === id).sort((a, b) => b.size - a.size);
    if (!mine.length) { out[id] = []; continue; }
    const biggest = mine[0].size;
    out[id] = mine
      .filter((c, k) => k === 0 || (c.size >= biggest * 0.3 && c.size >= total * 0.015))
      .slice(0, 3)
      .map((c) => ({ x: ((c.best % sw) + 0.5) / sw, y: (Math.floor(c.best / sw) + 0.5) / sh }));
  }
  return out;
}

// 儲存用：把區域資料壓縮成文字（連續相同值只記一次）
export function encodeLabels(labels) {
  const bytes = [];
  const pushVar = (v) => {
    while (v >= 0x80) { bytes.push((v & 0x7f) | 0x80); v >>>= 7; }
    bytes.push(v);
  };
  let i = 0;
  while (i < labels.length) {
    const v = labels[i];
    let j = i + 1;
    while (j < labels.length && labels[j] === v) j++;
    bytes.push(v);
    pushVar(j - i);
    i = j;
  }
  const u8 = new Uint8Array(bytes);
  let bin = '';
  for (let k = 0; k < u8.length; k += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
  return btoa(bin);
}

export function decodeLabels(b64, n) {
  const bin = atob(b64);
  const labels = new Uint8Array(n);
  let p = 0, i = 0;
  while (p < bin.length && i < n) {
    const v = bin.charCodeAt(p++);
    let run = 0, shift = 0, byte;
    do {
      byte = bin.charCodeAt(p++);
      run |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    labels.fill(v, i, Math.min(n, i + run));
    i += run;
  }
  return labels;
}
