// ═══════════════════════════════════════════════
// 카페24 OAuth 인증 함수
//   GET ?action=start    → 카페24 인증 페이지로 리다이렉트
//   GET ?code=...        → 인가 코드 → 토큰 교환 후 저장 (카페24 redirect_uri)
//   GET ?action=status   → 현재 토큰 상태 확인
//
// 필요 환경변수 (supabase secrets set):
//   CAFE24_MALL_ID, CAFE24_CLIENT_ID, CAFE24_CLIENT_SECRET
// ═══════════════════════════════════════════════
import { handleOptions, json, getToken, saveToken } from "../_shared/util.ts";

const MALL_ID = Deno.env.get("CAFE24_MALL_ID")!;
const CLIENT_ID = Deno.env.get("CAFE24_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("CAFE24_CLIENT_SECRET")!;
const SCOPE = "mall.read_order,mall.read_analytics,mall.read_category,mall.read_product";

const API_BASE = `https://${MALL_ID}.cafe24api.com/api/v2`;

// 연동 완료 응답
// 주의: Supabase 게이트웨이가 text/html 응답을 text/plain으로 강제 변환하므로
// HTML 페이지 대신 대시보드 리다이렉트(DASHBOARD_URL 설정 시) 또는
// UTF-8 BOM을 붙인 일반 텍스트(charset 헤더가 제거돼도 브라우저가 UTF-8로 인식)를 쓴다.
function doneResponse(): Response {
  const dash = Deno.env.get("DASHBOARD_URL");
  if (dash) return Response.redirect(`${dash}${dash.includes("?") ? "&" : "?"}cafe24=connected`, 302);
  return new Response(
    "\uFEFF✅ 카페24 연동 완료!\n\n이 창을 닫고 대시보드로 돌아가세요.",
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

function selfUrl(_req: Request): string {
  // 이 함수 자신의 공개 URL (redirect_uri로 사용)
  // 주의: 엣지 런타임의 req.url은 프록시 내부 주소라 /functions/v1 경로와 https가 빠짐
  return `${Deno.env.get("SUPABASE_URL")!}/functions/v1/cafe24-oauth`;
}

async function exchangeToken(params: Record<string, string>): Promise<Record<string, unknown>> {
  const basic = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`cafe24 token error ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function persistToken(body: Record<string, unknown>): Promise<void> {
  // 카페24 응답: access_token(2시간), refresh_token(2주), expires_at, refresh_token_expires_at
  const now = Date.now();
  await saveToken({
    provider: "cafe24",
    access_token: String(body.access_token ?? ""),
    refresh_token: String(body.refresh_token ?? ""),
    expires_at: body.expires_at
      ? new Date(String(body.expires_at)).toISOString()
      : new Date(now + 2 * 3600 * 1000).toISOString(),
    refresh_expires_at: body.refresh_token_expires_at
      ? new Date(String(body.refresh_token_expires_at)).toISOString()
      : new Date(now + 14 * 24 * 3600 * 1000).toISOString(),
  });
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const code = url.searchParams.get("code");

  try {
    // ① 인증 시작 → 카페24 로그인/동의 화면으로 리다이렉트
    if (action === "start") {
      const authorize =
        `${API_BASE}/oauth/authorize?response_type=code` +
        `&client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&state=perf` +
        `&redirect_uri=${encodeURIComponent(selfUrl(req))}` +
        `&scope=${encodeURIComponent(SCOPE)}`;
      return Response.redirect(authorize, 302);
    }

    // ② 카페24가 code를 들고 돌아옴 → 토큰 교환
    if (code) {
      const body = await exchangeToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: selfUrl(req),
      });
      await persistToken(body);
      return doneResponse();
    }

    // ③ 토큰 상태 확인
    if (action === "status") {
      const t = await getToken("cafe24");
      if (!t?.refresh_token) return json({ connected: false });
      const refreshValid = !t.refresh_expires_at || new Date(t.refresh_expires_at) > new Date();
      return json({
        connected: refreshValid,
        expires_at: t.expires_at,
        refresh_expires_at: t.refresh_expires_at,
      });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
