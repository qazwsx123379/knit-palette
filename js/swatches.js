// 色卡截圖分析：找出每個色塊、取代表色、剪下小圖，並把文字配給色塊
import { rgbToLab, labToHex } from './color.js';

function median(arr) {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  return s[Math.floor(s.length / 2)];
}

// 找色塊。imageData 是原尺寸截圖，回傳的座標也是原尺寸
export function detectSwatches(imageData) {
  const W = imageData.width, H = imageData.height;
  const scale = Math.min(1, 900 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
  const n = w * h;
  const src = imageData.data;
  // 縮小後的 Lab
  const lab = new Float32Array(n * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(H - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(W - 1, Math.floor((x + 0.5) / scale));
      const o = (sy * W + sx) * 4;
      const v = rgbToLab(src[o], src[o + 1], src[o + 2]);
      const i = y * w + x;
      lab[i * 3] = v[0]; lab[i * 3 + 1] = v[1]; lab[i * 3 + 2] = v[2];
    }
  }
  // 稍微模糊，讓毛線照片的紋理不會把色塊切碎
  const blur = new Float32Array(n * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sL = 0, sa = 0, sb = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = (yy * w + xx) * 3;
          sL += lab[j]; sa += lab[j + 1]; sb += lab[j + 2]; c++;
        }
      }
      const i = (y * w + x) * 3;
      blur[i] = sL / c; blur[i + 1] = sa / c; blur[i + 2] = sb / c;
    }
  }
  // 背景色：取圖片外框最常見的顏色
  const border = [];
  const bw = Math.max(1, Math.round(Math.min(w, h) * 0.02));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < bw || y < bw || x >= w - bw || y >= h - bw) border.push(y * w + x);
    }
  }
  const buckets = new Map();
  for (const i of border) {
    const key = `${Math.round(blur[i * 3] / 6)},${Math.round(blur[i * 3 + 1] / 6)},${Math.round(blur[i * 3 + 2] / 6)}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  let bestKey = null, bestCount = -1;
  for (const [k, c] of buckets) if (c > bestCount) { bestCount = c; bestKey = k; }
  const bg = bestKey.split(',').map((v) => Number(v) * 6);
  // 不是背景的像素
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(blur[i * 3] - bg[0], blur[i * 3 + 1] - bg[1], blur[i * 3 + 2] - bg[2]);
    mask[i] = d > 5 ? 1 : 0;
  }
  // 去掉細的東西（文字、線條）：先侵蝕再膨脹
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.006));
  const opened = dilate(erode(mask, w, h, r), w, h, r);
  // 連通區塊：相鄰像素顏色差不多才算同一塊，這樣緊貼的色塊也能分開
  const comp = new Int32Array(n).fill(-1);
  const comps = [];
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (!opened[s] || comp[s] >= 0) continue;
    const c = { x0: w, y0: h, x1: 0, y1: 0, area: 0 };
    comp[s] = comps.length;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || !opened[j] || comp[j] >= 0) continue;
        const d = Math.hypot(blur[i * 3] - blur[j * 3], blur[i * 3 + 1] - blur[j * 3 + 1], blur[i * 3 + 2] - blur[j * 3 + 2]);
        if (d > 9) continue;
        comp[j] = comps.length;
        stack.push(j);
      }
    }
    comps.push(c);
  }
  // 過濾：夠大、形狀接近方塊或圓
  const minArea = n * 0.0006;
  let cands = comps.filter((c) => {
    const bwid = c.x1 - c.x0 + 1, bhei = c.y1 - c.y0 + 1;
    const aspect = bwid / bhei;
    const fill = c.area / (bwid * bhei);
    return c.area >= minArea && aspect > 0.25 && aspect < 4 && fill > 0.45;
  });
  // 重疊的框合併（同一個色塊被切成幾塊時）
  cands = mergeOverlapping(cands);
  if (!cands.length) return [];
  // 跟大多數色塊差太多的（標誌、橫幅）拿掉
  const med = median(cands.map((c) => (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)));
  cands = cands.filter((c) => {
    const a = (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1);
    return a >= med * 0.3 && a <= med * 3.5;
  });
  // 換回原尺寸座標
  const boxes = cands.map((c) => ({
    x: Math.round(c.x0 / scale),
    y: Math.round(c.y0 / scale),
    w: Math.round((c.x1 - c.x0 + 1) / scale),
    h: Math.round((c.y1 - c.y0 + 1) / scale),
  }));
  return sortReadingOrder(boxes);
}

function erode(mask, w, h, r) {
  return minMaxFilter(mask, w, h, r, true);
}

function dilate(mask, w, h, r) {
  return minMaxFilter(mask, w, h, r, false);
}

// 方形範圍的最小/最大值濾鏡（先橫後直）
function minMaxFilter(mask, w, h, r, isMin) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const target = isMin ? 0 : 1;
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    const row = y * w;
    // 左到右記錄最近的 target，右到左再掃一次
    const near = new Float32Array(w).fill(Infinity);
    for (let x = 0; x < w; x++) {
      if (mask[row + x] === target) last = x;
      near[x] = x - last;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[row + x] === target) last = x;
      near[x] = Math.min(near[x], last - x);
    }
    for (let x = 0; x < w; x++) {
      const hit = near[x] <= r;
      tmp[row + x] = hit ? target : 1 - target;
    }
  }
  for (let x = 0; x < w; x++) {
    const near = new Float32Array(h).fill(Infinity);
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x] === target) last = y;
      near[y] = y - last;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x] === target) last = y;
      near[y] = Math.min(near[y], last - y);
    }
    for (let y = 0; y < h; y++) out[y * w + x] = near[y] <= r ? target : 1 - target;
  }
  return out;
}

function mergeOverlapping(cands) {
  const list = cands.map((c) => ({ ...c }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ix <= 0 || iy <= 0) continue;
        const inter = ix * iy;
        const small = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
        if (inter > small * 0.3) {
          a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0);
          a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
          a.area += b.area;
          list.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return list;
}

// 由上到下、由左到右排序
export function sortReadingOrder(boxes) {
  if (!boxes.length) return boxes;
  const medH = median(boxes.map((b) => b.h));
  const sorted = [...boxes].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const rows = [];
  for (const b of sorted) {
    const cy = b.y + b.h / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) < medH * 0.5);
    if (row) {
      row.items.push(b);
      row.cy = row.items.reduce((s, it) => s + it.y + it.h / 2, 0) / row.items.length;
    } else rows.push({ cy, items: [b] });
  }
  rows.sort((a, b) => a.cy - b.cy);
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
}

// 代表色：色塊中間一半範圍的中位數
export function swatchColor(imageData, box) {
  const { width: W, data } = imageData;
  const x0 = Math.round(box.x + box.w * 0.25), x1 = Math.round(box.x + box.w * 0.75);
  const y0 = Math.round(box.y + box.h * 0.25), y1 = Math.round(box.y + box.h * 0.75);
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 2500)));
  const Ls = [], as = [], bs = [];
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const o = (y * W + x) * 4;
      const v = rgbToLab(data[o], data[o + 1], data[o + 2]);
      Ls.push(v[0]); as.push(v[1]); bs.push(v[2]);
    }
  }
  return labToHex(median(Ls), median(as), median(bs));
}

// 在圖上某一點附近取色（滴管）
export function pickColor(imageData, x, y, radius = 3) {
  const { width: W, height: H, data } = imageData;
  const Ls = [], as = [], bs = [];
  for (let yy = Math.max(0, y - radius); yy <= Math.min(H - 1, y + radius); yy++) {
    for (let xx = Math.max(0, x - radius); xx <= Math.min(W - 1, x + radius); xx++) {
      const o = (yy * W + xx) * 4;
      const v = rgbToLab(data[o], data[o + 1], data[o + 2]);
      Ls.push(v[0]); as.push(v[1]); bs.push(v[2]);
    }
  }
  return labToHex(median(Ls), median(as), median(bs));
}

// 剪下色塊小圖（正方形，稍微往內縮一點避開邊框）
export function cropThumb(source, box, size = 96) {
  const inset = 0.04;
  const sx = box.x + box.w * inset, sy = box.y + box.h * inset;
  const sw = box.w * (1 - inset * 2), sh = box.h * (1 - inset * 2);
  const side = Math.min(sw, sh);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx + (sw - side) / 2, sy + (sh - side) / 2, side, side, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.82);
}

const CJK = /[　-鿿＀-￯]/;

function joinWords(words) {
  let s = '';
  for (const wd of words) {
    const t = wd.text.trim();
    if (!t) continue;
    if (s && !(CJK.test(s[s.length - 1]) && CJK.test(t[0]))) s += ' ';
    s += t;
  }
  return s.trim();
}

// 把 OCR 讀到的字配給最近的色塊（優先找色塊正下方，其次右邊、色塊上面的字）
export function assignText(boxes, words) {
  const result = boxes.map(() => []);
  for (const wd of words) {
    const t = (wd.text || '').trim();
    if (!t || wd.confidence < 25) continue;
    const { x0, y0, x1, y1 } = wd.bbox;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let best = -1, bestScore = Infinity;
    boxes.forEach((b, i) => {
      let score = Infinity;
      const inX = cx >= b.x - b.w * 0.25 && cx <= b.x + b.w * 1.25;
      const inY = cy >= b.y && cy <= b.y + b.h;
      if (inX && cy > b.y + b.h * 0.5 && cy - (b.y + b.h) < b.h * 1.6) {
        score = Math.max(0, cy - (b.y + b.h)); // 正下方
      } else if (inY && x0 >= b.x + b.w * 0.6 && x0 - (b.x + b.w) < b.w * 1.6) {
        score = 1000 + Math.max(0, x0 - (b.x + b.w)); // 右邊
      } else if (inY && cx >= b.x && cx <= b.x + b.w) {
        score = 500; // 字壓在色塊上
      }
      if (score < bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) result[best].push(wd);
  }
  return result.map((ws) => {
    // 依行排序
    ws.sort((a, b) => (Math.abs(a.bbox.y0 - b.bbox.y0) < 8 ? a.bbox.x0 - b.bbox.x0 : a.bbox.y0 - b.bbox.y0));
    const tokens = ws.map((w) => ({ ...w, text: w.text.trim() }));
    const codeIdx = tokens.findIndex((t) => /\d/.test(t.text));
    let code = '';
    let rest = tokens;
    if (codeIdx >= 0) {
      code = tokens[codeIdx].text.replace(/^[^\w#]+|[^\w]+$/g, '');
      rest = tokens.filter((_, i) => i !== codeIdx);
    }
    return { code, name: joinWords(rest) };
  });
}
