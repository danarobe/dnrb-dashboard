// ═══════════════════════════════════════════════
// 대시보드 사용자 인증/관리 함수
//   POST {action:'login', id, password}
//     → {token, id, name, role, exp}
//   POST {action:'list_users', token}                     — 관리자 전용
//   POST {action:'add_user', token, id, name, password}   — 관리자 전용 (직원 추가)
//   POST {action:'delete_user', token, id}                — 관리자 전용 (직원 삭제)
//   POST {action:'change_password', token, old_password, new_password} — 본인
//   POST {action:'npm_sso', token}  → {token: SSO 토큰(2분)} — 상품관리 시스템(newproduct-manager) 같은 계정 로그인용 (2026-09-07)
//   POST {action:'sso_issue', token, aud?}  → {code}  — 에이전트 앱(dnrb-agents) 이동용 60초 일회용 코드 (2026-09-10)
//                                            aud:'ad-dashboard'(2026-09-11) = 친구 광고 대시보드용 — 교환 시 **전용 토큰**이 나온다
//   POST {action:'sso_redeem', code}  → {token, id, name, role, exp[, aud]} — 그 코드를 정식 토큰으로 교환 (일회용, 즉시 삭제)
//   POST {action:'verify', token}     → {id, name, role, exp, perms:{menus,actions}} — 외부 앱(친구 광고 대시보드) 서버가 매 요청 검증용 (2026-09-11).
//                                      **aud:'ad-dashboard' 전용 토큰만** 받는다(401 otherwise). 전용 토큰은 파생 키로 서명돼
//                                      우리 함수(db·wm-me 등)에서는 서명 불일치로 거부되므로, 외부 서버가 토큰을 보관해도
//                                      워크스페이스 데이터(급여 명세서 등)에 손댈 수 없다. 시크릿 공유 없음.
//
// app_users 테이블은 anon 정책이 없어 이 함수(service_role)로만 접근 가능.
// 필요 secret: AUTH_SECRET
// ═══════════════════════════════════════════════
import bcrypt from "npm:bcryptjs@2.4.3";
import { handleOptions, json, signAuthToken, verifyAuthTokenString } from "../_shared/util.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN_TTL = 7 * 24 * 3600 * 1000; // 7일

// ── 외부 앱 전용 토큰 (aud) — AUTH_SECRET에서 파생한 키로 서명. 표준 토큰과 서명 키가 달라 서로 호환되지 않는다.
const AUD_ALLOWED = new Set(["ad-dashboard"]);
async function hmacAud(data: string, aud: string): Promise<string> {
  const secret = (Deno.env.get("AUTH_SECRET") ?? "") + "|aud:" + aud;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
interface AudUser { id: string; name: string; role: string; exp: number; aud: string }
async function signAudToken(user: AudUser): Promise<string> {
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(user))));
  return `${payload}.${await hmacAud(payload, user.aud)}`;
}
async function verifyAudToken(token: string): Promise<AudUser | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  let u: AudUser;
  try { u = JSON.parse(decodeURIComponent(escape(atob(payload)))) as AudUser; } catch { return null; }
  if (!u || !u.aud || !AUD_ALLOWED.has(u.aud)) return null;
  if (await hmacAud(payload, u.aud) !== sig) return null;
  if (!u.exp || u.exp < Date.now()) return null;
  return u;
}

