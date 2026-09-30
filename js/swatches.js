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
  return sortReadingOrder(snapToGrid(boxes));
}

// 整齊排列的色卡：某個色塊的框明顯比別人小（例如白色線在白底上只找到一半），
// 就對齊同一欄、同一列的其他色塊，補成一樣大
function snapToGrid(boxes) {
  if (boxes.length < 4) return boxes;
  const medW = median(boxes.map((b) => b.w));
  const medH = median(boxes.map((b) => b.h));
  const normal = boxes.filter((b) => Math.abs(b.w - medW) < medW * 0.12 && Math.abs(b.h - medH) < medH * 0.12);
  if (normal.length < boxes.length * 0.5) return boxes;
  return boxes.map((b) => {
    if (normal.includes(b)) return b;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const col = normal.filter((n) => Math.abs(n.x - b.x) < medW * 0.3 || Math.abs(n.x + n.w - (b.x + b.w)) < medW * 0.3 || Math.abs(n.x + n.w / 2 - cx) < medW * 0.3);
    const row = normal.filter((n) => Math.abs(n.y + n.h / 2 - cy) < medH * 0.5 || Math.abs(n.y - b.y) < medH * 0.3);
    if (!col.length || !row.length) return b;
    return { x: Math.round(median(col.map((n) => n.x))), y: Math.round(median(row.map((n) => n.y))), w: Math.round(medW), h: Math.round(medH) };
  });
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

const CJK = /[　-鿿豈-﫿]/;
const CJK_G = /[　-鿿豈-﫿]/g;

// 找出色塊的文字標籤（色號、色名）。只留下「白色標籤底上的深色字」，
// 毛線的紋理、顏色、深色毛線本身都不會被當成字。
// 回傳 { parts: [{ canvas, role: 'code' | 'name' | 'all' }] }，色號和色名分開，辨識比較準
export function textCrop(imageData, box, boxes = []) {
  const { width: W, height: H, data } = imageData;
  // 只在色塊的左右範圍內找（稍微內縮，避開邊框和隔壁色塊）
  const x0 = Math.max(0, Math.round(box.x + box.w * 0.03));
  const x1 = Math.min(W, Math.round(box.x + box.w * 0.97));
  const y0 = Math.max(0, Math.round(box.y));
  // 往下找到下一個色塊為止，最多 0.8 倍色塊高
  let y1 = Math.min(H, Math.round(box.y + box.h * 1.8));
  for (const b of boxes) {
    if (b === box || b.y <= box.y + box.h * 0.5) continue;
    const overlapX = Math.min(b.x + b.w, box.x + box.w) - Math.max(b.x, box.x);
    if (overlapX > box.w * 0.3) y1 = Math.min(y1, Math.max(box.y + box.h, b.y));
  }
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;
  const dark = new Uint8Array(w * h);
  const paper = new Uint8Array(w * h);
  const light = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((y0 + y) * W + x0 + x) * 4;
      const [L, a, b] = rgbToLab(data[o], data[o + 1], data[o + 2]);
      const C = Math.hypot(a, b);
      const i = y * w + x;
      light[i] = C < 28 ? L : 100;
      dark[i] = L < 55 && C < 26 ? 1 : 0;
      paper[i] = L > 80 && C < 18 ? 1 : 0;
    }
  }
  // 字的旁邊要有白色標籤底（上下左右一小段距離內）
  const reach = Math.max(3, Math.round(box.h * 0.035));
  const nearPaper = boxBlurAny(paper, w, h, reach);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = dark[i] && nearPaper[i] ? 1 : 0;

  // 每一列有幾個文字像素，找出文字所在的橫條
  const rows = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < w; x++) c += mask[y * w + x];
    rows[y] = c;
  }
  // 一列要有夠多文字像素才算有字（邊框、零星雜點不算）
  const th = Math.max(3, w * 0.04);
  const bands = [];
  let start = -1, gap = 0;
  for (let y = 0; y <= h; y++) {
    const on = y < h && rows[y] >= th;
    if (on) {
      if (start < 0) start = y;
      gap = 0;
    } else if (start >= 0) {
      gap++;
      if (gap > 2 || y === h) {
        const end = y - gap + 1;
        let score = 0;
        for (let k = start; k < end; k++) score += rows[k];
        if (end - start >= Math.max(4, box.h * 0.05) && end - start <= box.h * 0.5) bands.push({ start, end, score });
        start = -1;
        gap = 0;
      }
    }
  }
  if (!bands.length) return null;
  const best = bands.reduce((m, b) => (b.score > m.score ? b : m));
  const bh = best.end - best.start;
  // 兩行字（色號一行、色名一行）時一起拿
  const chosen = bands
    .filter((b) => b === best || (b.score >= best.score * 0.3 && Math.abs(b.start - best.start) < bh * 2.6))
    .sort((a, b) => a.start - b.start);

  const colsOf = (ys, ye) => {
    const cols = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let c = 0;
      for (let y = ys; y < ye; y++) c += mask[y * w + x];
      cols[x] = c;
    }
    return cols;
  };
  const extent = (cols) => {
    let a = -1, b = -1;
    for (let x = 0; x < w; x++) if (cols[x] > 0) { if (a < 0) a = x; b = x; }
    return [a, b];
  };
  const render = (cx0, cx1, ys, ye) => renderText(light, w, h, cx0, cx1, ys, ye, ye - ys);

  const parts = [];
  if (chosen.length >= 2) {
    // 兩行：第一行當色號，其餘當色名
    const [a0, a1] = extent(colsOf(chosen[0].start, chosen[0].end));
    const rest = chosen.slice(1);
    const rs = rest[0].start, re = rest[rest.length - 1].end;
    const [b0, b1] = extent(colsOf(rs, re));
    if (a0 >= 0) parts.push({ role: 'code', canvas: render(a0, a1, chosen[0].start, chosen[0].end) });
    if (b0 >= 0) parts.push({ role: 'name', canvas: render(b0, b1, rs, re) });
    return parts.length ? { parts } : null;
  }
  // 一行：用最寬的空隙把色號和色名切開（空隙要在前半段）
  const cols = colsOf(best.start, best.end);
  const [c0, c1] = extent(cols);
  if (c0 < 0) return null;
  let gapBest = null, run = 0;
  for (let x = c0; x <= c1; x++) {
    if (cols[x] === 0) run++;
    else {
      if (run > 0) {
        const gs = x - run;
        // 色號至少要有兩個數字寬，避免把「15」切成「1」和「5」
        if (gs < c0 + (c1 - c0) * 0.55 && gs - c0 >= bh * 0.8 && (!gapBest || run > gapBest.len)) gapBest = { start: gs, len: run };
      }
      run = 0;
    }
  }
  if (gapBest && gapBest.len >= bh * 0.22) {
    parts.push({ role: 'code', canvas: render(c0, gapBest.start - 1, best.start, best.end) });
    parts.push({ role: 'name', canvas: render(gapBest.start + gapBest.len, c1, best.start, best.end) });
  } else {
    parts.push({ role: 'all', canvas: render(c0, c1, best.start, best.end) });
  }
  return { parts };
}

