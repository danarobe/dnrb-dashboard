// ═══════════════════════════════════════════════
// cafe24-product — 상품 등록 전용 카페24 앱 (2026-11-25 사용자 결정)
//
// 왜 따로인가: 상품 쓰기(mall.write_product)는 삭제·전체 가격 변경까지 되는 넓은 권한이라
//   2026-09-29에 워크스페이스 앱(UzeJXo, cafe24-oauth)에는 넣지 않기로 했다. 상품 관리 시스템의
//   '업로드 대기' 상품을 엑셀 대신 API로 등록하기로 하면서(2026-11-25), 이 권한은
//   **새 전용 앱 하나에만** 주고 그 토큰은 **이 함수 안에서만** 쓴다.
//   - 토큰은 api_tokens provider='cafe24p' (기존 'cafe24'와 다른 앱 → 서로 무효화되지 않음)
//   - 다른 함수는 이 토큰을 읽지 않는다 (tools/check_cafe24_product_writes.sh 가 검사)
//
// 액션
//   POST ?action=start_url     (관리자 로그인) → 카페24 동의 화면 주소 {url} — state는 서명·10분 만료
//   GET  ?code=…&state=…       카페24가 돌아오는 redirect_uri → 토큰 저장 → 워크스페이스로 돌아감
//   GET  ?action=status        (관리자) 연동 상태·권한(scope)·마지막 자동 갱신 · &live=1 이면 실제로 읽어 확인
//   POST ?action=refresh       (x-cron-secret) 매일 자동 갱신 — 2주 안 쓰면 refresh 토큰이 만료되므로
//   GET  ?action=lookups       (관리자·상품관리) 분류·메인 진열 영역·최근 상품의 아이콘/진열/분류 사용 빈도 (읽기만)
//   POST ?action=register      (관리자·상품관리) 상품 관리 시스템 상품 하나를 숨김·판매 안 함으로 등록 — 2단계(2026-11-25)
//   POST ?action=reg_list      (관리자·상품관리) {npm_ids} → 등록 기록
//   GET  ?action=compare&product_no=&ref=  (관리자·상품관리) 우리가 만든 상품과 엑셀로 만든 상품의 설정 칸 비교
//   상품관리 서버는 x-sync-secret = **전용 비밀키 CAFE24P_SYNC_SECRET**으로 부른다(다른 연동의 NPM_SYNC_SECRET과 따로 — 보안 검토 2026-11-25) — 이 세 액션과 lookups만
//
// 안전장치 (카페24로 값을 보내는 곳은 c24pWrite 하나뿐)
//   ① DELETE는 보내지 않는다 — 허용 목록 WRITE_RULES 에 없음
//   ② 허용 목록 밖의 주소·메서드는 거부
//   ③ 상품을 만들 때는 진열·판매를 항상 'F'(숨김·판매 안 함)로 덮어쓴다
//   ④ 상품번호가 들어가는 쓰기는 **이 시스템이 만든 상품(c24p_registry)** 일 때만 — 기존 상품은 못 건드린다
//   ⑤ 쓰기마다 c24p_log 에 기록 (사진 원본 등 본문은 저장하지 않음)
//
// 필요 secrets: CAFE24_MALL_ID(공용), CAFE24P_CLIENT_ID, CAFE24P_CLIENT_SECRET, CAFE24P_SYNC_SECRET, AUTH_SECRET, CRON_SECRET, DASHBOARD_URL
// ═══════════════════════════════════════════════
import { handleOptions, json, getToken, saveToken, verifyAuthToken, safeEqual } from "../_shared/util.ts";

const MALL_ID = Deno.env.get("CAFE24_MALL_ID") ?? "";
const CLIENT_ID = Deno.env.get("CAFE24P_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("CAFE24P_CLIENT_SECRET") ?? "";
const PROVIDER = "cafe24p";
// 개발자센터 전용 앱 권한(2026-11-25 사용자가 켬): 상품 읽기·쓰기, 상품분류 읽기, 디자인 읽기 (+앱 기본)
//   ⚠ 여기에 더 넣으려면 개발자센터 앱 권한을 먼저 켜고 저장한 뒤 다시 연동해야 한다(아니면 invalid_scope).
const SCOPE = "mall.read_product,mall.write_product,mall.read_category,mall.read_design";
const API_BASE = `https://${MALL_ID}.cafe24api.com/api/v2`;
// 새 앱은 2026-09-01만 받음(2026-03-01을 보내면 400 — 2026-11-25 실측)
const API_VERSION = "2026-09-01";

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = (Deno.env.get("SB_SERVICE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) ?? "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 우리 DB (서비스 키) ──
async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}
async function stateGet(k: string): Promise<Record<string, unknown> | null> {
  const r = await sb(`c24p_state?k=eq.${encodeURIComponent(k)}&select=v,at`);
  if (!r.ok) return null;
  const row = (await r.json())[0];
  return row ? { ...(row.v ?? {}), at: row.at } : null;
}
async function stateSet(k: string, v: Record<string, unknown>): Promise<void> {
  await sb(`c24p_state?on_conflict=k`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ k, v, at: new Date().toISOString() }),
  });
}

