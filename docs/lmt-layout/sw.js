// PWA Service Worker：缓存应用外壳，实现离线可用（仅同源资源，跨域请求直接走网络）
const CACHE = 'lmt-layout-v21';
// @index-hash: 9dc9aaa0  （index.html 归一化内容前 8 位；改完 index.html 运行 tools/web-sync.ps1 -Bump 自动升版）
const ASSETS = [
  './index.html',
  './html2canvas.min.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];
// 预缓存请求：cache:'reload' 强制绕过浏览器 HTTP 缓存（GitHub Pages 默认 max-age=600）。
// 否则版本号升级后，install 仍可能把 HTTP 缓存里的旧 index.html 存进新缓存，
// 导致「已发布新版本但用户刷新后还是旧界面」。
const PRECACHE = ASSETS.map(function (u) {
  return new Request(new URL(u, self.location.href), { cache: 'reload' });
});

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域（如在线清单）交给网络，不做缓存
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (resp) {
        const copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        return resp;
      }).catch(function () { return caches.match('./index.html'); });
    })
  );
});
