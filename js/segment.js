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
  const scale = chromaScale(lab, sample);
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
  return { sub, centers, counts: Array.from(counts), chromaScale: scale };
}

// 敏感度 0–100 → 合併門檻。敏感度越高，分出的線越多
export function thresholdFor(sensitivity) {
  const s = Math.max(0, Math.min(100, sensitivity)) / 100;
  return 42 - s * 36; // 42（很粗）到 6（很細）
}

// 合併距離時亮度的權重較低：同一種線的亮面和陰影比較容易被視為同一種
const MERGE_WL = 0.55;

// cs：顏色差距的放大倍數。照片整體顏色很淡（光線暗、偏黃、粉彩色線）時放大，
// 才不會把淡藍、淡橘和桌面當成同一種線
function mergeDist(a, b, cs = 1) {
  const dL = (a[0] - b[0]) * MERGE_WL;
  return Math.sqrt(dL * dL + ((a[1] - b[1]) * cs) ** 2 + ((a[2] - b[2]) * cs) ** 2);
}

// 照片的鮮豔程度：取樣像素彩度的第 90 百分位；越淡放大越多（1–2.5 倍）
function chromaScale(lab, indices) {
  const cs = indices.map((i) => Math.hypot(lab[i * 3 + 1], lab[i * 3 + 2])).sort((a, b) => a - b);
  const p90 = cs[Math.floor(cs.length * 0.9)] || 30;
  return Math.max(1, Math.min(2.5, 32 / Math.max(p90, 1)));
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
        const d = mergeDist(groups[i].lab, groups[j].lab, cluster.chromaScale || 1);
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
      const d = mergeDist(groups[idx].lab, groups[j].lab, cluster.chromaScale || 1);
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
// 紋理用「各個方向都有起伏」來看：木紋、布紋只往一個方向有條紋（順著紋路看是平的），
// 毛線針目是一顆一顆的，往哪個方向看都有起伏
// 回傳變成背景的像素數
// 平滑門檻跟著背景本身的紋理調整：取圖片四周（大多是背景）起伏的中位數 × 2.7，限制在 0.3–1.0
// 量過：光滑桌面中位數 0.02（白色毛線 0.5 以上 → 門檻 0.3）；木紋桌面中位數 0.33、最多 0.75（毛線 1 以上 → 門檻 0.9）
const ISO_K = 2.7, ISO_MIN = 0.3, ISO_MAX = 1.0;

// 方框模糊（半徑 r）
export function boxBlur(src, w, h, r) {
  const n = w * h, tmp = new Float32Array(n), out = new Float32Array(n), k = 2 * r + 1;
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

// 四個方向（橫、直、兩個斜向）的亮度變化，各自在半徑 rr 內平均，取最小的那個方向
export function isoTexture(L, w, h, rr) {
  const n = w * h;
  const b = boxBlur(L, w, h, 1);
  const d = [0, 1, 2, 3].map(() => new Float32Array(n));
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      d[0][i] = Math.abs(b[i + 1] - b[i - 1]);
      d[1][i] = Math.abs(b[i + w] - b[i - w]);
      d[2][i] = Math.abs(b[i + w + 1] - b[i - w - 1]) * 0.707;
      d[3][i] = Math.abs(b[i + w - 1] - b[i - w + 1]) * 0.707;
    }
  }
  const m = d.map((a) => boxBlur(a, w, h, rr));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(m[0][i], m[1][i], m[2][i], m[3][i]);
  return out;
}