// ── state 서명 (연동 시작을 관리자 로그인으로만 열고, 돌아온 요청이 우리가 보낸 것인지 확인) ──
const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
async function hmac(data: string): Promise<string> {
  const secret = Deno.env.get("AUTH_SECRET") ?? "";
  if (!secret) throw new Error("AUTH_SECRET 미설정");
  // 로그인 토큰과 섞이지 않게 파생 키 사용
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret + "|cafe24p-state"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64u(String.fromCharCode(...new Uint8Array(sig)));
}
async function makeState(uid: string, name: string): Promise<string> {
  const p = b64u(unescape(encodeURIComponent(JSON.stringify({ uid, name, exp: Date.now() + 10 * 60 * 1000 }))));
  return `${p}.${await hmac(p)}`;
}
async function readState(s: string): Promise<{ uid: string; name: string } | null> {
  const [p, sig] = String(s || "").split(".");
  if (!p || !sig || !safeEqual(sig, await hmac(p))) return null;
  try {
    const o = JSON.parse(decodeURIComponent(escape(unb64u(p))));
    if (!o.exp || o.exp < Date.now()) return null;
    return { uid: String(o.uid), name: String(o.name ?? "") };
  } catch { return null; }
}

function selfUrl(): string {
  // 개발자센터 Redirect URI와 한 글자도 다르면 안 된다 (2026-11-25 등록값)
  return `${SB_URL}/functions/v1/cafe24-product`;
}

