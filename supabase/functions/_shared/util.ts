// 공용 유틸 — Edge Functions 전용

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-auth-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ── 대시보드 사용자 인증 토큰 (HMAC-SHA256 서명, AUTH_SECRET 필요) ──
export interface AuthUser { id: string; name: string; role: string; exp: number }

async function hmacB64(data: string): Promise<string> {
  const secret = Deno.env.get("AUTH_SECRET") ?? "";
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function signAuthToken(user: AuthUser): Promise<string> {
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(user))));
  return `${payload}.${await hmacB64(payload)}`;
}

export async function verifyAuthTokenString(token: string): Promise<AuthUser | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  if (await hmacB64(payload) !== sig) return null;
  try {
    const u = JSON.parse(decodeURIComponent(escape(atob(payload)))) as AuthUser;
    if (!u.exp || u.exp < Date.now()) return null;
    return u;
  } catch { return null; }
}

// 서명·만료 검증 후 DB에서 계정 존재를 재확인 — 삭제된 계정의 토큰은 즉시 무효,
// 역할은 토큰이 아닌 DB의 현재 값을 사용 (권한 변경 즉시 반영)
export async function verifyAuthToken(req: Request): Promise<AuthUser | null> {
  const token = req.headers.get("x-auth-token") ?? "";
  const u = token ? await verifyAuthTokenString(token) : null;
  if (!u) return null;
  const res = await rest(`app_users?id=eq.${encodeURIComponent(u.id)}&select=id,name,role`);
  if (!res.ok) return null;
  const row = (await res.json())[0];
  if (!row) return null;
  return { ...u, name: String(row.name), role: String(row.role) };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  return null;
}

// ── Supabase PostgREST 접근 (service_role — api_tokens 테이블용) ──
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
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

// ── 조회 결과 캐시 (api_cache 테이블) ──
// 무거운 카페24 주문 스캔(수십 초)을 같은 조건으로 다시 돌리지 않기 위한 것.
// 키에는 호출자가 역할까지 넣어야 한다 — 역할별로 응답이 다른 액션(performance)이 있음.
export async function cacheGet(key: string, ttlMs: number): Promise<unknown | null> {
  try {
    const res = await rest(`api_cache?cache_key=eq.${encodeURIComponent(key)}&select=payload,created_at`);
    if (!res.ok) return null;
    const row = (await res.json())[0];
    if (!row) return null;
    if (Date.now() - new Date(row.created_at).getTime() > ttlMs) return null;
    return row.payload;
  } catch { return null; }
}

export async function cacheSet(key: string, payload: unknown): Promise<void> {
  try {
    await rest(`api_cache?on_conflict=cache_key`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ cache_key: key, payload, created_at: new Date().toISOString() }),
    });
    // 오래된 항목 정리 (실패해도 무해)
    await rest(`api_cache?created_at=lt.${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
  } catch { /* 캐시는 실패해도 기능에 영향 없음 */ }
}

export interface TokenRow {
  provider: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  refresh_expires_at: string | null;
}

export async function getToken(provider: string): Promise<TokenRow | null> {
  const res = await rest(`api_tokens?provider=eq.${provider}&select=*`);
  if (!res.ok) throw new Error(`token read failed: ${res.status}`);
  const rows = await res.json();
  return rows[0] ?? null;
}

export async function saveToken(row: TokenRow): Promise<void> {
  const res = await rest(`api_tokens?on_conflict=provider`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`token save failed: ${res.status} ${await res.text()}`);
}
