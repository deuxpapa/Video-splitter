const CACHE_NAME = "video-splitter-shell-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./manual.html",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // GitHub Pagesは Cache-Control: max-age=600 を付けてくるため、
      // 普通に fetch するとブラウザのHTTPキャッシュ経由で古い内容を
      // 拾ってしまうことがある。"no-store" で毎回ネットワークから取り直す。
      cache.addAll(APP_SHELL.map((path) => new Request(path, { cache: "no-store" })))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    // 動画処理エンジン（外部）へのリクエストはそのままネットワークへ流す
    return;
  }
  // ネット接続があるときは常に最新版を取りに行き、取れた分をキャッシュに保存する。
  // オフラインなど取得に失敗したときだけ、保存済みのキャッシュを使う。
  // "no-store" を指定し、ブラウザ自身のHTTPキャッシュも経由させず、
  // 必ずネットワークまで取りに行く（GitHub Pagesのキャッシュ指示のせいで
  // 更新後もしばらく古い内容が返ってくるのを防ぐため）。
  const freshRequest = new Request(event.request, { cache: "no-store" });
  event.respondWith(
    fetch(freshRequest)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
