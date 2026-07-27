// ═══════════════════════════════════════════════
// 카페24 취소·반품 집계 함수
//   GET ?start_date=2026-07-01&end_date=2026-07-26
//   → { cancel: {count, amount, reasons[]}, return: {...}, orders: [...] }
//
//   GET ...&raw=1  → 집계 대신 API 원본 첫 페이지 반환 (필드 매핑 디버그용)
//
// 카페24 주문 상태 코드:
//   C40 = 취소 완료 / R40 = 반품 완료 (환불 완료)
// ═══════════════════════════════════════════════
import { handleOptions, json, getToken, saveToken } from "../_shared/util.ts";

const MALL_ID = Deno.env.get("CAFE24_MALL_ID")!;
const CLIENT_ID = Deno.env.get("CAFE24_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("CAFE24_CLIENT_SECRET")!;
const API_BASE = `https://${MALL_ID}.cafe24api.com/api/v2`;
const API_VERSION = "2026-03-01";

// ── 액세스 토큰 확보 (만료 임박 시 refresh) ──
async function getAccessToken(): Promise<string> {
  const t = await getToken("cafe24");
  if (!t?.refresh_token) throw new Error("카페24 미연동: 먼저 cafe24-oauth?action=start 로 인증하세요.");

  const expiresAt = t.expires_at ? new Date(t.expires_at).getTime() : 0;
  const stillValid = expiresAt - Date.now() > 5 * 60 * 1000; // 5분 여유
  if (stillValid && t.access_token) return t.access_token;

  // refresh
  const basic = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`토큰 갱신 실패 ${res.status}: ${JSON.stringify(body)} — 재인증이 필요할 수 있습니다.`);

  const now = Date.now();
  await saveToken({
    provider: "cafe24",
    access_token: String(body.access_token ?? ""),
    refresh_token: String(body.refresh_token ?? t.refresh_token),
    expires_at: body.expires_at
      ? new Date(String(body.expires_at)).toISOString()
      : new Date(now + 2 * 3600 * 1000).toISOString(),
    refresh_expires_at: body.refresh_token_expires_at
      ? new Date(String(body.refresh_token_expires_at)).toISOString()
      : new Date(now + 14 * 24 * 3600 * 1000).toISOString(),
  });
  return String(body.access_token);
}