export function separateBackground(prep, labels, id) {
  const { w, h, n, lab } = prep;
  const r = Math.max(3, Math.round(Math.max(w, h) * 0.006));
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = lab[i * 3];
  // 照片一邊比較暗（光從另一邊來）時，暗處的針目起伏也會跟著變小，會被誤認成平滑的桌面。
  // 所以先把亮度除以附近的平均亮度，看「相對」的起伏
  const Lm = boxBlur(L, w, h, r * 4);
  for (let i = 0; i < n; i++) L[i] = (L[i] * 70) / Math.max(15, Lm[i]);
  const tex = isoTexture(L, w, h, r * 2);
  const edge = Math.round(Math.min(w, h) * 0.04);
  const border = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i] === id && (x < edge || y < edge || x >= w - edge || y >= h - edge)) border.push(tex[i]);
    }
  }
  if (!border.length) return 0;
  const sorted = Float32Array.from(border).sort();
  const T = Math.max(ISO_MIN, Math.min(ISO_MAX, sorted[sorted.length >> 1] * ISO_K));
  const smooth = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (labels[i] === id && tex[i] < T) smooth[i] = 1;
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
  let nb = 0;
  for (let i = 0; i < n; i++) if (bg[i]) nb++;
  if (!nb) return 0;
  // 交界要畫在哪裡：只靠紋理門檻不準（範圍大會留下一條桌面，範圍小會吃掉平滑的白色毛線）。
  // 改用「分水嶺」：先標出確定是背景（上面找到的大片平滑）和確定是毛線（有針目紋理、往內縮一個針目寬，因為紋理會往外暈開約一個針目寬）的地方，
  // 兩邊同時往外長，交界自然落在兩者之間亮暗變化最明顯的那條線（毛線的輪廓）
  const texM = isoTexture(L, w, h, r);
  // 「確定是毛線」用的紋理：先把很暗的地方（不到附近平均的 75%）墊高。作品貼桌面那條很暗的影子線
  // 會讓旁邊的桌面也看起來有紋理；毛線本身的起伏主要在中間到亮的範圍，墊高影響不大
  const Lc = new Float32Array(n);
  for (let i = 0; i < n; i++) Lc[i] = Math.max(L[i], 52);
  const texY = isoTexture(Lc, w, h, r);
  const yarnInd = new Float32Array(n);
  for (let i = 0; i < n; i++) yarnInd[i] = labels[i] !== id ? (labels[i] === BG ? 0 : 1) : texY[i] > T * 1.15 && !bg[i] ? 1 : 0;
  const yarnCore = boxBlur(yarnInd, w, h, r);
  const state = new Uint8Array(n); // 0 未定 1 背景 2 毛線
  for (let i = 0; i < n; i++) {
    if (labels[i] === BG || bg[i]) state[i] = 1;
    else if (labels[i] !== id || yarnCore[i] > 0.999) state[i] = 2;
  }
  // 鏤空花邊的洞：洞裡露出的桌面被毛線圍住，大範圍的紋理會被毛線暈到，找不到。
  // 改看小範圍：平滑、比附近確定是毛線的部分暗很多（不到 80%）、連成一小塊（至少約兩個針目大小）的，當成背景的起點
  {
    const ys = [];
    for (let i = 0; i < n; i += 3) if (labels[i] === id && state[i] === 2) ys.push(lab[i * 3]);
    if (ys.length > 100) {
      ys.sort((a, b) => a - b);
      const medY = ys[ys.length >> 1];
      const texS = isoTexture(L, w, h, 2);
      // 跟「附近」的毛線比亮度（光線不均勻時，暗的那一邊的毛線不能被當成洞）
      const ym = new Float32Array(n), yl = new Float32Array(n);
      for (let i = 0; i < n; i++) if (labels[i] === id && state[i] === 2) { ym[i] = 1; yl[i] = lab[i * 3]; }
      const bym = boxBlur(ym, w, h, r * 10), byl = boxBlur(yl, w, h, r * 10);
      const refY = (i) => (bym[i] > 0.02 ? byl[i] / bym[i] : medY);
      const cand = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (labels[i] === id && state[i] !== 1 && texS[i] < Math.max(T * 2, 1.5) && lab[i * 3] < refY(i) * 0.8) cand[i] = 1;
      const seenH = new Uint8Array(n);
      const minHole = r * r * 2;
      for (let s0 = 0; s0 < n; s0++) {
        if (!cand[s0] || seenH[s0]) continue;
        const members = [];
        seenH[s0] = 1;
        stack.push(s0);
        while (stack.length) {
          const i = stack.pop();
          members.push(i);
          const x = i % w;
          for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
            if (j < 0 || j >= n || !cand[j] || seenH[j]) continue;
            seenH[j] = 1;
            stack.push(j);
          }
        }
        if (members.length >= minHole) for (const i of members) state[i] = 1;
      }
      // 洞的範圍：從找到的洞往外，比附近毛線暗的（不到 85%）都算洞，最多推一個針目寬
      let front = [];
      for (let i = 0; i < n; i++) if (state[i] === 1 && labels[i] === id && seenH[i] && cand[i]) front.push(i);
      for (let pass = 0; pass < r && front.length; pass++) {
        const next = [];
        for (const i of front) {
          const x = i % w;
          for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
            if (j < 0 || j >= n || labels[j] !== id || state[j] === 1 || lab[j * 3] >= refY(j) * 0.85) continue;
            state[j] = 1;
            next.push(j);
          }
        }
        front = next;
      }
    }
  }
  // 顏色也能幫忙時就用：確定是背景的和確定是毛線的，如果色調（a、b，不管亮度）差得夠多
  // （例如灰色桌面和米白毛線），其他像素看色調比較接近哪一邊，很明顯的就直接定下來。
  // 鏤空花邊的洞裡露出的桌面，四周都是毛線、紋理會被暈到，只能靠顏色認出來。木紋桌和白線色調一樣，這步不會作用
  const cB = [0, 0], cY = [0, 0];
  let nB = 0, nY = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== id) continue;
    if (state[i] === 1) { cB[0] += lab[i * 3 + 1]; cB[1] += lab[i * 3 + 2]; nB++; }
    else if (state[i] === 2) { cY[0] += lab[i * 3 + 1]; cY[1] += lab[i * 3 + 2]; nY++; }
  }
  if (nB > n * 0.01 && nY > n * 0.002) {
    const mB = [cB[0] / nB, cB[1] / nB], mY = [cY[0] / nY, cY[1] / nY];
    const sep = Math.hypot(mB[0] - mY[0], mB[1] - mY[1]);
    if (sep > 5) {
      for (let i = 0; i < n; i++) {
        if (labels[i] !== id || state[i]) continue;
        const a = lab[i * 3 + 1], b = lab[i * 3 + 2];
        const dB = Math.hypot(a - mB[0], b - mB[1]), dY = Math.hypot(a - mY[0], b - mY[1]);
        if (dB < sep * 0.3 && dB < dY * 0.4) state[i] = 1;
        else if (dY < sep * 0.3 && dY < dB * 0.4) state[i] = 2;
      }
    }
  }
  // 亮暗變化（梯度）：用調整過亮度的 L，光線不均勻也一樣
  const Lb = boxBlur(L, w, h, 1);
  const grad = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = Lb[i + 1] - Lb[i - 1], gy = Lb[i + w] - Lb[i - w];
      grad[i] = Math.min(255, Math.round(Math.hypot(gx, gy) * 6));
    }
  }
  const buckets = Array.from({ length: 256 }, () => []);
  const queued = new Uint8Array(n);
  const pushN = (i) => {
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= n || state[j] || queued[j]) continue;
      queued[j] = state[i];
      buckets[grad[j]].push(j);
    }
  };
  for (let i = 0; i < n; i++) if (state[i] && labels[i] === id) pushN(i);
  for (let i = 0; i < n; i++) if (state[i] && labels[i] !== id) pushN(i);
  for (let lv = 0; lv < 256; lv++) {
    const bk = buckets[lv];
    while (bk.length) {
      const i = bk.pop();
      if (state[i]) continue;
      state[i] = queued[i];
      // 新加入的鄰居亮暗變化比目前低的，也排在目前這一層（水位不會下降）
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || state[j] || queued[j]) continue;
        queued[j] = state[i];
        buckets[Math.max(lv, grad[j])].push(j);
      }
    }
  }
  for (let i = 0; i < n; i++) if (labels[i] === id && state[i] === 1) bg[i] = 1;
  // 剩下的「毛線」裡，靠近圖片邊緣又很小塊的（浮水印、雜點）也算背景；作品中間的小點（裝飾針）保留
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
  removeShadows(prep, labels, texM, T, id);
  return moved;
}

