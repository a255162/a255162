// 離線快取。
//
// 全部用相對路徑：這個 App 會放在 GitHub Pages 的子目錄（/pokecard/），
// 寫死 '/index.html' 會指到網站根目錄而整個失效——這是 PWA 最常見的踩雷點。

const VERSION = 'v2-m1';
const CACHE = 'pokecard-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/imageutil.js',
  './js/capture.js',
  './js/grade.js',
  './js/overlay.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // 個別加入：任一個檔案 404 不該讓整包安裝失敗
      Promise.all(
        SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('[sw] 快取失敗', url, err.message))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('pokecard-') && k !== CACHE)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部資源（之後的卡圖）另外處理

  // 程式碼（HTML／JS／CSS）走「網路優先」，沒網路才回快取。
  //
  // 一開始這裡是先給快取、背景更新，結果是改版後要開兩次才會拿到新程式——
  // 使用者永遠跑在上一版，量測邏輯修好了也看不到。程式碼求正確，
  // 多花的那幾十 KB 流量不重要；離線時 fetch 失敗就回快取，照樣能用。
  const isCode =
    req.mode === 'navigate' ||
    req.destination === 'script' ||
    req.destination === 'style' ||
    req.destination === 'document';

  if (isCode) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match('./index.html'))
        )
    );
    return;
  }

  // 圖片等靜態資源：先給快取（開得快），同時背景更新
  event.respondWith(
    caches.match(req).then((hit) => {
      const fetching = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || fetching;
    })
  );
});
