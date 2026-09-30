// 文字辨識（OCR）：用 Tesseract.js 讀出色卡上的色號和色名
// 第一次使用會從網路下載辨識引擎和語言資料，之後瀏覽器會記住

const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

export const OCR_LANGS = [
  { id: 'eng', label: '英文和數字' },
  { id: 'eng+chi_tra', label: '中文（繁體）加英文' },
  { id: 'eng+jpn', label: '日文加英文' },
];

let libPromise = null;
function loadLib() {
  if (window.Tesseract) return Promise.resolve();
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESS_URL;
      s.onload = () => resolve();
      s.onerror = () => {
        libPromise = null;
        reject(new Error('文字辨識工具載入失敗，請確認網路連線。'));
      };
      document.head.appendChild(s);
    });
  }
  return libPromise;
}

const workers = new Map();

// mode：'code' 只讀數字和英文字母（色號）；'line' 讀一行字；'block' 讀一小塊字
async function getWorker(langs, mode, onProgress) {
  await loadLib();
  const key = `${langs}|${mode}`;
  if (!workers.has(key)) {
    workers.set(
      key,
      window.Tesseract.createWorker(langs, 1, {
        logger: (m) => onProgress && onProgress(m),
      }).then(async (w) => {
        const params = { tessedit_pageseg_mode: mode === 'block' ? '6' : '7', preserve_interword_spaces: '1' };
        if (mode === 'code') params.tessedit_char_whitelist = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#.';
        await w.setParameters(params);
        return w;
      })
    );
  }
  return workers.get(key);
}

// 色名用哪種語言：選「中文加英文」時色名只用中文，比較不會把中文讀成英文字母
export function nameLang(langs) {
  if (langs === 'eng+chi_tra') return 'chi_tra';
  if (langs === 'eng+jpn') return 'jpn';
  return langs;
}

// 先下載好辨識工具（顯示「下載中」用）
export async function prepareOcr(langs, onProgress) {
  await getWorker('eng', 'code', onProgress);
  await getWorker(nameLang(langs), 'line', onProgress);
  await getWorker(langs, 'block', onProgress);
}

// 讀 textCrop 切好的文字小圖，回傳 { code, text }
export async function readLabelParts(parts, langs = 'eng') {
  let code = '', text = '';
  for (const p of parts) {
    if (p.role === 'code') {
      const w = await getWorker('eng', 'code');
      code = ((await w.recognize(p.canvas)).data.text || '').replace(/\s+/g, '');
    } else if (p.role === 'name') {
      const w = await getWorker(nameLang(langs), 'line');
      text += ' ' + ((await w.recognize(p.canvas)).data.text || '');
    } else {
      const w = await getWorker(langs, 'block');
      text += ' ' + ((await w.recognize(p.canvas)).data.text || '');
    }
  }
  return { code, text };
}