// 附近 r 像素內有沒有 1（方形範圍）
function boxBlurAny(mask, w, h, r) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -1e9;
    const row = y * w;
    const near = new Float32Array(w).fill(1e9);
    for (let x = 0; x < w; x++) { if (mask[row + x]) last = x; near[x] = x - last; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (mask[row + x]) last = x; near[x] = Math.min(near[x], last - x); }
    for (let x = 0; x < w; x++) tmp[row + x] = near[x] <= r ? 1 : 0;
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    const near = new Float32Array(h).fill(1e9);
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; near[y] = y - last; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; near[y] = Math.min(near[y], last - y); }
    for (let y = 0; y < h; y++) out[y * w + x] = near[y] <= r ? 1 : 0;
  }
  return out;
}

// 把一段文字畫成白底黑字、字高約 60 像素的圖
function renderText(light, w, h, cx0, cx1, ys, ye, bh) {
  const pad = Math.round(bh * 0.35);
  const sx = Math.max(0, cx0 - pad), sy = Math.max(0, ys - pad);
  const ex = Math.min(w, cx1 + pad + 1), ey = Math.min(h, ye + pad);
  const cw = ex - sx, ch = ey - sy;
  const small = document.createElement('canvas');
  small.width = cw;
  small.height = ch;
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const L = light[(sy + y) * w + sx + x];
      const v = Math.max(0, Math.min(255, ((L - 30) / 40) * 255));
      const o = (y * cw + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);
  const scale = Math.max(1, Math.min(5, 64 / Math.max(1, bh)));
  const out = document.createElement('canvas');
  out.width = Math.round(cw * scale) + 48;
  out.height = Math.round(ch * scale) + 48;
  const octx = out.getContext('2d');
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, out.width, out.height);
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(small, 24, 24, cw * scale, ch * scale);
  return out;
}