function textResponse(msg: string, status = 200): Response {
  // 게이트웨이가 text/html을 text/plain으로 바꾸므로 BOM 붙인 일반 텍스트
  return new Response(`﻿${msg}`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
}

// ── 토큰 ──
async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token ${res.status}: ${String((body as Record<string, unknown>).error_description ?? (body as Record<string, unknown>).error ?? "")}`);
  return body as Record<string, unknown>;
}
async function persist(body: Record<string, unknown>, prevRefresh = ""): Promise<string> {
  const now = Date.now();
  const access = String(body.access_token ?? "");
  await saveToken({
    provider: PROVIDER,
    access_token: access,
    refresh_token: String(body.refresh_token ?? prevRefresh),
    expires_at: body.expires_at ? new Date(String(body.expires_at)).toISOString() : new Date(now + 2 * 3600e3).toISOString(),
    refresh_expires_at: body.refresh_token_expires_at ? new Date(String(body.refresh_token_expires_at)).toISOString() : new Date(now + 14 * 86400e3).toISOString(),
  });
  if (Array.isArray(body.scopes)) await stateSet("scopes", { scopes: body.scopes });
  return access;
}
// force: 401(다른 요청이 먼저 갱신) 복구용 강제 재발급
async function accessToken(force = false): Promise<string> {
  const t = await getToken(PROVIDER);
  if (!t?.refresh_token) throw new Error("상품 등록용 카페24가 연동되지 않았습니다 — 워크스페이스에서 '상품 등록용 연동'을 먼저 해 주세요");
  const exp = t.expires_at ? new Date(t.expires_at).getTime() : 0;
  if (!force && t.access_token && exp - Date.now() > 5 * 60e3) return t.access_token;
  try {
    return await persist(await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token }), t.refresh_token);
  } catch (e) {
    await sleep(1500);   // 동시에 다른 요청이 갱신했으면 그 토큰을 쓴다
    const latest = await getToken(PROVIDER);
    if (latest?.access_token && latest.access_token !== t.access_token) return latest.access_token;
    throw e;
  }
}

// ── 카페24 읽기 (429·401 재시도) ──
async function c24Get(path: string): Promise<Record<string, unknown>> {
  let tok = await accessToken();
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "X-Cafe24-Api-Version": API_VERSION } });
    if (res.status === 401 && i === 0) { tok = await accessToken(true); continue; }
    if (res.status === 429) { await sleep(Number(res.headers.get("Retry-After")) * 1000 || 1000 * 2 ** i); continue; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`카페24 ${res.status}: ${JSON.stringify((body as Record<string, unknown>).error ?? body).slice(0, 300)}`);
    return body as Record<string, unknown>;
  }
  throw new Error("카페24 요청 한도 — 잠시 후 다시 시도하세요");
}

// ── 카페24 쓰기: 이 함수 하나만 값을 보낸다 ──
//   kind: create = 상품 만들기(진열·판매 F 강제) / own = 주소의 상품번호가 우리 등록 상품이어야 함
//         own_body = 본문의 product_no(들)가 우리 등록 상품이어야 함 / file = 상품과 무관한 본문 사진 업로드
const WRITE_RULES: { method: "POST" | "PUT"; re: RegExp; kind: "create" | "own" | "own_body" | "file" }[] = [
  { method: "POST", re: /^\/admin\/products$/, kind: "create" },
  { method: "PUT", re: /^\/admin\/products\/(\d+)$/, kind: "own" },
  { method: "POST", re: /^\/admin\/products\/(\d+)\/options$/, kind: "own" },
  { method: "PUT", re: /^\/admin\/products\/(\d+)\/variants$/, kind: "own" },
  { method: "POST", re: /^\/admin\/products\/(\d+)\/images$/, kind: "own" },
  { method: "POST", re: /^\/admin\/products\/(\d+)\/additionalimages$/, kind: "own" },
  { method: "POST", re: /^\/admin\/products\/(\d+)\/icons$/, kind: "own" },
  { method: "PUT", re: /^\/admin\/products\/(\d+)\/icons$/, kind: "own" },
  { method: "POST", re: /^\/admin\/categories\/(\d+)\/products$/, kind: "own_body" },
  { method: "POST", re: /^\/admin\/mains\/(\d+)\/products$/, kind: "own_body" },
  { method: "POST", re: /^\/admin\/products\/images$/, kind: "file" },
];

async function isOurProduct(nos: number[]): Promise<boolean> {
  const list = [...new Set(nos.filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length || list.length !== nos.length) return false;
  const r = await sb(`c24p_registry?product_no=in.(${list.join(",")})&select=product_no`);
  if (!r.ok) return false;
  return (await r.json()).length === list.length;
}

async function writeLog(row: Record<string, unknown>): Promise<void> {
  try { await sb(`c24p_log`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) }); } catch { /* 기록 실패는 쓰기 결과를 바꾸지 않음 */ }
}

async function c24pWrite(method: "POST" | "PUT", path: string, body: Record<string, unknown>, who: { name: string; npm_id?: string }): Promise<Record<string, unknown>> {
  const rule = WRITE_RULES.find((r) => r.method === method && r.re.test(path));
  if (!rule) throw new Error(`허용되지 않은 카페24 쓰기: ${method} ${path}`);
  const req = (body.request ?? body.requests) as unknown;
  if (rule.kind === "create") {
    if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("상품 만들기 본문 형식 오류");
    const r = req as Record<string, unknown>;
    r.display = "F"; r.selling = "F";   // ③ 숨김·판매 안 함 고정 (2026-11-25)
  } else if (rule.kind === "own") {
    const no = Number(path.match(rule.re)?.[1]);
    if (!(await isOurProduct([no]))) throw new Error(`이 시스템이 등록한 상품이 아니라 바꿀 수 없습니다 (상품번호 ${no})`);
  } else if (rule.kind === "own_body") {
    const r = (req ?? {}) as Record<string, unknown>;
    const raw = r.product_no;
    const nos = (Array.isArray(raw) ? raw : [raw]).map((n) => Number(n));
    if (!(await isOurProduct(nos))) throw new Error("이 시스템이 등록한 상품이 아니라 분류·진열을 바꿀 수 없습니다");
  }
  let tok = await accessToken();
  let last: Response | null = null;
  for (let i = 0; i < 6; i++) {
    last = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "X-Cafe24-Api-Version": API_VERSION },
      body: JSON.stringify(body),
    });
    if (last.status === 401 && i === 0) { tok = await accessToken(true); continue; }
    if (last.status === 429) { await sleep(Number(last.headers.get("Retry-After")) * 1000 || 1000 * 2 ** i); continue; }
    break;
  }
  const res = last!;
  const out = await res.json().catch(() => ({})) as Record<string, unknown>;
  await writeLog({ by_name: who.name, npm_id: who.npm_id ?? null, method, path, status: res.status, ok: res.ok, note: res.ok ? null : JSON.stringify(out.error ?? out).slice(0, 500) });
  if (!res.ok) throw new Error(`카페24 ${res.status}: ${JSON.stringify(out.error ?? out).slice(0, 300)}`);
  return out;
}

// ═══ 2단계: 숨김 등록 (2026-11-25) ═══
// 엑셀(상품관리 lib/excel-export.ts exportCafe24Upload)과 같은 뜻의 고정값 — 엑셀로 만든 실제 상품(2565·2572)을 읽어 맞춤.
//   진열·판매는 c24pWrite 가 F로 덮어쓴다. 배송기간·공급사·요약설명 등 엑셀에 없거나 사람이 따로 넣는 칸은 보내지 않는다.
const FIXED = {
  product_condition: "N", retail_price: 0, tax_type: "A",
  origin_classification: "F", origin_place_no: 1798, made_in_code: "KR",
  product_shipping_type: "C", shipping_scope: "A",
  minimum_quantity: 1, maximum_quantity: 0, order_quantity_limit_type: "O",
  adult_certification: "F", exposure_limit_type: "A",
  use_naverpay: "T", naverpay_type: "C", image_upload_type: "A",
} as const;
// 엑셀로 만든 상품과 비교할 설정 칸(상품마다 다른 이름·가격·사진·분류는 뺌)
const COMPARE_KEYS = [
  "product_condition", "retail_price", "tax_type", "tax_rate", "origin_classification", "origin_place_no", "made_in_code",
  "product_shipping_type", "shipping_scope", "shipping_fee_by_product", "shipping_calculation", "minimum_quantity", "maximum_quantity",
  "order_quantity_limit_type", "buy_unit", "buy_unit_type", "buy_limit_by_product", "adult_certification", "exposure_limit_type",
  "use_naverpay", "naverpay_type", "points_by_product", "except_member_points", "separated_mobile_description", "image_upload_type",
  "has_option", "option_type", "manufacturer_code", "brand_code", "trend_code", "single_purchase", "repurchase_restriction",
  "select_one_by_option", "product_weight", "classification_code",
];

type RegIn = {
  npm_id: string; product_name: string; supply_product_name: string; internal_product_name: string;
  price: number; supply_price: number; colors: { name: string; code: string }[]; sizes: string[];
  categories: number[]; mains: number[]; icons: string[]; icon_start: string; icon_days: number;
};
const nfc = (v: unknown) => String(v ?? "").normalize("NFC").trim();
const kstToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
function addDays(d: string, n: number): string {
  const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
}

// 입력 검사 — 모자라거나 이상하면 카페24로 아무것도 보내지 않는다
async function checkRegInput(b: Record<string, unknown>): Promise<RegIn> {
  const bad = (m: string) => { throw new Error(m); };
  const npm_id = nfc(b.npm_id);
  if (!/^[0-9a-f-]{36}$/.test(npm_id)) bad("상품 번호(npm_id) 형식 오류");
  const product_name = nfc(b.product_name), supply_product_name = nfc(b.supply_product_name), internal_product_name = nfc(b.internal_product_name);
  if (!product_name || product_name.length > 250) bad("판매 상품명이 비었거나 250자를 넘어요");
  if (supply_product_name.length > 250) bad("공급사 상품명이 250자를 넘어요");
  if (internal_product_name.length > 50) bad("상품명(관리용)이 50자를 넘어요");
  const price = Number(b.price), supply_price = Number(b.supply_price);
  if (!Number.isInteger(price) || price < 1000 || price > 10_000_000) bad("판매가가 비었거나 범위(1,000~10,000,000원) 밖이에요");
  if (price % 10 !== 0) bad("판매가는 10원 단위여야 해요");
  if (!Number.isInteger(supply_price) || supply_price < 0) bad("공급가(원가)가 올바르지 않아요");
  if (supply_price >= price) bad("공급가가 판매가보다 크거나 같아요 — 가격을 확인해 주세요");
  const colors = (Array.isArray(b.colors) ? b.colors : []).map((c) => ({ name: nfc((c as Record<string, unknown>).name), code: nfc((c as Record<string, unknown>).code) }));
  if (colors.length > 30) bad("색상이 30개를 넘어요");
  for (const c of colors) {
    if (!c.name || c.name.length > 50) bad("색상 이름이 비었거나 너무 길어요");
    if (!/^#[0-9A-Fa-f]{6}$/.test(c.code)) bad(`색상 '${c.name}'의 색상 코드가 없어요 — 상품관리 색상 목록에 있는 이름인지 확인해 주세요`);
  }
  const sizes = (Array.isArray(b.sizes) ? b.sizes : []).map(nfc).filter(Boolean);
  if (sizes.length > 20 || sizes.some((x) => x.length > 30)) bad("사이즈가 너무 많거나 길어요");
  if (new Set(colors.map((c) => c.name)).size !== colors.length || new Set(sizes).size !== sizes.length) bad("같은 색상·사이즈가 두 번 있어요");
  const nums = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
  const categories = [...new Set(nums(b.categories))], mains = [...new Set(nums(b.mains))];
  // 분류·메인 진열·아이콘은 비워도 된다 — 간편 등록 모드(2026-11-25 사용자 요청): 그 칸은 카페24에서 사람이 고른다
  if (categories.length > 10 || mains.length > 5) bad("분류는 10개, 메인 진열은 5개까지예요");
  const icons = [...new Set((Array.isArray(b.icons) ? b.icons : []).map(nfc))];
  if (icons.length > 5 || icons.some((x) => !/^icon_global_\d{2}$/.test(x))) bad("아이콘 형식 오류(최대 5개)");
  const icon_start = nfc(b.icon_start) || kstToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(icon_start)) bad("아이콘 표시 시작일 형식 오류");
  const icon_days = Number(b.icon_days ?? 4);
  if (!Number.isInteger(icon_days) || icon_days < 1 || icon_days > 30) bad("아이콘 표시 기간은 1~30일이에요");
  // 분류·메인 진열은 쇼핑몰에 실제로 있는 번호만 (고른 게 있을 때만 확인)
  if (categories.length || mains.length) {
    const [cb, mb] = await Promise.all([c24Get(`/admin/categories?limit=100&fields=category_no`), c24Get(`/admin/mains`)]);
    const catSet = new Set(((cb.categories ?? []) as Record<string, unknown>[]).map((c) => Number(c.category_no)));
    const mainSet = new Set(((mb.mains ?? []) as Record<string, unknown>[]).map((m) => Number(m.display_group)));
    const noCat = categories.filter((c) => !catSet.has(c)), noMain = mains.filter((m) => !mainSet.has(m));
    if (noCat.length) bad(`쇼핑몰에 없는 분류 번호: ${noCat.join(", ")}`);
    if (noMain.length) bad(`쇼핑몰에 없는 메인 진열 번호: ${noMain.join(", ")}`);
  }
  return { npm_id, product_name, supply_product_name, internal_product_name, price, supply_price, colors, sizes, categories, mains, icons, icon_start, icon_days };
}

async function regGet(npm_id: string): Promise<Record<string, unknown> | null> {
  const r = await sb(`c24p_registry?npm_id=eq.${encodeURIComponent(npm_id)}&select=*`);
  if (!r.ok) throw new Error("등록 기록을 읽지 못했어요");
  return (await r.json())[0] ?? null;
}
async function regPatch(npm_id: string, patch: Record<string, unknown>): Promise<void> {
  const r = await sb(`c24p_registry?npm_id=eq.${encodeURIComponent(npm_id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
  if (!r.ok) throw new Error("등록 기록 저장 실패");
}

// 같은 이름 상품이 이미 있는지 (엑셀로 이미 올렸을 때 두 번 만들지 않게)
async function sameNameProducts(name: string): Promise<number[]> {
  const b = await c24Get(`/admin/products?limit=100&fields=product_no,product_name&product_name=${encodeURIComponent(name)}`);
  return ((b.products ?? []) as Record<string, unknown>[]).filter((p) => nfc(p.product_name) === name).map((p) => Number(p.product_no));
}

// 같은 상품을 동시에 두 번 처리하지 않게 잠금 — UPDATE 한 문장(WHERE에 잠금 조건)이라 두 요청 중 하나만 잡는다.
//   잠금 시간 10분 = 엣지 함수 한 번의 최대 실행 시간보다 길다(함수가 먼저 끝나므로 실행 중에 잠금이 풀리지 않음).
//   잠근 요청만 풀고(lock_by 토큰), 상품 만들기 직전에 토큰·상품번호를 다시 확인한다(보안 검토 2026-11-25).
const LOCK_MS = 10 * 60e3;
async function regLock(npm_id: string, token: string): Promise<Record<string, unknown> | null> {
  const now = new Date().toISOString(), until = new Date(Date.now() + LOCK_MS).toISOString();
  const q = `npm_id=eq.${encodeURIComponent(npm_id)}&or=(lock_until.is.null,lock_until.lt.${encodeURIComponent(now)})`;
  const r = await sb(`c24p_registry?${q}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ lock_until: until, lock_by: token }) });
  if (!r.ok) throw new Error("등록 기록을 잠그지 못했어요");
  return (await r.json())[0] ?? null;
}
async function regUnlock(npm_id: string, token: string): Promise<void> {
  await sb(`c24p_registry?npm_id=eq.${encodeURIComponent(npm_id)}&lock_by=eq.${token}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ lock_until: null, lock_by: null }) });
}
// 아직 내가 잠금을 갖고 있는지 + 그 사이 상품번호가 생겼는지 (상품 만들기 직전)
async function regStillMine(npm_id: string, token: string): Promise<Record<string, unknown> | null> {
  const r = await sb(`c24p_registry?npm_id=eq.${encodeURIComponent(npm_id)}&lock_by=eq.${token}&lock_until=gt.${encodeURIComponent(new Date().toISOString())}&select=product_no`);
  if (!r.ok) return null;
  return (await r.json())[0] ?? null;
}

