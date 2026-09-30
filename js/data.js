// App 的資料：線材庫、色號小圖、作品配色庫。負責讀取、排隊存檔、通知畫面更新

const LIB = 'knit/library.json';
const THUMBS = (brandId) => `knit/thumbs/${brandId}.json`;
const WORKS = 'knit/works/index.json';
const WORK = (id) => `knit/works/${id}.json`;

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function taipeiDate(ts = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date(ts));
}

async function sha1Hex(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class Data {
  constructor(store) {
    this.store = store;
    this.library = { version: 1, brands: [], yarns: [] };
    this.thumbs = {};
    this.works = [];
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.queue = Promise.resolve();
    this.pending = 0;
    this.libTimer = null;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onStatus(fn) { this.statusListeners.add(fn); return () => this.statusListeners.delete(fn); }
  emit(what) { this.listeners.forEach((fn) => fn(what)); }
  status(s, err) { this.statusListeners.forEach((fn) => fn(s, err)); }

  async load() {
    const lib = await this.store.readJSON(LIB);
    if (lib) this.library = { version: 1, brands: [], yarns: [], ...lib };
    const thumbFiles = await Promise.all(this.library.brands.map((b) => this.store.readJSON(THUMBS(b.id)).catch(() => null)));
    thumbFiles.forEach((t) => t && Object.assign(this.thumbs, t));
    this.works = (await this.store.readJSON(WORKS)) || [];
    this.emit('all');
  }

  // 所有寫入排隊依序進行，避免兩筆存檔互相打架
  enqueue(task) {
    this.pending++;
    this.status('saving');
    const run = this.queue.then(task);
    this.queue = run.then(
      () => {
        this.pending--;
        if (!this.pending) this.status('saved');
      },
      (err) => {
        this.pending--;
        this.status('error', err);
      }
    );
    return run;
  }

  // ---------- 線材庫 ----------
  brand(id) { return this.library.brands.find((b) => b.id === id); }
  yarn(id) { return this.library.yarns.find((y) => y.id === id); }
  yarnsOf(brandId) { return this.library.yarns.filter((y) => y.brandId === brandId); }
  thumbOf(yarnId) { return this.thumbs[yarnId] || null; }

  libraryFiles(brandIds = []) {
    const files = { [LIB]: JSON.stringify(this.library, null, 1) };
    for (const id of brandIds) {
      const t = {};
      for (const y of this.yarnsOf(id)) if (this.thumbs[y.id]) t[y.id] = this.thumbs[y.id];
      files[THUMBS(id)] = JSON.stringify(t);
    }
    return files;
  }

  saveLibraryNow(brandIds = [], message = '更新線材庫', extra = {}) {
    clearTimeout(this.libTimer);
    this.libTimer = null;
    const files = { ...this.libraryFiles(brandIds), ...extra };
    return this.enqueue(() => this.store.commit(files, message));
  }

  // 連續點愛心或庫存時，等停手一下再一起存
  saveLibrarySoon() {
    clearTimeout(this.libTimer);
    this.status('saving');
    this.libTimer = setTimeout(() => {
      this.libTimer = null;
      this.saveLibraryNow([], '更新最愛與庫存');
    }, 1200);
  }

  toggle(yarnId, field) {
    const y = this.yarn(yarnId);
    if (!y) return;
    y[field] = !y[field];
    this.emit('library');
    this.saveLibrarySoon();
  }

  // rows: [{code, name, hex, thumb, fav, owned, replaceId?}]
  async addYarns({ brandId, brandName }, rows) {
    let brand = brandId ? this.brand(brandId) : null;
    if (!brand) {
      brand = { id: newId(), name: brandName.trim() };
      this.library.brands.push(brand);
    }
    for (const r of rows) {
      const existing = r.replaceId ? this.yarn(r.replaceId) : null;
      const target = existing || { id: newId(), brandId: brand.id, fav: false, owned: false };
      Object.assign(target, {
        code: r.code.trim(),
        name: r.name.trim(),
        hex: r.hex,
        fav: !!(r.fav || target.fav),
        owned: !!(r.owned || target.owned),
      });
      if (!existing) this.library.yarns.push(target);
      if (r.thumb) this.thumbs[target.id] = r.thumb;
    }
    this.emit('library');
    await this.saveLibraryNow([brand.id], `新增色號：${brand.name}（${rows.length} 個）`);
    return brand;
  }

  async updateYarn(id, patch) {
    const y = this.yarn(id);
    if (!y) return;
    Object.assign(y, patch);
    this.emit('library');
    await this.saveLibraryNow([], `修改色號：${y.code}`);
  }

  async deleteYarn(id) {
    const y = this.yarn(id);
    if (!y) return;
    this.library.yarns = this.library.yarns.filter((v) => v.id !== id);
    delete this.thumbs[id];
    this.emit('library');
    await this.saveLibraryNow([y.brandId], `刪除色號：${y.code}`);
  }

  async renameBrand(id, name) {
    const b = this.brand(id);
    if (!b) return;
    b.name = name.trim();
    this.emit('library');
    await this.saveLibraryNow([], `品牌改名：${b.name}`);
  }

  async deleteBrand(id) {
    const b = this.brand(id);
    if (!b) return;
    for (const y of this.yarnsOf(id)) delete this.thumbs[y.id];
    this.library.yarns = this.library.yarns.filter((y) => y.brandId !== id);
    this.library.brands = this.library.brands.filter((v) => v.id !== id);
    this.emit('library');
    await this.saveLibraryNow([], `刪除品牌：${b.name}`, { [THUMBS(id)]: null });
  }

  // ---------- 作品配色庫 ----------
  allTags() {
    const set = new Set();
    this.works.forEach((w) => (w.tags || []).forEach((t) => set.add(t)));
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  }

  // 自動命名：分類標籤＿日期＿序號
  autoName(tags) {
    const prefix = `${(tags && tags[0]) || '未分類'}_${taipeiDate()}_`;
    let n = 1;
    const names = new Set(this.works.map((w) => w.name));
    while (names.has(prefix + String(n).padStart(2, '0'))) n++;
    return prefix + String(n).padStart(2, '0');
  }

  async loadWork(id) {
    const work = await this.store.readJSON(WORK(id));
    if (!work) throw new Error('找不到這個配色檔，可能已經被刪除。');
    const imageURL = await this.store.readBlobURL(work.image);
    if (!imageURL) throw new Error('找不到這個配色檔的圖片。');
    return { work, imageURL };
  }

  // work: 完整作品資料（不含 id 時視為新檔）
  // imagePath：已經存在 GitHub 的原圖；沒有時用 imageBase64（原圖 JPEG）上傳；thumb：縮圖 dataURL
  async saveWork(work, { imagePath: knownPath, imageBase64, thumb }) {
    const now = Date.now();
    const isNew = !work.id;
    const imagePath = knownPath || `knit/images/${await sha1Hex(imageBase64)}.jpg`;
    const imageKnown = !!knownPath || this.works.some((w) => w.image === imagePath);
    const saved = {
      ...work,
      id: work.id || newId(),
      createdAt: work.createdAt || now,
      updatedAt: now,
      image: imagePath,
    };
    const entry = { id: saved.id, name: saved.name, tags: saved.tags || [], createdAt: saved.createdAt, updatedAt: now, image: imagePath, thumb };
    const nextWorks = isNew ? [entry, ...this.works] : this.works.map((w) => (w.id === saved.id ? entry : w));
    const files = {
      [WORK(saved.id)]: JSON.stringify(saved),
      [WORKS]: JSON.stringify(nextWorks),
    };
    if (!imageKnown) files[imagePath] = { base64: imageBase64 };
    await this.enqueue(() => this.store.commit(files, `${isNew ? '新增' : '更新'}配色：${saved.name}`));
    this.works = nextWorks;
    this.emit('works');
    return saved;
  }

  async renameWork(id, name) {
    const entry = this.works.find((w) => w.id === id);
    if (!entry) return;
    const work = await this.store.readJSON(WORK(id));
    entry.name = name.trim();
    const files = { [WORKS]: JSON.stringify(this.works) };
    if (work) files[WORK(id)] = JSON.stringify({ ...work, name: entry.name });
    this.emit('works');
    await this.enqueue(() => this.store.commit(files, `配色改名：${entry.name}`));
  }

  async deleteWork(id) {
    const entry = this.works.find((w) => w.id === id);
    if (!entry) return;
    this.works = this.works.filter((w) => w.id !== id);
    const files = { [WORKS]: JSON.stringify(this.works), [WORK(id)]: null };
    // 沒有其他配色用到這張圖，就一起刪掉
    if (!this.works.some((w) => w.image === entry.image)) files[entry.image] = null;
    this.emit('works');
    await this.enqueue(() => this.store.commit(files, `刪除配色：${entry.name}`));
  }
}
