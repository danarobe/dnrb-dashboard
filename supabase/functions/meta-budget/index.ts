// ═══════════════════════════════════════════════
// Meta 예산 쓰기 함수 (2026-08-26) — 광고관리자 메뉴의 예산 직접 변경 + 자정 예약
//   읽기 함수(meta-ads)와 일부러 분리: 쓰기 토큰(META_WRITE_TOKEN)은 이 함수만 안다.
//
//   GET  ?action=status   → { allowed, token_set, pin_set }  (버튼 노출 판단용)
//   GET  ?action=pending  → { pending: [...], recent: [...] }
//   POST ?action=verify   { pin } → PIN 인증만 (메뉴의 'PIN 인증' 버튼 — 세션 단위 활성화, 2026-08-26)
//   POST ?action=apply    { object_id, level, new_budget, pin } → 즉시 적용
//   POST ?action=schedule { object_id, object_name, level, new_budget, pin } → 다음 자정 예약
//   POST ?action=cancel   { id, pin } → 예약 취소
//   POST ?action=run      (헤더 x-cron-secret) → 자정 예약분 일괄 적용 — pg_cron이 00:00 KST에 호출
//
// 보안 (전부 서버 강제 — 화면 우회 불가):
//   ① 로그인 + admin + WRITE_USER_IDS 목록(개인 지정 — 공개 레포라 코드에 안 적고 secret으로)
//   ② PIN(WRITE_PIN secret) 매 요청 검증, 15분 내 5회 실패 시 잠금(api_cache 카운터)
//   ③ 일예산 상한 300,000원 / 하한 1,000원 (사용자 지정)
//   ④ 총예산(lifetime) 캠페인·세트는 변경 불가(일예산만)
//
// 필요 secrets: META_WRITE_TOKEN(ads_management 시스템 사용자 토큰 — 사용자가 발급),
//               WRITE_PIN, WRITE_USER_IDS("id1,id2"), CRON_SECRET, META_ACCESS_TOKEN(읽기 — 현재값 조회용)
// secrets 변경 후에는 이 함수 재배포 필요.
// ═══════════════════════════════════════════════
import { cacheGet, cacheSet, handleOptions, json, verifyAuthToken } from "../_shared/util.ts";

const GRAPH = "https://graph.facebook.com/v23.0";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_BUDGET = 300_000;   // 개당 일예산 상한 (사용자 지정 2026-08-26 — 처음 50만원에서 30만원으로 정정)
const MIN_BUDGET = 1_000;

const env = (k: string) => Deno.env.get(k) ?? "";
const allowedIds = () => env("WRITE_USER_IDS").split(",").map((s) => s.trim()).filter(Boolean);

const num = (v: unknown) => {
  const n = parseFloat(String(v ?? "0"));
  return isFinite(n) ? n : 0;
};
function seoulToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}
function addDays(ymd: string, d: number): string {
  const t = new Date(`${ymd}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}

// PostgREST 직접 호출 (service_role) — budget_writes·api_cache 관리
async function pg(path: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function metaGetObj(id: string, token: string): Promise<{ name: string; daily: number; lifetime: number }> {
  const qs = new URLSearchParams({ fields: "name,daily_budget,lifetime_budget", access_token: token });
  const res = await fetch(`${GRAPH}/${id}?${qs}`);
  const body = await res.json();
  if (!res.ok) throw new Error(`Meta 조회 실패: ${(body?.error?.message ?? "").slice(0, 200)}`);
  return { name: String(body.name ?? ""), daily: num(body.daily_budget), lifetime: num(body.lifetime_budget) };
}
async function metaSetBudget(id: string, won: number): Promise<void> {
  const res = await fetch(`${GRAPH}/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ daily_budget: String(won), access_token: env("META_WRITE_TOKEN") }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    throw new Error(`Meta 적용 실패: ${(body?.error?.message ?? JSON.stringify(body)).slice(0, 250)}`);
  }
}

// 예산 변경 후 관련 서버 캐시 비우기 — 화면이 바로 새 값을 보게
async function clearMetaCaches(): Promise<void> {
  await pg(`api_cache?key=like.${encodeURIComponent("meta:hierarchy")}*`, "DELETE").catch(() => {});
  await pg(`api_cache?key=like.${encodeURIComponent("meta:budgethist")}*`, "DELETE").catch(() => {});
}

// PIN 검증 + 15분 5회 잠금
async function checkPin(userId: string, pin: string): Promise<string | null> {
  const set = env("WRITE_PIN");
  if (!set) return "PIN이 아직 설정되지 않았습니다 (관리자에게 문의)";
  const key = `pinfail:${userId}`;
  const rec = (await cacheGet(key, 15 * 60 * 1000)) as { n?: number } | null;
  const n = rec?.n ?? 0;
  if (n >= 5) return "PIN 5회 오류 — 15분 뒤 다시 시도하세요";
  if (String(pin ?? "") !== set) {
    await cacheSet(key, { n: n + 1 });
    return `PIN이 올바르지 않습니다 (남은 시도 ${4 - n}회)`;
  }
  return null;
}