async function registerProduct(inp: RegIn, by: string): Promise<Record<string, unknown>> {
  // ① 기록 줄을 만들고(이미 있으면 그대로) → 잠금. 잠금을 못 잡으면 다른 요청이 진행 중
  const ins = await sb(`c24p_registry?on_conflict=npm_id`, { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ npm_id: inp.npm_id, state: "pending", by_name: by }) });
  if (!ins.ok) throw new Error("등록 기록을 만들지 못했어요");
  const token = crypto.randomUUID();
  const row = await regLock(inp.npm_id, token);
  if (!row) throw Object.assign(new Error("이 상품 등록이 이미 진행 중이에요 — 잠시 뒤 다시 눌러 주세요"), { status: 409 });
  try {
    return await registerSteps(inp, by, row, token);
  } finally {
    await regUnlock(inp.npm_id, token);
  }
}

async function registerSteps(inp: RegIn, by: string, row: Record<string, unknown>, token: string): Promise<Record<string, unknown>> {
  const steps: Record<string, unknown> = { ...((row?.steps ?? {}) as Record<string, unknown>) };
  await regPatch(inp.npm_id, { state: row?.product_no ? "created" : "pending", by_name: by });
  let no = row?.product_no ? Number(row.product_no) : 0;
  const who = { name: by, npm_id: inp.npm_id };

  // ② 상품 만들기 (한 번만) — 직전에 잠금·상품번호를 다시 확인
  if (!no) {
    const mine = await regStillMine(inp.npm_id, token);
    if (!mine) throw Object.assign(new Error("등록 잠금을 잃었어요 — 잠시 뒤 다시 눌러 주세요"), { status: 409 });
    if (mine.product_no) no = Number(mine.product_no);
  }
  if (!no) {
    const same = await sameNameProducts(inp.product_name);
    if (same.length) {
      await regPatch(inp.npm_id, { state: "failed", steps: { ...steps, create: { ok: false, error: "같은 이름 상품 있음", product_nos: same } } });
      throw Object.assign(new Error(`카페24에 같은 이름의 상품이 이미 있어요(상품번호 ${same.join(", ")}) — 엑셀로 이미 올린 상품이면 새로 만들지 않아요`), { status: 409, product_nos: same });
    }
    const out = await c24pWrite("POST", "/admin/products", {
      shop_no: 1,
      request: {
        ...FIXED,
        product_name: inp.product_name, supply_product_name: inp.supply_product_name, internal_product_name: inp.internal_product_name,
        price: inp.price, supply_price: inp.supply_price, has_option: "F",
        // 간편 등록(비운 칸)은 아예 보내지 않는다
        ...(inp.categories.length ? { add_category_no: inp.categories.map((c) => ({ category_no: c, recommend: "F", new: "F" })) } : {}),
        ...(inp.mains.length ? { main: inp.mains.map(String) } : {}),
        ...(inp.icons.length ? { icon: inp.icons } : {}),
      },
    }, who);
    no = Number((out.product as Record<string, unknown> | undefined)?.product_no);
    if (!no) throw new Error("카페24가 상품번호를 돌려주지 않았어요");
    steps.create = { ok: true, at: new Date().toISOString() };
    await regPatch(inp.npm_id, { product_no: no, state: "created", steps });
  }

  // ③ 옵션 (조합형 · 분리선택 · 컬러칩) — 엑셀 AK·AN열과 같은 뜻
  if (!(steps.options as Record<string, unknown> | undefined)?.ok && (inp.colors.length || inp.sizes.length)) {
    try {
      const options: Record<string, unknown>[] = [];
      if (inp.colors.length) options.push({ option_name: "컬러", option_value: inp.colors.map((c) => ({ option_text: c.name, option_color: c.code })) });
      if (inp.sizes.length) options.push({ option_name: "사이즈", option_value: inp.sizes.map((x) => ({ option_text: x })) });
      await c24pWrite("POST", `/admin/products/${no}/options`, { shop_no: 1, request: { has_option: "T", option_type: "T", option_list_type: "S", options } }, who);
      steps.options = { ok: true };
    } catch (e) { steps.options = { ok: false, error: String(e).slice(0, 300) }; }
    await regPatch(inp.npm_id, { steps });
  }

  // ④ 아이콘 표시 기간
  if (inp.icons.length && !(steps.icons as Record<string, unknown> | undefined)?.ok) {
    try {
      const end = addDays(inp.icon_start, inp.icon_days);
      await c24pWrite("PUT", `/admin/products/${no}/icons`, { shop_no: 1, request: {
        use_show_date: "T", show_start_date: `${inp.icon_start}T00:00:00+09:00`, show_end_date: `${end}T00:00:00+09:00`,
        image_list: inp.icons.map((code) => ({ code })),
      } }, who);
      steps.icons = { ok: true, start: inp.icon_start, end };
    } catch (e) { steps.icons = { ok: false, error: String(e).slice(0, 300) }; }
    await regPatch(inp.npm_id, { steps });
  }

  // ⑤ 다시 읽어 맞는지 스스로 확인
  const p = ((await c24Get(`/admin/products/${no}?embed=options`)).product ?? {}) as Record<string, unknown>;
  const opt = (p.options ?? {}) as Record<string, unknown>;
  const optList = (opt.options ?? []) as Record<string, unknown>[];
  const texts = (name: string) => (optList.find((o) => o.option_name === name)?.option_value as Record<string, unknown>[] | undefined ?? []);
  const colorOk = inp.colors.every((c) => texts("컬러").some((v) => v.option_text === c.name && String(v.option_color ?? "").toLowerCase() === c.code.toLowerCase())) && texts("컬러").length === inp.colors.length;
  const sizeOk = inp.sizes.every((x) => texts("사이즈").some((v) => v.option_text === x)) && texts("사이즈").length === inp.sizes.length;
  const cats = ((p.category ?? []) as Record<string, unknown>[]).map((c) => Number(c.category_no));
  const mainsGot = ((p.main ?? []) as unknown[]).map(Number);
  const iconsGot = ((p.icon ?? []) as unknown[]).map(String);
  const period = (p.icon_show_period ?? {}) as Record<string, unknown>;
  const checks = [
    { key: "hidden", label: "숨김·판매 안 함", ok: p.display === "F" && p.selling === "F" },
    { key: "name", label: "판매 상품명", ok: nfc(p.product_name) === inp.product_name },
    { key: "price", label: "판매가·공급가", ok: Number(p.price) === inp.price && Number(p.supply_price) === inp.supply_price },
    { key: "options", label: "옵션(컬러·사이즈)", ok: (inp.colors.length || inp.sizes.length) ? (opt.has_option === "T" && colorOk && sizeOk) : true },
    { key: "categories", label: "상품 분류", ok: inp.categories.every((c) => cats.includes(c)) },
    { key: "mains", label: "메인 진열", ok: inp.mains.every((m) => mainsGot.includes(m)) },
    { key: "icons", label: "아이콘·표시 기간", ok: inp.icons.every((i) => iconsGot.includes(i)) && (!inp.icons.length || String(period.start_date ?? "").startsWith(inp.icon_start)) },
  ];
  const allOk = checks.every((c) => c.ok);
  steps.verify = { ok: allOk, at: new Date().toISOString(), checks };
  await regPatch(inp.npm_id, { steps, state: "created" });
  return { ok: allOk, product_no: no, product_code: p.product_code ?? null, steps, checks };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    if (!MALL_ID || !CLIENT_ID || !CLIENT_SECRET) return json({ error: "상품 등록용 앱 설정(secrets)이 비어 있습니다" }, 500);

    // ① 카페24가 돌아옴 (redirect_uri) — 로그인 헤더가 없으므로 서명된 state로 확인
    const code = url.searchParams.get("code");
    if (code) {
      const who = await readState(url.searchParams.get("state") ?? "");
      if (!who) return textResponse("연동 요청이 만료됐거나 올바르지 않습니다. 워크스페이스에서 '상품 등록용 연동'을 다시 눌러 주세요.", 400);
      const body = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: selfUrl() });
      await persist(body);
      await stateSet("connected", { by_id: who.uid, by_name: who.name });
      const dash = Deno.env.get("DASHBOARD_URL");
      if (dash) return Response.redirect(`${dash}${dash.includes("?") ? "&" : "?"}cafe24p=connected`, 302);
      return textResponse("✅ 상품 등록용 카페24 연동 완료! 이 창을 닫으세요.");
    }
    const oauthErr = url.searchParams.get("error");
    if (oauthErr) {
      // 주소에 실려 온 값은 그대로 되돌려 보여 주지 않는다(보안 검토 2026-11-25) — 짧은 오류 코드만
      const codeTxt = /^[a-z_]{1,40}$/.test(oauthErr) ? oauthErr : "unknown";
      const hint = /scope/.test(codeTxt) ? " → 개발자센터의 상품 등록용 앱 권한(상품 읽기·쓰기, 상품분류 읽기, 디자인 읽기)이 저장됐는지 확인한 뒤 다시 연동하세요." : " → 워크스페이스에서 '상품 등록용 연동'을 다시 눌러 주세요.";
      return textResponse(`상품 등록용 카페24 연동 실패 (${codeTxt})${hint}`, 400);
    }

    // ② 매일 자동 갱신 (pg_cron c24p-refresh-daily)
    if (action === "refresh") {
      const secret = Deno.env.get("CRON_SECRET") ?? "";
      if (!secret || !safeEqual(req.headers.get("x-cron-secret") ?? "", secret)) return json({ error: "권한 없음" }, 403);
      const t = await getToken(PROVIDER);
      if (!t?.refresh_token) return json({ ok: false, skipped: "미연동" });
      try {
        await accessToken(true);
        const n = await getToken(PROVIDER);
        await stateSet("refresh", { ok: true, refresh_expires_at: n?.refresh_expires_at ?? null });
        return json({ ok: true });
      } catch (e) {
        await stateSet("refresh", { ok: false, error: String(e).slice(0, 300) });
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    // ③ 상품관리 서버(x-sync-secret) 또는 관리자 로그인
    const syncSecret = Deno.env.get("CAFE24P_SYNC_SECRET") ?? "";
    const viaSync = !!syncSecret && safeEqual(req.headers.get("x-sync-secret") ?? "", syncSecret);
    let user: { id: string; name: string; role: string } | null = null;
    if (viaSync) {
      if (!["lookups", "register", "reg_list", "compare"].includes(action ?? "")) return json({ error: "권한 없음" }, 403);
      user = { id: "npm", name: "상품관리", role: "admin" };
    } else {
      const u = await verifyAuthToken(req);
      if (!u) return json({ error: "로그인이 필요합니다" }, 401);
      if (u.role !== "admin") return json({ error: "관리자만 쓸 수 있습니다" }, 403);
      user = u;
    }

    if (action === "start_url") {
      const authorize = `${API_BASE}/oauth/authorize?response_type=code` +
        `&client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&state=${encodeURIComponent(await makeState(user.id, user.name))}` +
        `&redirect_uri=${encodeURIComponent(selfUrl())}` +
        `&scope=${encodeURIComponent(SCOPE)}`;
      return json({ url: authorize });
    }

    if (action === "status") {
      const t = await getToken(PROVIDER);
      if (!t?.refresh_token) return json({ connected: false });
      const refreshValid = !t.refresh_expires_at || new Date(t.refresh_expires_at) > new Date();
      const [scopes, refresh, conn] = await Promise.all([stateGet("scopes"), stateGet("refresh"), stateGet("connected")]);
      const out: Record<string, unknown> = {
        connected: refreshValid,
        refresh_expires_at: t.refresh_expires_at,
        scopes: (scopes?.scopes as string[] | undefined) ?? null,
        last_refresh: refresh,
        connected_by: conn ? { name: conn.by_name, at: conn.at } : null,
      };
      if (refreshValid && url.searchParams.get("live") === "1") {
        // 실제로 읽어 보고 권한이 살아 있는지 확인 (상품 수 · 분류 수 · 아이콘 수)
        const probe = async (p: string, pick: (b: Record<string, unknown>) => unknown) => {
          try { return { ok: true, value: pick(await c24Get(p)) }; } catch (e) { return { ok: false, error: String(e).slice(0, 200) }; }
        };
        out.live = {
          products: await probe(`/admin/products/count`, (b) => b.count),
          categories: await probe(`/admin/categories/count`, (b) => b.count),
          icons: await probe(`/admin/icons`, (b) => (b.icons as unknown[] | undefined)?.length ?? 0),
        };
      }
      return json(out);
    }

    if (action === "register") {
      if (req.method !== "POST") return json({ error: "POST만" }, 405);
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      const by = viaSync ? (nfc(body.by_name).slice(0, 30) || "상품관리") : user.name;
      let inp: RegIn;
      try { inp = await checkRegInput(body); } catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
      try { return json(await registerProduct(inp, by)); } catch (e) {
        const err = e as Error & { status?: number; product_nos?: number[] };
        return json({ ok: false, error: err.message, product_nos: err.product_nos ?? null }, err.status ?? 500);
      }
    }

    if (action === "reg_list") {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      const ids = (Array.isArray(body.npm_ids) ? body.npm_ids : []).map(nfc).filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 200);
      if (!ids.length) return json({ rows: [] });
      const r = await sb(`c24p_registry?npm_id=in.(${ids.join(",")})&select=npm_id,product_no,state,steps,by_name,created_at,updated_at`);
      return json({ rows: r.ok ? await r.json() : [] });
    }

    if (action === "compare") {
      // 우리가 만든 상품(product_no)과 엑셀로 만든 상품(ref)의 설정 칸이 같은지 — 다른 칸만 돌려줌
      const no = Number(url.searchParams.get("product_no")), ref = Number(url.searchParams.get("ref"));
      if (!no || !ref) return json({ error: "product_no·ref 필요" }, 400);
      const [a, b] = await Promise.all([c24Get(`/admin/products/${no}?embed=options`), c24Get(`/admin/products/${ref}?embed=options`)]);
      const pa = (a.product ?? {}) as Record<string, unknown>, pb = (b.product ?? {}) as Record<string, unknown>;
      const pick = (p: Record<string, unknown>, k: string) => k === "option_type" ? ((p.options as Record<string, unknown> | undefined)?.option_type ?? null) : (p[k] ?? null);
      const diffs = COMPARE_KEYS.map((k) => ({ key: k, ours: pick(pa, k), ref: pick(pb, k) })).filter((d) => JSON.stringify(d.ours) !== JSON.stringify(d.ref));
      return json({ product_no: no, ref, compared: COMPARE_KEYS.length, diffs });
    }

    if (action === "lookups") {
      const cats: Record<string, unknown>[] = [];
      for (let off = 0; off < 2000; off += 100) {
        const b = await c24Get(`/admin/categories?limit=100&offset=${off}&fields=category_no,category_name,category_depth,parent_category_no,display_type`);
        const rows = (b.categories ?? []) as Record<string, unknown>[];
        cats.push(...rows);
        if (rows.length < 100) break;
      }
      const mains = ((await c24Get(`/admin/mains`)).mains ?? []) as unknown[];
      // 최근 60일 등록 상품에서 아이콘·메인 진열·분류를 얼마나 썼는지 (기본값·자주 쓰는 것 표시용)
      const today = kstToday(), from = addDays(today, -60);
      const recent = ((await c24Get(`/admin/products?limit=100&created_start_date=${from}&created_end_date=${today}`)).products ?? []) as Record<string, unknown>[];
      const count = (pick: (p: Record<string, unknown>) => unknown[]) => {
        const m = new Map<string, number>();
        for (const p of recent) for (const v of pick(p)) m.set(String(v), (m.get(String(v)) ?? 0) + 1);
        return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => ({ k, n }));
      };
      const periods = recent.map((p) => (p.icon_show_period ?? {}) as Record<string, unknown>).filter((x) => x.start_date && x.end_date)
        .map((x) => Math.round((new Date(String(x.end_date)).getTime() - new Date(String(x.start_date)).getTime()) / 86400e3));
      return json({
        categories: cats, mains,
        usage: {
          products: recent.length,
          icons: count((p) => (p.icon ?? []) as unknown[]),
          mains: count((p) => (p.main ?? []) as unknown[]),
          icon_days: [...periods.reduce((m, d) => m.set(d, (m.get(d) ?? 0) + 1), new Map<number, number>()).entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => ({ k, n })),
        },
        icon_url: "https://img.echosting.cafe24.com/icon/product/global/{code}.gif",
      });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
