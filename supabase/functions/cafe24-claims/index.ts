// ═══════════════════════════════════════════════
// 카페24 취소·반품 집계 함수
//   GET ?start_date=2026-07-01&end_date=2026-07-26
//   → { cancel: {count, amount, reasons[]}, return: {...}, orders: [...] }
//
//   GET ...&raw=1  → 집계 대신 API 원본 첫 페이지 반환 (필드 매핑 디버그용)
//
// 집계 기준 (관리자 취소/반품관리 CSV와 실측 대조로 확정):
//   - 기간: 주문일(date_type=order_date) 기준 — 환불요청일/완료일 아님
//   - 취소: C40(취소완료)
//   - 반품: R00(반품신청)·R10(반품접수)·R30(처리중-수거전)·R34(처리중-환불전)·R40(반품완료)
//           반품 철회/반려는 제외
//   - 네이버페이(주문형) 주문 제외 — 네이버페이센터 CSV로 별도 반영
//   - 금액: 클레임의 실제(예정) 환불금액 refund_amounts 합
//   - 혼합 주문(한 주문에 취소+반품 공존): 취소 1건 + 반품 1건으로 각각 집계,
//     금액은 cancellation/return 클레임별로 분리 반영
// ═══════════════════════════════════════════════
import { handleOptions, json, getToken, saveToken, verifyAuthToken } from "../_shared/util.ts";

