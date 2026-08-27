// ═══════════════════════════════════════════════
// 마이페이지 — 직원 본인 전용 (2026-08-27)
//   GET  ?action=me            → 내 근무 정보(입사일·역할·연차 현황) + 올해 내 휴가 내역
//   POST ?action=leave_request { date, end_date?, type(annual|half), reason?, skip_offdays? } → 휴가 신청(pending)
//   POST ?action=leave_cancel  { id } → 내 '대기' 신청 취소
//
// ⚠ 보안 원칙: 로그인 계정(app_users.id) → wm_employees.app_user_id 로만 본인 행을 찾고,
//   모든 조회·쓰기를 그 employee_id로 고정한다. 남의 id를 보내도 무시된다(클라이언트가 id를 못 정함).
//   급여·계좌·시급은 응답에 절대 담지 않는다(마이페이지에 불필요 — 필요해지면 별도 검토).
//   관리자(대표)는 wm_employees에 연결이 없으므로 linked:false로 응답 — 비밀번호 변경만 쓰면 된다.
// ═══════════════════════════════════════════════
import { handleOptions, json, verifyAuthToken } from "../_shared/util.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DB ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const seoulToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
const fmtD = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// 올해 사용 연차 — wm-admin employee_list와 완전히 같은 규칙(여름휴가·하계/여름휴가 사유는 미차감)
function usedDays(rows: { type: string; reason?: string | null }[]): number {
  let used = 0;
  for (const l of rows) {
    if (l.type === "summer" || l.type === "sick") continue;   // 병가는 무급·연차 미차감
    if (l.reason && (l.reason.includes("하계휴가") || l.reason.includes("여름휴가"))) continue;
    used += l.type === "annual" ? 1 : 0.5;
  }
  return used;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  const me = await verifyAuthToken(req);
  if (!me) return json({ error: "로그인이 필요합니다" }, 401);

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "me";

  try {
    // 본인 직원 행 — 이것이 유일한 신원. 이후 모든 쿼리는 emp.id로 고정한다.
    const [emp] = await rest(
      `wm_employees?app_user_id=eq.${encodeURIComponent(me.id)}` +
        "&select=id,name,type,hire_date,birthday,annual_leave_total,active",
    );

    if (action === "me") {
      if (!emp) return json({ linked: false, name: me.name, role: me.role });
      const year = seoulToday().slice(0, 4);
      const leaves = await rest(
        `wm_leaves?employee_id=eq.${emp.id}&date=gte.${year}-01-01&date=lte.${year}-12-31` +
          "&select=id,date,type,reason,status,created_at&order=date.desc&limit=400",
      );
      const total = Number(emp.annual_leave_total ?? 0);
      const used = usedDays(leaves.filter((l: any) => l.status === "approved"));
      const pending = usedDays(leaves.filter((l: any) => l.status === "pending"));
      return json({
        linked: true,
        employee_id: emp.id,
        name: emp.name,
        role: me.role,
        type: emp.type,
        hire_date: emp.hire_date,
        birthday: emp.birthday,
        active: emp.active,
        annual: { total, used, pending, left: total - used },
        leaves,
        today: seoulToday(),
      });
    }

    if (!emp) return json({ error: "근무 관리에 연결된 직원 계정이 아닙니다" }, 403);
    if (emp.active === false) return json({ error: "비활성 계정입니다" }, 403);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // 휴가 신청 — 키오스크 request_leave 규칙 이식(항상 pending, 중복 날짜 차단, 기간 신청 지원)
    if (action === "leave_request") {
      const date = String(body.date ?? "");
      const endDate = String(body.end_date ?? "");
      const type = String(body.type ?? "");
      const reason = String(body.reason ?? "").slice(0, 200);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "날짜를 선택해주세요" }, 400);
      if (!["annual", "half", "sick"].includes(type)) return json({ error: "휴가 종류가 올바르지 않습니다" }, 400);

      let dates: string[] = [date];
      if (endDate && endDate !== date) {
        if (endDate < date) return json({ error: "종료 날짜가 시작 날짜보다 빠릅니다" }, 400);
        if (type === "half") return json({ error: "반차는 기간 신청을 할 수 없습니다" }, 400);
        const holidays = new Set(
          (await rest("wm_holidays?select=date&limit=2000")).map((h: any) => h.date),
        );
        dates = [];
        for (const d = new Date(`${date}T00:00:00`); ; d.setDate(d.getDate() + 1)) {
          const s = fmtD(d);
          if (s > endDate) break;
          if (dates.length >= 62) return json({ error: "기간이 너무 깁니다 (최대 2개월)" }, 400);
          if (body.skip_offdays && (d.getDay() === 0 || d.getDay() === 6 || holidays.has(s))) continue;
          dates.push(s);
        }
        if (!dates.length) return json({ error: "기간 내 등록할 날짜가 없습니다 (주말·공휴일 제외)" }, 400);
      }

      const existing = new Set(
        (await rest(`wm_leaves?employee_id=eq.${emp.id}&status=neq.rejected&select=date`)).map((r: any) => r.date),
      );
      const toInsert = dates.filter((s) => !existing.has(s));
      const skipped = dates.filter((s) => existing.has(s));
      if (!toInsert.length) return json({ error: "이미 신청한 날짜입니다" }, 400);

      const rows = await rest("wm_leaves", {
        method: "POST",
        body: JSON.stringify(
          toInsert.map((s) => ({ employee_id: emp.id, date: s, type, status: "pending", reason: reason || null })),
        ),
      });

      // 관리자에게 앱 알림 — 신청이 온 걸 모르면 승인이 늦어진다 (알림함 종 아이콘)
      try {
        const admins = await rest("app_users?role=eq.admin&select=id");
        if (admins.length) {
          const label = type === "annual" ? "연차" : "반차";
          const when = toInsert.length > 1 ? `${toInsert[0]} 외 ${toInsert.length - 1}일` : toInsert[0];
          await rest("notifications", {
            method: "POST",
            body: JSON.stringify(admins.map((a: any) => ({
              user_id: a.id,
              actor_name: emp.name,
              message: `휴가 신청 — ${when} ${label}${reason ? ` (${reason})` : ""}`,
              link_menu: "wm",
              read: false,
            }))),
          });
        }
      } catch { /* 알림 실패가 신청 자체를 막지는 않는다 */ }

      return json({ ok: true, inserted: rows.length, skipped });
    }

    // 내 '대기' 신청 취소 — 승인·반려된 건은 관리자만 처리
    if (action === "leave_cancel") {
      const id = Number(body.id);
      const rows = await rest(
        `wm_leaves?id=eq.${id}&employee_id=eq.${emp.id}&status=eq.pending`,
        { method: "DELETE" },
      );
      if (!rows || !rows.length) return json({ error: "취소할 수 있는 신청이 아닙니다 (이미 처리됨)" }, 400);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
