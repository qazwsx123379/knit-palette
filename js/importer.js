// 新增品牌與色號：上傳色卡截圖 → 自動找色塊、取色、讀文字 → 確認清單 → 加入線材庫
import { h, icon, button, toast, loading, pickFiles, fileToImage, nextFrame, confirmDialog } from './ui.js';
import { detectSwatches, swatchColor, pickColor, cropThumb, assignText } from './swatches.js';
import { readWords, OCR_LANGS } from './ocr.js';

function loadPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function savePref(key, v) {
  try { localStorage.setItem(key, v); } catch { /* 不影響使用 */ }
}

export function createImportView(app) {
  const { data } = app;
  const el = h('section', { class: 'view', id: 'view-import' });
  let state = null;

  function reset(params = {}) {
    state = {
      brandId: params.brandId || null,
      newBrand: '',
      lang: loadPref('ocr-lang', 'eng'),
      shots: [], // { img, imageData, words }
      rows: [],
      active: 0,
      tool: null, // 'frame' | { eyedrop: row }
    };
    drawStart();
  }

  // ---------- 第一步：選品牌、上傳截圖 ----------
  function drawStart() {
    const brands = data.library.brands;
    const fixed = state.brandId && data.brand(state.brandId);
    const brandSelect = h('select', { class: 'input', id: 'imp-brand' },
      h('option', { value: '' }, '＋ 新品牌'),
      brands.map((b) => h('option', { value: b.id, selected: b.id === state.brandId }, b.name))
    );
    const newBrand = h('input', { class: 'input', id: 'imp-new-brand', placeholder: '例如：Daruma、Hamanaka', value: state.newBrand });
    const newWrap = h('label', { class: 'field' }, h('span', {}, '新品牌名稱'), newBrand);
    const syncBrand = () => {
      state.brandId = brandSelect.value || null;
      newWrap.hidden = !!state.brandId;
    };
    brandSelect.addEventListener('change', syncBrand);
    newBrand.addEventListener('input', () => (state.newBrand = newBrand.value));
    const lang = h('select', { class: 'input', id: 'imp-lang' }, OCR_LANGS.map((l) => h('option', { value: l.id, selected: l.id === state.lang }, l.label)));
    lang.addEventListener('change', () => { state.lang = lang.value; savePref('ocr-lang', lang.value); });

    el.replaceChildren(
      h('div', { class: 'view-head' },
        h('h1', {}, fixed ? `加色號：${fixed.name}` : '新增品牌'),
        button('取消', { kind: 'ghost', onClick: () => app.go('library') })
      ),
      h('div', { class: 'card form-card' },
        fixed ? null : h('label', { class: 'field' }, h('span', {}, '品牌'), brandSelect),
        fixed ? null : newWrap,
        h('label', { class: 'field' }, h('span', {}, '色卡上的文字是什麼語言？'), lang),
        h('p', { class: 'muted' }, '第一次讀中文或日文時，需要下載約 2–4 MB 的文字辨識資料，請稍等。'),
        h('div', { class: 'drop', id: 'imp-drop' },
          icon('upload', 'drop-icon'),
          h('p', {}, '上傳官網色卡截圖'),
          h('p', { class: 'muted' }, '可以一次選多張。系統會找出每個色塊、取顏色、讀出色號和色名，再讓你確認。'),
          button('選擇截圖', { kind: 'primary', icon: 'upload', id: 'imp-pick', onClick: () => choose() })
        )
      )
    );
    if (!fixed) syncBrand();
    const drop = el.querySelector('#imp-drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
      if (files.length) process(files);
    });
  }

  async function choose() {
    const files = await pickFiles({ multiple: true });
    if (files.length) process(files);
  }

  function brandLabel() {
    const b = state.brandId && data.brand(state.brandId);
    return b ? b.name : state.newBrand.trim();
  }

  // ---------- 第二步：分析 ----------
  async function process(files) {
    if (!state.brandId && !state.newBrand.trim()) {
      toast('請先輸入新品牌名稱', 'error');
      el.querySelector('#imp-new-brand')?.focus();
      return;
    }
    const busy = loading('準備中…');
    let ocrFailed = null;
    try {
      for (let f = 0; f < files.length; f++) {
        const tag = files.length > 1 ? `截圖 ${f + 1}/${files.length}：` : '';
        busy.set(`${tag}找色塊…`);
        await nextFrame();
        const img = await fileToImage(files[f]);
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        const imageData = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        const boxes = detectSwatches(imageData);
        let words = [];
        if (!ocrFailed) {
          busy.set(`${tag}讀色號和色名…`);
          try {
            words = await readWords(c, state.lang, (m) => {
              if (m.status === 'recognizing text') busy.set(`${tag}讀色號和色名… ${Math.round(m.progress * 100)}%`);
              else if (/load|download|initializ/i.test(m.status)) busy.set(`${tag}下載文字辨識資料…`);
            });
          } catch (e) {
            ocrFailed = e;
          }
        }
        const texts = assignText(boxes, words);
        const shotIndex = state.shots.length;
        state.shots.push({ img, imageData, words });
        boxes.forEach((box, i) => {
          state.rows.push({
            shot: shotIndex, box,
            code: texts[i].code, name: texts[i].name,
            hex: swatchColor(imageData, box),
            thumb: cropThumb(img, box),
            fav: false, owned: false,
          });
        });
      }
    } catch (e) {
      busy.close();
      toast(e.message || '分析失敗', 'error');
      return;
    }
    busy.close();
    if (ocrFailed) toast('文字辨識沒有成功，色號和色名請自己輸入。', 'error');
    state.active = 0;
    drawConfirm();
    if (!state.rows.length) toast('沒有找到色塊。可以用「框選補上色號」自己框出來。');
  }

  // ---------- 第三步：確認清單 ----------
  let previewWrap, overlay, rowsEl, banner, submitBtn;

  function existingCode(code) {
    if (!state.brandId || !code) return null;
    const c = code.trim().toLowerCase();
    return data.yarnsOf(state.brandId).find((y) => y.code.trim().toLowerCase() === c) || null;
  }

  function drawConfirm() {
    previewWrap = h('div', { class: 'shot-wrap' });
    overlay = h('div', { class: 'shot-overlay' });
    rowsEl = h('div', { class: 'imp-rows' });
    banner = h('div', { class: 'tool-banner', hidden: true });
    submitBtn = button('', { kind: 'primary', id: 'imp-submit', onClick: submit });
    const tabs = state.shots.length > 1
      ? h('div', { class: 'seg' }, state.shots.map((_, i) => h('button', { type: 'button', class: i === state.active ? 'on' : '', onclick: () => { state.active = i; drawConfirm(); } }, `截圖 ${i + 1}`)))
      : null;
    el.replaceChildren(
      h('div', { class: 'view-head' },
        h('h1', {}, `確認色號：${brandLabel()}`),
        button('重新上傳', { kind: 'ghost', onClick: () => reset({ brandId: state.brandId }) })
      ),
      h('p', { class: 'muted' }, '請逐一確認。字讀錯可以直接改；顏色不對按「滴管」再點截圖上的顏色；多出來的按垃圾桶；漏掉的用「框選補上色號」。'),
      h('div', { class: 'imp-layout' },
        h('div', { class: 'imp-shot card' },
          h('div', { class: 'toolbar' },
            tabs,
            button('框選補上色號', { icon: 'box', kind: state.tool === 'frame' ? 'on' : '', id: 'imp-frame', onClick: () => setTool(state.tool === 'frame' ? null : 'frame') })
          ),
          banner,
          previewWrap
        ),
        h('div', { class: 'imp-list' }, rowsEl)
      ),
      h('div', { class: 'sticky-foot' },
        button('取消', { kind: 'ghost', onClick: async () => { if (await confirmDialog('放棄這次新增？', '確認清單的內容不會保存。', '放棄', true)) app.go('library'); } }),
        submitBtn
      )
    );
    const shot = state.shots[state.active];
    const img = h('img', { src: shot.img.src, alt: '色卡截圖', class: 'shot-img', draggable: 'false' });
    previewWrap.append(img, overlay);
    bindOverlay(shot);
    setTool(state.tool);
    drawRows();
  }

  function setTool(t) {
    state.tool = t;
    const frameBtn = el.querySelector('#imp-frame');
    if (frameBtn) frameBtn.classList.toggle('on', t === 'frame');
    previewWrap.classList.toggle('crosshair', !!t);
    if (!t) banner.hidden = true;
    else if (t === 'frame') { banner.hidden = false; banner.textContent = '在截圖上拖曳，框出漏掉的色塊。'; }
    else if (t.eyedrop) { banner.hidden = false; banner.textContent = `點截圖上的顏色，設定第 ${state.rows.indexOf(t.eyedrop) + 1} 個的代表色。`; }
    if (t) banner.append(' ', h('button', { class: 'link', type: 'button', onclick: () => setTool(null) }, '取消'));
  }

  function drawBoxes() {
    overlay.replaceChildren();
    const shot = state.shots[state.active];
    const W = shot.imageData.width, H = shot.imageData.height;
    state.rows.forEach((r, i) => {
      if (r.shot !== state.active) return;
      overlay.append(h('button', {
        type: 'button',
        class: 'shot-box',
        title: `第 ${i + 1} 個`,
        style: { left: `${(r.box.x / W) * 100}%`, top: `${(r.box.y / H) * 100}%`, width: `${(r.box.w / W) * 100}%`, height: `${(r.box.h / H) * 100}%` },
        onclick: (e) => {
          if (state.tool) return;
          e.stopPropagation();
          const rowEl = rowsEl.children[i];
          rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          rowEl.classList.add('flash');
          setTimeout(() => rowEl.classList.remove('flash'), 900);
        },
      }, h('span', {}, i + 1)));
    });
  }

  function bindOverlay(shot) {
    const W = shot.imageData.width, H = shot.imageData.height;
    const toImg = (e) => {
      const r = overlay.getBoundingClientRect();
      return { x: Math.max(0, Math.min(W - 1, ((e.clientX - r.left) / r.width) * W)), y: Math.max(0, Math.min(H - 1, ((e.clientY - r.top) / r.height) * H)) };
    };
    let start = null, rectEl = null;
    overlay.addEventListener('pointerdown', (e) => {
      if (!state.tool) return;
      e.preventDefault();
      const p = toImg(e);
      if (state.tool.eyedrop) {
        const row = state.tool.eyedrop;
        row.hex = pickColor(shot.imageData, Math.round(p.x), Math.round(p.y));
        setTool(null);
        drawRows();
        toast('已更新代表色');
        return;
      }
      start = p;
      overlay.setPointerCapture(e.pointerId);
      rectEl = h('div', { class: 'shot-rect' });
      overlay.append(rectEl);
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!start || !rectEl) return;
      const p = toImg(e);
      Object.assign(rectEl.style, {
        left: `${(Math.min(start.x, p.x) / W) * 100}%`, top: `${(Math.min(start.y, p.y) / H) * 100}%`,
        width: `${(Math.abs(p.x - start.x) / W) * 100}%`, height: `${(Math.abs(p.y - start.y) / H) * 100}%`,
      });
    });
    overlay.addEventListener('pointerup', (e) => {
      if (!start) return;
      const p = toImg(e);
      const box = { x: Math.round(Math.min(start.x, p.x)), y: Math.round(Math.min(start.y, p.y)), w: Math.round(Math.abs(p.x - start.x)), h: Math.round(Math.abs(p.y - start.y)) };
      start = null;
      rectEl && rectEl.remove();
      rectEl = null;
      if (box.w < 6 || box.h < 6) return;
      const text = assignText([box], shot.words)[0];
      state.rows.push({ shot: state.active, box, code: text.code, name: text.name, hex: swatchColor(shot.imageData, box), thumb: cropThumb(shot.img, box), fav: false, owned: false });
      drawRows();
      rowsEl.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(`已加入第 ${state.rows.length} 個`);
    });
  }

  function drawRows() {
    rowsEl.replaceChildren();
    state.rows.forEach((r, i) => {
      const code = h('input', { class: 'input', value: r.code, placeholder: '色號', 'aria-label': `第 ${i + 1} 個色號` });
      const name = h('input', { class: 'input', value: r.name, placeholder: '色名', 'aria-label': `第 ${i + 1} 個色名` });
      const warn = h('span', { class: 'chip warn', hidden: true }, '線材庫已有，會更新');
      const syncWarn = () => (warn.hidden = !existingCode(r.code));
      code.addEventListener('input', () => { r.code = code.value; syncWarn(); });
      name.addEventListener('input', () => (r.name = name.value));
      syncWarn();
      const fav = h('button', { class: 'tile-fav static', type: 'button', 'aria-pressed': String(r.fav), title: '最愛', 'aria-label': '最愛', onclick: () => { r.fav = !r.fav; fav.setAttribute('aria-pressed', String(r.fav)); } }, icon('heart'));
      const own = h('button', { class: 'tile-own static', type: 'button', 'aria-pressed': String(r.owned), title: '我有這個線', 'aria-label': '我有這個線', onclick: () => { r.owned = !r.owned; own.setAttribute('aria-pressed', String(r.owned)); } }, icon('check'), h('span', {}, '有'));
      rowsEl.append(h('div', { class: 'imp-row' },
        h('span', { class: 'imp-num' }, i + 1),
        h('span', { class: 'imp-thumb-wrap' },
          h('img', { class: 'imp-thumb', src: r.thumb, alt: '' }),
          h('span', { class: 'imp-hex', style: { background: r.hex }, title: '換色用的代表色' })
        ),
        h('div', { class: 'imp-fields' }, code, name, warn),
        h('div', { class: 'imp-tools' },
          fav, own,
          h('button', { class: 'icon-btn', type: 'button', title: '滴管：重新取色', 'aria-label': '滴管：重新取色', onclick: () => { if (r.shot !== state.active) { state.active = r.shot; drawConfirm(); } setTool({ eyedrop: r }); previewWrap.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, icon('drop')),
          h('button', { class: 'icon-btn', type: 'button', title: '刪除這一個', 'aria-label': '刪除這一個', onclick: () => { state.rows.splice(i, 1); drawRows(); } }, icon('trash'))
        )
      ));
    });
    if (!state.rows.length) rowsEl.append(h('div', { class: 'empty' }, h('p', {}, '清單是空的。用「框選補上色號」在截圖上框出色塊。')));
    submitBtn.querySelector('span')?.remove();
    submitBtn.append(h('span', {}, `加入線材庫（${state.rows.length} 個色號）`));
    submitBtn.disabled = !state.rows.length;
    drawBoxes();
  }

  async function submit() {
    const missing = state.rows.filter((r) => !r.code.trim()).length;
    if (missing && !(await confirmDialog(`有 ${missing} 個沒有填色號`, '還是要加入線材庫嗎？', '加入'))) return;
    const rows = state.rows.map((r) => ({ ...r, replaceId: existingCode(r.code)?.id || null }));
    const busy = loading('存到 GitHub…');
    try {
      await data.addYarns({ brandId: state.brandId, brandName: state.newBrand }, rows);
      busy.close();
      toast(`已加入 ${rows.length} 個色號`);
      app.go('library');
    } catch (e) {
      busy.close();
      toast(e.message || '存檔失敗', 'error');
    }
  }

  return { el, onShow: (params) => reset(params || {}) };
}
