// ═══════════════════════════════════════════════
// 마이페이지 — 직원 본인 전용 (2026-08-27)
//   GET  ?action=me            → 내 근무 정보(입사일·역할·연차 현황) + 올해 내 휴가 내역
//   POST ?action=leave_request { date, end_date?, type(annual|half), reason?, skip_offdays? } → 휴가 신청(pending)
//   POST ?action=leave_cancel  { id } → 내 '대기' 신청 취소
//   GET  ?action=payslip_list      → 관리자가 업로드한 내 급여 명세서 파일 목록 (2026-09-10 사용자 요청 — 계산값이 아니라 업로드 파일)
//   GET  ?action=payslip_file&id=  → 그 파일 본문(바이트 중계, 본인 것만). 공개 URL·서명 URL 없음.
//   ── 출장 여비 신청서 (2026-09-17 사용자 요청: '입력완료' 제출 + 개인 사비 지출·영수증, 관리자 확인) ──
//   GET  ?action=trip_list             → { rows:[내 신청서…], receipts:[…] }
//   GET  ?action=trip_receipt&id=      → 내 영수증 파일 바이트 중계
//   POST ?action=trip_receipt_upload   { file_name, mime, data_b64 } → { id, file_name, mime, size }  (비공개 버킷 wm-receipts)
//   POST ?action=trip_submit           { kind, place, purpose, start_date, end_date, nights, note, ot:[…], expenses:[…] } → { row }
//        금액·초과근로 시간은 서버가 다시 계산(단가표·15분 올림)하고, 영수증은 본인이 올린 것만 연결된다. 제출 시 관리자에게 알림.
//   GET  ?action=doc_request_list      → { rows } 내 서류 출력 요청 (2026-09-21)
//   POST ?action=doc_request           { doc_type: cert|car, use?, car_no?, car_model? } → { row }  관리자에게 앱 알림+푸시, 관리자 PC에서 인쇄
//   POST ?action=doc_request_cancel    { id } → 내 '요청' 상태 건 취소
//   POST ?action=trip_update           { id, …trip_submit과 같은 필드 } → { row }  (2026-09-21) 본인 신청서가 '보완 요청' 또는 '확인 대기'일 때만
//        수정해 다시 제출 → status submitted, resubmit_count+1, 직전 보완 사유는 prev_review_note로 보관. 확인 완료된 건은 수정 불가.
//
// ⚠ 보안 원칙: 로그인 계정(app_users.id) → wm_employees.app_user_id 로만 본인 행을 찾고,
//   모든 조회·쓰기를 그 employee_id로 고정한다. 남의 id를 보내도 무시된다(클라이언트가 id를 못 정함).
//   me 응답에는 급여·계좌·시급을 담지 않는다. 급여 명세서 파일은 wm_payslips.employee_id = 본인일 때만 내려간다.
//   관리자(대표)는 wm_employees에 연결이 없으므로 linked:false로 응답 — 비밀번호 변경만 쓰면 된다.
// ═══════════════════════════════════════════════
import { CORS_HEADERS, handleOptions, json, verifyAuthToken } from "../_shared/util.ts";

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

// ── 출장 여비 (2026-09-17) — 단가표·계산 규칙은 index.html TRIP_KINDS/ceil15와 동일하게 유지 ──
const TRIP_PER: Record<string, number> = { domestic: 10000, intl_short: 20000, intl_long: 40000 };
const RECEIPT_BUCKET = "wm-receipts";
const RECEIPT_MIME: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" };
const D_RE = /^\d{4}-\d{2}-\d{2}$/, T_RE = /^\d{2}:\d{2}$/;
function otMinutes(sv: string, ev: string, meal: boolean): number {
  if (!T_RE.test(sv) || !T_RE.test(ev)) return 0;
  const [sh, sm] = sv.split(":").map(Number), [eh, em] = ev.split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  if (meal) mins -= 60;
  return Math.max(0, mins);
}
const storageH = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` });
async function receiptPut(path: string, bytes: Uint8Array, mime: string) {
  const r = await fetch(`${SB_URL}/storage/v1/object/${RECEIPT_BUCKET}/${path}`, { method: "POST", headers: { ...storageH(), "Content-Type": mime, "x-upsert": "false" }, body: bytes });
  if (!r.ok) throw new Error(`storage ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