// 作品投在桌面上的影子：顏色跟背景同色系但比較暗、又平滑，常被分到毛線的群（灰影子併進藍線或杏色線），
// 換色後會變成一圈假邊。從背景往外一圈一圈推，把這種像素也改成背景；最後把作品外面零星的小碎塊也清掉
function removeShadows(prep, labels, texM, T, id) {
  const { w, h, n, lab } = prep;
  const r = Math.max(3, Math.round(Math.max(w, h) * 0.006));
  // 「附近」的背景顏色：照片光線不均勻（一邊比較暗）時，要跟旁邊的桌面比，不能跟整張圖的平均比，
  // 否則暗的那一邊的毛線會被當成影子
  const m = new Float32Array(n), cL = new Float32Array(n), ca = new Float32Array(n), cb = new Float32Array(n);
  let nb = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== BG) continue;
    m[i] = 1; cL[i] = lab[i * 3]; ca[i] = lab[i * 3 + 1]; cb[i] = lab[i * 3 + 2];
    nb++;
  }
  if (!nb) return;
  const R = r * 10;
  const bm = boxBlur(m, w, h, R), bL = boxBlur(cL, w, h, R), ba = boxBlur(ca, w, h, R), bb = boxBlur(cb, w, h, R);
  const isBg = (i) => labels[i] === BG;
  for (let pass = 0; pass < r * 4; pass++) {
    const grow = [];
    for (let i = 0; i < n; i++) {
      if (isBg(i) || bm[i] < 0.02) continue;
      const x = i % w;
      if (!((x > 0 && isBg(i - 1)) || (x < w - 1 && isBg(i + 1)) || (i >= w && isBg(i - w)) || (i + w < n && isBg(i + w)))) continue;
      const L0 = bL[i] / bm[i];
      const dL = L0 - lab[i * 3];
      const dab = Math.hypot(lab[i * 3 + 1] - ba[i] / bm[i], lab[i * 3 + 2] - bb[i] / bm[i]);
      const sameHue = dab < 6 + Math.max(0, dL) * 0.2;
      // 平滑、比旁邊的背景暗、色調跟背景接近（差不多亮的不算：白色毛線邊緣也是這樣，會被一路吃掉）
      if (sameHue && dL > 4 && texM[i] < T * 1.1) grow.push(i);
    }
    for (const i of grow) labels[i] = BG;
    if (!grow.length) break;
  }
  // 影子靠著毛線的部分，紋理分不出來，改看亮度：離背景兩個針目寬以內、亮度不到旁邊桌面的 68%、色調相近的才算影子
  // （量過：作品貼桌面的影子 51–64%、作品中間洞裡的影子 40–60%；背光的白色花邊 73% 以上）
  // 影子和桌面之間常隔著一圈淡淡的半影，所以不要求一路連過去，只看離背景多遠
  const dist = new Uint8Array(n).fill(255);
  let front = [];
  for (let i = 0; i < n; i++) if (isBg(i)) { dist[i] = 0; front.push(i); }
  for (let d = 1; d <= r * 2 && front.length; d++) {
    const next = [];
    for (const i of front) {
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || dist[j] !== 255) continue;
        dist[j] = d;
        next.push(j);
      }
    }
    front = next;
  }
  for (let i = 0; i < n; i++) {
    if (isBg(i) || dist[i] === 255 || bm[i] < 0.02) continue;
    const L0 = bL[i] / bm[i];
    const dL = L0 - lab[i * 3];
    const dab = Math.hypot(lab[i * 3 + 1] - ba[i] / bm[i], lab[i * 3 + 2] - bb[i] / bm[i]);
    if (dab < 6 + Math.max(0, dL) * 0.2 && lab[i * 3] < L0 * 0.68) labels[i] = BG;
  }
  // 作品外面零星的小碎塊（木紋上的亮點、影子邊）：不是背景的像素連成一塊，小於整張圖 0.2% 就算背景
  const seen = new Uint8Array(n);
  const stack = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (seen[s0] || isBg(s0)) continue;
    const members = [];
    seen[s0] = 1;
    stack.push(s0);
    while (stack.length) {
      const i = stack.pop();
      members.push(i);
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || seen[j] || isBg(j)) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (members.length < n * 0.002) for (const i of members) labels[i] = BG;
  }
  removeThin(labels, w, h);
  // 貼在作品邊上的小顆粒（同一種顏色的一小塊，周圍一半以上是背景；或是跟背景同一群、碰到背景的小塊）也算背景；被毛線包住的小裝飾不算
  const seen2 = new Uint8Array(n);
  for (let s0 = 0; s0 < n; s0++) {
    if (seen2[s0] || isBg(s0)) continue;
    const v = labels[s0];
    const members = [];
    let edgeBg = 0, edgeAll = 0;
    seen2[s0] = 1;
    stack.push(s0);
    while (stack.length) {
      const i = stack.pop();
      members.push(i);
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n) continue;
        if (labels[j] !== v) { edgeAll++; if (isBg(j)) edgeBg++; continue; }
        if (seen2[j]) continue;
        seen2[j] = 1;
        stack.push(j);
      }
    }
    if (members.length < n * 0.001 && (edgeBg > edgeAll * 0.5 || (v === id && edgeBg > 0))) for (const i of members) labels[i] = BG;
  }
}

