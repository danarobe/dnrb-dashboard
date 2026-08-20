// ═══════════════════════════════════════════════
// @멘션 알림 생성 + 웹 푸시 발송 (2026-08-20)
//   POST { targets: [user_id...], actor_name, message, link_menu }
//   1) notifications 테이블에 수신자별 행 삽입 (앱 내 종 아이콘용)
//   2) 수신자의 push_subscriptions 전 기기로 웹 푸시 발송 (휴대폰 알림)
//      — 만료된 구독(404/410)은 자동 삭제
// 필요 secrets: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
// ═══════════════════════════════════════════════
import webpush from "npm:web-push@3.6.7";
import { handleOptions, json, verifyAuthToken } from "../_shared/util.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", ...(init.headers ?? {}),
    },
  });

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  const me = await verifyAuthToken(req);
  if (!me) return json({ error: "로그인이 필요합니다" }, 401);

  try {
    const { targets, actor_name, message, link_menu } = await req.json().catch(() => ({}));
    const ids = [...new Set((targets ?? []).map((t: unknown) => String(t)).filter(Boolean))].slice(0, 20);
    const msg = String(message ?? "").slice(0, 200);
    if (!ids.length || !msg) return json({ error: "targets, message 필수" }, 400);
    const actor = String(actor_name ?? me.name ?? me.id).slice(0, 40);
    const link = String(link_menu ?? "").slice(0, 20);

    // 1) 앱 내 알림 행 삽입
    const ins = await rest("notifications", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(ids.map((user_id) => ({ user_id, actor_name: actor, message: msg, link_menu: link }))),
    });
    if (!ins.ok) throw new Error("알림 저장 실패 " + ins.status);

    // 2) 웹 푸시 — 구독 기기가 있는 수신자에게만
    const pub = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
    const priv = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
    let pushed = 0, removed = 0;
    if (pub && priv) {
      webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com", pub, priv);
      const subsRes = await rest(`push_subscriptions?user_id=in.(${ids.map((i) => `"${i}"`).join(",")})`);
      const subs = subsRes.ok ? await subsRes.json() : [];
      const payload = JSON.stringify({
        title: `${actor}님이 나를 언급했어요`,
        body: msg,
        url: `https://danarobe.github.io/dnrb-dashboard/${link ? "#" + link : ""}`,
      });
      await Promise.all(subs.map(async (s: { endpoint: string; p256dh: string; auth: string }) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          pushed++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode ?? 0;
          if (code === 404 || code === 410) {   // 만료된 구독 정리
            await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
            removed++;
          } else console.error("push 실패", code, String(e).slice(0, 120));
        }
      }));
    }
    return json({ ok: true, saved: ids.length, pushed, removed });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
