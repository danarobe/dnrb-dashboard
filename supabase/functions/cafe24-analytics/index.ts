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
import { handleOptions, json, getToken, saveToken, verifyAuthToken } from "../_shared/util.ts";

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

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "summary";

  try {
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
      const authed = await verifyAuthToken(req);
      if (!authed || authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
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
      const authed = await verifyAuthToken(req);
      if (!authed || authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const e = url.searchParams.get("end_date");
      if (!e) return json({ error: "end_date 필수 (YYYY-MM-DD)" }, 400);
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
      const LIMIT = 500;
      for (let offset = 0; offset <= 60000; offset += LIMIT) {
        const body = await apiGet(
          `${API_BASE}/admin/orders?start_date=${fetchStart}&end_date=${fetchEnd}&date_type=shipend_date` +
          `&embed=items&fields=order_id,items&limit=${LIMIT}&offset=${offset}`, token);
        const orders = (body.orders ?? []) as Record<string, unknown>[];
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
        if (orders.length < LIMIT) break;
      }

      const metrics: Record<string, M> = {};
      for (const [no, m] of map) metrics[String(no)] = m;
      return json({ period: { end: e, start7: s7, start21: s21, loss_start: lossS, loss_end: lossE }, metrics });
    }

    // ── 상품 기본 정보 배치 조회 (관리자 전용): 진열 계산용 ──
    if (action === "productinfo") {
      const authed = await verifyAuthToken(req);
      if (!authed || authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
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

      const NET_RETURN_STATUSES = new Set(["R40", "R30", "R34"]);
      type Opt = { option: string; total_qty: number; return_qty: number };
      type Row = {
        product_no: number; product_name: string; total_qty: number; return_qty: number;
        opts: Map<string, Opt>;
      };
      const map = new Map<number, Row>();
      const LIMIT = 500;
      let totalQty = 0, returnQty = 0;
      // 주문 단위 shipend_date는 부분배송 시 기간 밖 품목까지 포함하므로,
      // 주문은 여유 범위로 수집한 뒤 '품목별 배송완료일(delivered_date)'로 정확히 필터
      // (관리자 전체주문조회의 배송완료일 검색과 동일 기준 — 실측 검증 완료)
      const day = 24 * 3600 * 1000;
      const pad = (d: Date) => d.toISOString().slice(0, 10);
      const fetchStart = pad(new Date(new Date(s).getTime() - 7 * day));
      const fetchEnd = pad(new Date(Math.min(new Date(e).getTime() + 30 * day, Date.now())));
      for (let offset = 0; offset <= 60000; offset += LIMIT) {
        const body = await apiGet(
          `${API_BASE}/admin/orders?start_date=${fetchStart}&end_date=${fetchEnd}&date_type=shipend_date` +
          `&embed=items&fields=order_id,items&limit=${LIMIT}&offset=${offset}`, token);
        const orders = (body.orders ?? []) as Record<string, unknown>[];
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
        if (orders.length < LIMIT) break;
      }
      const rows = [...map.values()].map((r) => ({
        product_no: r.product_no, product_name: r.product_name,
        total_qty: r.total_qty, return_qty: r.return_qty,
        net_return_rate: r.total_qty > 0 ? +(r.return_qty / r.total_qty * 100).toFixed(2) : 0,
        options: [...r.opts.values()].map((o) => ({
          ...o,
          net_return_rate: o.total_qty > 0 ? +(o.return_qty / o.total_qty * 100).toFixed(2) : 0,
        })).sort((a, b) => b.total_qty - a.total_qty),
      })).sort((a, b) => b.return_qty - a.return_qty);
      return json({
        period: { start: s, end: e },
        basis: "item_delivered_date",
        totals: {
          total_qty: totalQty, return_qty: returnQty,
          net_return_rate: totalQty > 0 ? +(returnQty / totalQty * 100).toFixed(2) : 0,
        },
        rows,
      });
    }

    // ── 판매 성과: 기간 판매수량 + 취소·반품완료 수량 + 판매가·공급가 ──
    // rows: [{product_no, product_name, paid_qty(주문수량), order_amount(주문금액),
    //          cancel_qty(취소·반품완료 수량), price(판매가), supply_price(공급가)}]
    if (action === "performance") {
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);

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
      const LIMIT = 100;
      for (let offset = 0; offset <= 8000; offset += LIMIT) {
        const body = await apiGet(
          `${API_BASE}/admin/orders?start_date=${s}&end_date=${e}&date_type=order_date` +
          `&order_status=C40,R40&embed=items&fields=order_id,items&limit=${LIMIT}&offset=${offset}`, token);
        const orders = (body.orders ?? []) as Record<string, unknown>[];
        for (const o of orders) {
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            const st = String(it.order_status ?? "");
            if (st !== "C40" && st !== "R40") continue;
            const row = map.get(Number(it.product_no));
            if (row) row.cancel_qty += num(it.quantity);
          }
        }
        if (orders.length < LIMIT) break;
      }

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
      return json({ period: { start: s, end: e }, product_count: rows.length, rows });
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
