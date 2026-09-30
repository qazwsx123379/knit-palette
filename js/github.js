// 資料存在你的 GitHub 私人 repo。每次存檔是一筆 commit，改壞了可以從 GitHub 救回舊版本

const API = 'https://api.github.com';

export class StoreError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class GitHubStore {
  constructor({ owner, repo, token }) {
    this.owner = owner.trim();
    this.repo = repo.trim();
    this.token = token.trim();
    this.branch = null;
  }

  async req(method, path, body, accept = 'application/vnd.github+json') {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new StoreError('連不上 GitHub，請確認網路連線。', 0);
    }
    if (res.status === 401) throw new StoreError('存取金鑰無效或已過期，請到「設定」重新貼上。', 401);
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new StoreError('GitHub 暫時限制存取次數，請過幾分鐘再試。', 403);
    }
    return res;
  }

  repoPath(p = '') {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${p}`;
  }

  // 連線並確認權限
  async connect() {
    const res = await this.req('GET', this.repoPath());
    if (res.status === 404) throw new StoreError('找不到這個 repo。請確認帳號、repo 名稱，以及金鑰有開這個 repo 的權限。', 404);
    if (!res.ok) throw new StoreError(`GitHub 回應錯誤（${res.status}）。`, res.status);
    const info = await res.json();
    this.branch = info.default_branch || 'main';
    if (info.permissions && !info.permissions.push) {
      throw new StoreError('這把金鑰只能讀、不能寫。請把「Contents」權限設成 Read and write。', 403);
    }
    // 空的 repo 沒有分支，先建立一個說明檔
    const ref = await this.req('GET', this.repoPath(`/git/ref/heads/${this.branch}`));
    if (ref.status === 404 || ref.status === 409) {
      const put = await this.req('PUT', this.repoPath('/contents/README.md'), {
        message: '建立編織配色資料庫',
        content: utf8ToBase64('# 編織配色資料\n\n這個 repo 由「編織配色」App 自動管理，請不要手動修改 knit 資料夾。\n'),
      });
      if (!put.ok) throw new StoreError('無法初始化 repo，請確認金鑰有寫入權限。', put.status);
    }
    return info;
  }

  async readRaw(path) {
    const res = await this.req(
      'GET',
      this.repoPath(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`),
      null,
      'application/vnd.github.raw+json'
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new StoreError(`讀取 ${path} 失敗（${res.status}）。`, res.status);
    return res;
  }

  async readJSON(path) {
    const res = await this.readRaw(path);
    return res ? res.json() : null;
  }

  async readBlobURL(path) {
    const res = await this.readRaw(path);
    if (!res) return null;
    return URL.createObjectURL(await res.blob());
  }

  // 一次寫入多個檔案（一筆 commit）。files: { 路徑: 文字 | {base64} | null(刪除) }
  async commit(files, message) {
    const entries = [];
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        entries.push({ path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const body = typeof content === 'string'
        ? { content: content, encoding: 'utf-8' }
        : { content: content.base64, encoding: 'base64' };
      const res = await this.req('POST', this.repoPath('/git/blobs'), body);
      if (!res.ok) throw new StoreError('上傳資料失敗，請再試一次。', res.status);
      entries.push({ path, mode: '100644', type: 'blob', sha: (await res.json()).sha });
    }
    // 另一台裝置剛好也在存檔時，最多重試三次
    for (let attempt = 0; attempt < 3; attempt++) {
      const refRes = await this.req('GET', this.repoPath(`/git/ref/heads/${this.branch}`));
      if (!refRes.ok) throw new StoreError('讀取分支失敗。', refRes.status);
      const headSha = (await refRes.json()).object.sha;
      const commitRes = await this.req('GET', this.repoPath(`/git/commits/${headSha}`));
      const baseTree = (await commitRes.json()).tree.sha;
      // 刪除不存在的檔案會失敗，先過濾掉
      let tree = entries;
      if (entries.some((e) => e.sha === null)) {
        tree = [];
        for (const e of entries) {
          if (e.sha !== null) { tree.push(e); continue; }
          const exists = await this.req('GET', this.repoPath(`/contents/${e.path}?ref=${headSha}`));
          if (exists.ok) tree.push(e);
        }
      }
      const treeRes = await this.req('POST', this.repoPath('/git/trees'), { base_tree: baseTree, tree });
      if (!treeRes.ok) throw new StoreError('存檔失敗（建立檔案清單時出錯）。', treeRes.status);
      const newTree = (await treeRes.json()).sha;
      const cRes = await this.req('POST', this.repoPath('/git/commits'), { message, tree: newTree, parents: [headSha] });
      if (!cRes.ok) throw new StoreError('存檔失敗（建立 commit 時出錯）。', cRes.status);
      const newCommit = (await cRes.json()).sha;
      const upd = await this.req('PATCH', this.repoPath(`/git/refs/heads/${this.branch}`), { sha: newCommit, force: false });
      if (upd.ok) return newCommit;
      if (upd.status !== 422 && upd.status !== 409) throw new StoreError('存檔失敗（更新分支時出錯）。', upd.status);
    }
    throw new StoreError('存檔衝突，請重新整理頁面後再試。', 409);
  }
}

// 測試與示範用：資料只存在這個分頁，重新整理就消失
export class MemoryStore {
  constructor() {
    this.files = new Map();
    this.owner = 'demo';
    this.repo = 'demo';
  }
  async connect() {}
  async readJSON(path) {
    const v = this.files.get(path);
    return v == null ? null : JSON.parse(v);
  }
  async readBlobURL(path) {
    const v = this.files.get(path);
    if (v == null) return null;
    return `data:image/jpeg;base64,${v}`;
  }
  async commit(files) {
    for (const [p, c] of Object.entries(files)) {
      if (c === null) this.files.delete(p);
      else this.files.set(p, typeof c === 'string' ? c : c.base64);
    }
    await new Promise((r) => setTimeout(r, 120));
    return 'demo';
  }
}
