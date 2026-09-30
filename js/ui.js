// 共用的畫面元件：建立元素、提示訊息、對話框、側邊面板、圖示

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  upload: '<path d="M12 16V4m0 0l-5 5m5-5l5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/>',
  save: '<path d="M5 4h11l3 3v12a1 1 0 01-1 1H6a1 1 0 01-1-1V4z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  saveAs: '<path d="M5 4h9l3 3v5M5 4v15a1 1 0 001 1h6"/><path d="M8 4v5h6V4"/><path d="M18 15v6m-3-3h6"/>',
  share: '<path d="M12 3v12m0-12l-4 4m4-4l4 4M5 12v7a1 1 0 001 1h12a1 1 0 001-1v-7"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7L19 16z"/>',
  wand: '<path d="M4 20L15 9"/><path d="M15 4v2M19 8h2M18 5l1.5-1.5M13 7l4 4"/>',
  brush: '<path d="M14.5 4.5l5 5-8 8H7v-4.5l7.5-8.5z"/><path d="M4 20c2 0 3-1 3-2.5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  merge: '<path d="M7 4v5a5 5 0 005 5 5 5 0 015 5v1M17 4v5a5 5 0 01-5 5"/>',
  split: '<path d="M12 20v-7M12 13L6 5m6 8l6-8M4 5h4m8 0h4"/>',
  trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a1 1 0 001 1h8a1 1 0 001-1l1-12M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  drop: '<path d="M14 4l6 6-2 2-6-6 2-2z"/><path d="M13 7l-8 8v4h4l8-8"/>',
  box: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4.2 4.2l2.1 2.1m11.4 11.4l2.1 2.1M2 12h3m14 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  palette: '<path d="M12 3a9 9 0 100 18c1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5s.8-1.5 2-1.5H17a4 4 0 004-4c0-4.7-4-8.5-9-8.5z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  yarn: '<circle cx="12" cy="12" r="8"/><path d="M5 9c4 0 9 2 12 8M7 5.5c3 1 7 5 8 11M9 20c0-5 3-11 10-12"/>',
  book: '<path d="M4 5a1 1 0 011-1h5a2 2 0 012 2v14a2 2 0 00-2-2H4V5zM20 5a1 1 0 00-1-1h-5a2 2 0 00-2 2v14a2 2 0 012-2h6V5z"/>',
};

export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', `icon ${cls}`);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}

export function button(label, { icon: ic, kind = '', onClick, title, disabled, id } = {}) {
  return h('button', { class: `btn ${kind}`, type: 'button', onclick: onClick, title, disabled, id }, ic ? icon(ic) : null, label ? h('span', {}, label) : null);
}

let toastTimer;
export function toast(msg, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), kind === 'error' ? 5000 : 2600);
}

// 對話框：回傳按下的按鈕 value；點背景或按 Esc 回傳 null
export function modal({ title, body, actions = [], wide = false, dismissible = true }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const close = (v) => {
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) close(null);
    };
    const actionEls = actions.map((a) =>
      h('button', {
        class: `btn ${a.kind || ''}`,
        type: 'button',
        onclick: async () => {
          if (a.validate && !(await a.validate())) return;
          close(a.value);
        },
      }, a.label)
    );
    const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', { class: 'modal-title' }, title),
      body ? h('div', { class: 'modal-body' }, body) : null,
      actionEls.length ? h('div', { class: 'modal-actions' }, actionEls) : null
    );
    const wrap = h('div', { class: 'modal-wrap', onclick: (e) => { if (e.target === wrap && dismissible) close(null); } }, box);
    document.body.append(wrap);
    document.addEventListener('keydown', onKey);
    const focusable = box.querySelector('input, select, textarea') || actionEls[actionEls.length - 1];
    if (focusable) setTimeout(() => focusable.focus(), 30);
    box.closeWith = close;
  });
}

export async function confirmDialog(title, text, okLabel = '確定', danger = false) {
  const v = await modal({
    title,
    body: text ? h('p', {}, text) : null,
    actions: [
      { label: '取消', value: false, kind: 'ghost' },
      { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return v === true;
}

export async function promptDialog(title, label, value = '', okLabel = '確定') {
  const input = h('input', { type: 'text', class: 'input', value, id: 'prompt-input', 'aria-label': label });
  const body = h('label', { class: 'field' }, h('span', {}, label), input);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') body.closest('.modal').querySelector('.modal-actions .primary').click();
  });
  const v = await modal({
    title,
    body,
    actions: [
      { label: '取消', value: null, kind: 'ghost' },
      { label: okLabel, value: 'ok', kind: 'primary', validate: () => input.value.trim().length > 0 },
    ],
  });
  return v === 'ok' ? input.value.trim() : null;
}

// 從右邊或下方滑出的面板（手機上是全螢幕）
export function sheet({ title, content, headerExtra, onClose }) {
  const close = () => {
    document.removeEventListener('keydown', onKey);
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 180);
    onClose && onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' },
      h('h2', {}, title),
      headerExtra || null,
      h('button', { class: 'icon-btn', type: 'button', title: '關閉', 'aria-label': '關閉', onclick: close }, icon('close'))
    ),
    h('div', { class: 'sheet-body' }, content)
  );
  const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) close(); } }, panel);
  document.body.append(wrap);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => wrap.classList.add('open'));
  return { close, panel, body: panel.querySelector('.sheet-body') };
}

export function loading(text) {
  const el = h('div', { class: 'loading-wrap' }, h('div', { class: 'loading-box' }, h('div', { class: 'spinner' }), h('p', { class: 'loading-text' }, text)));
  document.body.append(el);
  return {
    set: (t) => (el.querySelector('.loading-text').textContent = t),
    close: () => el.remove(),
  };
}

export function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('這個檔案沒辦法當成圖片打開，請換 JPG 或 PNG。'));
    img.src = url;
  });
}

export function urlToImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('圖片載入失敗。'));
    img.src = url;
  });
}

export function pickFiles({ multiple = false, accept = 'image/*' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve([...input.files]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

// 讓畫面有機會先更新（顯示「處理中」）再做重的計算
export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

export function formatDate(ts) {
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(ts));
}