// 兩種線交界、或線和背景交界常有 2–6 像素寬的細條被分到第三種線（例如藍線和杏色線之間的深色縫被當成白線），
// 換色後變成一圈怪色的邊。用 7×7 的「開運算」找出這種細條，改成附近最多的那種線
function removeThin(labels, w, h) {
  const n = w * h;
  const ids = [...new Set(labels)].filter((v) => v !== BG);
  const thin = new Uint8Array(n);
  const ind = new Float32Array(n);
  for (const id of ids) {
    for (let i = 0; i < n; i++) ind[i] = labels[i] === id ? 1 : 0;
    const core = boxBlur(ind, w, h, 3);
    for (let i = 0; i < n; i++) ind[i] = core[i] > 0.999 ? 1 : 0;
    const keep = boxBlur(ind, w, h, 3);
    for (let i = 0; i < n; i++) if (labels[i] === id && keep[i] < 0.001) thin[i] = 1;
  }
  const out = labels.slice();
  const cnt = new Map();
  for (let i = 0; i < n; i++) {
    if (!thin[i]) continue;
    const x = i % w, y = (i / w) | 0;
    cnt.clear();
    for (let dy = -4; dy <= 4; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -4; dx <= 4; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (thin[j]) continue;
        cnt.set(labels[j], (cnt.get(labels[j]) || 0) + 1);
      }
    }
    // 優先給旁邊的毛線；旁邊只有背景才變背景
    let best = -1, bc = 0;
    for (const [v, c] of cnt) if (v !== BG && c > bc) { best = v; bc = c; }
    if (best < 0 && cnt.has(BG)) best = BG;
    if (best >= 0) out[i] = best;
  }
  labels.set(out);
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

