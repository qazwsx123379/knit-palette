// 作品配色庫：縮圖牆，可以直接點開，也可以搜尋、依分類標籤篩選
import { h, icon, button, modal, confirmDialog, promptDialog, toast, formatDate } from './ui.js';

export function createGalleryView(app) {
  const { data } = app;
  let query = '';
  let tag = null;
  const grid = h('div', { class: 'work-grid' });
  const tagsEl = h('div', { class: 'tag-chips' });
  const search = h('input', { type: 'search', class: 'input search', placeholder: '搜尋作品名稱或標籤', id: 'gal-search', 'aria-label': '搜尋作品名稱或標籤' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); draw(); });

  async function menu(w) {
    const v = await modal({
      title: w.name,
      actions: [
        { label: '刪除', value: 'delete', kind: 'danger' },
        { label: '改名稱', value: 'rename' },
        { label: '關閉', value: null, kind: 'ghost' },
      ],
    });
    if (v === 'rename') {
      const name = await promptDialog('配色改名稱', '名稱', w.name, '儲存');
      if (name) data.renameWork(w.id, name).then(() => toast('已改名')).catch((e) => toast(e.message, 'error'));
    } else if (v === 'delete') {
      if (await confirmDialog(`刪除「${w.name}」？`, '刪除後會從作品庫移除。GitHub 上仍保留歷史紀錄，需要時可以救回。', '刪除', true)) {
        data.deleteWork(w.id).then(() => toast('已刪除')).catch((e) => toast(e.message, 'error'));
      }
    }
  }

  function draw() {
    const all = data.allTags();
    if (tag && !all.includes(tag)) tag = null;
    tagsEl.replaceChildren(
      h('button', { type: 'button', class: `tag ${tag === null ? 'on' : ''}`, 'aria-pressed': String(tag === null), onclick: () => { tag = null; draw(); } }, '全部'),
      ...all.map((t) => h('button', { type: 'button', class: `tag ${tag === t ? 'on' : ''}`, 'aria-pressed': String(tag === t), onclick: () => { tag = tag === t ? null : t; draw(); } }, t))
    );
    tagsEl.hidden = !all.length;
    const list = data.works.filter((w) => {
      if (tag && !(w.tags || []).includes(tag)) return false;
      if (!query) return true;
      return `${w.name} ${(w.tags || []).join(' ')}`.toLowerCase().includes(query);
    });
    grid.replaceChildren(...list.map((w) =>
      h('article', { class: 'work-card' },
        h('button', { type: 'button', class: 'work-open', onclick: () => app.openWork(w.id), 'aria-label': `打開 ${w.name}` },
          w.thumb ? h('img', { src: w.thumb, alt: '', loading: 'lazy' }) : h('span', { class: 'work-noimg' }),
          h('span', { class: 'work-meta' },
            h('strong', {}, w.name),
            h('span', { class: 'muted' }, formatDate(w.updatedAt || w.createdAt)),
            (w.tags || []).length ? h('span', { class: 'work-tags' }, (w.tags || []).map((t) => h('span', { class: 'tag small' }, t))) : null
          )
        ),
        h('button', { type: 'button', class: 'icon-btn work-more', title: '改名稱或刪除', 'aria-label': `${w.name} 的其他動作`, onclick: () => menu(w) }, icon('more'))
      )
    ));
    if (!data.works.length) {
      grid.append(h('div', { class: 'empty' },
        icon('book', 'empty-icon'),
        h('p', {}, '還沒有存過的配色。'),
        h('p', { class: 'muted' }, '在「配色」上傳作品、選好顏色後按「存檔」，就會出現在這裡。'),
        button('去配色', { kind: 'primary', onClick: () => app.go('work') })
      ));
    } else if (!list.length) {
      grid.append(h('div', { class: 'empty' }, h('p', {}, '找不到符合的配色。')));
    }
  }

  const el = h('section', { class: 'view', id: 'view-gallery' },
    h('div', { class: 'view-head' }, h('h1', {}, '作品配色庫')),
    h('div', { class: 'toolbar' }, search),
    tagsEl,
    grid
  );
  data.on((what) => { if (what === 'all' || what === 'works') draw(); });
  draw();
  return { el, onShow: draw };
}
