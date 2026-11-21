/*
 * Service Worker（ブラウザの裏で動く、通信の中継役）
 *
 * 方針は「ネットワーク優先・だめならキャッシュ」:
 *   - つながるときは、いつも最新のファイルを取りに行く（毎朝のカードがすぐ見えるように）
 *   - 取れたファイルは端末に保存（キャッシュ）しておく
 *   - 電波が弱い・圏外のときは、保存してある前回の内容を表示する
 *
 * GitHub API など、このサイト以外への通信には手を出さない。
 */

const CACHE = "asa-it-v1";

self.addEventListener("install", () => self.skipWaiting()); // 新しい版をすぐ使い始める
self.addEventListener("activate", (event) => {
  // 古い版のキャッシュを消す
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((cached) => cached || Response.error()))
  );
});