// 친구 광고 대시보드 접근 허용 여부 (2026-09-11 사용자 요청): 관리자는 항상, 그 외는 ad_dashboard_users에 등재된 계정만.
// sso_issue(aud)와 verify 양쪽에서 검사 → 목록에서 빼면 다음 요청부터 즉시 차단.
// 세부 권한(2026-09-11): perms = {menus:[…], actions:[…]} — 친구 앱이 화면 숨김 + 서버 검사에 쓴다. 관리자는 전부.
const AD_MENUS = ["home", "compare", "ptest", "atest", "abest", "admgr", "upload", "perf", "data", "shoot"];   // 친구 앱 실제 키 (2026-09-11 확인: atest 테스트 소재·abest 베스트소재)
const AD_ACTIONS = ["toggle", "budget", "upload", "creative", "delete"];
const AD_DEFAULT_PERMS = { menus: ["home", "compare", "ptest", "atest", "abest"], actions: [] as string[] };
type AdPerms = { menus: string[]; actions: string[] };
function normPerms(raw: unknown): AdPerms {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (v: unknown, allowed: string[]) => Array.isArray(v) ? v.map(String).filter((k) => allowed.includes(k)) : null;
  return { menus: pick(r.menus, AD_MENUS) ?? AD_DEFAULT_PERMS.menus, actions: pick(r.actions, AD_ACTIONS) ?? AD_DEFAULT_PERMS.actions };
}
async function audAllowed(aud: string, userId: string, role: string): Promise<AdPerms | null> {
  if (aud !== "ad-dashboard") return null;
  if (role === "admin") return { menus: [...AD_MENUS], actions: [...AD_ACTIONS] };
  const res = await usersRest(`ad_dashboard_users?user_id=eq.${encodeURIComponent(userId)}&select=user_id,perms`);
  const row = res.ok ? ((await res.json()) as Record<string, unknown>[])[0] : null;
  return row ? normPerms(row.perms) : null;
}