async function cafe24Get(path: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Cafe24-Api-Version": API_VERSION,
    },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`cafe24 GET ${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// 안전한 숫자 변환
function num(v: unknown): number {
  const n = parseFloat(String(v ?? "0").replace(/[^\d.\-]/g, ""));
  return isFinite(n) ? n : 0;
}

// 항목에서 사유 추출 (API 버전에 따라 필드명이 다를 수 있어 방어적으로 탐색)
function pickReason(obj: Record<string, unknown>): string {
  for (const key of [
    "claim_reason", "cancel_reason", "return_reason",
    "claim_reason_type", "reason",
  ]) {
    const v = obj?.[key];
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  const url = new URL(req.url);
  const startDate = url.searchParams.get("start_date");
  const endDate = url.searchParams.get("end_date");
  const raw = url.searchParams.get("raw") === "1";
  if (!startDate || !endDate) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);

  try {
    const token = await getAccessToken();

    // 취소완료(C40) + 반품완료(R40) 주문을 페이지네이션으로 전부 수집
    const LIMIT = 100;
    const allOrders: Record<string, unknown>[] = [];
    let offset = 0;
    while (offset <= 8000) {
      // date_type=order_date: 선택한 기간은 '주문일' 기준 (취소/반품 완료일이 아님)
      const path =
        `/admin/orders?start_date=${startDate}&end_date=${endDate}` +
        `&date_type=order_date` +
        `&order_status=C40,R40&embed=items,cancellation,return` +
        `&limit=${LIMIT}&offset=${offset}`;
      const body = await cafe24Get(path, token);
      const orders = (body.orders ?? []) as Record<string, unknown>[];
      if (raw && offset === 0) return json({ raw: body });
      allOrders.push(...orders);
      if (orders.length < LIMIT) break;
      offset += LIMIT;
    }

    // ── 집계: 주문 단위 (기존 CSV 로직과 동일하게 주문번호 기준 중복 없음) ──
    type Bucket = { count: number; amount: number; reasons: Record<string, number>; orders: unknown[] };
    const cancel: Bucket = { count: 0, amount: 0, reasons: {}, orders: [] };
    const ret: Bucket = { count: 0, amount: 0, reasons: {}, orders: [] };

    // 클레임(cancellation/return embed) 배열에서 실제 환불금액 합산
    // — 관리자 취소/반품관리 CSV의 '총 실제 환불금액'과 동일 기준
    const claimRefund = (claims: unknown): number => {
      if (!Array.isArray(claims)) return 0;
      let s = 0;
      for (const c of claims as Record<string, unknown>[]) {
        const ra = c.refund_amounts;
        if (Array.isArray(ra)) {
          for (const x of ra as Record<string, unknown>[]) s += num(x.amount);
        }
      }
      return s;
    };
    // claim_reason_type 코드 → 관리자 화면 '구분' 라벨 (실데이터 대조로 확인)
    const REASON_TYPE_LABEL: Record<string, string> = {
      A: "고객변심", B: "배송지연", E: "상품불만족", G: "서비스불만족", H: "품절",
      I: "기타", J: "배송오류", K: "상품불량", L: "배송오류", O: "고객변심",
      P: "상품불만족", V: "상품불량",
    };
    const claimReason = (claims: unknown): string => {
      if (!Array.isArray(claims)) return "";
      for (const c of claims as Record<string, unknown>[]) {
        // 구분 카테고리 우선 (집계 버킷이 깔끔) → 없으면 자유 입력 사유 텍스트
        const t = String(c.claim_reason_type ?? "").trim();
        if (t) return REASON_TYPE_LABEL[t] ?? t;
        const txt = String(c.claim_reason ?? "").trim();
        if (txt) return txt;
      }
      return "";
    };

    for (const o of allOrders) {
      // 네이버페이(주문형) 주문 제외 — 클레임이 네이버페이센터에서 관리되어
      // 카페24 취소/반품관리에 없고, 네이버페이 CSV로 별도 반영되므로 이중집계 방지
      const placeName = String(o.order_place_name ?? "").replace(/\s/g, "");
      if (String(o.order_place_id ?? "") === "NCHECKOUT" || placeName.includes("네이버페이")) continue;

      const items = (o.items ?? []) as Record<string, unknown>[];
      // 주문 내 품목 상태로 취소/반품 판별 (C40=취소완료, R40=반품완료)
      const itemStatuses = items.map((it) => String(it.order_status ?? ""));
      const isCancel = itemStatuses.some((s) => s.startsWith("C4"));
      const isReturn = itemStatuses.some((s) => s.startsWith("R4"));

      // 금액: 실제 환불금액 합 (취소+반품 클레임). 환불이 없으면
      // 결제완료 건에 한해 결제금액으로 대체 (미결제 취소는 0원 처리)
      const refunded = claimRefund(o.cancellation) + claimRefund(o.return);
      const amount = refunded ||
        (String(o.paid ?? "") === "T" ? num(o.payment_amount) : 0);

      // 사유: 클레임 개체 → 품목 → 주문 순으로 탐색
      let reason = claimReason(o.cancellation) || claimReason(o.return);
      if (!reason) {
        for (const it of items) {
          reason = pickReason(it);
          if (reason) break;
        }
      }
      if (!reason) reason = pickReason(o) || "사유 미기재";

      const summary = {
        order_id: o.order_id,
        order_date: o.order_date,
        amount,
        reason,
        type: isReturn ? "return" : "cancel",
      };

      if (isReturn) {
        ret.count++; ret.amount += amount;
        ret.reasons[reason] = (ret.reasons[reason] ?? 0) + 1;
        ret.orders.push(summary);
      } else if (isCancel) {
        cancel.count++; cancel.amount += amount;
        cancel.reasons[reason] = (cancel.reasons[reason] ?? 0) + 1;
        cancel.orders.push(summary);
      }
    }

    const toRanked = (m: Record<string, number>) =>
      Object.entries(m).map(([reason, cnt]) => ({ reason, cnt }))
        .sort((a, b) => b.cnt - a.cnt);

    return json({
      provider: "cafe24",
      period: { start: startDate, end: endDate },
      fetched_orders: allOrders.length,
      cancel: { count: cancel.count, amount: Math.round(cancel.amount), reasons: toRanked(cancel.reasons) },
      return: { count: ret.count, amount: Math.round(ret.amount), reasons: toRanked(ret.reasons) },
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