// 把 OCR 讀到的一段字拆成色號和色名，例如「01冰雪白」→ 01、冰雪白
export function parseLabel(text) {
  let t = (text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s#\-.'&]/gu, ' ')
    .replace(/([A-Za-z0-9])(?=[　-鿿])/g, '$1 ')
    .replace(/([　-鿿])(?=[A-Za-z0-9])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = t.split(' ').filter(Boolean);
  // 色號：第一個含數字的詞；O 看成 0、I/l 看成 1
  const norm = (tok) => (/^[0-9OoIl]+$/.test(tok) && /\d/.test(tok) ? tok.replace(/[Oo]/g, '0').replace(/[Il]/g, '1') : tok);
  let idx = tokens.findIndex((tok) => /\d/.test(tok) || /^[Oo][0-9]/.test(tok));
  let code = '';
  if (idx >= 0) {
    code = norm(tokens[idx]).replace(/^[.\-']+|[.\-']+$/g, '');
    tokens.splice(idx, 1);
  }
  let nameTokens = tokens;
  // 名字有中文時，旁邊零星的一兩個英文字母通常是雜訊
  if (nameTokens.some((tok) => CJK.test(tok))) nameTokens = nameTokens.filter((tok) => CJK.test(tok) || tok.length > 2);
  let name = '';
  for (const tok of nameTokens) {
    if (name && !(CJK.test(name[name.length - 1]) && CJK.test(tok[0]))) name += ' ';
    name += tok;
  }
  // 中文字之間不要有空白
  name = name.replace(/([　-鿿])\s+(?=[　-鿿])/g, '$1');
  return { code, name: name.trim(), cjk: (name.match(CJK_G) || []).length };
}

// 色號是連續編號時（01、02、03…），用前後的號碼補正讀錯或讀不到的色號
// rows 要照色卡上的順序排列；會直接修改 rows[i].code
export function fixSequence(rows) {
  const nums = rows.map((r, i) => (/^\d+$/.test(r.code) ? { i, v: Number(r.code), len: r.code.length } : null));
  const counts = new Map();
  for (const n of nums) if (n) counts.set(n.v - n.i, (counts.get(n.v - n.i) || 0) + 1);
  let offset = null, best = 0;
  for (const [k, c] of counts) if (c > best) { best = c; offset = k; }
  if (offset === null || best < Math.max(3, rows.length * 0.5)) return 0;
  const lens = new Map();
  for (const n of nums) if (n && n.v - n.i === offset) lens.set(n.len, (lens.get(n.len) || 0) + 1);
  const width = [...lens.entries()].sort((a, b) => b[1] - a[1])[0][0];
  let fixed = 0;
  rows.forEach((r, i) => {
    const expect = String(i + offset).padStart(width, '0');
    if (r.code === expect) return;
    const n = nums[i];
    // 讀到的是正常數字、長度也對，但跟順序不合：可能色卡本來就跳號，保留
    if (n && n.len === width) return;
    r.code = expect;
    fixed++;
  });
  return fixed;
}
