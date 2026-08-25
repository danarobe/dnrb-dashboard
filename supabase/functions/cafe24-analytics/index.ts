// ═══════════════════════════════════════════════
// 카페24 애널리틱스 — 상품 조회수·주문수·주문율
//   GET ?action=summary&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD[&device_type=pc|mobile]
//     → { rows: [{product_no, product_name, views, order_count, order_qty, order_amount, rate}], totals }
//   GET ?action=categories
//     → { categories: [{category_no, category_name, category_depth, parent_category_no}] }
//   GET ?action=category_products&category_no=N
//     → { product_nos: [...] }
//
// 데이터 출처:
//   조회수/주문수 — 카페24 애널리틱스 API (ca-api.cafe24data.com, scope: mall.read_analytics)
//   카테고리     — Admin API (scope: mall.read_category)
// ═══════════════════════════════════════════════
import { cacheGet, cacheSet, handleOptions, json, getToken, saveToken, verifyAuthToken } from "../_shared/util.ts";

const MALL_ID = Deno.env.get("CAFE24_MALL_ID")!;
const CLIENT_ID = Deno.env.get("CAFE24_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("CAFE24_CLIENT_SECRET")!;
const API_BASE = `https://${MALL_ID}.cafe24api.com/api/v2`;
const DATA_BASE = "https://ca-api.cafe24data.com";
const API_VERSION = "2026-03-01";

// ── 액세스 토큰 확보 (만료 임박 시 refresh) — cafe24-claims와 동일 로직 ──
// force=true: 저장된 만료시각과 무관하게 강제 재발급 (401 복구용 — 동시 갱신 경쟁으로
// 다른 인스턴스가 새 토큰을 발급하면 기존 토큰이 무효화되어 만료시각만으론 판단 불가)
async function getAccessToken(force = false): Promise<string> {
  const t = await getToken("cafe24");
  if (!t?.refresh_token) throw new Error("카페24 미연동: 먼저 cafe24-oauth?action=start 로 인증하세요.");

  const expiresAt = t.expires_at ? new Date(t.expires_at).getTime() : 0;
  const stillValid = expiresAt - Date.now() > 5 * 60 * 1000;
  if (!force && stillValid && t.access_token) return t.access_token;

  const basic = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  const body = await res.json();
  if (!res.ok) {
    // 다른 인스턴스가 먼저 갱신했을 수 있음 → 잠시 후 DB의 최신 토큰 재사용
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

// 카페24 요청 한도(429 "Too much requests occur. (40/40)") — 홈처럼 여러 조회가 겹치면 쉽게 걸린다.
// 버킷이 다시 차기를 기다렸다가 재시도한다. Retry-After가 오면 그 값을 우선 따른다.
const RATE_LIMIT_RETRIES = 6;

async function apiGet(url: string, token: string): Promise<Record<string, unknown>> {
  const doFetch = (tk: string) => fetch(url, {
    headers: {
      Authorization: `Bearer ${tk}`,
      "Content-Type": "application/json",
      "X-Cafe24-Api-Version": API_VERSION,
    },
  });
  let res = await doFetch(token);
  if (res.status === 401) {
    // 동시 갱신 경쟁으로 토큰이 무효화된 경우 → 강제 재발급 후 1회 재시도
    res = await doFetch(await getAccessToken(true));
  }
  for (let i = 0; res.status === 429 && i < RATE_LIMIT_RETRIES; i++) {
    const ra = Number(res.headers.get("Retry-After"));
    await res.body?.cancel();
    await sleep(isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** i, 8000));
    res = await doFetch(token);
  }
  const body = await res.json();
  if (!res.ok) throw new Error(`GET ${url.replace(/\?.*$/, "")} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// 애널리틱스 API 페이지네이션 수집 (limit 최대 1000)
async function collectData(
  path: string, listKey: string, params: URLSearchParams, token: string,
): Promise<Record<string, unknown>[]> {
  const LIMIT = 1000;
  const all: Record<string, unknown>[] = [];
  for (let offset = 0; offset <= 20000; offset += LIMIT) {
    const p = new URLSearchParams(params);
    p.set("limit", String(LIMIT));
    p.set("offset", String(offset));
    const body = await apiGet(`${DATA_BASE}${path}?${p}`, token);
    const items = (body[listKey] ?? []) as Record<string, unknown>[];
    all.push(...items);
    if (items.length < LIMIT) break;
  }
  return all;
}

const num = (v: unknown) => {
  const n = parseFloat(String(v ?? "0"));
  return isFinite(n) ? n : 0;
};

// ── 주문 페이지네이션 (카페24 offset 상한 회피) ────────────────────────────
// 카페24는 offset이 15,000 이상이면 422를 준다:
//   "[Start location of list] must be less than 15000. (parameter.offset)"
// 분석 기간이 한 달만 돼도 패딩 포함 주문이 16,000건을 넘어(실측 7/1~7/31 → 16,321건)
// 조회 도중 422 → 500으로 죽었다. 그래서 **기간을 조각내어 조각마다 offset을 0부터 다시 센다.**
// 조각 크기는 /count로 실측해 정하고(상한을 넘으면 반으로 쪼갬), 조각들은 동시에 처리해 시간을 줄인다.
const CAFE24_MAX_OFFSET = 15000;
// 카페24는 조회 기간도 3개월 이내로 제한한다("...should be within 3 months days..." 422).
// 패딩(e+30일)까지 더하면 두 달짜리 분석도 넘길 수 있으므로 처음부터 80일 이하로 잘라 시작한다.
const MAX_RANGE_DAYS = 80;
const ORDER_PAGE = 500;
// 홈은 취소반품·판매성과·재고대조를 한꺼번에 부르므로, 조회 하나가 쓰는 동시 요청 수를 낮게 잡는다
// (전에 3으로 뒀다가 홈에서 3개월을 고르면 카페24 429가 났다)
const CHUNK_CONCURRENCY = 2;

const dayMs = 24 * 3600 * 1000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

// /count에는 **embed·fields를 넘기면 안 된다** — 그러면 카페24가 {count:N} 대신 []를 돌려줘서
// 건수가 0으로 읽히고 조회 범위가 통째로 버려진다(실측). 집계 대상에 영향을 주는 것만 남긴다.
const COUNT_PARAMS = new Set(["date_type", "order_status"]);
const countFilter = (filter: string) =>
  filter.split("&").filter((kv) => COUNT_PARAMS.has(kv.split("=")[0])).join("&");

// 반환값 -1 = 개수를 읽지 못함 (형식이 예상과 다름) → 쪼개지 말고 통째로 읽게 한다
async function countOrders(token: string, qs: string): Promise<number> {
  const body = await apiGet(`${API_BASE}/admin/orders/count?${qs}`, token);
  const c = (body as Record<string, unknown>).count;
  return c === undefined || c === null ? -1 : num(c);
}

// [s,e]를 offset 상한 안에 들어오는 날짜 조각들로 나눈다 (하루까지 쪼개도 넘치면 그대로 두고 상한까지만 읽음)
async function splitOrderRanges(token: string, filter: string, s: string, e: string): Promise<[string, string][]> {
  const cf = countFilter(filter);
  const out: [string, string][] = [];
  // 3개월 제한부터 피하고 시작 — 80일 이하 조각으로 미리 나눈다
  const stack: [string, string][] = [];
  for (let t = new Date(s).getTime(), end = new Date(e).getTime(); t <= end;) {
    const chunkEnd = Math.min(t + (MAX_RANGE_DAYS - 1) * dayMs, end);
    stack.push([ymd(t), ymd(chunkEnd)]);
    t = chunkEnd + dayMs;
  }
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const c = await countOrders(token, `start_date=${a}&end_date=${b}&${cf}`);
    if (c === 0) continue;
    // 개수를 못 읽으면 예전처럼 통째로 읽는다 (데이터가 빈 채로 반환되는 사고 방지)
    if (c < 0 || c < CAFE24_MAX_OFFSET || a === b) { out.push([a, b]); continue; }
    const midMs = new Date(a).getTime() + Math.floor((new Date(b).getTime() - new Date(a).getTime()) / dayMs / 2) * dayMs;
    stack.push([a, ymd(midMs)], [ymd(midMs + dayMs), b]);
  }
  return out.sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

/** 기간 내 주문을 조각·페이지 단위로 모두 훑어 onOrders에 넘긴다.
 *  filter는 date_type·order_status·embed·fields 등 start_date/end_date를 뺀 나머지 쿼리스트링. */
async function eachOrder(
  token: string, filter: string, s: string, e: string,
  onOrders: (orders: Record<string, unknown>[]) => void,
): Promise<void> {
  const ranges = await splitOrderRanges(token, filter, s, e);
  // **부분배송 주문은 배송종료일이 여러 개라 두 조각 모두에 잡힌다**(실측: 조각 합계가 전체보다 176건 많음).
  // 조각을 나눈 뒤로 생긴 문제라 주문번호로 걸러 같은 주문을 두 번 세지 않는다.
  const seen = new Set<string>();
  let idx = 0;
  const worker = async () => {
    while (idx < ranges.length) {
      const [a, b] = ranges[idx++];
      for (let offset = 0; offset < CAFE24_MAX_OFFSET; offset += ORDER_PAGE) {
        const body = await apiGet(
          `${API_BASE}/admin/orders?start_date=${a}&end_date=${b}&${filter}&limit=${ORDER_PAGE}&offset=${offset}`, token);
        const orders = (body.orders ?? []) as Record<string, unknown>[];
        const fresh = orders.filter((o) => {
          const id = String(o.order_id ?? "");
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        if (fresh.length) onOrders(fresh);
        if (orders.length < ORDER_PAGE) break;    // 페이지 끝 판정은 걸러내기 전 길이로
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, ranges.length) }, worker));
}

// 카페24 claim_reason은 '신청 사유 (구매자|판매자 주문취소 : 접수 사유)' 형태로 두 사유가 합쳐져 온다.
// 실측 예: "사이즈작음 (구매자 주문취소 : 구매 의사 취소)" / "(판매자 주문취소 : )" (신청 사유 없음)
const CLAIM_ACCEPT_SUFFIX = /\((?:구매자|판매자)\s*주문취소\s*:\s*([^)]*)\)\s*$/;
function splitClaimReason(raw: unknown): { request: string; accept: string } {
  const s = String(raw ?? "").trim();
  const m = s.match(CLAIM_ACCEPT_SUFFIX);
  if (!m) return { request: s, accept: "" };
  return { request: s.slice(0, m.index).trim(), accept: (m[1] ?? "").trim() };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "summary";

  try {
    // 외부 차단: 전 액션 로그인 필수 — 서명·만료 + DB 실계정 확인 (역할은 DB 현재값)
    const authed = await verifyAuthToken(req);
    if (!authed) return json({ error: "로그인이 필요합니다" }, 401);

    // ── 결과 캐시 (10분) — 무거운 주문 스캔 액션만. 반드시 각 액션의 **권한 검사 뒤에**
    // fromCache()를 불러야 한다 (캐시가 권한 우회 통로가 되면 안 됨).
    // performance는 역할에 따라 응답이 달라서(비관리자 order_amount=0) 키에 역할 포함.
    const qsKey = new URLSearchParams(url.search);
    qsKey.delete("nocache"); qsKey.sort();
    const cacheKey = `an:${qsKey.toString()}` + (action === "performance" ? `:${authed.role}` : "");
    const noCache = url.searchParams.get("nocache") === "1";
    const fromCache = async () => noCache ? null : await cacheGet(cacheKey, 10 * 60 * 1000);
    const respond = async (body: unknown) => { await cacheSet(cacheKey, body); return json(body); };

    const token = await getAccessToken();

    // ── 카테고리 목록 ──
    if (action === "categories") {
      const LIMIT = 100;
      const cats: Record<string, unknown>[] = [];
      for (let offset = 0; offset <= 2000; offset += LIMIT) {
        const body = await apiGet(
          `${API_BASE}/admin/categories?limit=${LIMIT}&offset=${offset}` +
          `&fields=category_no,category_name,category_depth,parent_category_no`, token);
        const items = (body.categories ?? []) as Record<string, unknown>[];
        cats.push(...items);
        if (items.length < LIMIT) break;
      }
      return json({ categories: cats });
    }

    // ── 특정 카테고리의 상품번호 목록 ──
    if (action === "category_products") {
      const catNo = url.searchParams.get("category_no");
      if (!catNo) return json({ error: "category_no 필수" }, 400);
      // 주의: 이 엔드포인트는 offset을 무시함 (실측) — limit만 크게 잡아 한 번에 조회
      const body = await apiGet(
        `${API_BASE}/admin/categories/${catNo}/products?display_group=1&limit=1000`, token);
      const items = (body.products ?? []) as Record<string, unknown>[];
      const nos = [...new Set(items.map((p) => Number(p.product_no)))];
      return json({ category_no: Number(catNo), product_nos: nos, truncated: items.length >= 1000 });
    }

    // ── 기간 총 매출액 (결제완료 주문 기준 — 시간대별 매출 합산) ──
    // 카페24 관리자 통계의 '결제합계'와 동일 시스템(애널리틱스) 데이터.
    // 주문수는 통계와 정확히 일치하며 금액은 ±0.5% 내외 차이 가능(부분취소 반영 시점 차이).
    if (action === "revenue") {
      // 총 매출액은 관리자 전용 (직원은 서버 차단)
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const p = new URLSearchParams({ mall_id: MALL_ID, start_date: s, end_date: e });
      const times = await collectData("/sales/times", "times", p, token);
      const revenue = times.reduce((t, r) => t + num(r.order_amount), 0);
      const orderCount = times.reduce((t, r) => t + num(r.order_count), 0);
      return json({ period: { start: s, end: e }, revenue, order_count: orderCount });
    }

    // ── 진열 계산용 지표 (관리자 전용): 7일/30일 조회수·판매량 + 30일 취소반품수량 ──
    if (action === "displaymetrics") {
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const e = url.searchParams.get("end_date");
      if (!e) return json({ error: "end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);
      const day = 24 * 3600 * 1000;
      const dstr = (t: number) => new Date(t).toISOString().slice(0, 10);
      const endMs = new Date(e).getTime();
      // 트렌드 지표(조회·판매)는 21일 창 — 신상 회전이 빠르고 간절기 영향이 커서 30일은 과거 시즌 노이즈 포함 (상품팀 결정)
      const s7 = dstr(endMs - 6 * day), s21 = dstr(endMs - 20 * day);

      const range = (s: string) => new URLSearchParams({ mall_id: MALL_ID, start_date: s, end_date: e });
      const [v7, v21, q7, q21] = await Promise.all([
        collectData("/products/view", "view", range(s7), token),
        collectData("/products/view", "view", range(s21), token),
        collectData("/products/sales", "sales", range(s7), token),
        collectData("/products/sales", "sales", range(s21), token),
      ]);

      type M = { v7: number; v21: number; q7: number; q21: number; amt7: number; amt21: number; del7: number; ret7: number };
      const map = new Map<number, M>();
      const of = (no: number): M => {
        let m = map.get(no);
        if (!m) { m = { v7: 0, v21: 0, q7: 0, q21: 0, amt7: 0, amt21: 0, del7: 0, ret7: 0 }; map.set(no, m); }
        return m;
      };
      for (const r of v7) of(Number(r.product_no)).v7 += num(r.count);
      for (const r of v21) of(Number(r.product_no)).v21 += num(r.count);
      for (const r of q7) { const m = of(Number(r.product_no)); m.q7 += num(r.order_product_count); m.amt7 += num(r.order_amount); }
      for (const r of q21) { const m = of(Number(r.product_no)); m.q21 += num(r.order_product_count); m.amt21 += num(r.order_amount); }

      // 순반품률 — '판매 성과' 메뉴와 동일 기준: 품목 delivered_date + R40/R30/R34
      // 창은 기준일 3일 전부터 거슬러 7일 (예: 기준일 07/30 → 07/21~07/27) — 최근 3일은 반품 접수가 미확정이라 제외
      const lossS = dstr(endMs - 9 * day), lossE = dstr(endMs - 3 * day);
      const NET_RETURN_STATUSES = new Set(["R40", "R30", "R34"]);
      const fetchStart = dstr(new Date(lossS).getTime() - 7 * day);
      const fetchEnd = dstr(Math.min(new Date(lossE).getTime() + 30 * day, Date.now()));
      await eachOrder(token, "date_type=shipend_date&embed=items&fields=order_id,items", fetchStart, fetchEnd, (orders) => {
        for (const o of orders) {
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            const dd = String(it.delivered_date ?? "").slice(0, 10);
            if (!dd || dd < lossS || dd > lossE) continue;
            const no = Number(it.product_no);
            if (!no) continue;
            const m = of(no);
            const qty = num(it.quantity);
            m.del7 += qty;
            if (NET_RETURN_STATUSES.has(String(it.order_status ?? ""))) m.ret7 += qty;
          }
        }
      });

      const metrics: Record<string, M> = {};
      for (const [no, m] of map) metrics[String(no)] = m;
      return respond({ period: { end: e, start7: s7, start21: s21, loss_start: lossS, loss_end: lossE }, metrics });
    }

    // ── 상품 기본 정보 배치 조회 (관리자 전용): 진열 계산용 ──
    if (action === "productinfo") {
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const nosParam = url.searchParams.get("product_nos") ?? "";
      const nos = nosParam.split(",").map((s) => Number(s)).filter((n) => n > 0);
      if (!nos.length) return json({ error: "product_nos 필수" }, 400);
      const out: Record<string, unknown>[] = [];
      for (let i = 0; i < nos.length; i += 100) {
        const chunk = nos.slice(i, i + 100).join(",");
        const body = await apiGet(
          `${API_BASE}/admin/products?product_no=${chunk}` +
          `&fields=product_no,product_code,product_name,price,supply_price,created_date,sold_out,display,selling&limit=100`, token);
        out.push(...((body.products ?? []) as Record<string, unknown>[]));
      }
      return json({ products: out });
    }

    // ── 순반품률: 배송완료일 기준 상품별 전체수량 · 반품수량 ──
    // 기존 '순반품률 분석 대시보드 v6'와 동일 정책:
    //   모수  = 기간(배송완료일 date_type=shipend_date) 내 모든 주문 품목 수량 합
    //   반품 = 품목 상태 R40(반품완료-환불완료)·R30(처리중-수거전)·R34(처리중-환불전)만
    //   순반품률 = 반품수량 ÷ 전체수량 × 100
    if (action === "netreturns") {
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);

      // 2026-08-08 사용자 결정: 반품신청(R00)·접수(R10)도 포함 — 반품 관리 메뉴와 기준 통일.
      // 상태는 품목당 하나뿐이라 중복 집계 불가, 철회·반려는 실측 0건(신청 이력 2,730건 기준).
      const NET_RETURN_STATUSES = new Set(["R00", "R10", "R30", "R34", "R40"]);
      type Opt = { option: string; total_qty: number; return_qty: number };
      type Row = {
        product_no: number; product_name: string; total_qty: number; return_qty: number;
        opts: Map<string, Opt>;
      };
      const map = new Map<number, Row>();
      let totalQty = 0, returnQty = 0;
      // 주문 단위 shipend_date는 부분배송 시 기간 밖 품목까지 포함하므로,
      // 주문은 여유 범위로 수집한 뒤 '품목별 배송완료일(delivered_date)'로 정확히 필터
      // (관리자 전체주문조회의 배송완료일 검색과 동일 기준 — 실측 검증 완료)
      const day = 24 * 3600 * 1000;
      const pad = (d: Date) => d.toISOString().slice(0, 10);
      const fetchStart = pad(new Date(new Date(s).getTime() - 7 * day));
      const fetchEnd = pad(new Date(Math.min(new Date(e).getTime() + 30 * day, Date.now())));
      await eachOrder(token, "date_type=shipend_date&embed=items&fields=order_id,items", fetchStart, fetchEnd, (orders) => {
        for (const o of orders) {
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            const dd = String(it.delivered_date ?? "").slice(0, 10);
            if (!dd || dd < s || dd > e) continue;
            const no = Number(it.product_no);
            if (!no) continue;
            let row = map.get(no);
            if (!row) {
              row = {
                product_no: no, product_name: String(it.product_name ?? ""),
                total_qty: 0, return_qty: 0, opts: new Map(),
              };
              map.set(no, row);
            }
            const qty = num(it.quantity);
            const isReturn = NET_RETURN_STATUSES.has(String(it.order_status ?? ""));
            row.total_qty += qty; totalQty += qty;
            if (isReturn) { row.return_qty += qty; returnQty += qty; }
            // 옵션별 집계 (option_value 예: "컬러=아이보리, 사이즈=1사이즈")
            const optKey = String(it.option_value ?? "").trim() || "(단일 옵션)";
            let opt = row.opts.get(optKey);
            if (!opt) { opt = { option: optKey, total_qty: 0, return_qty: 0 }; row.opts.set(optKey, opt); }
            opt.total_qty += qty;
            if (isReturn) opt.return_qty += qty;
          }
        }
      });
      const rows = [...map.values()].map((r) => ({
        product_no: r.product_no, product_name: r.product_name,
        total_qty: r.total_qty, return_qty: r.return_qty,
        net_return_rate: r.total_qty > 0 ? +(r.return_qty / r.total_qty * 100).toFixed(2) : 0,
        options: [...r.opts.values()].map((o) => ({
          ...o,
          net_return_rate: o.total_qty > 0 ? +(o.return_qty / o.total_qty * 100).toFixed(2) : 0,
        })).sort((a, b) => b.total_qty - a.total_qty),
      })).sort((a, b) => b.return_qty - a.return_qty);
      return respond({
        period: { start: s, end: e },
        basis: "item_delivered_date",
        totals: {
          total_qty: totalQty, return_qty: returnQty,
          net_return_rate: totalQty > 0 ? +(returnQty / totalQty * 100).toFixed(2) : 0,
        },
        rows,
      });
    }

    // ── 반품 관리: 결제수량 상위 상품의 창별(7/14/21/30일) 순반품률 (관리자·MD) ──
    // 반품 상태 기준 = R00/R10 + R30/R34/R40 (신청·접수 포함).
    // 2026-08-08부터 netreturns(판매 성과)도 같은 기준 — 진열(displaymetrics)만 R30/R34/R40 유지.
    // 상태는 품목당 하나뿐이라 신청·접수를 더해도 중복 집계되지 않는다(실측: 철회·반려 코드 자체가 없음).
    //
    // 성능: 30일 창의 패딩 범위를 **한 번만** 훑고 delivered_date로 잘라 4개 창을 모두 만든다
    // (창마다 따로 조회하면 123초, 한 번 훑으면 ~50초 — 실측으로 4개 창 수치 완전 일치 확인).
    if (action === "returnwatch") {
      if (!["admin", "staff"].includes(authed.role)) return json({ error: "접근 권한이 없습니다" }, 403);
      const e = url.searchParams.get("end_date");
      if (!e) return json({ error: "end_date 필수 (YYYY-MM-DD)" }, 400);
      const topN = Math.max(1, Math.min(100, Number(url.searchParams.get("top") ?? 30)));
      const minQty = Math.max(0, Number(url.searchParams.get("min_qty") ?? 10));   // 소표본 판정 보류 기준
      const riskAt = Number(url.searchParams.get("risk") ?? 20);                    // '위험' 경계 (%)
      // 관리 상품(watch)도 창 집계에 포함 — 상위 N 밖이어도 관리 탭에서 7/14/30일 수치를 보여주기 위함.
      // 30일 창 주문 스캔은 어차피 전 주문을 훑으므로 추가 비용은 집계 몇 줄뿐이다.
      const extras = (url.searchParams.get("extra") ?? "").split(",")
        .map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 200);
      const hit = await fromCache(); if (hit) return json(hit);

      const RET = new Set(["R00", "R10", "R30", "R34", "R40"]);
      const WINDOWS = [7, 14, 21, 30];
      const endMs = new Date(e).getTime();
      const winStart: Record<number, string> = {};
      for (const w of WINDOWS) winStart[w] = ymd(endMs - (w - 1) * dayMs);
      const scanFrom = ymd(endMs - 29 * dayMs);

      // ① 결제수량 순위 — 애널리틱스(빠름). 7일·14일 각각의 상위 topN을 합집합으로 본다
      const paid: Record<number, Record<number, number>> = {};      // window → product_no → 결제수량
      const nameOf = new Map<number, string>();
      for (const w of [7, 14]) {
        const rows = await collectData("/products/sales", "sales",
          new URLSearchParams({ mall_id: MALL_ID, start_date: winStart[w], end_date: e }), token);
        const m: Record<number, number> = {};
        for (const r of rows) {
          const no = Number(r.product_no);
          if (!no) continue;
          m[no] = (m[no] ?? 0) + num(r.order_product_count);
          if (r.product_name) nameOf.set(no, String(r.product_name));
        }
        paid[w] = m;
      }
      const topOf = (w: number) => Object.entries(paid[w])
        .sort((a, b) => b[1] - a[1]).slice(0, topN).map(([no]) => Number(no));
      const rank7 = topOf(7), rank14 = topOf(14);
      const target = new Set([...rank7, ...rank14, ...extras]);   // extras는 순위 0·flagged 판정 제외(judge 창 없음)
      const rankIdx = (arr: number[], no: number) => { const i = arr.indexOf(no); return i < 0 ? 0 : i + 1; };

      // ② 배송완료·반품 수량 — 30일 창 패딩 범위를 한 번만 훑는다
      type Cell = { del: number; ret: number };
      const mk = (): Record<number, Cell> => ({ 7: { del: 0, ret: 0 }, 14: { del: 0, ret: 0 }, 21: { del: 0, ret: 0 }, 30: { del: 0, ret: 0 } });
      type Row = { name: string; win: Record<number, Cell>; opts: Map<string, Record<number, Cell>> };
      const rows = new Map<number, Row>();
      const fetchStart = ymd(new Date(scanFrom).getTime() - 7 * dayMs);
      const fetchEnd = ymd(Math.min(endMs + 30 * dayMs, Date.now()));

      await eachOrder(token, "date_type=shipend_date&embed=items&fields=order_id,items", fetchStart, fetchEnd, (orders) => {
        for (const o of orders) {
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            const no = Number(it.product_no);
            if (!no || !target.has(no)) continue;                    // 상위 상품만 집계 (응답 가볍게)
            const dd = String(it.delivered_date ?? "").slice(0, 10);
            if (!dd || dd < scanFrom || dd > e) continue;
            let row = rows.get(no);
            if (!row) { row = { name: String(it.product_name ?? nameOf.get(no) ?? ""), win: mk(), opts: new Map() }; rows.set(no, row); }
            const optKey = String(it.option_value ?? "").trim() || "(단일 옵션)";
            let opt = row.opts.get(optKey);
            if (!opt) { opt = mk(); row.opts.set(optKey, opt); }
            const qty = num(it.quantity);
            const isRet = RET.has(String(it.order_status ?? ""));
            for (const w of WINDOWS) {
              if (dd < winStart[w]) continue;
              row.win[w].del += qty; opt[w].del += qty;
              if (isRet) { row.win[w].ret += qty; opt[w].ret += qty; }
            }
          }
        }
      });

      // ③ 위험 판정 — 배송완료 minQty 미만은 '판정 보류'(소표본 요행 배제, 판매 성과와 같은 기준)
      const rate = (c: Cell) => c.del > 0 ? +(c.ret / c.del * 100).toFixed(2) : 0;
      const risky = (c: Cell) => c.del >= minQty && rate(c) >= riskAt;
      const out = [...rows.entries()].map(([no, r]) => {
        const options = [...r.opts.entries()].map(([option, w]) => ({
          option,
          windows: Object.fromEntries(WINDOWS.map((k) => [k, { ...w[k], rate: rate(w[k]), risk: risky(w[k]) }])),
        })).sort((a, b) => b.windows[14].del - a.windows[14].del);
        const windows = Object.fromEntries(WINDOWS.map((k) => [k, { ...r.win[k], rate: rate(r.win[k]), risk: risky(r.win[k]) }]));
        // 판정 창 = 순위에 든 창 (7일 상위면 7일, 14일 상위면 14일 — 둘 다면 둘 중 하나라도)
        const judge = [rank7.includes(no) ? 7 : 0, rank14.includes(no) ? 14 : 0].filter(Boolean) as number[];
        const productRisk = judge.some((w) => risky(r.win[w]));
        const optionRisk = options.filter((o) => judge.some((w) => o.windows[w].risk));
        return {
          product_no: no, product_name: r.name,
          rank7: rankIdx(rank7, no), rank14: rankIdx(rank14, no),
          paid7: paid[7][no] ?? 0, paid14: paid[14][no] ?? 0,
          windows, options,
          product_risk: productRisk,
          risk_options: optionRisk.map((o) => o.option),
          flagged: productRisk || optionRisk.length > 0,
        };
      }).sort((a, b) => (b.windows[14].rate - a.windows[14].rate));

      return respond({
        end_date: e, window_start: winStart, basis: "item_delivered_date",
        statuses: [...RET], min_qty: minQty, risk_at: riskAt, top: topN,
        products: out,
      });
    }

    // ── 상품별 반품 사유 원문 (판매 성과 상세용) ──
    // netreturns와 **완전히 같은 모수**를 쓴다: 품목 delivered_date 기준 기간 내 R00/R10/R30/R34/R40
    // (2026-08-08부터 신청·접수 포함 — netreturns와 동시 변경, 두 기준은 항상 같이 움직여야 함).
    // 다만 order_status 필터로 반품 주문만 받아 스캔량을 크게 줄인다 (실측 4,554건 → 486건).
    //
    // 카페24는 '반품 신청 사유'와 '반품 접수 사유'를 claim_reason 한 필드에 합쳐서 준다:
    //     "사이즈작음 (구매자 주문취소 : 구매 의사 취소)"
    //      └ 신청 사유 ┘ └────── 접수 사유 ──────┘
    // 사용자 규칙: 둘 다 있으면 중복으로 보고 **신청 사유만** 집계, 신청이 비면 접수 사유를 쓴다.
    if (action === "returnreasons") {
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);

      const NET_RETURN_STATUSES = ["R00", "R10", "R30", "R34", "R40"];
      const statusSet = new Set(NET_RETURN_STATUSES);
      const day = 24 * 3600 * 1000;
      const pad = (d: Date) => d.toISOString().slice(0, 10);
      const fetchStart = pad(new Date(new Date(s).getTime() - 7 * day));
      const fetchEnd = pad(new Date(Math.min(new Date(e).getTime() + 30 * day, Date.now())));

      type Out = {
        product_no: number; product_name: string; option: string;
        qty: number; date: string; request: string; accept: string;
        claim: string;   // 클레임 번호 — 여러 상품 동반 반품 시 사유가 공유되므로 클라이언트가 이걸로 구분
      };
      const items: Out[] = [];
      const filter = `date_type=shipend_date&order_status=${NET_RETURN_STATUSES.join(",")}` +
        `&embed=items&fields=order_id,items`;
      await eachOrder(token, filter, fetchStart, fetchEnd, (orders) => {
        for (const o of orders) {
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            if (!statusSet.has(String(it.order_status ?? ""))) continue;
            const dd = String(it.delivered_date ?? "").slice(0, 10);
            if (!dd || dd < s || dd > e) continue;      // netreturns와 동일한 기간 판정
            const no = Number(it.product_no);
            if (!no) continue;
            const { request, accept } = splitClaimReason(it.claim_reason);
            items.push({
              product_no: no,
              product_name: String(it.product_name ?? ""),
              option: String(it.option_value ?? "").trim(),
              qty: num(it.quantity),
              date: dd,
              request, accept,
              claim: String(it.claim_code ?? o.order_id ?? ""),
            });
          }
        }
      });
      return respond({ period: { start: s, end: e }, basis: "item_delivered_date", items });
    }

    // ── 기간 내 품목별 결제수량 (안정재고 편성 + 광고관리자 실결제 수 열) ──
    // 결제일 기준으로 주문을 수집해 product_no + option_value 단위로 수량 합산.
    // 주의: 카페24 date_type의 결제일 값은 payment_date가 아니라 `pay_date` (다른 값은 422 반환).
    // items: [{product_no, product_name, option_value, paid_qty}]
    // 권한: 관리자 전용 (2026-08-26 admgr용으로 admin+staff로 잠깐 열었다가, 같은 날
    // 광고관리자 메뉴가 관리자 전용이 되면서 원래대로 축소 — staff 소비처 없음)
    if (action === "paiditems") {
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);

      type Item = {
        product_no: number; product_name: string; option_value: string;
        paid_qty: number; canceled_qty: number;
      };
      const map = new Map<string, Item>();
      // 취소·반품으로 되돌아간 수량은 별도 집계 (결제수량 자체는 그대로 유지)
      const CANCELED = new Set(["C40", "R40", "R30", "R34"]);
      let orderCount = 0;
      await eachOrder(token, "date_type=pay_date&embed=items&fields=order_id,items", s, e, (orders) => {
        orderCount += orders.length;
        for (const o of orders) {
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            const no = Number(it.product_no);
            if (!no) continue;
            const opt = String(it.option_value ?? "").trim();
            const key = `${no}|${opt}`;
            let row = map.get(key);
            if (!row) {
              row = {
                product_no: no, product_name: String(it.product_name ?? ""),
                option_value: opt, paid_qty: 0, canceled_qty: 0,
              };
              map.set(key, row);
            }
            const qty = num(it.quantity);
            row.paid_qty += qty;
            if (CANCELED.has(String(it.order_status ?? ""))) row.canceled_qty += qty;
          }
        }
      });

      // 전체 상품명 목록 — 기간 내 결제가 0건인 상품도 "카페24에 존재함"을 판정하려면 필요.
      // (이게 없으면 판매 0건 재고가 '미매칭'과 구분되지 않음)
      // 주의: /admin/products는 limit 최대 100 (초과 시 422), offset은 정상 동작
      const products: { product_no: number; product_name: string }[] = [];
      const PLIMIT = 100;
      for (let offset = 0; offset <= 20000; offset += PLIMIT) {
        const body = await apiGet(
          `${API_BASE}/admin/products?limit=${PLIMIT}&offset=${offset}&fields=product_no,product_name`, token);
        const ps = (body.products ?? []) as Record<string, unknown>[];
        for (const p of ps) {
          products.push({ product_no: Number(p.product_no), product_name: String(p.product_name ?? "") });
        }
        if (ps.length < PLIMIT) break;
      }

      const items = [...map.values()].sort((a, b) => b.paid_qty - a.paid_qty);
      return respond({
        period: { start: s, end: e },
        order_count: orderCount, item_count: items.length,
        product_count: products.length,
        items, products,
      });
    }

    // ── 판매 성과: 기간 판매수량 + 취소·반품완료 수량 + 판매가·공급가 ──
    // rows: [{product_no, product_name, paid_qty(주문수량), order_amount(주문금액),
    //          cancel_qty(취소·반품완료 수량), price(판매가), supply_price(공급가)}]
    if (action === "performance") {
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);   // 키에 역할 포함됨

      // ① 기간 판매(주문) 수량·금액 — 애널리틱스
      const base = new URLSearchParams({ mall_id: MALL_ID, start_date: s, end_date: e });
      const sales = await collectData("/products/sales", "sales", base, token);

      type Perf = {
        product_no: number; product_name: string;
        paid_qty: number; order_amount: number; cancel_qty: number;
        price: number; supply_price: number;
      };
      const map = new Map<number, Perf>();
      for (const r of sales) {
        const no = Number(r.product_no);
        const cur = map.get(no) ?? {
          product_no: no, product_name: String(r.product_name ?? ""),
          paid_qty: 0, order_amount: 0, cancel_qty: 0, price: 0, supply_price: 0,
        };
        cur.paid_qty += num(r.order_product_count);
        cur.order_amount += num(r.order_amount);
        map.set(no, cur);
      }

      // ② 취소·반품 완료 수량 — 주문 품목(C40/R40) 집계 (주문일 기준, 전 채널)
      await eachOrder(token,
        "date_type=order_date&order_status=C40,R40&embed=items&fields=order_id,items", s, e, (orders) => {
        for (const o of orders) {
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            const st = String(it.order_status ?? "");
            if (st !== "C40" && st !== "R40") continue;
            const row = map.get(Number(it.product_no));
            if (row) row.cancel_qty += num(it.quantity);
          }
        }
      });

      // ③ 판매가·공급가 — 상품 정보 (100개씩 배치)
      const nos = [...map.keys()];
      for (let i = 0; i < nos.length; i += 100) {
        const chunk = nos.slice(i, i + 100).join(",");
        const body = await apiGet(
          `${API_BASE}/admin/products?product_no=${chunk}` +
          `&fields=product_no,product_name,price,supply_price&limit=100`, token);
        for (const p of (body.products ?? []) as Record<string, unknown>[]) {
          const row = map.get(Number(p.product_no));
          if (!row) continue;
          row.price = num(p.price);
          row.supply_price = num(p.supply_price);
          if (!row.product_name) row.product_name = String(p.product_name ?? "");
        }
      }

      const rows = [...map.values()].sort((a, b) => b.paid_qty - a.paid_qty);
      // 주문금액(판매합계)은 관리자만 — 직원·CS는 UI에서도 숨김/블러 처리되는 값이라 서버에서 0으로 제거
      if (authed.role !== "admin") for (const r of rows) r.order_amount = 0;
      return respond({ period: { start: s, end: e }, product_count: rows.length, rows });
    }

    // ── 조회수 + 주문수 통합 (기본) ──
    const startDate = url.searchParams.get("start_date");
    const endDate = url.searchParams.get("end_date");
    if (!startDate || !endDate) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);

    const base = new URLSearchParams({ mall_id: MALL_ID, start_date: startDate, end_date: endDate });
    const device = url.searchParams.get("device_type");
    if (device && device !== "total") base.set("device_type", device);

    const [views, sales] = await Promise.all([
      collectData("/products/view", "view", base, token),
      collectData("/products/sales", "sales", base, token),
    ]);

    // product_no 기준 조인
    type Row = {
      product_no: number; product_name: string;
      views: number; order_count: number; order_qty: number; order_amount: number; rate: number;
    };
    const map = new Map<number, Row>();
    const rowOf = (no: number, name: string): Row => {
      let r = map.get(no);
      if (!r) {
        r = { product_no: no, product_name: name, views: 0, order_count: 0, order_qty: 0, order_amount: 0, rate: 0 };
        map.set(no, r);
      }
      if (name && !r.product_name) r.product_name = name;
      return r;
    };
    for (const v of views) {
      const r = rowOf(Number(v.product_no), String(v.product_name ?? ""));
      r.views += num(v.count);
    }
    for (const s of sales) {
      const r = rowOf(Number(s.product_no), String(s.product_name ?? ""));
      r.order_count += num(s.order_count);
      r.order_qty += num(s.order_product_count);
      r.order_amount += num(s.order_amount);
    }

    const rows = [...map.values()];
    for (const r of rows) r.rate = r.views > 0 ? +(r.order_count / r.views * 100).toFixed(2) : 0;
    rows.sort((a, b) => b.views - a.views);

    const totals = rows.reduce((t, r) => ({
      views: t.views + r.views,
      order_count: t.order_count + r.order_count,
      order_qty: t.order_qty + r.order_qty,
      order_amount: t.order_amount + r.order_amount,
    }), { views: 0, order_count: 0, order_qty: 0, order_amount: 0 });

    return json({
      period: { start: startDate, end: endDate },
      device_type: device ?? "total",
      product_count: rows.length,
      totals: { ...totals, rate: totals.views > 0 ? +(totals.order_count / totals.views * 100).toFixed(2) : 0 },
      rows,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
