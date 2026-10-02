// App 入口：連線、切換畫面、存檔狀態
import { h, icon, toast, confirmDialog, loading } from './ui.js';
import { GitHubStore, MemoryStore } from './github.js';
import { Data } from './data.js';
import { createWorkspace } from './workspace.js';
import { createLibraryView } from './library.js';
import { createImportView } from './importer.js';
import { createGalleryView } from './gallery.js';
import { createSettingsView, readSettings, APP_VERSION } from './settings.js';
import { seedDemo } from './demo.js';

const root = document.getElementById('app');
const NAV = [
  { id: 'work', label: '配色', icon: 'palette' },
  { id: 'library', label: '線材庫', icon: 'yarn' },
  { id: 'gallery', label: '作品庫', icon: 'book' },
];

const app = {
  data: null,
  views: {},
  current: null,
  go,
  restart,
  openWork: async (id) => {
    if (await app.views.work.openWork(id)) go('work');
  },
  confirmDiscard: async () => {
    if (!app.views.work || !app.views.work.isDirty()) return true;
    return confirmDialog('目前的配色還沒存檔', '要放棄這些修改嗎？', '放棄修改', true);
  },
};

let main, statusEl, navEls = [];

function shell() {
  statusEl = h('span', { class: 'save-status', role: 'status', 'aria-live': 'polite' });
  const nav = h('nav', { class: 'nav', 'aria-label': '主要頁面' },
    NAV.map((n) => {
      const b = h('a', { href: `#${n.id}`, class: 'nav-item', 'data-route': n.id }, icon(n.icon), h('span', {}, n.label));
      navEls.push(b);
      return b;
    })
  );
  main = h('main', { class: 'main' });
  root.replaceChildren(
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#work', title: `版本：${APP_VERSION}` }, icon('yarn'), h('span', {}, '編織配色')),
      nav,
      statusEl,
      h('a', { class: 'icon-btn', href: '#settings', title: '設定', 'aria-label': '設定', 'data-route': 'settings' }, icon('gear'))
    ),
    main
  );
}

function go(route, params) {
  const view = app.views[route] || app.views.work || app.views.settings;
  const name = app.views[route] ? route : app.views.work ? 'work' : 'settings';
  app.current = name;
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  main.replaceChildren(view.el);
  navEls.forEach((a) => a.classList.toggle('on', a.dataset.route === name || (name === 'import' && a.dataset.route === 'library')));
  if (view.onShow) view.onShow(params);
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => {
  const r = location.hash.slice(1);
  if (r && r !== app.current) go(r);
});

window.addEventListener('beforeunload', (e) => {
  const dirty = (app.views.work && app.views.work.isDirty()) || (app.data && app.data.pending > 0) || (app.data && app.data.libTimer);
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function setStatus(s, err) {
  if (s === 'saving') { statusEl.textContent = '儲存中…'; statusEl.className = 'save-status saving'; }
  else if (s === 'saved') { statusEl.textContent = '已儲存'; statusEl.className = 'save-status saved'; setTimeout(() => { if (statusEl.textContent === '已儲存') statusEl.textContent = ''; }, 2500); }
  else if (s === 'error') { statusEl.textContent = '存檔失敗'; statusEl.className = 'save-status error'; toast(err && err.message ? err.message : '存檔失敗', 'error'); }
}

async function restart() {
  app.views = {};
  app.data = null;
  navEls = [];
  shell();
  app.views.settings = createSettingsView(app);
  const demo = new URLSearchParams(location.search).has('demo');
  const settings = readSettings();
  if (!demo && !settings) {
    root.classList.add('setup');
    go('settings');
    return;
  }
  root.classList.remove('setup');
  const busy = loading('讀取你的線材庫和作品…');
  try {
    const store = demo ? new MemoryStore() : new GitHubStore(settings);
    await store.connect();
    if (demo) await seedDemo(store);
    const data = new Data(store);
    await data.load();
    app.data = data;
    data.onStatus(setStatus);
    app.views.work = createWorkspace(app);
    app.views.library = createLibraryView(app);
    app.views.import = createImportView(app);
    app.views.gallery = createGalleryView(app);
    busy.close();
    if (demo) toast('示範模式：資料不會保存');
    go(location.hash.slice(1) || 'work');
  } catch (e) {
    busy.close();
    toast(e.message || '連線失敗', 'error');
    go('settings');
  }
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

restart();
