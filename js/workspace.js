// 配色工作區：上傳作品 → 辨識線材 → 調整 → 點選換色 → 存檔、另存新檔、匯出
import { h, icon, button, toast, modal, confirmDialog, loading, pickFiles, fileToImage, urlToImage, nextFrame } from './ui.js';
import * as Seg from './segment.js';
import { recolor, paintRegions } from './recolor.js';
import { labToHex, hexToRgb, deltaE } from './color.js';
import { openPicker, swatchVisual } from './library.js';
import { openExport } from './export.js';

const WORK_MAX = 1100; // 作品圖的處理尺寸（長邊像素）
const DEFAULT_SENS = 55;
const REGION_COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9a6324', '#800000', '#aaffc3', '#000075'];
const BG = Seg.BG;

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
      brush: { on: false, size: 30 },
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
    if (S.selected !== null && S.selected !== BG && !groupById(S.selected)) S.selected = null;
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
      S.dirty = true;
      busy.close();
      drawAll();
      toast(`找到 ${S.groups.length} 種線`);
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
    const showRegions = S.mode === 'detect' && (S.showRegions || S.brush.on);
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
  }

  let rafPending = false;
  function renderCanvasSoon() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderCanvas(); });
  }

  function renderBadges() {
    badgesEl.replaceChildren();
    badgesEl.classList.toggle('passive', S.brush.on && S.mode === 'detect');
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
    let painting = false, last = null, down = null;
    const moveCursor = (e) => {
      if (!(S.brush.on && S.mode === 'detect')) { brushCursor.hidden = true; return; }
      const p = toImg(e);
      const d = radius() * 2 * p.scale;
      brushCursor.hidden = false;
      Object.assign(brushCursor.style, { width: `${d}px`, height: `${d}px`, left: `${(p.x / S.w) * 100}%`, top: `${(p.y / S.h) * 100}%` });
    };
    const paintTo = (p) => {
      const r = radius();
      const target = S.selected;
      if (!last) Seg.paintCircle(S.labels, S.w, S.h, p.x, p.y, r, target);
      else {
        const dist = Math.hypot(p.x - last.x, p.y - last.y);
        const steps = Math.max(1, Math.ceil(dist / (r / 2)));
        for (let s = 1; s <= steps; s++) {
          Seg.paintCircle(S.labels, S.w, S.h, last.x + ((p.x - last.x) * s) / steps, last.y + ((p.y - last.y) * s) / steps, r, target);
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
        paintTo(toImg(e));
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
    if (m === 'color') S.selected = null;
    brushCursor.hidden = true;
    refresh();
  }

  function groupChip(g, { onClick, selected }) {
    return h('button', { type: 'button', class: `gchip ${selected ? 'on' : ''}`, 'aria-pressed': String(!!selected), onclick: onClick },
      h('span', { class: 'gnum' }, g.n),
      h('span', { class: 'gdot', style: { background: S.showRegions || S.brush.on ? regionColor(g) : srcHex(g) } })
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
      S.groups.map((g) => groupChip(g, { selected: sel === g.id, onClick: () => selectGroup(g.id) })),
      h('button', { type: 'button', class: `gchip bg ${sel === BG ? 'on' : ''}`, 'aria-pressed': String(sel === BG), onclick: () => selectGroup(BG) }, '背景（不換色）')
    );

    const brushSize = h('input', { type: 'range', min: 1, max: 100, value: S.brush.size, id: 'brush-size', 'aria-label': '筆刷大小' });
    brushSize.addEventListener('input', () => (S.brush.size = Number(brushSize.value)));

    return h('div', { class: 'panel-body' },
      h('p', { class: 'lead' }, `找到 ${S.groups.length} 種線，圖上的數字是每種線的位置。辨識不對的話，在這裡修正。`),
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
        button('復原', { icon: 'undo', onClick: undo, disabled: !S.undo.length })
      ),
      S.brush.on
        ? h('label', { class: 'field' }, h('span', {}, `筆刷大小（正在塗：${selGroup ? selGroup.n + ' 號線' : sel === BG ? '背景' : '未選'}）`), brushSize)
        : null,
      button('辨識完成，開始配色', { kind: 'primary block', onClick: () => setMode('color') })
    );
  }

  function toggleBrush() {
    S.brush.on = !S.brush.on;
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
        y ? h('button', { class: 'icon-btn', type: 'button', title: '改回原色', 'aria-label': `${g.n} 號線改回原色`, onclick: () => { g.yarn = null; markDirty(); refresh(); } }, icon('close')) : null
      );
      list.append(row);
    }
    const hold = button('按住看原圖', { icon: 'eye', id: 'btn-hold' });
    const setHold = (v) => { if (S.hold !== v) { S.hold = v; renderCanvas(); } };
    hold.addEventListener('pointerdown', (e) => { e.preventDefault(); setHold(true); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => hold.addEventListener(ev, () => setHold(false)));
    hold.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') setHold(true); });
    hold.addEventListener('keyup', () => setHold(false));
    return h('div', { class: 'panel-body' },
      h('p', { class: 'lead' }, '點圖上的數字或下面的清單，幫每種線挑顏色。'),
      list,
      hold
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
