// ═══════════════════════════════════════════════
// 알바 휴가 승인 담당 (2026-11-13 사용자 요청: "알바 휴가는 물류팀 직원도 승인·반려, 신청이 오면 그 직원에게도 알림")
//   담당자 = alba_leave_approvers 표(관리자가 직원 관리 › 권한·보안에서 이름 칩으로 지정 — 아이디를 코드에 적지 않음).
//   담당자는 알바(wm_employees.type = 'parttime')의 '승인 대기' 휴가만 승인·반려할 수 있다(정직원 휴가·삭제·등록은 관리자만).
//   알림: 알바가 키오스크·마이페이지로 휴가를 신청하면 담당자에게 앱 알림(종) + 휴대폰 푸시. 관리자 알림은 예전 그대로 따로 간다.
// ═══════════════════════════════════════════════
import "./sbkey.ts";
import webpush from "npm:web-push@3.6.7";

const env = (n: string) => Deno.env.get(n) ?? "";
const sbKey = () => env("SB_SERVICE_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");

async function q(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${env("SUPABASE_URL")}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: sbKey(), Authorization: `Bearer ${sbKey()}`,
      "Content-Type": "application/json", Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

export const LEAVE_LABEL: Record<string, string> = { annual: "연차", half: "반차", summer: "여름휴가", sick: "병가" };

/** 지금 유효한 담당자 계정 id — 관리자 계정·로그인이 막힌(퇴사) 계정은 뺀다 */
export async function albaApproverIds(): Promise<string[]> {
  const rows = await q("alba_leave_approvers?select=user_id");
  const ids = (rows as { user_id: string }[]).map((r) => r.user_id).filter((s) => /^[A-Za-z0-9._@-]{1,64}$/.test(s));
  if (!ids.length) return [];
  const users = await q(`app_users?id=in.(${ids.map((i) => `"${i}"`).join(",")})&select=id,role,login_blocked`);
  return (users as { id: string; role: string; login_blocked: boolean }[])
    .filter((u) => u.role !== "admin" && !u.login_blocked).map((u) => u.id);
}

export async function isAlbaApprover(userId: string): Promise<boolean> {
  return (await albaApproverIds()).includes(userId);
}

/** 알바의 휴가 신청 → 담당자에게 앱 알림 + 휴대폰 푸시. 알바가 아니면 아무것도 안 한다. 실패는 호출부에서 무시. */
export async function notifyAlbaLeave(empId: number, name: string, dates: string[], type: string, reason?: string | null) {
  if (!dates.length) return;
  const [emp] = await q(`wm_employees?id=eq.${Number(empId)}&select=type,app_user_id`);
  if (!emp || emp.type !== "parttime") return;
  const ids = (await albaApproverIds()).filter((id) => id !== emp.app_user_id);
  if (!ids.length) return;
  const label = LEAVE_LABEL[type] ?? "휴가";
  const when = dates.length > 1 ? `${dates[0]} 외 ${dates.length - 1}일` : dates[0];
  await q("notifications", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify(ids.map((user_id) => ({
      user_id, actor_name: name, read: false, link_menu: "home",
      message: `알바 휴가 신청 — ${when} ${label}${reason ? ` (${reason})` : ""} · 홈 화면에서 승인·반려`,
    }))),
  });
  // 휴대폰 푸시 — 잠금 화면에 보이므로 사유는 넣지 않는다
  const pub = env("VAPID_PUBLIC_KEY"), priv = env("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return;
  webpush.setVapidDetails(env("VAPID_SUBJECT") || "mailto:admin@example.com", pub, priv);
  const subs = await q(`push_subscriptions?user_id=in.(${ids.map((i) => `"${i}"`).join(",")})&select=endpoint,p256dh,auth`);
  const payload = JSON.stringify({
    title: "알바 휴가 신청", body: `${name} · ${when} ${label} — 눌러서 승인·반려`,
    url: "https://danarobe.github.io/dnrb-dashboard/#home",
  });
  await Promise.all((subs as { endpoint: string; p256dh: string; auth: string }[]).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode ?? 0;
      if (code === 404 || code === 410) {   // 만료된 구독 정리
        await q(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => null);
      }
    }
  }));
}
