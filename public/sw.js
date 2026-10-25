/*
 * Hushly Service Worker
 * ------------------------
 * 1. PWA app-shell caching: instant cold starts, graceful offline fallback.
 * 2. Web Push: shows notifications for messages received while the app is
 *    closed or in the background (server only pushes when no live socket).
 * 3. notificationclick: focuses the running app or opens a deep link.
 */

const VERSION = 'ghostline-v2'
const SHELL_CACHE = `${VERSION}-shell`
const STATIC_CACHE = `${VERSION}-static`

// Routes cached at install — the minimal offline shell.
const SHELL_URLS = ['/', '/manifest.webmanifest', '/logo.svg', '/offline.html']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS).catch(() => undefined))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  )
})

// ─── fetch strategy ───────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // APIs are always live — never cached (auth + realtime data).
  if (url.pathname.startsWith('/api/')) return

  // Static build assets: network-first with cache fallback. (Cache-first would
  // serve stale dev chunks that keep their filename but change content.)
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(STATIC_CACHE).then((c) => c.put(req, copy)).catch(() => undefined)
          return res
        })
        .catch(async () => (await caches.match(req)) || Response.error())
    )
    return
  }

  // Truly immutable local assets: cache-first.
  if (
    url.pathname.startsWith('/icon-') ||
    url.pathname === '/maskable-512.png' ||
    url.pathname === '/apple-touch-icon.png' ||
    url.pathname === '/favicon-32.png' ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone()
            caches.open(STATIC_CACHE).then((c) => c.put(req, copy)).catch(() => undefined)
            return res
          })
      )
    )
    return
  }

  // Navigations: network-first, fall back to cached shell so the app opens
  // even with no connection.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(SHELL_CACHE).then((c) => c.put('/', copy)).catch(() => undefined)
          return res
        })
        .catch(async () => {
          const shell = (await caches.match('/')) || (await caches.match(req))
          return (
            shell ||
            new Response('<h1>Hushly is offline</h1>', {
              status: 503,
              headers: { 'Content-Type': 'text/html' },
            })
          )
        })
    )
  }
})

// ─── web push ────────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  let payload = { title: 'Hushly', body: 'New activity — tap to open.', url: '/' }
  try {
    if (event.data) payload = { ...payload, ...event.data.json() }
  } catch {
    /* keep defaults */
  }

  event.waitUntil(
    (async () => {
      // Suppress the OS banner when the user is actively looking at the app —
      // in-app UI already shows the message there.
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (clientList.some((c) => c.visibilityState === 'visible' && c.focused)) return

      await self.registration.showNotification(payload.title, {
        body: payload.body,
        tag: payload.tag || 'ghostline',
        renotify: Boolean(payload.tag),
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url: payload.url || '/' },
      })
    })()
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/'

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of clientList) {
        // Focus the app if it is open; carry the deep link over.
        if ('focus' in client) {
          client.postMessage({ type: 'open-chat', url: target })
          await client.focus()
          return
        }
      }
      await self.clients.openWindow(target)
    })()
  )
})
