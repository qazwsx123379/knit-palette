// 線材庫：依品牌分區的色塊牆、最愛與庫存、編輯色號、配色時挑線
import { h, icon, button, sheet, modal, confirmDialog, promptDialog, toast } from './ui.js';
import { recommend } from './color.js';

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'fav', label: '最愛' },
  { id: 'owned', label: '我的庫存' },
];

function loadPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function savePref(key, v) {
  try { localStorage.setItem(key, v); } catch { /* 無痕模式等情況存不了，不影響使用 */ }
}

function matches(y, brand, filter, q) {
  if (filter === 'fav' && !y.fav) return false;
  if (filter === 'owned' && !y.owned) return false;
  if (!q) return true;
  const s = `${brand ? brand.name : ''} ${y.code} ${y.name}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((t) => s.includes(t));
}

export function swatchVisual(data, y, cls = 'tile-img') {
  const t = data.thumbOf(y.id);
  return t
    ? h('img', { class: cls, src: t, alt: '', loading: 'lazy' })
    : h('span', { class: cls, style: { background: y.hex } });
}

// 單一色號方塊：點方塊本體、愛心、有這個線
export function yarnTile(data, y, { onMain, showBrand = false, badge } = {}) {
  const brand = data.brand(y.brandId);
  const fav = h('button', { class: 'tile-fav', type: 'button', 'aria-pressed': String(!!y.fav), title: y.fav ? '取消最愛' : '加入最愛', 'aria-label': `${y.code} 最愛` }, icon('heart'));
  const own = h('button', { class: 'tile-own', type: 'button', 'aria-pressed': String(!!y.owned), title: y.owned ? '從我的庫存移除' : '我有這個線', 'aria-label': `${y.code} 我有這個線` }, icon('check'), h('span', {}, '有'));
  fav.addEventListener('click', (e) => {
    e.stopPropagation();
    data.toggle(y.id, 'fav');
    fav.setAttribute('aria-pressed', String(!!y.fav));
  });
  own.addEventListener('click', (e) => {
    e.stopPropagation();
    data.toggle(y.id, 'owned');
    own.setAttribute('aria-pressed', String(!!y.owned));
  });
  return h('div', { class: 'tile', 'data-yarn': y.id },
    h('button', { class: 'tile-main', type: 'button', onclick: () => onMain && onMain(y) },
      swatchVisual(data, y),
      badge ? h('span', { class: 'tile-badge' }, badge) : null,
      h('span', { class: 'tile-code' }, y.code || '（無色號）'),
      h('span', { class: 'tile-name' }, showBrand && brand ? `${brand.name}${y.name ? ' · ' + y.name : ''}` : y.name || '')
    ),
    fav,
    own
  );
}

function filterBar(current, onChange) {
  const bar = h('div', { class: 'seg', role: 'group', 'aria-label': '篩選' });
  for (const f of FILTERS) {
    bar.append(h('button', {
      type: 'button',
      class: f.id === current ? 'on' : '',
      'aria-pressed': String(f.id === current),
      onclick: () => onChange(f.id),
    }, f.label));
  }
  return bar;
}

// 色塊牆：一個品牌一區
function renderWall(container, data, { filter, query, onTile, brandActions }) {
  container.innerHTML = '';
  let shown = 0;
  for (const brand of data.library.brands) {
    const yarns = data.yarnsOf(brand.id).filter((y) => matches(y, brand, filter, query));
    if (!yarns.length && (filter !== 'all' || query)) continue;
    shown += yarns.length;
    const head = h('div', { class: 'brand-head' },
      h('h3', {}, brand.name),
      h('span', { class: 'count' }, `${yarns.length} 色`),
      brandActions ? brandActions(brand) : null
    );
    const grid = h('div', { class: 'tile-grid' }, yarns.map((y) => yarnTile(data, y, { onMain: onTile })));
    if (!yarns.length) grid.append(h('p', { class: 'muted' }, '這個品牌還沒有色號。'));
    container.append(h('section', { class: 'brand-section', 'data-brand': brand.id }, head, grid));
  }
  if (!data.library.brands.length) {
    container.append(h('div', { class: 'empty' },
      icon('yarn', 'empty-icon'),
      h('p', {}, '線材庫還沒有資料。'),
      h('p', { class: 'muted' }, '按右上角「新增品牌」，上傳品牌的色卡截圖。')
    ));
  } else if (!shown) {
    const msg = filter === 'fav' ? '還沒有標記最愛的線。點色號上的愛心就會加入。'
      : filter === 'owned' ? '還沒有標記庫存。點色號上的「有」就會加入。'
      : '找不到符合的色號。';
    container.append(h('div', { class: 'empty' }, h('p', {}, msg)));
  }
}

export function createLibraryView(app) {
  const { data } = app;
  let filter = loadPref('lib-filter', 'all');
  let query = '';
  const wall = h('div', { class: 'wall' });
  const filterSlot = h('div');
  const search = h('input', { type: 'search', class: 'input search', placeholder: '搜尋色號或色名', id: 'lib-search', 'aria-label': '搜尋色號或色名' });
  search.addEventListener('input', () => { query = search.value.trim(); draw(); });

  const brandActions = (brand) => h('div', { class: 'brand-actions' },
    button('加色號', { icon: 'plus', kind: 'small', onClick: () => app.go('import', { brandId: brand.id }) }),
    button('', { icon: 'more', kind: 'small icon-only', title: `${brand.name} 的其他動作`, onClick: () => brandMenu(brand) })
  );

  async function brandMenu(brand) {
    const v = await modal({
      title: brand.name,
      actions: [
        { label: '刪除品牌', value: 'delete', kind: 'danger' },
        { label: '改名稱', value: 'rename', kind: '' },
        { label: '關閉', value: null, kind: 'ghost' },
      ],
    });
    if (v === 'rename') {
      const name = await promptDialog('品牌改名稱', '品牌名稱', brand.name, '儲存');
      if (name) data.renameBrand(brand.id, name).catch((e) => toast(e.message, 'error'));
    } else if (v === 'delete') {
      const n = data.yarnsOf(brand.id).length;
      if (await confirmDialog(`刪除「${brand.name}」？`, `這個品牌的 ${n} 個色號都會刪除。已經存檔的作品配色不受影響。`, '刪除', true)) {
        data.deleteBrand(brand.id).then(() => toast('已刪除品牌')).catch((e) => toast(e.message, 'error'));
      }
    }
  }

  function draw() {
    filterSlot.replaceChildren(filterBar(filter, (f) => { filter = f; savePref('lib-filter', f); draw(); }));
    renderWall(wall, data, { filter, query, onTile: (y) => editYarn(data, y), brandActions });
  }

  const el = h('section', { class: 'view', id: 'view-library' },
    h('div', { class: 'view-head' },
      h('h1', {}, '線材庫'),
      button('新增品牌', { icon: 'plus', kind: 'primary', onClick: () => app.go('import', {}) })
    ),
    h('div', { class: 'toolbar' }, filterSlot, search),
    wall
  );
  data.on((what) => { if (what === 'all' || what === 'library') draw(); });
  draw();
  return { el, onShow: draw };
}

// 編輯單一色號
export async function editYarn(data, y) {
  const brand = data.brand(y.brandId);
  const code = h('input', { class: 'input', value: y.code, id: 'edit-code' });
  const name = h('input', { class: 'input', value: y.name || '', id: 'edit-name' });
  const hex = h('input', { type: 'color', class: 'color-input', value: y.hex || '#888888', id: 'edit-hex' });
  const body = h('div', { class: 'edit-yarn' },
    swatchVisual(data, y, 'edit-thumb'),
    h('div', { class: 'edit-fields' },
      h('p', { class: 'muted' }, brand ? brand.name : ''),
      h('label', { class: 'field' }, h('span', {}, '色號'), code),
      h('label', { class: 'field' }, h('span', {}, '色名'), name),
      h('label', { class: 'field inline' }, hex, h('span', {}, '換色用的代表色（系統換色和推薦時使用）'))
    )
  );
  const v = await modal({
    title: '編輯色號',
    body,
    actions: [
      { label: '刪除', value: 'delete', kind: 'danger' },
      { label: '取消', value: null, kind: 'ghost' },
      { label: '儲存', value: 'save', kind: 'primary' },
    ],
  });
  if (v === 'save') {
    data.updateYarn(y.id, { code: code.value.trim(), name: name.value.trim(), hex: hex.value })
      .then(() => toast('已儲存'))
      .catch((e) => toast(e.message, 'error'));
  } else if (v === 'delete') {
    if (await confirmDialog(`刪除 ${y.code}？`, '已經存檔的作品配色不受影響。', '刪除', true)) {
      data.deleteYarn(y.id).then(() => toast('已刪除')).catch((e) => toast(e.message, 'error'));
    }
  }
}

// 配色時挑線：推薦＋色塊牆
export function openPicker(app, { title, baseHex, currentId, onPick }) {
  const { data } = app;
  let filter = loadPref('pick-filter', 'all');
  let query = '';
  const recSlot = h('div', { class: 'rec' });
  const wall = h('div', { class: 'wall' });
  const filterSlot = h('div');
  const search = h('input', { type: 'search', class: 'input search', placeholder: '搜尋色號或色名', id: 'pick-search', 'aria-label': '搜尋色號或色名' });
  let ui;
  const pick = (y) => { onPick(y); ui.close(); };
  search.addEventListener('input', () => { query = search.value.trim(); draw(); });

  function recRow(label, list) {
    if (!list.length) return null;
    return h('div', { class: 'rec-row' },
      h('h4', {}, label),
      h('div', { class: 'tile-row' }, list.map((y) => yarnTile(data, y, { onMain: pick, showBrand: true, badge: y.owned ? '已有' : null })))
    );
  }

  function draw() {
    filterSlot.replaceChildren(filterBar(filter, (f) => { filter = f; savePref('pick-filter', f); draw(); }));
    const pool = data.library.yarns.filter((y) => matches(y, data.brand(y.brandId), filter, ''));
    const { similar, complement } = recommend(baseHex, pool, { excludeId: currentId });
    recSlot.replaceChildren(
      ...(similar.length || complement.length
        ? [h('h3', { class: 'rec-title' }, '推薦'), recRow('相近色', similar), recRow('互補色', complement)].filter(Boolean)
        : [])
    );
    renderWall(wall, data, { filter, query, onTile: pick });
    wall.querySelectorAll(`[data-yarn="${currentId}"]`).forEach((t) => t.classList.add('current'));
  }

  const off = data.on((what) => { if (what === 'library') draw(); });
  ui = sheet({
    title,
    content: h('div', {}, h('div', { class: 'toolbar' }, filterSlot, search), recSlot, wall),
    onClose: off,
  });
  draw();
  return ui;
}
