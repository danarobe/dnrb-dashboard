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

export async function verifyAuthToken(req: Request): Promise<AuthUser | null> {
  const token = req.headers.get("x-auth-token") ?? "";
  return token ? await verifyAuthTokenString(token) : null;
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