// 자정 예약분 일괄 적용 — pg_cron이 00:00 KST(15:00 UTC)에 호출
async function runPending(): Promise<Record<string, unknown>> {
  const today = seoulToday();
  const due = (await pg(`budget_writes?status=eq.pending&apply_date=lte.${today}&order=requested_at.asc`, "GET")) as Record<string, unknown>[];
  let ok = 0, fail = 0;
  for (const row of due) {
    try {
      if (!env("META_WRITE_TOKEN")) throw new Error("META_WRITE_TOKEN 미설정");
      await metaSetBudget(String(row.object_id), num(row.new_budget));
      await pg(`budget_writes?id=eq.${row.id}`, "PATCH", { status: "applied", applied_at: new Date().toISOString() });
      ok++;
    } catch (e) {
      await pg(`budget_writes?id=eq.${row.id}`, "PATCH", { status: "failed", applied_at: new Date().toISOString(), error: String(e).slice(0, 300) }).catch(() => {});
      fail++;
    }
  }
  if (ok) await clearMetaCaches();
  return { due: due.length, applied: ok, failed: fail };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "status";

  try {
    // 자정 실행 경로 — 사용자 토큰 대신 cron 비밀 헤더
    if (action === "run") {
      const secret = env("CRON_SECRET");
      if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "권한 없음" }, 403);
      return json(await runPending());
    }

    const authed = await verifyAuthToken(req);
    if (!authed || authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
    const allowed = allowedIds().includes(authed.id);

    if (action === "status") {
      return json({ allowed, token_set: !!env("META_WRITE_TOKEN"), pin_set: !!env("WRITE_PIN"), max_budget: MAX_BUDGET });
    }
    if (!allowed) return json({ error: "예산 변경 권한이 없습니다 (지정 사용자 전용)" }, 403);

    if (action === "pending") {
      const pending = await pg("budget_writes?status=eq.pending&order=requested_at.desc&limit=100", "GET");
      const recent = await pg("budget_writes?status=neq.pending&order=requested_at.desc&limit=20", "GET");
      return json({ pending, recent });
    }

    // 이하 쓰기 3종 — 매 요청 PIN 검증
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const pinErr = await checkPin(authed.id, String(body.pin ?? ""));
    if (pinErr) return json({ error: pinErr }, 403);
    const who = `${authed.name}(${authed.id})`;

    if (action === "verify") return json({ ok: true });   // PIN 검증만 통과하면 됨 (실패·잠금은 checkPin이 처리)

    if (action === "cancel") {
      const id = num(body.id);
      const rows = (await pg(`budget_writes?id=eq.${id}&status=eq.pending`, "PATCH", { status: "canceled", applied_at: new Date().toISOString() })) as unknown[];
      if (!rows.length) return json({ error: "취소할 예약이 없습니다" }, 400);
      return json({ ok: true });
    }

    // apply / schedule 공통 검증
    const objectId = String(body.object_id ?? "");
    const level = String(body.level ?? "");
    const newBudget = Math.round(num(body.new_budget));
    if (!objectId || !["campaign", "adset"].includes(level)) return json({ error: "대상이 올바르지 않습니다" }, 400);
    if (newBudget < MIN_BUDGET || newBudget > MAX_BUDGET) {
      return json({ error: `예산은 ${MIN_BUDGET.toLocaleString()}원 ~ ${MAX_BUDGET.toLocaleString()}원 사이여야 합니다 (상한선 서버 강제)` }, 400);
    }

    // 현재값 확인 (읽기 토큰) — 총예산 전용 대상은 거부
    let cur = { name: String(body.object_name ?? ""), daily: 0, lifetime: 0 };
    try { cur = await metaGetObj(objectId, env("META_ACCESS_TOKEN") || env("META_WRITE_TOKEN")); } catch { /* 조회 실패해도 진행(이름·old만 비게 됨) */ }
    if (!cur.daily && cur.lifetime) return json({ error: "총예산(lifetime) 대상은 지원하지 않습니다 — 일예산만 변경 가능" }, 400);

    if (action === "apply") {
      if (!env("META_WRITE_TOKEN")) return json({ error: "Meta 쓰기 토큰(META_WRITE_TOKEN)이 아직 설정되지 않았습니다" }, 400);
      await metaSetBudget(objectId, newBudget);
      await pg("budget_writes", "POST", {
        object_id: objectId, object_name: cur.name || String(body.object_name ?? ""), level,
        old_budget: cur.daily || null, new_budget: newBudget, mode: "now", status: "applied",
        requested_by: who, applied_at: new Date().toISOString(),
      });
      await clearMetaCaches();
      return json({ ok: true, old_budget: cur.daily, new_budget: newBudget });
    }

    if (action === "schedule") {
      // 같은 대상의 기존 예약은 자동 대체 (최신 예약 하나만 유효)
      await pg(`budget_writes?object_id=eq.${objectId}&status=eq.pending`, "PATCH", { status: "canceled", applied_at: new Date().toISOString() }).catch(() => {});
      const applyDate = addDays(seoulToday(), 1);   // 다음 자정 = 내일 날짜 00:00 KST
      await pg("budget_writes", "POST", {
        object_id: objectId, object_name: cur.name || String(body.object_name ?? ""), level,
        old_budget: cur.daily || null, new_budget: newBudget, mode: "midnight", apply_date: applyDate,
        status: "pending", requested_by: who,
      });
      return json({ ok: true, apply_date: applyDate, new_budget: newBudget, token_set: !!env("META_WRITE_TOKEN") });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e).slice(0, 400) }, 500);
  }
});
