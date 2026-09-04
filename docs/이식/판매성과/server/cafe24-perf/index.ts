// ═══════════════════════════════════════════════════════════════
// cafe24-perf — 판매 성과 이식용 Edge Function (danarobe/dnrb-dashboard 에서 발췌, 2026-09-04)
//   GET ?action=performance&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
//     → { period, product_count, rows:[{product_no, product_name, paid_qty, order_amount, cancel_qty, price, supply_price}] }
//   GET ?action=netreturns&start_date&end_date
//     → { period, basis:"item_delivered_date", totals:{total_qty, return_qty, net_return_rate}, rows:[{..., options:[...]}] }
//   GET ?action=returnreasons&start_date&end_date
//     → { period, items:[{product_no, product_name, option, qty, date, request, accept, claim}] }
//
// 데이터 출처
//   판매수량·주문금액 — 카페24 애널리틱스 API /products/sales (scope mall.read_analytics)
//   취소·반품 수량·사유 — Admin API /admin/orders (embed=items, scope mall.read_order)
//   판매가·공급가     — Admin API /admin/products (scope mall.read_product)
//
// 필요 secrets: CAFE24_MALL_ID, CAFE24_CLIENT_ID, CAFE24_CLIENT_SECRET, PERF_API_KEY(아래 인증 어댑터용)
// 필요 테이블: api_tokens, api_cache (sql/schema.sql)
// 최초 1회 카페24 OAuth 인증: cafe24-oauth?action=start
//
// ⚠ 원본(cafe24-analytics)은 자체 로그인 토큰 검증으로 보호한다. 여기서는 이식처가 갈아끼우기 쉽도록
//   x-api-key 헤더 비교로 단순화했다 — 반드시 이식처의 인증으로 교체하거나, 최소한 키를 서버(백엔드)에서만 쓸 것.
//   (브라우저에 키를 심으면 누구나 카페24 데이터를 긁어갈 수 있다.)
// ═══════════════════════════════════════════════════════════════
import { cacheGet, cacheSet, handleOptions, json, getToken, saveToken } from "../_shared/util.ts";

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
  const action = url.searchParams.get("action") ?? "performance";

  try {
    // ── [인증 어댑터] 이식처의 인증으로 교체할 자리 ──
    const apiKey = Deno.env.get("PERF_API_KEY") ?? "";
    if (!apiKey || req.headers.get("x-api-key") !== apiKey) return json({ error: "인증 실패" }, 401);

    // ── 결과 캐시 (10분) — 무거운 주문 스캔을 같은 조건으로 다시 돌리지 않는다.
    //    ⚠ 반드시 인증 검사 뒤에 fromCache()를 부를 것 (캐시가 인증 우회 통로가 되면 안 됨).
    //    역할별로 응답이 달라지게 만들면 캐시 키에 역할을 넣어야 한다 (원본은 performance에 role 포함).
    const qsKey = new URLSearchParams(url.search);
    qsKey.delete("nocache"); qsKey.sort();
    const cacheKey = `perf:${qsKey.toString()}`;
    const noCache = url.searchParams.get("nocache") === "1";
    const fromCache = async () => noCache ? null : await cacheGet(cacheKey, 10 * 60 * 1000);
    const respond = async (body: unknown) => { await cacheSet(cacheKey, body); return json(body); };

    const token = await getAccessToken();

    if (action === "performance") {
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);

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
      // [이식 메모] 원본은 관리자가 아니면 여기서 order_amount를 0으로 지웠다(역할별 금액 비공개). 필요하면 인증 어댑터의 역할로 같은 처리를 추가할 것.
      return respond({ period: { start: s, end: e }, product_count: rows.length, rows });
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

    return json({ error: "unknown action (performance | netreturns | returnreasons)" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
