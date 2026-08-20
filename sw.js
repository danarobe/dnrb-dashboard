/* DNRB 대시보드 — 웹 푸시 서비스 워커 (2026-08-20)
   @멘션 알림을 휴대폰·데스크톱 시스템 알림으로 표시한다. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'DNRB 대시보드', {
    body: d.body || '',
    data: { url: d.url || './' },
    badge: undefined,
    tag: 'dnrb-mention',                 // 같은 종류 알림은 최신 것으로 갱신
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.includes('dnrb-dashboard') && 'focus' in c) { c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
