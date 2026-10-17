// Field Responder service worker: shows Web Push alerts while the app is closed and opens the
// task when the notification is tapped. Served at /field/sw.js (scope /field/). No caching here;
// the app's own outbox handles offline work.
/* eslint-env serviceworker */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : '13STORE Field Responder';
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/field/';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    renotify: typeof data.tag === 'string',
    data: { url, incidentId: data.incidentId },
    lang: 'th',
    vibrate: [200, 100, 200],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/field/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const mine = clients.find((c) => c.url.startsWith(self.location.origin + '/field'));
      if (mine) {
        mine.postMessage({ type: 'open', url: target });
        return 'focus' in mine ? mine.focus() : undefined;
      }
      return self.clients.openWindow(target);
    }),
  );
});
