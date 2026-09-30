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

async function getWorker(langs, onProgress) {
  await loadLib();
  if (!workers.has(langs)) {
    workers.set(
      langs,
      window.Tesseract.createWorker(langs, 1, {
        logger: (m) => onProgress && onProgress(m),
      })
    );
  }
  return workers.get(langs);
}

// 回傳每個字的文字、信心分數和位置（原圖座標）
export async function readWords(source, langs = 'eng', onProgress) {
  const worker = await getWorker(langs, onProgress);
  // 小圖放大兩倍，字比較容易讀對
  const w = source.width, h = source.height;
  const scale = Math.max(w, h) < 1600 ? 2 : 1;
  const c = document.createElement('canvas');
  c.width = w * scale;
  c.height = h * scale;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, c.width, c.height);
  const { data } = await worker.recognize(c);
  return (data.words || []).map((wd) => ({
    text: wd.text,
    confidence: wd.confidence,
    bbox: {
      x0: wd.bbox.x0 / scale,
      y0: wd.bbox.y0 / scale,
      x1: wd.bbox.x1 / scale,
      y1: wd.bbox.y1 / scale,
    },
  }));
}