// 「陰影群」：光線、壓縮讓某種線的暗部、線和線之間的縫、影子被分成另一群。判斷方式：
// (1) 這群多半是零碎的邊（7×7 範圍內自己這群不到 3/4 的像素超過一半），或
// (2) 有點零碎（超過 1/4），而且「調亮之後」顏色跟旁邊某種較大的線一樣（暗杏色＝杏色線的陰影）。
// 真的深色線（例如咖啡色）會自己連成一大片，不會被當成陰影。
// 拆掉的群，每個像素交給附近「調亮後顏色最接近」的那種線。回傳拆掉幾群
// 暗的顏色調亮到 L：a、b 跟著亮度等比例放大（最多 3 倍）
function shadeDist(p, g) {
  const k = Math.max(1, Math.min(3, g[0] / Math.max(p[0], 10)));
  return Math.hypot((p[0] - g[0]) * 0.15, p[1] * k - g[1], p[2] * k - g[2]);
}

export function dissolveEdgeGroups(prep, labels) {
  const { w, h, n, lab } = prep;
  const ids = [...new Set(labels)].filter((v) => v !== BG);
  if (ids.length < 2) return 0;
  const ind = new Float32Array(n);
  const stats = groupStats(prep, labels);
  const dissolve = new Set();
  for (const id of ids) {
    const st = stats[id];
    if (!st || st.count > n * 0.15) continue;
    for (let i = 0; i < n; i++) ind[i] = labels[i] === id ? 1 : 0;
    const frac = boxBlur(ind, w, h, 3);
    let edge = 0;
    for (let i = 0; i < n; i++) if (ind[i] && frac[i] < 0.75) edge++;
    const ef = edge / st.count;
    const shadeOf = ids.some((o) => o !== id && stats[o].count > st.count * 0.5 && stats[o].lab[0] > st.lab[0] + 8 && shadeDist(st.lab, stats[o].lab) < 10);
    if (ef > 0.5 || (ef > 0.25 && shadeOf)) dissolve.add(id);
  }
  if (!dissolve.size || dissolve.size === ids.length) return 0;
  const colorOf = (id) => stats[id] && stats[id].lab;
  const RW = 5;
  let todo = [];
  for (let i = 0; i < n; i++) if (dissolve.has(labels[i])) todo.push(i);
  const px = [0, 0, 0];
  for (let pass = 0; pass < 20 && todo.length; pass++) {
    const assign = [];
    const left = [];
    for (const i of todo) {
      const x = i % w, y = (i / w) | 0;
      const cnt = new Map();
      for (let dy = -RW; dy <= RW; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -RW; dx <= RW; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const v = labels[yy * w + xx];
          if (dissolve.has(v)) continue;
          cnt.set(v, (cnt.get(v) || 0) + 1);
        }
      }
      px[0] = lab[i * 3]; px[1] = lab[i * 3 + 1]; px[2] = lab[i * 3 + 2];
      let best = -1, bs = -1;
      for (const [v, c] of cnt) {
        const g = colorOf(v);
        if (!g) continue;
        const score = Math.sqrt(c) * Math.exp(-shadeDist(px, g) / 10);
        if (score > bs) { bs = score; best = v; }
      }
      if (best >= 0) assign.push([i, best]);
      else left.push(i);
    }
    for (const [i, v] of assign) labels[i] = v;
    todo = left;
  }
  return dissolve.size;
}

