// ═══════════════════════════════════════════════
// 아카이브·회의록 테이블 접근 프록시
//   POST { path, method, body?, prefer? }
//   → 로그인 토큰 검증(DB 실계정 확인) 후 service_role로 PostgREST 대행
//
// 테이블 anon 정책을 제거하고 이 함수로만 접근한다 (외부 직접 접근 차단).
// path는 PostgREST 경로 그대로 (예: "cr_archive?select=*&order=created_at.desc")
// ═══════════════════════════════════════════════
import { handleOptions, json, verifyAuthToken, CORS_HEADERS } from "../_shared/util.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 테이블별 접근 가능 역할 (회의 보드용 topics는 이 대시보드 소관이 아니므로 미포함)
const TABLE_ROLES: Record<string, string[]> = {
  cr_archive: ["admin"],
  perf_archive: ["admin", "staff"],
  adv_archive: ["admin", "staff"],
  ad_meeting_topics: ["admin", "staff"],
  ad_meeting_notes: ["admin", "staff"],
  ad_note_comments: ["admin", "staff"],   // 공유 회의 기록 댓글
  ad_note_likes: ["admin", "staff"],      // 공유 회의 기록 좋아요
  disp_season_out: ["admin"],   // 진열 시즌 제외 목록 (관리자 전용 메뉴)
  return_watch: ["admin", "staff"],   // 반품 관리 상품 (관리자 + MD)
  ad_test_state: ["admin", "staff"],  // 테스트 소재 숨김·추가소재권장·메모 (2026-08-27 다시 admin+staff — 광고관리자에서 MD·마케터에게 테스트 소재 탭만 열어줌)
  best_ads: ["admin", "staff"],   // 베스트소재 모음 — 광고세트 단위. MD·마케터도 열람·제거 가능 (2026-08-28 사용자 지정 — 담기는 광고세트 탭이 admin 전용이라 admin만)
  profit_archive: ["admin"],    // 순익 시나리오 기간별 기록
  project_tasks: ["admin"],     // 프로젝트 관리 업무 (관리자 전용 — 사용자 결정 2026-08-19)
  board_topics: ["admin"],      // 대표 회의보드 안건 (관리자 전용 — 사용자 결정 2026-08-19, 대표끼리 서로 수정 가능이라 AUTHOR_FIELDS 미적용)
  notifications: ["admin", "staff", "cs"],  // @멘션 알림 (2026-08-20). 남을 수신자로 POST해야 하므로 AUTHOR_FIELDS 미적용 — 읽기는 클라이언트가 본인 필터(내부 신뢰 전제, 비공개 회의기록과 동일 수준)
  push_subscriptions: ["admin", "staff", "cs"],  // 웹 푸시 구독 (기기별, 2026-08-20) — AUTHOR_FIELDS로 본인 것만
};
// 본인 것만 쓰기·수정·삭제 가능한 테이블과 작성자 컬럼 (클라이언트 규칙을 서버에서 강제)
const AUTHOR_FIELDS: Record<string, string> = {
  ad_meeting_notes: "author_id",
  ad_note_comments: "author_id",
  ad_note_likes: "user_id",
  push_subscriptions: "user_id",   // 푸시 구독은 본인 것만 등록·삭제
};
const METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  const me = await verifyAuthToken(req);
  if (!me) return json({ error: "로그인이 필요합니다" }, 401);

  try {
    const { path, method, body, prefer } = await req.json().catch(() => ({}));
    const p = String(path ?? "");
    const m = String(method ?? "GET").toUpperCase();
    const table = p.split("?")[0];
    if (!METHODS.has(m)) return json({ error: "잘못된 요청" }, 400);
    if (!/^[a-z_]+$/.test(table) || !TABLE_ROLES[table]) return json({ error: "허용되지 않은 테이블" }, 403);
    if (!TABLE_ROLES[table].includes(me.role)) return json({ error: "접근 권한이 없습니다" }, 403);

    const authorField = AUTHOR_FIELDS[table];
    if (authorField) {
      if (m === "PATCH" || m === "DELETE") {
        const qs = new URLSearchParams(p.split("?")[1] ?? "");
        if (qs.get(authorField) !== `eq.${me.id}`) return json({ error: "본인 것만 수정·삭제할 수 있습니다" }, 403);
      }
      if (m === "POST" && body && String((body as Record<string, unknown>)[authorField]) !== me.id) {
        return json({ error: "작성자 정보가 올바르지 않습니다" }, 400);
      }
    }

    const headers: Record<string, string> = {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
    };
    if (prefer) headers["Prefer"] = String(prefer);
    const upstream = await fetch(`${SB_URL}/rest/v1/${p}`, {
      method: m,
      headers,
      body: m === "GET" ? undefined : (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await upstream.text();
    if (upstream.status === 204 || !text) {
      return new Response(null, { status: upstream.status === 204 ? 204 : upstream.status, headers: CORS_HEADERS });
    }
    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