const MALL_ID = Deno.env.get("CAFE24_MALL_ID")!;
const CLIENT_ID = Deno.env.get("CAFE24_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("CAFE24_CLIENT_SECRET")!;
const API_BASE = `https://${MALL_ID}.cafe24api.com/api/v2`;
const API_VERSION = "2026-03-01";

// ── 액세스 토큰 확보 (만료 임박 시 refresh) ──
// force=true: 401 복구용 강제 재발급 (동시 갱신 경쟁 대응)
async function getAccessToken(force = false): Promise<string> {
  const t = await getToken("cafe24");
  if (!t?.refresh_token) throw new Error("카페24 미연동: 먼저 cafe24-oauth?action=start 로 인증하세요.");

  const expiresAt = t.expires_at ? new Date(t.expires_at).getTime() : 0;
  const stillValid = expiresAt - Date.now() > 5 * 60 * 1000; // 5분 여유
  if (!force && stillValid && t.access_token) return t.access_token;

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
  if (!res.ok) {
    await new Promise((r) => setTimeout(r, 1500));
    const latest = await getToken("cafe24");
    if (latest?.access_token && latest.access_token !== t.access_token) return latest.access_token;
    throw new Error(`토큰 갱신 실패 ${res.status}: ${JSON.stringify(body)} — 재인증이 필요할 수 있습니다.`);
  }

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 카페24 요청 한도(429 "Too much requests occur. (40/40)") — 홈에서 여러 조회가 겹치면 쉽게 걸린다.
// 버킷이 다시 차기를 기다렸다가 재시도한다. Retry-After가 오면 그 값을 우선 따른다.
const RATE_LIMIT_RETRIES = 6;

async function cafe24Get(path: string, token: string): Promise<Record<string, unknown>> {
  const doFetch = (tk: string) => fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${tk}`,
      "Content-Type": "application/json",
      "X-Cafe24-Api-Version": API_VERSION,
    },
  });
  let res = await doFetch(token);
  if (res.status === 401) res = await doFetch(await getAccessToken(true));
  for (let i = 0; res.status === 429 && i < RATE_LIMIT_RETRIES; i++) {
    const ra = Number(res.headers.get("Retry-After"));
    await res.body?.cancel();
    await sleep(isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** i, 8000));
    res = await doFetch(token);
  }
  const body = await res.json();
  if (!res.ok) throw new Error(`cafe24 GET ${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// 안전한 숫자 변환
function num(v: unknown): number {
  const n = parseFloat(String(v ?? "0").replace(/[^\d.\-]/g, ""));
  return isFinite(n) ? n : 0;
}

// ── 주문 페이지네이션 (카페24 제약 회피) — cafe24-analytics의 eachOrder와 같은 방식 ──
// 카페24 제약: ① offset < 15,000 ② 조회 기간 ≤ 3개월 ③ /count에 fields·embed를 넘기면
// {count:N} 대신 []가 오는 경우가 있어 건수를 0으로 오독한다(count에는 date_type·order_status만).
// 여기서는 embed=items,cancellation,return이 무거워(limit 100에 페이지당 ~1.7MB) limit을 올리지 않고,
// 페이지를 받는 즉시 집계해 넘긴다(주문을 전부 모으면 3개월치가 100MB를 넘어 메모리가 터진다).
const CAFE24_MAX_OFFSET = 15000;
const MAX_RANGE_DAYS = 80;
const CLAIM_PAGE = 100;
const CHUNK_CONCURRENCY = 2;   // 홈에서 다른 조회와 겹치므로 낮게 (3이면 429)
const dayMs = 24 * 3600 * 1000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

async function countOrders(token: string, qs: string): Promise<number> {
  const body = await cafe24Get(`/admin/orders/count?${qs}`, token);
  const c = (body as Record<string, unknown>).count;
  return c === undefined || c === null ? -1 : num(c);   // -1 = 못 읽음 → 쪼개지 말고 통째로
}

async function splitRanges(token: string, countQs: string, s: string, e: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  const stack: [string, string][] = [];
  for (let t = new Date(s).getTime(), end = new Date(e).getTime(); t <= end;) {
    const chunkEnd = Math.min(t + (MAX_RANGE_DAYS - 1) * dayMs, end);
    stack.push([ymd(t), ymd(chunkEnd)]);
    t = chunkEnd + dayMs;
  }
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const c = await countOrders(token, `start_date=${a}&end_date=${b}&${countQs}`);
    if (c === 0) continue;
    if (c < 0 || c < CAFE24_MAX_OFFSET || a === b) { out.push([a, b]); continue; }
    const midMs = new Date(a).getTime() +
      Math.floor((new Date(b).getTime() - new Date(a).getTime()) / dayMs / 2) * dayMs;
    stack.push([a, ymd(midMs)], [ymd(midMs + dayMs), b]);
  }
  return out.sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

/** 기간 내 주문을 조각·페이지 단위로 훑어 페이지마다 onOrders에 넘긴다 (모아두지 않음). */
async function eachClaimOrder(
  token: string, listQs: string, countQs: string, s: string, e: string,
  onOrders: (orders: Record<string, unknown>[]) => void,
): Promise<void> {
  const ranges = await splitRanges(token, countQs, s, e);
  // 부분배송 주문은 배송종료일이 여러 개라 두 조각 모두에 잡힌다 → 주문번호로 중복 제거
  const seen = new Set<string>();
  let idx = 0;
  const worker = async () => {
    while (idx < ranges.length) {
      const [a, b] = ranges[idx++];
      for (let offset = 0; offset < CAFE24_MAX_OFFSET; offset += CLAIM_PAGE) {
        const body = await cafe24Get(
          `/admin/orders?start_date=${a}&end_date=${b}&${listQs}&limit=${CLAIM_PAGE}&offset=${offset}`, token);
        const orders = (body.orders ?? []) as Record<string, unknown>[];
        const fresh = orders.filter((o) => {
          const id = String(o.order_id ?? "");
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        if (fresh.length) onOrders(fresh);
        if (orders.length < CLAIM_PAGE) break;    // 페이지 끝 판정은 걸러내기 전 길이로
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, ranges.length) }, worker));
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

  // 취소·반품 데이터는 관리자 전용 (직원은 서버 차단)
  const authed = await verifyAuthToken(req);
  if (!authed || authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);

  const url = new URL(req.url);
  const startDate = url.searchParams.get("start_date");
  const endDate = url.searchParams.get("end_date");
  const raw = url.searchParams.get("raw") === "1";
  if (!startDate || !endDate) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);

  try {
    const token = await getAccessToken();

    // 수집 대상 상태 (품목 order_status 기준)
    //   취소: C40(취소완료)만
    //   반품: R00(반품신청)·R10(반품접수)·R30(처리중-수거전)·R34(처리중-환불전)·R40(반품완료)
    //         — 명시 목록이므로 반품 철회/반려 건은 자연히 제외됨
    const RETURN_STATUSES = new Set(["R00", "R10", "R30", "R34", "R40"]);
    const STATUS_FILTER = ["C40", ...RETURN_STATUSES].join(",");

    // date_type=order_date: 선택한 기간은 '주문일' 기준 (취소/반품 완료일이 아님)
    const listQs = `date_type=order_date&order_status=${STATUS_FILTER}&embed=items,cancellation,return`;
    const countQs = `date_type=order_date&order_status=${STATUS_FILTER}`;   // count엔 embed 금지

    // 디버그용 원문 보기 — 첫 페이지만 그대로 반환 (조각 나누기 없이 단순 호출)
    if (raw) {
      const body = await cafe24Get(
        `/admin/orders?start_date=${startDate}&end_date=${endDate}&${listQs}&limit=${CLAIM_PAGE}&offset=0`, token);
      return json({ raw: body });
    }

    // ── 집계: 주문 단위 (기존 CSV 로직과 동일하게 주문번호 기준 중복 없음) ──
    type Bucket = { count: number; amount: number; reasons: Record<string, number> };
    const cancel: Bucket = { count: 0, amount: 0, reasons: {} };
    const ret: Bucket = { count: 0, amount: 0, reasons: {} };
    let fetchedOrders = 0;

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

    await eachClaimOrder(token, listQs, countQs, startDate, endDate, (orders) => {
      fetchedOrders += orders.length;
      for (const o of orders) {
      // 네이버페이(주문형) 주문 제외 — 클레임이 네이버페이센터에서 관리되어
      // 카페24 취소/반품관리에 없고, 네이버페이 CSV로 별도 반영되므로 이중집계 방지
      const placeName = String(o.order_place_name ?? "").replace(/\s/g, "");
      if (String(o.order_place_id ?? "") === "NCHECKOUT" || placeName.includes("네이버페이")) continue;

      const items = (o.items ?? []) as Record<string, unknown>[];
      // 주문 내 품목 상태로 취소/반품 판별 (취소=C40 / 반품=RETURN_STATUSES)
      // 혼합 주문(취소+반품 공존)은 양쪽에 각각 1건씩 집계하고,
      // 금액은 각 클레임(cancellation/return)의 환불액만 분리 반영
      const itemStatuses = items.map((it) => String(it.order_status ?? ""));
      const isCancel = itemStatuses.some((s) => s.startsWith("C4"));
      const isReturn = itemStatuses.some((s) => RETURN_STATUSES.has(s));
      const mixed = isCancel && isReturn;

      // 단독 주문에서 클레임 환불액이 비어있을 때만 결제금액으로 대체
      // (혼합 주문에 fallback을 쓰면 주문 전체 결제액이 양쪽에 중복 반영되므로 금지.
      //  미결제 취소는 0원 처리)
      const fallbackAmt = mixed ? 0 : (String(o.paid ?? "") === "T" ? num(o.payment_amount) : 0);

      // 사유 fallback: 품목 → 주문 순으로 탐색
      const itemReason = (): string => {
        for (const it of items) {
          const r = pickReason(it);
          if (r) return r;
        }
        return pickReason(o);
      };

      if (isCancel) {
        const amount = claimRefund(o.cancellation) || fallbackAmt;
        const reason = claimReason(o.cancellation) || itemReason() || "사유 미기재";
        cancel.count++; cancel.amount += amount;
        cancel.reasons[reason] = (cancel.reasons[reason] ?? 0) + 1;
      }
      if (isReturn) {
        const amount = claimRefund(o.return) || fallbackAmt;
        const reason = claimReason(o.return) || itemReason() || "사유 미기재";
        ret.count++; ret.amount += amount;
        ret.reasons[reason] = (ret.reasons[reason] ?? 0) + 1;
      }
      }
    });

    const toRanked = (m: Record<string, number>) =>
      Object.entries(m).map(([reason, cnt]) => ({ reason, cnt }))
        .sort((a, b) => b.cnt - a.cnt);

    return json({
      provider: "cafe24",
      period: { start: startDate, end: endDate },
      fetched_orders: fetchedOrders,
      cancel: { count: cancel.count, amount: Math.round(cancel.amount), reasons: toRanked(cancel.reasons) },
      return: { count: ret.count, amount: Math.round(ret.amount), reasons: toRanked(ret.reasons) },
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
