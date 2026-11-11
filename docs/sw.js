/* オフラインでも開けるようにアプリ本体をキャッシュする。
 * 動画の解析はすべて端末の中で動くので、ネットが必要なのは Gemini を使うときだけ。 */

const CACHE = 'cutlistmaker-v2.0.3';

const SHELL = [
  './',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'vendor/mp4box.all.min.js',
  'vendor/pptxgen.bundle.js',
  'vendor/exceljs.min.js',
  'vendor/jszip.min.js',
  'js/ui.js',
  'js/pipeline.js',
  'js/decode.js',
  'js/detect.js',
  'js/score.js',
  'js/sheet.js',
  'js/gemini.js',
  'js/prompts.js',
  'js/audio.js',
  'js/narration.js',
  'js/pptx.js',
  'js/xlsx.js',
  'js/output.js',
  'js/timecode.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // Gemini への通信は素通し

  // アプリ本体（HTML / 自作 JS / CSS）は、つながっていれば必ず最新を取りに行く。
  // キャッシュ優先にすると、直したはずの不具合が古いままになってしまう。
  // 外部ライブラリは滅多に変わらないので、キャッシュを返しつつ裏で更新する。
  const isAppCode = !url.pathname.includes('/vendor/');

  if (isAppCode) {
    // cache: 'no-cache' はブラウザの保存分を捨てるのではなく、サーバーに
    // 「変わっていないか」を必ず確かめさせる指定。GitHub Pages は 10 分間
    // 変更を見に行かない設定で配っているので、これが無いと直した直後の
    // 10 分間は古いままになる。変わっていなければ 304 が返るだけで軽い。
    event.respondWith(
      fetch(request, { cache: 'no-cache' })
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
      return hit || network;
    }),
  );
});