// 同一種顏色、但在作品上分開的區塊，各自變成一種線（例如花邊、花心、內圈雖然都是白色）。
// 每種線裡最大的一塊保留原本的編號，其他夠大的（超過整張圖 minFrac）各自給新編號；太小的碎塊留在原本的線。
// 回傳新建立的編號
// reserved：畫面上還在用的編號（不能拿來當新編號）
export function splitRegions(labels, w, h, reserved = [], minFrac = 0.0015) {
  const n = w * h;
  const used = new Set([...labels, ...reserved]);
  const free = [];
  for (let i = 0; i < 255; i++) if (!used.has(i)) free.push(i);
  const comps = new Map(); // 編號 → [{ members }]
  const seen = new Uint8Array(n);
  const stack = [];
  for (let s0 = 0; s0 < n; s0++) {
    const v = labels[s0];
    if (seen[s0] || v === BG) continue;
    const members = [];
    seen[s0] = 1;
    stack.push(s0);
    while (stack.length) {
      const i = stack.pop();
      members.push(i);
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || seen[j] || labels[j] !== v) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (members.length < n * minFrac) continue;
    if (!comps.has(v)) comps.set(v, []);
    for (const part of splitAtNecks(members, w, h)) comps.get(v).push(part);
  }
  const made = [];
  for (const list of comps.values()) {
    list.sort((a, b) => b.length - a.length);
    for (let k = 1; k < list.length && free.length; k++) {
      const id = free.shift();
      for (const i of list[k]) labels[i] = id;
      made.push(id);
    }
  }
  return made;
}

// 兩大塊只靠一小段連在一起（例如花邊和內圈在兩端接起來）：把這塊往內縮，看會不會斷成兩大塊（各超過整張圖 1.5%），
// 會的話以斷開的兩大塊為中心，各自往外長回原本的範圍。鏤空花邊縮了會碎成很多小塊，小塊不算，所以不會被切碎
function splitAtNecks(members, w, h) {
  const n = w * h;
  if (members.length < n * 0.03) return [members];
  const k = Math.max(4, Math.round(Math.max(w, h) * 0.012));
  const ind = new Float32Array(n);
  for (const i of members) ind[i] = 1;
  const core = boxBlur(ind, w, h, k);
  const owner = new Int32Array(n).fill(-1);
  const seeds = [];
  let id = 0;
  const stack = [];
  for (const s0 of members) {
    if (core[s0] < 0.999 || owner[s0] !== -1) continue;
    const part = [];
    owner[s0] = -2;
    stack.push(s0);
    while (stack.length) {
      const i = stack.pop();
      part.push(i);
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || owner[j] !== -1 || core[j] < 0.999) continue;
        owner[j] = -2;
        stack.push(j);
      }
    }
    if (part.length >= n * 0.015) { for (const i of part) owner[i] = id; seeds.push(part); id++; }
    else for (const i of part) owner[i] = -3;
  }
  if (seeds.length < 2) return [members];
  // 從各個大塊同時往外長（只在原本的範圍內）
  for (const i of members) if (owner[i] < 0) owner[i] = -1;
  let front = seeds.flat();
  while (front.length) {
    const next = [];
    for (const i of front) {
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || !ind[j] || owner[j] !== -1) continue;
        owner[j] = owner[i];
        next.push(j);
      }
    }
    front = next;
  }
  const parts = seeds.map(() => []);
  for (const i of members) if (owner[i] >= 0) parts[owner[i]].push(i);
  return parts;
}
