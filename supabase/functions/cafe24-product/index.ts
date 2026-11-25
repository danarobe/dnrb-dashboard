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
//   GET  ?action=lookups       (관리자) 분류·메인 진열 영역·아이콘 목록 (읽기만 — 2단계 화면용)
//
// 안전장치 (카페24로 값을 보내는 곳은 c24pWrite 하나뿐)
//   ① DELETE는 보내지 않는다 — 허용 목록 WRITE_RULES 에 없음
//   ② 허용 목록 밖의 주소·메서드는 거부
//   ③ 상품을 만들 때는 진열·판매를 항상 'F'(숨김·판매 안 함)로 덮어쓴다
//   ④ 상품번호가 들어가는 쓰기는 **이 시스템이 만든 상품(c24p_registry)** 일 때만 — 기존 상품은 못 건드린다
//   ⑤ 쓰기마다 c24p_log 에 기록 (사진 원본 등 본문은 저장하지 않음)
//
// 필요 secrets: CAFE24_MALL_ID(공용), CAFE24P_CLIENT_ID, CAFE24P_CLIENT_SECRET, AUTH_SECRET, CRON_SECRET, DASHBOARD_URL
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
const API_VERSION = "2026-03-01";

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

// deno-lint-ignore no-unused-vars -- 2단계(숨김 등록)부터 쓴다
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
void c24pWrite;

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

    // ③ 아래는 관리자 로그인만
    const user = await verifyAuthToken(req);
    if (!user) return json({ error: "로그인이 필요합니다" }, 401);
    if (user.role !== "admin") return json({ error: "관리자만 쓸 수 있습니다" }, 403);

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

    if (action === "lookups") {
      const cats: Record<string, unknown>[] = [];
      for (let off = 0; off < 2000; off += 100) {
        const b = await c24Get(`/admin/categories?limit=100&offset=${off}&fields=category_no,category_name,category_depth,parent_category_no,display_type`);
        const rows = (b.categories ?? []) as Record<string, unknown>[];
        cats.push(...rows);
        if (rows.length < 100) break;
      }
      const safe = async (p: string, key: string) => { try { return ((await c24Get(p))[key] ?? []) as unknown[]; } catch (e) { return { error: String(e).slice(0, 200) }; } };
      const [mains, icons] = await Promise.all([safe(`/admin/mains`, "mains"), safe(`/admin/icons`, "icons")]);
      return json({ categories: cats, mains, icons });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
