// 讓 App 可以加到主畫面。App 本身的檔案先從網路拿最新版，網路不通時才用快取
const CACHE = 'knit-palette-v8';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/main.js', 'js/ui.js', 'js/color.js', 'js/segment.js', 'js/recolor.js', 'js/swatches.js', 'js/ocr.js',
  'js/github.js', 'js/data.js', 'js/workspace.js', 'js/library.js', 'js/importer.js', 'js/gallery.js',
  'js/settings.js', 'js/export.js', 'js/demo.js', 'js/sam.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 只處理 App 自己的檔案；GitHub 資料、字型、文字辨識工具都直接走網路
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
