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
import { handleOptions, json, getToken, saveToken } from "../_shared/util.ts";

const MALL_ID = Deno.env.get("CAFE24_MALL_ID")!;
const CLIENT_ID = Deno.env.get("CAFE24_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("CAFE24_CLIENT_SECRET")!;
const API_BASE = `https://${MALL_ID}.cafe24api.com/api/v2`;
const DATA_BASE = "https://ca-api.cafe24data.com";
const API_VERSION = "2026-03-01";

// ── 액세스 토큰 확보 (만료 임박 시 refresh) — cafe24-claims와 동일 로직 ──
async function getAccessToken(): Promise<string> {
  const t = await getToken("cafe24");
  if (!t?.refresh_token) throw new Error("카페24 미연동: 먼저 cafe24-oauth?action=start 로 인증하세요.");

  const expiresAt = t.expires_at ? new Date(t.expires_at).getTime() : 0;
  const stillValid = expiresAt - Date.now() > 5 * 60 * 1000;
  if (stillValid && t.access_token) return t.access_token;

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

async function apiGet(url: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Cafe24-Api-Version": API_VERSION,
    },
  });
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
      const LIMIT = 100;
      const nos: number[] = [];
      for (let offset = 0; offset <= 10000; offset += LIMIT) {
        const body = await apiGet(
          `${API_BASE}/admin/categories/${catNo}/products?display_group=1&limit=${LIMIT}&offset=${offset}`, token);
        const items = (body.products ?? []) as Record<string, unknown>[];
        nos.push(...items.map((p) => Number(p.product_no)));
        if (items.length < LIMIT) break;
      }
      return json({ category_no: Number(catNo), product_nos: nos });
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
