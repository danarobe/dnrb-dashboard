// ═══════════════════════════════════════════════════════════════
// 업로드 캘린더 (2026-10-23 사용자 요청 "상품관리 시스템의 업로드 캘린더를 물류팀도 워크스페이스에서 볼 수 있게")
//
//   GET ?month=YYYY-MM   — x-auth-token 검증 후 관리자·MD(마케터 포함)·물류팀·CS팀(2026-10-23 CS팀 추가 — 사용자 요청).
//   상품관리 시스템(newproduct-manager) `/api/dnrb-calendar`를 연동 비밀키(NPM_SYNC_SECRET — 두 시스템 공유 키)로 읽어
//   그대로 돌려준다(읽기 전용). 응답 = { month, products: [{ id, name, status, status_label, upload_date }], reups: [{ id, title, reup_date }] }
//   상품관리의 /calendar 화면과 같은 자료(업로드 예정일 upload_date가 그 달인 상품 + 끌올). 등록·삭제는 상품관리에서만.
// ═══════════════════════════════════════════════════════════════
import { handleOptions, json, verifyAuthToken } from "../_shared/util.ts";

const NPM = "https://newproduct-manager.vercel.app";

// 2026-10-23 사용자 요청으로 CS팀도 연다 → 관리자·MD(마케터)·CS팀·물류팀 = 로그인한 직원 전원(verifyAuthToken이 marketer→staff, logistics→cs로 합쳐 줌).
//   서버 간 계정(에이전트·크론·상품관리 연동)은 막는다.
async function roleOk(me: { id: string; role: string }): Promise<boolean> {
  if (["sales-agent", "cron", "npm-sync"].includes(me.id)) return false;
  return me.role === "admin" || me.role === "staff" || me.role === "cs";
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "GET") return json({ error: "GET만 받습니다" }, 405);
  const me = await verifyAuthToken(req);
  if (!me) return json({ error: "로그인이 필요합니다" }, 401);
  if (!(await roleOk(me))) return json({ error: "접근 권한이 없습니다" }, 403);

  const month = new URL(req.url).searchParams.get("month") ?? "";
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: "month는 YYYY-MM" }, 400);
  const secret = Deno.env.get("NPM_SYNC_SECRET") ?? "";
  if (!secret) return json({ error: "연동 비밀키 미설정" }, 500);

  try {
    const res = await fetch(`${NPM}/api/dnrb-calendar${month ? `?month=${month}` : ""}`, {
      headers: { "x-sync-secret": secret },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let d: any; try { d = JSON.parse(text); } catch { d = null; }
    if (!d) return json({ error: `상품관리 시스템이 캘린더 자료를 주지 않았어요(${res.status}) — 상품관리 쪽 배포를 확인해 주세요` }, 502);
    if (!res.ok || d.error) return json({ error: `상품관리 시스템 응답 오류(${res.status}) ${d.error ?? ""}` }, 502);
    return json(d);
  } catch (e) {
    return json({ error: "상품관리 시스템에 연결하지 못했어요 — " + (e instanceof Error ? e.message : String(e)) }, 502);
  }
});
