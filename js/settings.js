// 設定：連接存放資料的 GitHub 私人 repo。金鑰只存在這台裝置的瀏覽器裡
import { h, button, toast, confirmDialog } from './ui.js';
import { GitHubStore } from './github.js';

// 每次發布新版都要改，方便確認手機、電腦上用的是不是最新版
export const APP_VERSION = '2026-10-03 第 14 版';

const KEY = 'knit-github';

export function readSettings() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return v && v.owner && v.repo && v.token ? v : null;
  } catch {
    return null;
  }
}

function writeSettings(v) {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    toast('這個瀏覽器不能儲存設定（可能是無痕模式）', 'error');
  }
}

export function createSettingsView(app) {
  const el = h('section', { class: 'view narrow', id: 'view-settings' });

  function draw() {
    const cur = readSettings() || { owner: '', repo: 'knit-palette-data', token: '' };
    const owner = h('input', { class: 'input', id: 'set-owner', value: cur.owner, placeholder: '你的 GitHub 帳號名稱', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false' });
    const repo = h('input', { class: 'input', id: 'set-repo', value: cur.repo, placeholder: 'knit-palette-data', autocapitalize: 'off', spellcheck: 'false' });
    const token = h('input', { class: 'input', id: 'set-token', type: 'password', value: cur.token, placeholder: 'github_pat_ 開頭的一長串', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const show = h('input', { type: 'checkbox', id: 'set-show' });
    show.addEventListener('change', () => (token.type = show.checked ? 'text' : 'password'));
    const status = h('p', { class: 'muted', role: 'status' });

    async function connect() {
      const v = { owner: owner.value.trim(), repo: repo.value.trim(), token: token.value.trim() };
      if (!v.owner || !v.repo || !v.token) {
        status.textContent = '三個欄位都要填。';
        return;
      }
      status.textContent = '連線中…';
      try {
        await new GitHubStore(v).connect();
        writeSettings(v);
        status.textContent = '連線成功。';
        toast('已連上 GitHub');
        history.replaceState(null, '', '#work');
        app.restart();
      } catch (e) {
        status.textContent = e.message;
      }
    }

    async function logout() {
      if (!(await confirmDialog('在這台裝置登出？', '會清除這台裝置上的金鑰。GitHub 上的資料不受影響，之後貼上金鑰就能再用。', '登出', true))) return;
      writeSettings(null);
      app.restart();
    }

    el.replaceChildren(
      h('div', { class: 'view-head' }, h('h1', {}, '設定')),
      h('div', { class: 'card form-card' },
        h('h2', {}, '資料存放位置'),
        h('p', {}, '線材庫和作品配色會存在你自己的 GitHub 私人 repo。每台裝置第一次使用時，要在這裡貼一次存取金鑰。'),
        h('label', { class: 'field' }, h('span', {}, 'GitHub 帳號'), owner),
        h('label', { class: 'field' }, h('span', {}, 'repo 名稱'), repo),
        h('label', { class: 'field' }, h('span', {}, '存取金鑰'), token),
        h('label', { class: 'check' }, show, h('span', {}, '顯示金鑰')),
        h('div', { class: 'row-actions' },
          button('連線並儲存', { kind: 'primary', onClick: connect, id: 'set-connect' }),
          readSettings() ? button('在這台裝置登出', { kind: 'ghost', onClick: logout }) : null
        ),
        status
      ),
      h('details', { class: 'card help', open: !readSettings() },
        h('summary', {}, '第一次設定：怎麼建立 repo 和存取金鑰'),
        h('ol', {},
          h('li', {}, '在 GitHub 建立一個「Private（私人）」repo，名稱例如 ', h('code', {}, 'knit-palette-data'), '。'),
          h('li', {}, '打開 ', h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'GitHub 建立金鑰頁面'), '（Fine-grained token）。'),
          h('li', {}, 'Token name 隨意取，例如「編織配色」。Expiration 選最長的時間，到期後要重新建立一把。'),
          h('li', {}, 'Repository access 選「Only select repositories」，只勾剛剛建立的 repo。'),
          h('li', {}, 'Permissions 裡找到「Contents」，改成「Read and write」。'),
          h('li', {}, '按「Generate token」，複製 github_pat_ 開頭的金鑰，貼到上面的欄位。')
        ),
        h('p', { class: 'muted' }, '金鑰只存在這台裝置的瀏覽器裡，不會傳到其他地方。這把金鑰只能動這一個 repo，就算外流也碰不到你的其他資料。')
      ),
      h('p', { class: 'muted small', id: 'app-version' }, `App 版本：${APP_VERSION}。如果跟最新版不同，請關掉分頁重新打開，或按住重新整理鍵強制更新。`)
    );
  }

  draw();
  return { el, onShow: draw };
}
