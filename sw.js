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
  // 알림에 실린 주소는 이 앱(scope) 안일 때만 연다 — 다른 사이트로 보내는 푸시 방지 (보안 점검 2026-09-22)
  let url = self.registration.scope;
  try {
    const u = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope);
    if (u.href.startsWith(self.registration.scope)) url = u.href;
  } catch (_) {}
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) { c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