async function usersRest(path: string, init: RequestInit = {}): Promise<Response> {
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

async function getUser(id: string): Promise<Record<string, unknown> | null> {
  const res = await usersRest(`app_users?id=eq.${encodeURIComponent(id)}&select=*`);
  if (!res.ok) throw new Error("사용자 조회 실패 " + res.status);
  return (await res.json())[0] ?? null;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    // ── 로그인 ──
    if (action === "login") {
      const id = String(body.id ?? "").trim();
      const password = String(body.password ?? "");
      if (!id || !password) return json({ error: "아이디와 비밀번호를 입력해주세요" }, 400);
      const user = await getUser(id);
      if (!user || !bcrypt.compareSync(password, String(user.password_hash))) {
        return json({ error: "아이디 또는 비밀번호가 올바르지 않습니다" }, 401);
      }
      const payload = {
        id: String(user.id), name: String(user.name),
        role: String(user.role), exp: Date.now() + TOKEN_TTL,
      };
      return json({ token: await signAuthToken(payload), ...payload });
    }

    // ── 상품관리 시스템 → 대시보드 로그인 토큰 발급 (2026-09-07, 서버 간): x-sync-secret(NPM_SYNC_SECRET)으로만.
    //    상품관리에 로그인한 사용자가 'DNRB 워크스페이스' 링크를 누르면 저쪽 서버가 그 아이디의 토큰을 요청한다.
    //    여기 없는 아이디(상품관리 전용 계정)면 404 → 저쪽이 로그인 화면으로 보낸다.
    if (action === "issue_for") {
      const secret = Deno.env.get("NPM_SYNC_SECRET") ?? "";
      if (!secret || req.headers.get("x-sync-secret") !== secret) return json({ error: "접근 권한이 없습니다" }, 403);
      const user = await getUser(String(body.id ?? "").trim());
      if (!user) return json({ error: "대시보드에 없는 계정" }, 404);
      const payload = { id: String(user.id), name: String(user.name), role: String(user.role), exp: Date.now() + TOKEN_TTL };
      return json({ token: await signAuthToken(payload), ...payload });
    }

    // ── 에이전트 앱 SSO 코드 교환 (2026-09-10, 보안 검토 반영): 워크스페이스가 sso_issue로 받은 **60초 일회용 코드**를
    //    에이전트 앱이 주소 해시로 받아 여기서 정식 토큰으로 바꾼다. 7일짜리 토큰을 주소에 싣지 않으려는 것 —
    //    공용 PC 브라우저 기록에 남아도 이미 소진된 코드라 쓸모없다. 코드는 api_cache(sso:<code>)에 두고 교환 즉시 지운다.
    if (action === "sso_redeem") {
      const code = String(body.code ?? "");
      if (!/^[A-Za-z0-9_-]{20,80}$/.test(code)) return json({ error: "잘못된 코드" }, 400);
      const res = await usersRest(`api_cache?cache_key=eq.${encodeURIComponent("sso:" + code)}&select=payload,created_at`);
      const row = res.ok ? (await res.json())[0] : null;
      // 읽었으면 성공·실패와 무관하게 먼저 지운다 (일회용)
      if (row) await usersRest(`api_cache?cache_key=eq.${encodeURIComponent("sso:" + code)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      if (!row || Date.now() - new Date(row.created_at).getTime() > 60 * 1000) return json({ error: "코드가 만료됐거나 이미 사용됐습니다" }, 401);
      const rp = (row.payload ?? {}) as Record<string, unknown>;
      const user = await getUser(String(rp.id ?? ""));
      if (!user) return json({ error: "로그인이 필요합니다" }, 401);
      const aud = String(rp.aud ?? "");
      if (aud) {   // 외부 앱 전용 토큰 — 우리 함수에서는 못 쓰는 파생 키 서명 (2026-09-11)
        const perms = await audAllowed(aud, String(user.id), String(user.role));
        if (!perms) return json({ error: "이 앱에 대한 접근 권한이 없습니다" }, 403);
        const payload: AudUser = { id: String(user.id), name: String(user.name), role: String(user.role), exp: Date.now() + TOKEN_TTL, aud };
        return json({ token: await signAudToken(payload), ...payload, perms });
      }
      const payload = { id: String(user.id), name: String(user.name), role: String(user.role), exp: Date.now() + TOKEN_TTL };
      return json({ token: await signAuthToken(payload), ...payload });
    }

    // ── 외부 앱 토큰 검증 (2026-09-11, 친구 광고 대시보드 서버가 매 요청 호출): aud 전용 토큰만. 계정 삭제·역할 변경 즉시 반영(DB 재조회).
    if (action === "verify") {
      const u = await verifyAudToken(String(body.token ?? ""));
      if (!u) return json({ error: "유효하지 않은 토큰" }, 401);
      const user = await getUser(u.id);
      if (!user) return json({ error: "유효하지 않은 토큰" }, 401);
      const perms = await audAllowed(u.aud, String(user.id), String(user.role));
      if (!perms) return json({ error: "이 앱에 대한 접근 권한이 없습니다" }, 403);
      return json({ id: String(user.id), name: String(user.name), role: String(user.role), exp: u.exp, aud: u.aud, perms });
    }

    // ── 이하 액션은 로그인 토큰 필요 ──
    // 서명 검증 후 DB에서 계정 존재·현재 역할 재확인 (삭제된 계정 토큰 즉시 무효화)
    const me = await verifyAuthTokenString(String(body.token ?? ""));
    if (!me) return json({ error: "로그인이 필요합니다" }, 401);
    const meRow = await getUser(me.id);
    if (!meRow) return json({ error: "로그인이 필요합니다" }, 401);
    me.role = String(meRow.role);

    // ── 상품관리 시스템 SSO 토큰 (2026-09-07): 대시보드 로그인 상태로 같은 아이디·이름·역할을 2분짜리 HMAC 토큰에 담아
    //    newproduct-manager /api/sso 로 넘긴다. 서명 키는 두 시스템이 이미 공유하는 NPM_SYNC_SECRET. 역할은 DB 원본값(logistics 구분 필요).
    if (action === "npm_sso") {
      const secret = Deno.env.get("NPM_SYNC_SECRET") ?? "";
      if (!secret) return json({ error: "연동 키가 설정되지 않았습니다" }, 500);
      const payload = JSON.stringify({ id: me.id, name: String(meRow.name ?? me.id), role: me.role, exp: Date.now() + 2 * 60 * 1000, n: crypto.randomUUID() });
      const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const body64 = b64url(new TextEncoder().encode(payload));
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body64))));
      return json({ token: `${body64}.${sig}` });
    }

    // ── 에이전트 앱 SSO 코드 발급 (2026-09-10): 로그인 상태에서 60초 일회용 코드. 짝은 위 sso_redeem.
    if (action === "sso_issue") {
      const aud = String(body.aud ?? "");
      if (aud && !AUD_ALLOWED.has(aud)) return json({ error: "알 수 없는 대상 앱" }, 400);
      if (aud && !(await audAllowed(aud, me.id, me.role))) return json({ error: "이 앱에 대한 접근 권한이 없습니다 — 관리자에게 요청하세요" }, 403);
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const code = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const res = await usersRest(`api_cache?on_conflict=cache_key`, {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ cache_key: "sso:" + code, payload: aud ? { id: me.id, aud } : { id: me.id }, created_at: new Date().toISOString() }),
      });
      if (!res.ok) return json({ error: "코드 발급 실패 " + res.status }, 500);
      return json({ code, ttl_sec: 60 });
    }

    if (action === "change_password") {
      const user = await getUser(me.id);
      if (!user || !bcrypt.compareSync(String(body.old_password ?? ""), String(user.password_hash))) {
        return json({ error: "현재 비밀번호가 올바르지 않습니다" }, 401);
      }
      const newPw = String(body.new_password ?? "");
      if (newPw.length < 4) return json({ error: "새 비밀번호는 4자 이상이어야 합니다" }, 400);
      const res = await usersRest(`app_users?id=eq.${encodeURIComponent(me.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ password_hash: bcrypt.hashSync(newPw, 10) }),
      });
      if (!res.ok) throw new Error("비밀번호 변경 실패 " + res.status);
      return json({ ok: true });
    }

    // 이름 목록만 — 로그인한 누구나 (@멘션 대상 찾기용, 2026-08-20. 역할·가입일 미포함)
    if (action === "list_names") {
      const res = await usersRest(`app_users?select=id,name&order=name.asc`);
      if (!res.ok) throw new Error("목록 조회 실패 " + res.status);
      return json({ users: await res.json() });
    }

    // ── 이하 관리자 전용 ──
    if (me.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);

    if (action === "list_users") {
      const res = await usersRest(`app_users?select=id,name,role,created_at,birthday&order=created_at.asc`);
      if (!res.ok) throw new Error("목록 조회 실패 " + res.status);
      return json({ users: await res.json() });
    }

    if (action === "add_user") {
      const id = String(body.id ?? "").trim();
      const name = String(body.name ?? "").trim();
      const password = String(body.password ?? "");
      if (!id || !name || password.length < 4) {
        return json({ error: "아이디·이름을 입력하고 비밀번호는 4자 이상으로 해주세요" }, 400);
      }
      if (await getUser(id)) return json({ error: "이미 존재하는 아이디입니다" }, 409);
      const res = await usersRest("app_users", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ id, name, role: "staff", password_hash: bcrypt.hashSync(password, 10) }),
      });
      if (!res.ok) throw new Error("직원 추가 실패 " + res.status);
      return json({ ok: true });
    }

    // 권한 변경 (관리자/직원/CS팀). 본인 권한은 변경 불가 — 마지막 관리자 잠금 방지
    if (action === "set_role") {
      const id = String(body.id ?? "").trim();
      const role = String(body.role ?? "");
      if (!["admin", "staff", "marketer", "cs", "logistics"].includes(role)) return json({ error: "잘못된 역할입니다" }, 400);   // logistics = 물류팀 (2026-08-27, 권한은 CS 동일)
      if (id === me.id) return json({ error: "본인의 권한은 변경할 수 없습니다" }, 400);
      if (!await getUser(id)) return json({ error: "존재하지 않는 아이디입니다" }, 404);
      const res = await usersRest(`app_users?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error("권한 변경 실패 " + res.status);
      return json({ ok: true });
    }

    if (action === "delete_user") {
      const id = String(body.id ?? "").trim();
      const target = await getUser(id);
      if (!target) return json({ error: "존재하지 않는 아이디입니다" }, 404);
      if (String(target.role) === "admin") return json({ error: "관리자 계정은 삭제할 수 없습니다" }, 400);
      const res = await usersRest(`app_users?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE", headers: { Prefer: "return=minimal" },
      });
      if (!res.ok) throw new Error("직원 삭제 실패 " + res.status);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
