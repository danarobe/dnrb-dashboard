// ═══════════════════════════════════════════════
// 대시보드 사용자 인증/관리 함수
//   POST {action:'login', id, password}
//     → {token, id, name, role, exp}
//   POST {action:'list_users', token}                     — 관리자 전용
//   POST {action:'add_user', token, id, name, password}   — 관리자 전용 (직원 추가)
//   POST {action:'delete_user', token, id}                — 관리자 전용 (직원 삭제)
//   POST {action:'change_password', token, old_password, new_password} — 본인
//
// app_users 테이블은 anon 정책이 없어 이 함수(service_role)로만 접근 가능.
// 필요 secret: AUTH_SECRET
// ═══════════════════════════════════════════════
import bcrypt from "npm:bcryptjs@2.4.3";
import { handleOptions, json, signAuthToken, verifyAuthTokenString } from "../_shared/util.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN_TTL = 7 * 24 * 3600 * 1000; // 7일

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

    // ── 이하 액션은 로그인 토큰 필요 ──
    const me = await verifyAuthTokenString(String(body.token ?? ""));
    if (!me) return json({ error: "로그인이 필요합니다" }, 401);

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

    // ── 이하 관리자 전용 ──
    if (me.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);

    if (action === "list_users") {
      const res = await usersRest(`app_users?select=id,name,role,created_at&order=created_at.asc`);
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

    // 권한 변경 (직원 ↔ 관리자). 본인 권한은 변경 불가 — 마지막 관리자 잠금 방지
    if (action === "set_role") {
      const id = String(body.id ?? "").trim();
      const role = String(body.role ?? "");
      if (!["admin", "staff"].includes(role)) return json({ error: "잘못된 역할입니다" }, 400);
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