async function receiptStream(row: { storage_path: string; mime: string; file_name: string }): Promise<Response> {
  const r = await fetch(`${SB_URL}/storage/v1/object/${RECEIPT_BUCKET}/${row.storage_path}`, { headers: storageH() });
  if (!r.ok) return json({ error: `파일을 불러오지 못했습니다 (${r.status})` }, 502);
  return new Response(r.body, { status: 200, headers: { ...CORS_HEADERS, "Content-Type": row.mime, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`, "Cache-Control": "private, no-store" } });
}

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

    // 내 급여 명세서 파일 — 관리자가 wm-admin payslip_upload로 올린 것. 조회 조건에 employee_id=본인을 박아 넣는다.
    if (action === "payslip_list") {
      const rows = await rest(
        `wm_payslips?employee_id=eq.${emp.id}&select=id,ym,file_name,mime,size,note,uploaded_at&order=ym.desc&limit=120`,
      );
      return json({ rows });
    }
    if (action === "payslip_file") {
      const id = Number(url.searchParams.get("id"));
      if (!Number.isInteger(id) || id <= 0) return json({ error: "파일 번호 오류" }, 400);
      const [row] = await rest(`wm_payslips?id=eq.${id}&employee_id=eq.${emp.id}&select=storage_path,mime,file_name`);
      if (!row) return json({ error: "파일이 없거나 본인 것이 아닙니다" }, 404);
      const res = await fetch(`${SB_URL}/storage/v1/object/wm-payslips/${row.storage_path}`, {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      });
      if (!res.ok) return json({ error: `파일을 불러오지 못했습니다 (${res.status})` }, 502);
      return new Response(res.body, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": row.mime,
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
          "Cache-Control": "private, no-store",
        },
      });
    }

    if (action === "doc_request_list") {
      return json({ rows: await rest(`wm_doc_requests?employee_id=eq.${emp.id}&select=*&order=requested_at.desc&limit=50`) });
    }

    // ── 출장 여비: 내 신청 목록 / 내 영수증 (본인 employee_id 조건 고정) ──
    if (action === "trip_list") {
      const rows = await rest(`wm_trip_claims?employee_id=eq.${emp.id}&select=*&order=submitted_at.desc&limit=100`);
      const receipts = await rest(`wm_trip_receipts?employee_id=eq.${emp.id}&select=id,claim_id,file_name,mime,size&order=id`);
      return json({ rows, receipts });
    }
    if (action === "trip_receipt") {
      const id = Number(url.searchParams.get("id"));
      if (!Number.isInteger(id) || id <= 0) return json({ error: "파일 번호 오류" }, 400);
      const [row] = await rest(`wm_trip_receipts?id=eq.${id}&employee_id=eq.${emp.id}&select=storage_path,mime,file_name`);
      if (!row) return json({ error: "파일이 없거나 본인 것이 아닙니다" }, 404);
      return await receiptStream(row);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // 관리자 전원에게 앱 알림 + 웹 푸시(휴대폰) — notify 함수에 직원 본인 토큰을 그대로 넘겨 호출 (2026-09-21 사용자 요청: 재제출도 알림).
    // notify 호출이 실패하면 예전처럼 notifications 행만 직접 넣는다.
    const notifyAdmins = async (msg: string, title = "출장 여비 신청서") => {
      try {
        const admins = await rest("app_users?role=eq.admin&select=id");
        if (!admins.length) return;
        const targets = admins.map((a: { id: string }) => a.id);
        const r = await fetch(`${SB_URL}/functions/v1/notify`, {
          method: "POST",
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", "x-auth-token": req.headers.get("x-auth-token") ?? "" },
          body: JSON.stringify({ targets, actor_name: emp.name, message: msg, link_menu: "wm", title }),
        });
        if (!r.ok) await rest("notifications", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(targets.map((id: string) => ({ user_id: id, actor_name: emp.name, message: msg, link_menu: "wm", read: false }))) });
      } catch { /* 알림 실패가 제출을 막지는 않는다 */ }
    };

    // 서류 출력 요청 (2026-09-21) — 재직증명서(cert)·차량 등록 요청서(car). 관리자가 근무 관리 › 서류 요청에서 인쇄해 준다.
    if (action === "doc_request") {
      const docType = String(body.doc_type ?? "");
      if (!["cert", "car"].includes(docType)) return json({ error: "서류 종류 오류" }, 400);
      const payload: Record<string, string> = { use: String(body.use ?? "").trim().slice(0, 100) };
      if (docType === "car") {
        payload.car_no = String(body.car_no ?? "").trim().slice(0, 30);
        payload.car_model = String(body.car_model ?? "").trim().slice(0, 40);
        if (!payload.car_no) return json({ error: "차량 번호를 입력해주세요" }, 400);
      }
      const dup = await rest(`wm_doc_requests?employee_id=eq.${emp.id}&doc_type=eq.${docType}&status=eq.requested&select=id`);
      if (dup.length) return json({ error: "이미 출력 요청이 접수돼 있어요 — 관리자가 처리하면 알려드립니다" }, 409);
      const rows = await rest("wm_doc_requests", { method: "POST", body: JSON.stringify({ employee_id: emp.id, doc_type: docType, payload, status: "requested" }) });
      const label = docType === "cert" ? "재직증명서" : "차량 등록 요청서";
      await notifyAdmins(`${label} 출력 요청${payload.use ? ` (용도: ${payload.use})` : ""} → 근무 관리 › 서류 요청`, `${label} 출력 요청`);
      return json({ ok: true, row: rows[0] });
    }
    if (action === "doc_request_cancel") {
      const rows = await rest(`wm_doc_requests?id=eq.${Number(body.id)}&employee_id=eq.${emp.id}&status=eq.requested`, { method: "PATCH", body: JSON.stringify({ status: "cancelled", handled_at: new Date().toISOString() }) });
      if (!rows.length) return json({ error: "취소할 수 있는 요청이 아닙니다" }, 400);
      return json({ ok: true });
    }


    // 영수증 업로드 — 신청서 제출 전에 파일마다 먼저 올리고 받은 id를 지출 행에 붙인다 (8MB, PDF·이미지)
    if (action === "trip_receipt_upload") {
      const mime = String(body.mime ?? "");
      const fileName = String(body.file_name ?? "").slice(0, 200) || "receipt";
      if (!RECEIPT_MIME[mime]) return json({ error: "PDF·JPG·PNG·WEBP·HEIC 파일만 올릴 수 있어요" }, 400);
      const b64 = String(body.data_b64 ?? "");
      if (!b64 || b64.length > 11_500_000) return json({ error: "파일이 너무 큽니다 (최대 8MB)" }, 400);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      if (bytes.length > 8 * 1024 * 1024) return json({ error: "파일이 너무 큽니다 (최대 8MB)" }, 400);
      const path = `${emp.id}/${crypto.randomUUID()}.${RECEIPT_MIME[mime]}`;
      await receiptPut(path, bytes, mime);
      const rows = await rest("wm_trip_receipts", { method: "POST", body: JSON.stringify({ employee_id: emp.id, file_name: fileName, mime, size: bytes.length, storage_path: path }) });
      const row = rows[0];
      return json({ id: row.id, file_name: row.file_name, mime: row.mime, size: row.size });
    }

    // 신청서 제출('입력완료') — 계산은 서버가 다시 한다
    // 신청서 본문 검증·재계산 — 제출(trip_submit)·재제출(trip_update) 공용
    const buildTrip = async (): Promise<{ error?: string; data?: Record<string, unknown>; usedIds: number[]; summary: string }> => {
      const kind = String(body.kind ?? "");
      if (!(kind in TRIP_PER)) return { error: "출장 구분 오류", usedIds: [], summary: "" };
      const place = String(body.place ?? "").trim().slice(0, 120);
      const purpose = String(body.purpose ?? "").trim().slice(0, 300);
      const note = String(body.note ?? "").trim().slice(0, 500);
      const sd = String(body.start_date ?? ""), ed = String(body.end_date ?? "");
      if (!place) return { error: "출장지를 입력해주세요", usedIds: [], summary: "" };
      if (!D_RE.test(sd) || !D_RE.test(ed) || ed < sd) return { error: "출장 기간이 올바르지 않습니다", usedIds: [], summary: "" };
      const nights = Math.max(0, Math.min(60, Math.floor(Number(body.nights) || 0)));
      const per = TRIP_PER[kind];
      const otIn = Array.isArray(body.ot) ? (body.ot as Record<string, unknown>[]).slice(0, 60) : [];
      const ot = otIn.map((r) => {
        const sv = String(r.s ?? ""), ev = String(r.e ?? ""), meal = !!r.meal;
        const raw = otMinutes(sv, ev, meal);
        return { date: D_RE.test(String(r.date ?? "")) ? String(r.date) : "", s: sv, e: ev, meal, memo: String(r.memo ?? "").slice(0, 200), raw, ceil: Math.ceil(raw / 15) * 15 };
      }).filter((r) => r.raw > 0);
      const otTotal = ot.reduce((t, r) => t + r.ceil, 0);
      const exIn = Array.isArray(body.expenses) ? (body.expenses as Record<string, unknown>[]).slice(0, 100) : [];
      const receiptIds = exIn.map((x) => Number(x.receipt_id)).filter((n) => Number.isInteger(n) && n > 0);
      const mine = new Set<number>();
      if (receiptIds.length) {
        const rs = await rest(`wm_trip_receipts?employee_id=eq.${emp.id}&id=in.(${receiptIds.join(",")})&select=id`);
        for (const r of rs as { id: number }[]) mine.add(Number(r.id));
      }
      const expenses = exIn.map((x) => {
        const rid = Number(x.receipt_id);
        return { date: D_RE.test(String(x.date ?? "")) ? String(x.date) : "", item: String(x.item ?? "").trim().slice(0, 120), amount: Math.max(0, Math.floor(Number(x.amount) || 0)), memo: String(x.memo ?? "").trim().slice(0, 200), receipt_id: mine.has(rid) ? rid : null };
      }).filter((x) => x.item || x.amount > 0 || x.receipt_id);
      const expenseTotal = expenses.reduce((t, x) => t + x.amount, 0);
      const usedIds = expenses.map((x) => x.receipt_id).filter((v): v is number => v != null);
      const summary = `${sd}~${ed} ${place} (출장비 ${(nights * per).toLocaleString("ko-KR")}원${expenseTotal ? ` · 사비 ${expenseTotal.toLocaleString("ko-KR")}원` : ""})`;
      return { data: { kind, place, purpose: purpose || null, start_date: sd, end_date: ed, nights, per_night: per, trip_pay: nights * per, ot, ot_total_min: otTotal, expenses, expense_total: expenseTotal, note: note || null }, usedIds, summary };
    };
    // 신청서 제출('입력완료') — 계산은 서버가 다시 한다
    if (action === "trip_submit") {
      const b = await buildTrip();
      if (b.error || !b.data) return json({ error: b.error }, 400);
      const rows = await rest("wm_trip_claims", { method: "POST", body: JSON.stringify({ employee_id: emp.id, ...b.data, status: "submitted" }) });
      const row = rows[0];
      if (b.usedIds.length) await rest(`wm_trip_receipts?employee_id=eq.${emp.id}&id=in.(${b.usedIds.join(",")})`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ claim_id: row.id }) });
      await notifyAdmins(`출장 여비 신청서 — ${b.summary} → 근무 관리 › 출장 여비`);
      return json({ ok: true, row });
    }

    // 수정 후 재제출 (2026-09-21) — 본인 것 + 보완 요청/확인 대기 상태만. 확인 완료된 건은 관리자가 '되돌리기' 해야 수정 가능.
    if (action === "trip_update") {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) return json({ error: "신청서 번호 오류" }, 400);
      const [cur] = await rest(`wm_trip_claims?id=eq.${id}&employee_id=eq.${emp.id}&select=id,status,review_note,resubmit_count`);
      if (!cur) return json({ error: "신청서가 없거나 본인 것이 아닙니다" }, 404);
      if (cur.status === "confirmed") return json({ error: "이미 확인 완료된 신청서는 수정할 수 없어요 — 관리자에게 요청하세요" }, 409);
      const b = await buildTrip();
      if (b.error || !b.data) return json({ error: b.error }, 400);
      const wasReturned = cur.status === "returned";
      const rows = await rest(`wm_trip_claims?id=eq.${id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...b.data, status: "submitted", reviewed_by: null, reviewed_at: null, review_note: null,
          prev_review_note: wasReturned ? (cur.review_note ?? null) : (cur.prev_review_note ?? null),
          resubmit_count: Number(cur.resubmit_count ?? 0) + 1, resubmitted_at: new Date().toISOString() }),
      });
      const row = rows[0];
      // 영수증 연결 갱신: 이번에 쓰인 것만 이 신청서에, 빠진 것은 연결 해제
      await rest(`wm_trip_receipts?employee_id=eq.${emp.id}&claim_id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ claim_id: null }) });
      if (b.usedIds.length) await rest(`wm_trip_receipts?employee_id=eq.${emp.id}&id=in.(${b.usedIds.join(",")})`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ claim_id: id }) });
      await notifyAdmins(`출장 여비 신청서 ${wasReturned ? "보완 후 재제출" : "수정 재제출"} — ${b.summary} → 근무 관리 › 출장 여비`, wasReturned ? "출장 여비 보완 후 재제출" : "출장 여비 수정 재제출");
      return json({ ok: true, row });
    }

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
