// Cross-origin isolation shim for static hosts that can't send headers
// (GitHub Pages). Threaded wasm needs SharedArrayBuffer, which needs the page
// to be crossOriginIsolated (COOP same-origin + COEP require-corp).
//
// The same file runs in two roles:
// - as a classic <script> in each page (first thing in <head>): if the page
//   isn't isolated, register this file as a service worker (scope: its own
//   directory, so it works under a subpath) and reload once it is active;
// - as that service worker: re-serve every same-origin response with the
//   COOP/COEP/CORP (and Document-Policy: js-profiling) headers.
// It does nothing when the server already sends the headers. If service
// workers are unavailable (insecure origin, private mode, registration
// failure) or the reload didn't help, it gives up quietly and the pages fall
// back to the single-threaded wasm builds. At most one reload per tab session.
// ?coi=0 disables it.
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (e) => {
    const r = e.request;
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
    if (new URL(r.url).origin !== self.location.origin) return;
    e.respondWith(fetch(r).then((res) => {
      if (res.status === 0) return res; // opaque
      const h = new Headers(res.headers);
      h.set('Cross-Origin-Opener-Policy', 'same-origin');
      h.set('Cross-Origin-Embedder-Policy', 'require-corp');
      h.set('Cross-Origin-Resource-Policy', 'same-origin');
      h.set('Document-Policy', 'js-profiling');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }));
  });
} else (() => {
  const KEY = 'zpg-coi-reloaded';
  const store = (f) => { try { return f(sessionStorage); } catch (_) { return undefined; } };
  if (window.crossOriginIsolated) { store((s) => s.removeItem(KEY)); return; }
  if (!window.isSecureContext || !navigator.serviceWorker || /[?&]coi=0(&|$)/.test(location.search)) return;
  navigator.serviceWorker.register(document.currentScript.src)
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      // Reload only if we can remember having done so (no storage: no reload, no loop).
      if (store((s) => s.getItem(KEY)) !== null) return;
      if (store((s) => (s.setItem(KEY, '1'), true))) location.reload();
    })
    .catch((e) => console.warn('coi-sw: service worker unavailable, staying single-threaded:', e));
})();
