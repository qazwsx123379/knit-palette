// 配色工作區：上傳作品 → 辨識線材 → 調整 → 點選換色 → 存檔、另存新檔、匯出
import { h, icon, button, toast, modal, confirmDialog, loading, pickFiles, fileToImage, urlToImage, nextFrame } from './ui.js';
import * as Seg from './segment.js';
import { recolor, paintRegions } from './recolor.js';
import { labToHex, hexToRgb, deltaE } from './color.js';
import { openPicker, swatchVisual } from './library.js';
import { openExport } from './export.js';
import { loadSam, analyzeImage, selectByPoints } from './sam.js';

const WORK_MAX = 1100; // 作品圖的處理尺寸（長邊像素）
const DEFAULT_SENS = 55;
const REGION_COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9a6324', '#800000', '#aaffc3', '#000075'];
const BG = Seg.BG;
const NEW_LINE = -1; // AI 圈選時「套用成新的一種線」

export function createWorkspace(app) {
  const { data } = app;
  let S = null; // 目前的工作階段
  const el = h('section', { class: 'view', id: 'view-work' });
  let canvas, ctx, outImage, badgesEl, panelEl, titleEl, brushCursor;

  // ---------- 工作階段 ----------
  function newSession(srcCanvas, extra = {}) {
    const w = srcCanvas.width, hh = srcCanvas.height;
    const imageData = srcCanvas.getContext('2d').getImageData(0, 0, w, hh);
    return {
      work: null,
      w, h: hh, srcCanvas,
      prep: Seg.prepareImage(imageData),
      cluster: null,
      labels: null,
      groups: [],
      positions: {},
      sensitivity: DEFAULT_SENS,
      manual: false,
      mode: 'detect',
      selected: null,
      brush: { on: false, size: 30, smart: true },
      wand: false,
      ai: { on: false, bgMode: false, handle: null, points: [], mask: null, options: [], pick: 0, size: 0, include: true, busy: false },
      tol: 14, // 智慧筆刷、魔術棒的顏色容許範圍
      showRegions: false,
      hold: false,
      undo: [],
      dirty: false,
      imageBase64: null,
      imagePath: null, // 原圖已經存在 GitHub 的位置
      ...extra,
    };
  }

  function imageToCanvas(img) {
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const scale = Math.min(1, WORK_MAX / Math.max(nw, nh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(nw * scale));
    c.height = Math.max(1, Math.round(nh * scale));
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function markDirty() {
    S.dirty = true;
    drawTitle();
  }

  function yarnInfo(g) {
    if (!g.yarn) return null;
    const live = data.yarn(g.yarn.id);
    if (live) {
      const brand = data.brand(live.brandId);
      return { ...live, brandName: brand ? brand.name : g.yarn.brandName, live: true };
    }
    return { ...g.yarn, live: false };
  }

  function groupById(id) { return S.groups.find((g) => g.id === id); }
  function srcHex(g) { return labToHex(...g.srcLab); }
  function regionColor(g) { return REGION_COLORS[(g.n - 1) % REGION_COLORS.length]; }

  // 依統計更新每種線的顏色、面積、數字位置
  function recompute({ renumber = false, keep = null } = {}) {
    const stats = Seg.groupStats(S.prep, S.labels);
    S.groups = S.groups.filter((g) => stats[g.id] || g.id === keep);
    for (const g of S.groups) {
      const st = stats[g.id];
      g.count = st ? st.count : 0;
      if (st) g.srcLab = st.lab;
    }
    if (renumber) {
      S.groups.sort((a, b) => b.count - a.count);
      S.groups.forEach((g, i) => (g.n = i + 1));
    }
    S.positions = Seg.labelPositions(S.labels, S.w, S.h, S.groups.map((g) => g.id));
    // 哪一種線佔了圖片四周的一大半：很可能是背景（桌面、地板）
    const border = new Map();
    let total = 0;
    const add = (i) => { const l = S.labels[i]; border.set(l, (border.get(l) || 0) + 1); total++; };
    for (let x = 0; x < S.w; x++) { add(x); add((S.h - 1) * S.w + x); }
    for (let y = 1; y < S.h - 1; y++) { add(y * S.w); add(y * S.w + S.w - 1); }
    S.bgSuspect = null;
    for (const g of S.groups) if ((border.get(g.id) || 0) / total > 0.6) S.bgSuspect = g.id;
    if (S.selected !== null && S.selected !== BG && S.selected !== NEW_LINE && !groupById(S.selected)) S.selected = null;
  }

  // 依敏感度重新分組；已經選好的線，盡量配回顏色最接近的新分組
  function regroup() {
    if (!S.cluster) S.cluster = Seg.clusterImage(S.prep);
    const old = S.groups;
    const g = Seg.groupClusters(S.cluster, S.sensitivity);
    S.labels = Seg.smoothLabels(Seg.labelsFromMapping(S.cluster.sub, g.mapping), S.w, S.h);
    S.groups = Array.from({ length: g.count }, (_, i) => ({ id: i, n: i + 1, srcLab: [50, 0, 0], count: 0, yarn: null }));
    recompute({ renumber: true });
    for (const ng of S.groups) {
      let best = null, bd = 12;
      for (const og of old) {
        if (!og.yarn) continue;
        const d = deltaE(og.srcLab, ng.srcLab);
        if (d < bd) { bd = d; best = og; }
      }
      if (best) ng.yarn = best.yarn;
    }
    S.manual = false;
    S.undo = [];
  }

  // 自動把背景（平滑的桌面）分開成「不換色」，同顏色但有針目紋理的毛線保留下來
  // 回傳分出來的背景佔整張圖的比例
  function autoBackground() {
    if (S.bgSuspect == null) return 0;
    const moved = Seg.separateBackground(S.prep, S.labels, S.bgSuspect);
    if (moved) recompute({ renumber: S.mode === 'detect' });
    return moved / S.prep.n;
  }

  function pushUndo() {
    S.undo.push({ labels: S.labels.slice(), groups: JSON.parse(JSON.stringify(S.groups)), selected: S.selected });
    if (S.undo.length > 20) S.undo.shift();
  }

  function undo() {
    const u = S.undo.pop();
    if (!u) return;
    S.labels = u.labels;
    S.groups = u.groups;
    S.selected = u.selected;
    recompute();
    markDirty();
    refresh();
  }

  function unusedId() {
    const used = new Set(S.groups.map((g) => g.id));
    for (let i = 0; i < 255; i++) if (!used.has(i)) return i;
    return null;
  }

  // ---------- 開新作品、打開舊作品 ----------
  async function newFromFile(file) {
    if (!(await app.confirmDiscard())) return;
    const busy = loading('讀取圖片…');
    try {
      const img = await fileToImage(file);
      busy.set('辨識線材中…');
      await nextFrame();
      S = newSession(imageToCanvas(img));
      regroup();
      const bgShare = autoBackground();
      S.dirty = true;
      busy.close();
      drawAll();
      toast(bgShare > 0.05 ? `找到 ${S.groups.length} 種線，背景（桌面）已自動設為不換色` : `找到 ${S.groups.length} 種線`);
    } catch (e) {
      busy.close();
      toast(e.message || '圖片處理失敗', 'error');
    }
  }

  async function openWork(id) {
    if (!(await app.confirmDiscard())) return false;
    const busy = loading('打開配色檔…');
    try {
      const { work, imageURL } = await data.loadWork(id);
      const img = await urlToImage(imageURL);
      const c = document.createElement('canvas');
      c.width = work.width;
      c.height = work.height;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(img, 0, 0, c.width, c.height);
      await nextFrame();
      S = newSession(c, {
        work: { id: work.id, name: work.name, tags: work.tags || [], createdAt: work.createdAt },
        imagePath: work.image,
        labels: Seg.decodeLabels(work.labels, work.width * work.height),
        groups: work.groups.map((g) => ({ ...g })),
        sensitivity: work.sensitivity ?? DEFAULT_SENS,
        manual: true,
        mode: 'color',
      });
      recompute();
      busy.close();
      drawAll();
      return true;
    } catch (e) {
      busy.close();
      toast(e.message || '打開失敗', 'error');
      return false;
    }
  }

  async function chooseImage() {
    const [file] = await pickFiles();
    if (file) newFromFile(file);
  }

  // ---------- 畫面 ----------
  function drawTitle() {
    if (!titleEl) return;
    titleEl.replaceChildren(
      ...[
        h('span', { class: 'work-name' }, S && S.work ? S.work.name : S ? '新作品（尚未存檔）' : '配色工作區'),
        S && S.dirty ? h('span', { class: 'dirty', title: '有還沒存檔的修改' }, '未存檔') : null,
      ].filter(Boolean)
    );
  }

  function drawAll() {
    titleEl = h('h1', { class: 'work-title' });
    const actions = h('div', { class: 'head-actions' },
      button('上傳圖片', { icon: 'upload', onClick: chooseImage, id: 'btn-upload' }),
      button('存檔', { icon: 'save', kind: 'primary', onClick: () => save(false), disabled: !S, id: 'btn-save' }),
      button('另存新檔', { icon: 'saveAs', onClick: () => save(true), disabled: !S, id: 'btn-saveas' }),
      button('匯出', { icon: 'share', onClick: doExport, disabled: !S, id: 'btn-export' })
    );
    const head = h('div', { class: 'view-head work-head' }, titleEl, actions);
    drawTitle();
    if (!S) {
      const drop = h('div', { class: 'drop big', id: 'work-drop' },
        icon('palette', 'drop-icon'),
        h('p', { class: 'drop-title' }, '上傳作品照片、織圖或截圖'),
        h('p', { class: 'muted' }, '系統會自動找出用了幾種線，並用數字標出位置。'),
        button('選擇圖片', { icon: 'upload', kind: 'primary', onClick: chooseImage }),
        h('p', { class: 'muted small' }, '或打開「作品庫」裡存過的配色，重新配色。')
      );
      bindDrop(drop);
      el.replaceChildren(head, drop);
      return;
    }
    canvas = h('canvas', { class: 'work-canvas', width: S.w, height: S.h, 'aria-label': '作品預覽' });
    ctx = canvas.getContext('2d');
    outImage = ctx.createImageData(S.w, S.h);
    badgesEl = h('div', { class: 'badges' });
    brushCursor = h('div', { class: 'brush-cursor', hidden: true });
    const wrap = h('div', { class: 'canvas-wrap' }, canvas, badgesEl, brushCursor);
    bindCanvas();
    bindDrop(wrap);
    panelEl = h('div', { class: 'panel card' });
    const stage = h('div', { class: 'stage' }, wrap);
    el.replaceChildren(head, h('div', { class: 'work-layout' }, stage, panelEl));
    refresh();
  }

  function bindDrop(target) {
    target.addEventListener('dragover', (e) => { e.preventDefault(); target.classList.add('over'); });
    target.addEventListener('dragleave', () => target.classList.remove('over'));
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      target.classList.remove('over');
      const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
      if (f) newFromFile(f);
    });
  }

  function refresh() {
    drawTitle();
    renderCanvas();
    renderBadges();
    renderPanel();
  }

  function targets() {
    const t = {};
    for (const g of S.groups) {
      const y = yarnInfo(g);
      if (y) t[g.id] = { srcLab: g.srcLab, hex: y.hex };
    }
    return t;
  }

  function renderCanvas() {
    if (!S || !ctx) return;
    const showRegions = S.mode === 'detect' && !S.ai.on && (S.showRegions || S.brush.on || S.wand);
    if (showRegions) {
      const colors = {};
      for (const g of S.groups) colors[g.id] = hexToRgb(regionColor(g));
      paintRegions(S.prep, S.labels, colors, outImage);
    } else if (S.mode === 'color' && !S.hold) {
      recolor(S.prep, S.labels, targets(), outImage);
    } else {
      outImage.data.set(S.prep.rgba);
    }
    ctx.putImageData(outImage, 0, 0);
    if (S.mode === 'detect' && S.ai.on) drawAiOverlay();
  }

  // AI 圈選的預覽：在原本的照片上，選到的地方保持明亮，沒選到的地方變暗，外框用亮黃色描出來
  // 點過的地方畫圓點（綠色＝要的、紅色＝不要的）
  function drawAiOverlay() {
    const { mask, points } = S.ai;
    if (mask) {
      const ov = ctx.getImageData(0, 0, S.w, S.h);
      const d = ov.data;
      for (let i = 0; i < mask.length; i++) {
        if (mask[i]) continue;
        const o = i * 4;
        d[o] *= 0.28; d[o + 1] *= 0.28; d[o + 2] *= 0.32;
      }
      // 外框：粗一點（2 像素）比較看得清楚
      const edge = new Uint8Array(mask.length);
      for (let y = 1; y < S.h - 1; y++) {
        for (let x = 1; x < S.w - 1; x++) {
          const i = y * S.w + x;
          if (mask[i] && (!mask[i - 1] || !mask[i + 1] || !mask[i - S.w] || !mask[i + S.w])) edge[i] = 1;
        }
      }
      for (let y = 1; y < S.h - 1; y++) {
        for (let x = 1; x < S.w - 1; x++) {
          const i = y * S.w + x;
          if (edge[i] || edge[i - 1] || edge[i + 1] || edge[i - S.w] || edge[i + S.w]) {
            d[i * 4] = 255; d[i * 4 + 1] = 214; d[i * 4 + 2] = 10;
          }
        }
      }
      ctx.putImageData(ov, 0, 0);
    }
    const r = Math.max(5, Math.max(S.w, S.h) * 0.009);
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.include ? '#22a559' : '#d33a3a';
      ctx.fill();
      ctx.lineWidth = r * 0.35;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
  }

  let rafPending = false;
  function renderCanvasSoon() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderCanvas(); });
  }

  function renderBadges() {
    badgesEl.replaceChildren();
    badgesEl.classList.toggle('passive', (S.brush.on || S.wand) && S.mode === 'detect');
    // AI 圈選時把數字藏起來，才看得清楚選到哪裡
    badgesEl.hidden = S.ai.on && S.mode === 'detect';
    // 數字互相重疊時，只留每種線的第一個，其餘的不顯示
    const rect = canvas.getBoundingClientRect();
    const placed = [];
    const minGap = 30;
    const free = (p) => placed.every((q) => Math.hypot((p.x - q.x) * rect.width, (p.y - q.y) * rect.height) >= minGap);
    const shown = new Map(S.groups.map((g) => [g.id, []]));
    for (const g of S.groups) {
      const first = (S.positions[g.id] || [])[0];
      if (first) { shown.get(g.id).push(first); placed.push(first); }
    }
    for (const g of S.groups) {
      for (const p of (S.positions[g.id] || []).slice(1)) {
        if (!rect.width || free(p)) { shown.get(g.id).push(p); placed.push(p); }
      }
    }
    for (const g of S.groups) {
      for (const p of shown.get(g.id)) {
        badgesEl.append(h('button', {
          type: 'button',
          class: `badge ${S.selected === g.id ? 'selected' : ''}`,
          style: { left: `${p.x * 100}%`, top: `${p.y * 100}%` },
          title: `${g.n} 號線`,
          'aria-label': `${g.n} 號線`,
          onclick: () => selectGroup(g.id),
        }, g.n));
      }
    }
  }

  function selectGroup(id) {
    if (S.mode === 'color') {
      if (id !== BG) openYarnPicker(groupById(id));
      return;
    }
    S.selected = id;
    renderBadges();
    renderPanel();
  }

  // ---------- 畫布操作：點選、筆刷 ----------
  function bindCanvas() {
    const toImg = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * S.w, y: ((e.clientY - r.top) / r.height) * S.h, scale: r.width / S.w };
    };
    const radius = () => 2 + (S.brush.size / 100) * Math.max(S.w, S.h) * 0.08;
    const clampX = (x) => Math.max(0, Math.min(S.w - 1, Math.round(x)));
    const clampY = (y) => Math.max(0, Math.min(S.h - 1, Math.round(y)));
    let painting = false, last = null, down = null;
    const moveCursor = (e) => {
      if (!(S.brush.on && S.mode === 'detect')) { brushCursor.hidden = true; return; }
      const p = toImg(e);
      const d = radius() * 2 * p.scale;
      brushCursor.hidden = false;
      Object.assign(brushCursor.style, { width: `${d}px`, height: `${d}px`, left: `${(p.x / S.w) * 100}%`, top: `${(p.y / S.h) * 100}%` });
    };
    let seed = null;
    const dab = (x, y, r, target) => {
      if (S.brush.smart && seed) Seg.paintCircleSmart(S.labels, S.prep, x, y, r, target, seed, S.tol);
      else Seg.paintCircle(S.labels, S.w, S.h, x, y, r, target);
    };
    const paintTo = (p) => {
      const r = radius();
      const target = S.selected;
      if (!last) dab(p.x, p.y, r, target);
      else {
        const dist = Math.hypot(p.x - last.x, p.y - last.y);
        const steps = Math.max(1, Math.ceil(dist / (r / 2)));
        for (let s = 1; s <= steps; s++) {
          dab(last.x + ((p.x - last.x) * s) / steps, last.y + ((p.y - last.y) * s) / steps, r, target);
        }
      }
      last = p;
      renderCanvasSoon();
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!S) return;
      if (S.brush.on && S.mode === 'detect') {
        if (S.selected === null) { toast('先在右邊選要塗的線'); return; }
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        pushUndo();
        painting = true;
        last = null;
        const p0 = toImg(e);
        // 智慧筆刷的基準色：下筆那一點的顏色
        seed = Seg.sampleLab(S.prep, clampX(p0.x), clampY(p0.y));
        paintTo(p0);
        return;
      }
      if (S.ai.on && S.mode === 'detect') {
        e.preventDefault();
        if (!S.ai.handle) { toast('AI 還在準備中，請稍等'); return; }
        const p0 = toImg(e);
        S.ai.points.push({ x: clampX(p0.x), y: clampY(p0.y), include: S.ai.include });
        runAi();
        return;
      }
      if (S.wand && S.mode === 'detect') {
        if (S.selected === null) { toast('先在右邊選要改成哪一種線'); return; }
        e.preventDefault();
        const p0 = toImg(e);
        pushUndo();
        const n = Seg.floodSelect(S.labels, S.prep, clampX(p0.x), clampY(p0.y), S.selected, S.tol);
        S.manual = true;
        recompute({ keep: S.selected });
        markDirty();
        refresh();
        toast(n < 50 ? '選到的範圍很小，可以把「顏色容許範圍」調大' : '已選取相近的區域');
        return;
      }
      down = toImg(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!S) return;
      moveCursor(e);
      if (painting) paintTo(toImg(e));
    });
    canvas.addEventListener('pointerleave', () => (brushCursor.hidden = true));
    const end = (e) => {
      if (painting) {
        painting = false;
        last = null;
        if (S.brush.smart) Seg.fillHoles(S.labels, S.w, S.h, S.selected);
        S.manual = true;
        recompute({ keep: S.selected });
        markDirty();
        refresh();
        return;
      }
      if (!down) return;
      const p = toImg(e);
      const moved = Math.hypot(p.x - down.x, p.y - down.y) * p.scale;
      down = null;
      if (moved > 8) return;
      const x = Math.max(0, Math.min(S.w - 1, Math.floor(p.x))), y = Math.max(0, Math.min(S.h - 1, Math.floor(p.y)));
      const id = S.labels[y * S.w + x];
      if (id === BG) {
        if (S.mode === 'detect') selectGroup(BG);
        else toast('這裡是背景，不換色');
        return;
      }
      selectGroup(id);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', () => { painting = false; last = null; down = null; });
  }

  // ---------- 右側面板 ----------
  function renderPanel() {
    const tabs = h('div', { class: 'seg mode-tabs', role: 'tablist' },
      h('button', { type: 'button', role: 'tab', class: S.mode === 'detect' ? 'on' : '', 'aria-selected': String(S.mode === 'detect'), onclick: () => setMode('detect') }, '1 調整辨識'),
      h('button', { type: 'button', role: 'tab', class: S.mode === 'color' ? 'on' : '', 'aria-selected': String(S.mode === 'color'), onclick: () => setMode('color') }, '2 配色')
    );
    panelEl.replaceChildren(tabs, S.mode === 'detect' ? detectPanel() : colorPanel());
  }

  function setMode(m) {
    if (m === 'color' && !S.groups.length) { toast('目前沒有任何一種線，請先新增'); return; }
    S.mode = m;
    S.brush.on = false;
    S.wand = false;
    stopAi();
    if (m === 'color') S.selected = null;
    brushCursor.hidden = true;
    refresh();
  }

  function groupChip(g, { onClick, selected }) {
    return h('button', { type: 'button', class: `gchip ${selected ? 'on' : ''}`, 'aria-pressed': String(!!selected), onclick: onClick },
      h('span', { class: 'gnum' }, g.n),
      h('span', { class: 'gdot', style: { background: S.showRegions || S.brush.on || S.wand ? regionColor(g) : srcHex(g) } })
    );
  }

  function detectPanel() {
    const sens = h('input', { type: 'range', min: 0, max: 100, step: 1, value: S.sensitivity, id: 'sens', 'aria-label': '辨識敏感度' });
    sens.addEventListener('change', async () => {
      const v = Number(sens.value);
      if (S.manual && !(await confirmDialog('重新分組？', '調整敏感度會重新辨識，你手動修改過的區域會被清除。', '重新分組'))) {
        sens.value = S.sensitivity;
        return;
      }
      S.sensitivity = v;
      const busy = loading('重新辨識中…');
      await nextFrame();
      regroup();
      autoBackground();
      busy.close();
      markDirty();
      refresh();
      toast(`找到 ${S.groups.length} 種線`);
    });
    const regions = h('input', { type: 'checkbox', id: 'show-regions', checked: S.showRegions });
    regions.addEventListener('change', () => { S.showRegions = regions.checked; refresh(); });

    const sel = S.selected;
    const selGroup = sel !== null && sel !== BG ? groupById(sel) : null;
    const chips = h('div', { class: 'gchips' },
      S.ai.on ? h('button', { type: 'button', class: `gchip new ${sel === NEW_LINE ? 'on' : ''}`, 'aria-pressed': String(sel === NEW_LINE), onclick: () => selectGroup(NEW_LINE) }, '＋ 新的一種線') : null,
      S.groups.map((g) => groupChip(g, { selected: sel === g.id, onClick: () => selectGroup(g.id) })),
      h('button', { type: 'button', class: `gchip bg ${sel === BG ? 'on' : ''}`, 'aria-pressed': String(sel === BG), onclick: () => selectGroup(BG) }, '背景（不換色）')
    );

    const brushSize = h('input', { type: 'range', min: 1, max: 100, value: S.brush.size, id: 'brush-size', 'aria-label': '筆刷大小' });
    brushSize.addEventListener('input', () => (S.brush.size = Number(brushSize.value)));
    const tol = h('input', { type: 'range', min: 4, max: 60, value: S.tol, id: 'tool-tol', 'aria-label': '顏色容許範圍' });
    tol.addEventListener('input', () => (S.tol = Number(tol.value)));
    const smart = h('input', { type: 'checkbox', id: 'brush-smart', checked: S.brush.smart });
    smart.addEventListener('change', () => { S.brush.smart = smart.checked; renderPanel(); });
    const target = selGroup ? `${selGroup.n} 號線` : sel === BG ? '背景' : sel === NEW_LINE ? '新的一種線' : '未選';

    const suspect = S.bgSuspect != null ? groupById(S.bgSuspect) : null;
    const toolOn = S.ai.on || S.brush.on || S.wand;
    const bgNotice = suspect && !toolOn ? bgNoticeEl(suspect) : null;
    // 用工具時，面板只留需要的東西，不用捲動就看得到「套用」
    if (toolOn) {
      const toolName = S.ai.on ? 'AI 圈選' : S.brush.on ? '筆刷' : '魔術棒';
      return h('div', { class: 'panel-body' },
        S.ai.bgMode ? h('p', { class: 'lead' }, 'AI 去背景') : h('div', { class: 'field' }, h('span', {}, '選好的範圍要變成哪一種線'), chips),
        S.ai.on ? aiBox(target) : h('div', { class: 'tool-box' },
          h('p', { class: 'small' }, S.brush.on ? `在圖上塗，塗到的地方會變成：${target}` : `點圖上的一個地方，相連又相近的顏色會變成：${target}`),
          S.brush.on ? h('label', { class: 'field' }, h('span', {}, '筆刷大小'), brushSize) : null,
          S.brush.on ? h('label', { class: 'check' }, smart, h('span', {}, '只塗跟下筆處相近的顏色（智慧筆刷）')) : null,
          S.wand || S.brush.smart
            ? h('label', { class: 'field' }, h('span', {}, '顏色容許範圍'), tol, h('span', { class: 'range-labels' }, h('span', {}, '只選很像的'), h('span', {}, '範圍大一點')))
            : null
        ),
        h('div', { class: 'tool-grid' },
          S.ai.on && S.ai.points.length
            ? button('收回上一個點', { icon: 'undo', id: 'btn-ai-undo', onClick: undoAiPoint })
            : button('復原', { icon: 'undo', onClick: undo, disabled: !S.undo.length }),
          button(`關閉${toolName}`, { icon: 'close', id: S.ai.on ? 'btn-ai' : null, onClick: () => { if (S.ai.on) toggleAi(); else if (S.brush.on) toggleBrush(); else toggleWand(); } })
        ),
        button('辨識完成，開始配色', { kind: 'primary block', onClick: () => setMode('color') })
      );
    }
    return h('div', { class: 'panel-body' },
      h('p', { class: 'lead' }, `找到 ${S.groups.length} 種線，圖上的數字是每種線的位置。辨識不對的話，在這裡修正。`),
      S.bgIgnore === S.bgSuspect ? null : bgNotice,
      h('label', { class: 'field' },
        h('span', {}, '辨識敏感度'),
        sens,
        h('span', { class: 'range-labels' }, h('span', {}, '少一點線'), h('span', {}, '多一點線'))
      ),
      h('label', { class: 'check' }, regions, h('span', {}, '顯示區域色塊')),
      h('div', { class: 'field' }, h('span', {}, '選一種線'), chips),
      h('p', { class: 'muted small' }, selGroup ? `已選 ${selGroup.n} 號線。` : sel === BG ? '已選背景。用筆刷可以把區域改成背景。' : '也可以直接點圖片上的區域。'),
      h('div', { class: 'tool-grid' },
        button('合併', { icon: 'merge', onClick: mergeSelected, disabled: !selGroup || S.groups.length < 2, title: '把這種線跟另一種線合併' }),
        button('拆分', { icon: 'split', onClick: splitSelected, disabled: !selGroup, title: '把這種線拆成兩種' }),
        button('刪除這種線', { icon: 'trash', onClick: deleteSelected, disabled: !selGroup, title: '改成背景，不換色' }),
        button('新增一種線', { icon: 'plus', onClick: addGroup }),
        button(S.brush.on ? '關閉筆刷' : '筆刷塗改', { icon: 'brush', kind: S.brush.on ? 'on' : '', onClick: toggleBrush }),
        button(S.ai.on ? '關閉 AI 圈選' : 'AI 圈選', { icon: 'sparkle', kind: S.ai.on ? 'on' : '', onClick: toggleAi, title: '點一下要選的東西，AI 會找出它的範圍', id: 'btn-ai' }),
        button(S.wand ? '關閉魔術棒' : '魔術棒', { icon: 'wand', kind: S.wand ? 'on' : '', onClick: toggleWand, title: '點一下，把相連、顏色相近的整片改成選好的線' }),
        button('復原', { icon: 'undo', onClick: undo, disabled: !S.undo.length })
      ),
      S.ai.on ? aiBox(target) : null,
      S.brush.on || S.wand
        ? h('div', { class: 'tool-box' },
          h('p', { class: 'small' }, S.brush.on ? `在圖上塗，塗到的地方會變成：${target}` : `點圖上的一個地方，相連又相近的顏色會變成：${target}`),
          S.brush.on ? h('label', { class: 'field' }, h('span', {}, '筆刷大小'), brushSize) : null,
          S.brush.on ? h('label', { class: 'check' }, smart, h('span', {}, '只塗跟下筆處相近的顏色（智慧筆刷）')) : null,
          S.wand || S.brush.smart
            ? h('label', { class: 'field' }, h('span', {}, '顏色容許範圍'), tol, h('span', { class: 'range-labels' }, h('span', {}, '只選很像的'), h('span', {}, '範圍大一點')))
            : null
        )
        : null,
      button('辨識完成，開始配色', { kind: 'primary block', onClick: () => setMode('color') })
    );
  }

  // ---------- AI 圈選 ----------
  function aiBox(target) {
    const a = S.ai;
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '點選方式' },
      h('button', { type: 'button', class: a.include ? 'on' : '', 'aria-pressed': String(a.include), onclick: () => { a.include = true; renderPanel(); } }, h('span', { class: 'dot include' }), '要這裡'),
      h('button', { type: 'button', class: !a.include ? 'on' : '', 'aria-pressed': String(!a.include), onclick: () => { a.include = false; renderPanel(); } }, h('span', { class: 'dot exclude' }), '不要這裡')
    );
    const hasInclude = a.points.some((p) => p.include);
    const status = !a.handle ? '準備中…'
      : a.busy ? 'AI 圈選中…'
      : !a.points.length ? '點圖上你要選的東西（例如花邊）。'
      : !hasInclude ? '還沒有綠點。先切到「要這裡」，點你要選的東西。'
      : a.points.length > 1 ? '每個綠點會各自找範圍再合起來，沒選到的地方直接再點一個綠點；選太多就在那裡點紅點，或切換「範圍大小」。'
      : '黃框裡亮的地方是選到的範圍。不對就先切換「範圍大小」；還是不對再補 1–2 個點。';
    const sizeNames = ['小', '中', '大'];
    const sizes = a.options.length > 1 && !a.busy
      ? h('div', { class: 'field' },
        h('span', {}, '範圍大小'),
        h('div', { class: 'seg', role: 'group', 'aria-label': '選取範圍大小' },
          a.options.map((o, i) => h('button', {
            type: 'button',
            class: i === a.pick ? 'on' : '',
            'aria-pressed': String(i === a.pick),
            onclick: () => { a.pick = i; a.size = i; a.mask = o.mask; refresh(); },
          }, `${sizeNames[i] || i + 1}（${Math.max(1, Math.round(o.area * 100))}%）`))
        ))
      : null;
    if (a.bgMode) {
      const st = !a.handle ? '準備中…' : a.busy ? 'AI 找作品範圍中…'
        : !a.points.length ? '點一下作品本身（任何地方都可以），AI 會找出整件作品。'
        : '亮的地方是作品，變暗的會設為背景。作品沒選完整：切換「範圍大小」或在漏掉的地方再點一下。';
      return h('div', { class: 'tool-box' },
        h('p', { class: 'small', id: 'ai-status' }, st),
        sizes,
        h('div', { class: 'row-actions' },
          button('作品以外都設為背景', { kind: 'primary', onClick: applyAi, disabled: !a.mask || a.busy, id: 'btn-ai-apply' }),
          button('清除重選', { kind: 'ghost', onClick: () => { a.points = []; a.mask = null; a.options = []; refresh(); }, disabled: !a.points.length })
        )
      );
    }
    const bgWarn = S.selected != null && S.selected === S.bgSuspect && S.bgIgnore !== S.bgSuspect
      ? h('p', { class: 'warn-text' }, `注意：${groupById(S.selected).n} 號線看起來是背景。套用到這裡，之後設成背景時會一起變成不換色。建議選「＋ 新的一種線」。`)
      : null;
    return h('div', { class: 'tool-box' },
      bgWarn,
      h('p', { class: 'small', id: 'ai-status' }, status),
      seg,
      sizes,
      h('div', { class: 'row-actions' },
        button(`套用到：${target}`, { kind: 'primary', onClick: applyAi, disabled: !a.mask || a.busy || S.selected === null, id: 'btn-ai-apply' }),
        button('清除重選', { kind: 'ghost', onClick: () => { a.points = []; a.mask = null; a.options = []; a.include = true; refresh(); }, disabled: !a.points.length })
      ),
      S.selected === null ? h('p', { class: 'small' }, '先在上面選好的範圍要變成哪一種線。') : null
    );
  }

  async function toggleAi(bgMode = false) {
    if (S.ai.on && !(bgMode === true && !S.ai.bgMode)) { stopAi(); refresh(); return; }
    S.ai.on = true;
    S.ai.bgMode = bgMode === true;
    S.ai.points = [];
    S.ai.mask = null;
    S.ai.options = [];
    S.selected = NEW_LINE;
    S.brush.on = false;
    S.wand = false;
    refresh();
    if (S.ai.handle) return;
    const busy = loading('下載 AI 模型…（第一次約 15 MB，之後不用再下載）');
    try {
      await loadSam((got, total) => busy.set(`下載 AI 模型… ${got.toFixed(1)} / ${total.toFixed(1)} MB（只有第一次需要）`));
      busy.set('AI 正在看這張圖…（大約 5–30 秒）');
      await nextFrame();
      const session = S;
      const handle = await analyzeImage(S.srcCanvas);
      if (session !== S) { busy.close(); return; } // 等待中換了圖
      S.ai.handle = handle;
      busy.close();
      refresh();
      toast(S.ai.bgMode ? 'AI 準備好了，點一下作品本身' : 'AI 準備好了，點圖上要選的東西');
    } catch (e) {
      busy.close();
      S.ai.on = false;
      refresh();
      toast(e.message || 'AI 圈選啟動失敗', 'error');
    }
  }

  function stopAi() {
    if (!S) return;
    if (S.selected === NEW_LINE) S.selected = null;
    S.ai.on = false;
    S.ai.bgMode = false;
    S.ai.points = [];
    S.ai.mask = null;
    S.ai.options = [];
  }

  // 整理 AI 給的範圍：保留含有綠點的連通區塊，補掉裡面的小洞
  function cleanMask(mask, points) {
    const w = S.w, h = S.h, n = w * h;
    const comp = new Int32Array(n).fill(-1);
    const keep = new Set();
    const stack = [];
    const label = (start, id, val) => {
      comp[start] = id;
      stack.push(start);
      let size = 0, edge = false;
      while (stack.length) {
        const i = stack.pop();
        size++;
        const x = i % w;
        if (x === 0 || x === w - 1 || i < w || i >= n - w) edge = true;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
          if (j < 0 || j >= n || comp[j] >= 0 || mask[j] !== val) continue;
          comp[j] = id;
          stack.push(j);
        }
      }
      return { size, edge };
    };
    // 選到的區塊
    let id = 0;
    const sizes = [];
    for (let i = 0; i < n; i++) if (mask[i] && comp[i] < 0) sizes[id] = label(i, id++, 1).size;
    for (const p of points) {
      if (!p.include) continue;
      const i = p.y * w + p.x;
      if (mask[i]) { keep.add(comp[i]); continue; }
      // 綠點剛好在選取範圍外：找附近最大的一塊（不要撿到雜點）
      let best = -1;
      const R = Math.round(Math.max(w, h) * 0.06);
      for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
        const x = p.x + dx, y = p.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const j = y * w + x;
        if (mask[j] && (best < 0 || sizes[comp[j]] > sizes[best])) best = comp[j];
      }
      if (best >= 0 && sizes[best] > n * 0.0005) keep.add(best);
    }
    // 都找不到：留最大的一塊
    if (!keep.size && sizes.length) keep.add(sizes.indexOf(Math.max(...sizes)));
    if (!keep.size) return mask;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (mask[i] && keep.has(comp[i])) out[i] = 1;
    // 補洞：沒選到、又被選取範圍包住的小洞（小於整張圖 0.3%）
    const hole = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      if (out[i] || hole[i] >= 0) continue;
      const members = [];
      let edge = false;
      hole[i] = 1;
      stack.push(i);
      while (stack.length) {
        const k = stack.pop();
        members.push(k);
        const x = k % w;
        if (x === 0 || x === w - 1 || k < w || k >= n - w) edge = true;
        for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w]) {
          if (j < 0 || j >= n || out[j] || hole[j] >= 0) continue;
          hole[j] = 1;
          stack.push(j);
        }
      }
      if (!edge && members.length < n * 0.003) for (const k of members) out[k] = 1;
    }
    return out;
  }

  // 收回上一個點（AI 圈選中）
  function undoAiPoint() {
    S.ai.points.pop();
    if (S.ai.points.some((p) => p.include)) runAi();
    else {
      S.ai.mask = null;
      S.ai.options = [];
      refresh();
    }
  }

  // 連續點很快時，只算最新的那一次
  let aiRun = 0;
  const aiCache = { handle: null, map: new Map() };
  async function runAi() {
    if (!S.ai.points.some((p) => p.include)) {
      S.ai.mask = null;
      S.ai.options = [];
      refresh();
      toast('先用「加入範圍」點一下你要選的東西（綠點），再用紅點排除多選的地方');
      return;
    }
    const my = ++aiRun;
    const session = S;
    S.ai.busy = true;
    renderPanel();
    renderCanvas();
    try {
      // 綠點交給 AI 找範圍；紅點不直接給 AI（它對排除點的反應不穩定），
      // 改成「找出紅點那個東西的最小範圍，再從選取範圍扣掉」
      const inc = S.ai.points.filter((p) => p.include);
      const exc = S.ai.points.filter((p) => !p.include);
      // 綠點多的時候，AI 一次看全部點常常只選到其中一部分（例如右邊花邊點了好幾個卻沒選到）。
      // 所以每個綠點也各自找一次範圍，再全部合起來；3 個點以上就只用各自找的結果
      let raw = inc.length >= 3 ? null : await selectByPoints(S.ai.handle, inc);
      if (inc.length > 1) {
        // 每個點的結果記起來，多點一個點時不用全部重算
        if (aiCache.handle !== S.ai.handle) { aiCache.handle = S.ai.handle; aiCache.map = new Map(); }
        for (const p of inc) {
          const key = `${p.x},${p.y}`;
          if (!aiCache.map.has(key)) aiCache.map.set(key, await selectByPoints(S.ai.handle, [p]));
          const one = aiCache.map.get(key);
          if (!one.length) continue;
          if (!raw) { raw = one.map((o) => ({ ...o, mask: o.mask.slice() })); continue; }
          raw.forEach((o, k) => {
            const m = one[Math.min(k, one.length - 1)].mask;
            for (let i = 0; i < o.mask.length; i++) if (m[i]) o.mask[i] = 1;
          });
        }
      }
      raw = raw || [];
      for (const e of exc) {
        const parts = await selectByPoints(S.ai.handle, [{ x: e.x, y: e.y, include: true }]);
        const cut = parts.find((o) => o.area > 0.0005) || parts[0];
        if (!cut) continue;
        for (const o of raw) for (let i = 0; i < o.mask.length; i++) if (cut.mask[i]) o.mask[i] = 0;
      }
      if (my !== aiRun || session !== S) return;
      // 只留下跟綠點連在一起的那一塊，散落的小點、小洞清掉
      const options = raw.map((o) => {
        const mask = cleanMask(o.mask, S.ai.points);
        let area = 0;
        for (let i = 0; i < mask.length; i++) area += mask[i];
        return { ...o, mask, area: area / mask.length };
      });
      // 預設用最小的範圍（AI 最有把握的常常是整件作品，太大）；使用者切換過大小，就沿用他選的
      let pick = Math.min(S.ai.size, options.length - 1);
      if (S.ai.bgMode) {
        pick = 0;
        options.forEach((o, i) => { if (o.area < 0.9 && o.area >= options[pick].area) pick = i; });
      }
      S.ai.options = options;
      S.ai.pick = pick;
      S.ai.mask = options.length ? options[pick].mask : null;
    } catch (e) {
      if (my === aiRun) toast(e.message || 'AI 圈選失敗', 'error');
    } finally {
      if (my === aiRun && session === S) {
        S.ai.busy = false;
        refresh();
      }
    }
  }

  function applyAi() {
    const { mask } = S.ai;
    if (S.ai.bgMode) {
      if (!mask) return;
      pushUndo();
      let n = 0;
      for (let i = 0; i < mask.length; i++) if (!mask[i] && S.labels[i] !== BG) { S.labels[i] = BG; n++; }
      S.manual = true;
      stopAi();
      recompute({ renumber: true });
      S.selected = null;
      markDirty();
      refresh();
      toast(n ? '作品以外都設為背景了（不換色）。不對可以按「復原」' : '沒有改變');
      return;
    }
    if (!mask || S.selected === null) return;
    pushUndo();
    let target = S.selected;
    let created = null;
    if (target === NEW_LINE) {
      target = unusedId();
      if (target === null) { toast('線的種類太多了，請先合併一些'); return; }
      created = { id: target, n: S.groups.reduce((m, g) => Math.max(m, g.n), 0) + 1, srcLab: [50, 0, 0], count: 0, yarn: null };
      S.groups.push(created);
    }
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { S.labels[i] = target; n++; }
    S.ai.points = [];
    S.ai.mask = null;
    S.ai.options = [];
    S.ai.include = true;
    S.manual = true;
    recompute({ keep: target });
    // 套用完，下一次預設還是「新的一種線」
    if (created) S.selected = NEW_LINE;
    markDirty();
    refresh();
    toast(!n ? '沒有選到任何範圍' : created ? `已套用成 ${created.n} 號線。可以繼續點下一個東西` : '已套用。可以繼續點下一個東西');
  }

  function toggleWand() {
    S.wand = !S.wand;
    if (S.wand) { S.brush.on = false; stopAi(); }
    if (S.wand && S.selected === null) toast('先選要改成哪一種線，再點圖');
    refresh();
  }

  // 「這種線看起來是背景」的一行提示（調整辨識和配色都會出現）
  function bgNoticeEl(suspect) {
    return h('div', { class: 'notice compact' },
      h('span', {}, `${suspect.n} 號線裡混了背景（桌面），換色會連桌面一起變。`),
      button('AI 去背景', { kind: 'small primary', id: 'btn-ai-bg', title: '點一下作品，作品以外都設為背景', onClick: () => { if (S.mode !== 'detect') setMode('detect'); toggleAi(true); } }),
      button('整個設為背景', { kind: 'small', id: 'btn-bg', onClick: () => setBackground(suspect.id) }),
      button('不是', { kind: 'small ghost', onClick: () => { S.bgIgnore = suspect.id; renderPanel(); } })
    );
  }

  function setBackground(id) {
    const g = groupById(id);
    if (!g) return;
    pushUndo();
    const before = g.count;
    // 先用紋理把平滑的桌面分出來；分不出多少（例如桌面也有花紋）時，才把整種線設為背景
    const moved = Seg.separateBackground(S.prep, S.labels, id);
    let msg;
    if (moved > before * 0.3) {
      msg = `已把背景（桌面）設為不換色，${g.n} 號裡有紋理的毛線保留下來。可以按「復原」`;
    } else {
      for (let i = 0; i < S.labels.length; i++) if (S.labels[i] === id) S.labels[i] = BG;
      msg = `已把 ${g.n} 號整個設為背景（不換色）。可以按「復原」`;
    }
    S.manual = true;
    if (S.selected === id) S.selected = null;
    recompute({ renumber: S.mode === 'detect' });
    S.bgIgnore = null;
    markDirty();
    refresh();
    toast(msg);
  }

  function toggleBrush() {
    S.brush.on = !S.brush.on;
    if (S.brush.on) { S.wand = false; stopAi(); }
    if (S.brush.on && S.selected === null) toast('先選要塗的線，再在圖上塗');
    refresh();
  }

  async function mergeSelected() {
    const a = groupById(S.selected);
    if (!a) return;
    const others = S.groups.filter((g) => g.id !== a.id);
    const v = await modal({
      title: `${a.n} 號線要跟哪一種線合併？`,
      body: h('div', { class: 'gchips' }, others.map((g) => groupChip(g, { onClick: (e) => e.currentTarget.closest('.modal').closeWith?.(g.id) }))),
      actions: [{ label: '取消', value: null, kind: 'ghost' }],
    });
    if (v == null) return;
    const b = groupById(v);
    pushUndo();
    const [keep, drop] = b.count >= a.count ? [b, a] : [a, b];
    for (let i = 0; i < S.labels.length; i++) if (S.labels[i] === drop.id) S.labels[i] = keep.id;
    if (!keep.yarn && drop.yarn) keep.yarn = drop.yarn;
    S.manual = true;
    S.selected = keep.id;
    recompute({ renumber: true });
    markDirty();
    refresh();
    toast('已合併');
  }

  async function splitSelected() {
    const g = groupById(S.selected);
    const nid = unusedId();
    if (!g || nid === null) return;
    pushUndo();
    const busy = loading('拆分中…');
    await nextFrame();
    const ok = Seg.splitGroup(S.prep, S.labels, g.id, nid);
    busy.close();
    if (!ok) { S.undo.pop(); toast('這種線沒辦法再分成兩種了'); return; }
    S.groups.push({ id: nid, n: 0, srcLab: g.srcLab, count: 0, yarn: null });
    S.manual = true;
    recompute({ renumber: true });
    S.selected = nid;
    markDirty();
    refresh();
    toast('已拆成兩種線');
  }

  function deleteSelected() {
    const g = groupById(S.selected);
    if (!g) return;
    pushUndo();
    for (let i = 0; i < S.labels.length; i++) if (S.labels[i] === g.id) S.labels[i] = BG;
    S.manual = true;
    S.selected = null;
    recompute({ renumber: true });
    markDirty();
    refresh();
    toast('已改成背景（不換色）。按「復原」可以救回');
  }

  function addGroup() {
    const nid = unusedId();
    if (nid === null) return;
    pushUndo();
    const n = S.groups.reduce((m, g) => Math.max(m, g.n), 0) + 1;
    S.groups.push({ id: nid, n, srcLab: [50, 0, 0], count: 0, yarn: null });
    S.selected = nid;
    S.brush.on = true;
    S.manual = true;
    refresh();
    toast(`已新增 ${n} 號線，用筆刷塗出它的位置`);
  }

  function colorPanel() {
    const list = h('div', { class: 'assign-list' });
    for (const g of S.groups) {
      const y = yarnInfo(g);
      const row = h('div', { class: 'assign-row' },
        h('button', { type: 'button', class: 'assign-main', onclick: () => openYarnPicker(g), 'aria-label': `幫 ${g.n} 號線挑顏色` },
          h('span', { class: 'badge static' }, g.n),
          h('span', { class: 'orig', style: { background: srcHex(g) }, title: '原本的顏色' }),
          h('span', { class: 'arrow-to' }, '→'),
          y ? (y.live ? swatchVisual(data, y, 'assign-thumb') : h('span', { class: 'assign-thumb', style: { background: y.hex } }))
            : h('span', { class: 'assign-thumb unset' }, '挑線'),
          h('span', { class: 'assign-text' },
            y ? h('strong', {}, `${y.brandName || ''} ${y.code}`.trim()) : h('strong', { class: 'muted' }, '還沒選，維持原色'),
            y && y.name ? h('span', { class: 'muted' }, y.name) : null
          ),
          y && y.live ? h('span', { class: `chip ${y.owned ? 'ok' : ''}` }, y.owned ? '已有' : '需要買') : null
        ),
        y ? h('button', { class: 'icon-btn', type: 'button', title: '改回原色', 'aria-label': `${g.n} 號線改回原色`, onclick: () => { pushUndo(); g.yarn = null; markDirty(); refresh(); } }, icon('close')) : null
      );
      list.append(row);
    }
    const hold = button('按住看原圖', { icon: 'eye', id: 'btn-hold' });
    const setHold = (v) => { if (S.hold !== v) { S.hold = v; renderCanvas(); } };
    hold.addEventListener('pointerdown', (e) => { e.preventDefault(); setHold(true); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => hold.addEventListener(ev, () => setHold(false)));
    hold.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') setHold(true); });
    hold.addEventListener('keyup', () => setHold(false));
    const suspect = S.bgSuspect != null && S.bgIgnore !== S.bgSuspect ? groupById(S.bgSuspect) : null;
    return h('div', { class: 'panel-body' },
      h('p', { class: 'lead' }, '點圖上的數字或下面的清單，幫每種線挑顏色。'),
      suspect ? bgNoticeEl(suspect) : null,
      list,
      hold,
      h('div', { class: 'tool-grid' },
        button('復原', { icon: 'undo', onClick: undo, disabled: !S.undo.length, id: 'btn-undo-color' }),
        button('回去修改範圍', { icon: 'brush', onClick: () => setMode('detect'), title: '回到「1 調整辨識」，重新圈選或修改每種線的範圍' })
      )
    );
  }

  function openYarnPicker(g) {
    if (!g) return;
    if (!data.library.yarns.length) {
      toast('線材庫還沒有色號，先到「線材庫」新增品牌');
      return;
    }
    const y = yarnInfo(g);
    openPicker(app, {
      title: `幫 ${g.n} 號線挑顏色`,
      baseHex: y ? y.hex : srcHex(g),
      currentId: g.yarn ? g.yarn.id : null,
      onPick: (picked) => {
        const brand = data.brand(picked.brandId);
        pushUndo();
        g.yarn = { id: picked.id, brandId: picked.brandId, brandName: brand ? brand.name : '', code: picked.code, name: picked.name, hex: picked.hex };
        markDirty();
        refresh();
      },
    });
  }

  // ---------- 存檔、另存新檔 ----------
  function tagDialog(current, title) {
    const chosen = new Set(current);
    const chipsEl = h('div', { class: 'tag-chips' });
    const preview = h('p', { class: 'muted' });
    const input = h('input', { class: 'input', placeholder: '例如：毛衣、圍巾、帽子', id: 'new-tag', 'aria-label': '新增分類標籤' });
    const all = new Set([...data.allTags(), ...current]);
    const draw = () => {
      chipsEl.replaceChildren(...[...all].map((t) =>
        h('button', { type: 'button', class: `tag ${chosen.has(t) ? 'on' : ''}`, 'aria-pressed': String(chosen.has(t)), onclick: () => { chosen.has(t) ? chosen.delete(t) : chosen.add(t); draw(); } }, t)
      ));
      if (!all.size) chipsEl.append(h('span', { class: 'muted' }, '還沒有標籤，在下面輸入一個。'));
      preview.textContent = `檔名會是：${data.autoName([...chosen])}`;
    };
    const addTag = () => {
      const t = input.value.trim();
      if (!t) return;
      all.add(t);
      chosen.add(t);
      input.value = '';
      draw();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });
    draw();
    return modal({
      title,
      body: h('div', { class: 'tag-dialog' },
        h('div', { class: 'field' }, h('span', {}, '分類標籤（可以選多個，第一個會用在檔名）'), chipsEl),
        h('div', { class: 'inline-add' }, input, button('加入', { onClick: addTag })),
        preview
      ),
      actions: [
        { label: '取消', value: null, kind: 'ghost' },
        { label: title, value: 'ok', kind: 'primary', validate: () => { if (input.value.trim()) addTag(); return true; } },
      ],
    }).then((v) => (v === 'ok' ? [...chosen] : null));
  }

  function renderRecolored() {
    const c = document.createElement('canvas');
    c.width = S.w;
    c.height = S.h;
    const cx = c.getContext('2d');
    const img = cx.createImageData(S.w, S.h);
    recolor(S.prep, S.labels, targets(), img);
    cx.putImageData(img, 0, 0);
    return c;
  }

  function makeThumb(full) {
    const scale = 260 / Math.max(S.w, S.h);
    const c = document.createElement('canvas');
    c.width = Math.round(S.w * scale);
    c.height = Math.round(S.h * scale);
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(full, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72);
  }

  async function save(asNew) {
    if (!S) return;
    let tags = S.work ? S.work.tags : [];
    let name = S.work ? S.work.name : null;
    if (asNew || !S.work) {
      const res = await tagDialog(tags, asNew ? '另存新檔' : '存檔');
      if (!res) return;
      tags = res;
      name = data.autoName(tags);
    }
    const busy = loading('存到 GitHub…');
    try {
      // 原圖所屬的配色都被刪掉時，圖片也已刪除，要重新上傳
      if (S.imagePath && !data.works.some((w) => w.image === S.imagePath)) S.imagePath = null;
      if (!S.imagePath && !S.imageBase64) S.imageBase64 = S.srcCanvas.toDataURL('image/jpeg', 0.9).split(',')[1];
      const payload = {
        name,
        tags,
        width: S.w,
        height: S.h,
        labels: Seg.encodeLabels(S.labels),
        groups: S.groups.map((g) => ({ id: g.id, n: g.n, srcLab: g.srcLab.map((v) => Math.round(v * 100) / 100), count: g.count, yarn: g.yarn })),
        sensitivity: S.sensitivity,
      };
      if (!asNew && S.work) {
        payload.id = S.work.id;
        payload.createdAt = S.work.createdAt;
      }
      const saved = await data.saveWork(payload, { imagePath: S.imagePath, imageBase64: S.imageBase64, thumb: makeThumb(renderRecolored()) });
      S.work = { id: saved.id, name: saved.name, tags: saved.tags, createdAt: saved.createdAt };
      S.imagePath = saved.image;
      S.dirty = false;
      busy.close();
      drawTitle();
      toast(asNew ? `已另存新檔：${saved.name}` : `已存檔：${saved.name}`);
    } catch (e) {
      busy.close();
      toast(e.message || '存檔失敗', 'error');
    }
  }

  function doExport() {
    if (!S) return;
    const rows = S.groups.map((g) => ({ n: g.n, origHex: srcHex(g), yarn: yarnInfo(g), thumb: g.yarn ? data.thumbOf(g.yarn.id) : null }));
    openExport({ image: renderRecolored(), rows, name: S.work ? S.work.name : '新作品' });
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (S && canvas && el.isConnected) renderBadges(); }, 150);
  });

  data.on((what) => {
    // 線材庫改了（例如代表色、庫存），預覽跟著更新
    if (S && (what === 'library' || what === 'all') && canvas && el.isConnected) refresh();
  });

  drawAll();
  return {
    el,
    onShow: () => { if (S && canvas) renderCanvas(); },
    isDirty: () => !!(S && S.dirty),
    openWork,
    clear: () => { S = null; drawAll(); },
  };
}
