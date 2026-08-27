// ═══════════════════════════════════════════════════════════════
// 근무관리 — 관리자 전용 함수 (급여 계산 · 직원/출퇴근/휴가/공휴일 · 키오스크 기기)
//
//   POST { action, ... }  — 로그인 토큰(x-auth-token) 검증 후 role === 'admin'만
//
// 조회·급여 액션 (2단계):
//   salary_all      { year, month }               월 전체 급여
//   salary_one      { employee_id, year, month }  개인 급여
//   labor_total     { start_date, end_date }      기간 인건비 합계 (대시보드 순익 메뉴용)
//   employee_list   {}                            직원 목록 (계좌 포함 — 관리자 전용이므로 OK)
//   attendance_list { year, month }               월 출퇴근 기록
//   edits_pending   {}                            승인 대기 중인 시간 수정 신청
//
// 쓰기 액션 (3단계):
//   attendance_upsert { id?, employee_id, date, clock_in, clock_out?, note? }
//   attendance_delete { id }
//   edit_review       { id, status }              시간 수정 신청 승인/거절 (승인 시 출퇴근 반영)
//   leave_list        { year, month?, status? }
//   leave_create      { employee_id, date, end_date?, type, reason?, skip_offdays?, auto_approve? }
//   leave_review      { id, status }
//   leave_delete      { id }
//   employee_upsert   { id?, ...필드 }            ⚠️ 부분 수정 — 보낸 필드만 갱신 (기존 Express PUT의
//                                                  "일부만 보내면 나머지 초기화" 함정을 의도적으로 제거)
//   employee_active   { id, active }              소프트 삭제/복구 (하드 삭제 없음 — 급여 기록 보존)
//   set_pin           { employee_id, pin }        4자리 → bcrypt 저장 (4단계 배포용)
//   holiday_create    { date, name, hours? }
//   holiday_delete    { id }
//
// 대시보드가 만들거나 고친 행은 source='admin'(출퇴근) 등으로 표시된다 —
// 병행 동기화(sync.sh)가 이 표시를 보고 기존 JSON 값으로 덮어쓰지 않는다.
//
// 급여 로직은 salary.ts — work-manager salary.js의 축자 이식. 수정 전 그 파일 주석 참조.
// ═══════════════════════════════════════════════════════════════
import bcrypt from 'npm:bcryptjs@2.4.3';
import { handleOptions, json, verifyAuthToken } from '../_shared/util.ts';
import {
  calcOne, getExtendedRange, sortEmployees,
  type WmAttendance, type WmEmployee, type WmHoliday, type WmLeave,
} from './salary.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function rest(path: string, init: RequestInit = {}): Promise<any[]> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`db ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

/** KST 현재 시각 'YYYY-MM-DD HH:MM:SS' — Edge Function은 UTC로 돌므로 반드시 이걸 쓸 것.
 *  'sv-SE' 로케일이 정확히 이 형식을 내놓는다. (급여 로직은 시간대 무관 — 거긴 건드리지 말 것) */
function kstNow(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
}

/** attendance_edits.js minutesDiff 그대로 */
function minutesDiff(a: string, b: string): number {
  return Math.floor((new Date(b.replace(' ', 'T')).getTime() - new Date(a.replace(' ', 'T')).getTime()) / 60000);
}

const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const D_RE = /^\d{4}-\d{2}-\d{2}$/;

async function auditLog(actor: string, action: string, employee_id: number | null, detail: unknown) {
  try {
    await rest('wm_kiosk_log', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ actor, action, employee_id, detail }),
    });
  } catch (_) { /* 로그 실패가 본 동작을 막으면 안 됨 */ }
}

const ym2 = (y: unknown, m: unknown) => `${y}-${String(m).padStart(2, '0')}`;

/** ym 다음 달의 1일 — 휴가 조회 상한(미만)에 사용.
 *  주의: `${ym}-31`처럼 고정 31일을 쓰면 6월(30일)에서 존재하지 않는 날짜로 400이 난다. */
function nextMonthFirst(ym: string): string {
  let [y, m] = ym.split('-').map(Number);
  if (++m > 12) { m = 1; y++; }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/** 급여 계산에 필요한 데이터를 한 번에 로드 (직원별 쿼리 반복 방지) */
async function loadForMonth(ym: string) {
  const { from, to } = getExtendedRange(ym);
  const [employees, attendance, leaves, holidays] = await Promise.all([
    rest('wm_employees?select=id,name,type,hourly_rate,monthly_salary,transport_allowance,annual_leave_total,fixed_clock_in,birthday,bank_name,bank_account,bank_holder,active&active=is.true') as Promise<WmEmployee[]>,
    // 확장 범위(월 경계 주 포함)만 — salary.js의 getExtendedRecords와 동일 범위
    rest(`wm_attendance?select=id,employee_id,date,clock_in,clock_out,work_minutes&date=gte.${from}&date=lte.${to}&limit=5000`) as Promise<WmAttendance[]>,
    rest(`wm_leaves?select=id,employee_id,date,type,status&date=gte.${ym}-01&date=lt.${nextMonthFirst(ym)}&limit=2000`) as Promise<WmLeave[]>,
    rest('wm_holidays?select=date,name,hours&limit=2000') as Promise<WmHoliday[]>,
  ]);
  return { employees, attendance, leaves, holidays };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  const me = await verifyAuthToken(req);
  if (!me) return json({ error: '로그인이 필요합니다' }, 401);
  if (me.role !== 'admin') return json({ error: '접근 권한이 없습니다' }, 403);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? '');

    if (action === 'salary_all') {
      const ym = ym2(body.year, body.month);
      const { employees, attendance, leaves, holidays } = await loadForMonth(ym);
      const rows = sortEmployees(employees).map(emp => calcOne(emp, ym, attendance, leaves, holidays));
      return json(rows);
    }

    if (action === 'salary_one') {
      const ym = ym2(body.year, body.month);
      const empId = Number(body.employee_id);
      const { employees, attendance, leaves, holidays } = await loadForMonth(ym);
      const emp = employees.find(e => e.id === empId);
      if (!emp) return json({ error: '직원 없음' }, 404);
      return json(calcOne(emp, ym, attendance, leaves, holidays));
    }

    // 대시보드 순익 메뉴의 '근무관리에서 불러오기' — 기간이 걸친 달들의 급여 합계.
    // 예전엔 브라우저가 http://localhost:3001 을 월마다 호출했다(근무관리 켜진 PC에서만 동작).
    if (action === 'labor_total') {
      const s = String(body.start_date ?? ''), e = String(body.end_date ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) {
        return json({ error: '기간이 올바르지 않습니다' }, 400);
      }
      const months: string[] = [];
      let [y, m] = [Number(s.slice(0, 4)), Number(s.slice(5, 7))];
      const [ey, em] = [Number(e.slice(0, 4)), Number(e.slice(5, 7))];
      while (y < ey || (y === ey && m <= em)) {
        months.push(`${y}-${String(m).padStart(2, '0')}`);
        if (++m > 12) { m = 1; y++; }
        if (months.length > 36) break;   // 안전장치
      }
      let total = 0, empN = 0;
      const detail: { ym: string; total: number }[] = [];
      for (const ym of months) {
        const { employees, attendance, leaves, holidays } = await loadForMonth(ym);
        const rows = sortEmployees(employees).map(emp => calcOne(emp, ym, attendance, leaves, holidays));
        const sub = rows.reduce((t, r: any) => t + (r.totalPay || 0), 0);
        total += sub; empN = rows.length;
        detail.push({ ym, total: sub });
      }
      return json({ total, employee_count: empN, months: detail });
    }

    if (action === 'employee_list') {
      // 관리자 전용 함수이므로 계좌·급여 포함. pin_hash는 절대 내보내지 않는다.
      const year = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 4);
      const [emps, approved, users] = await Promise.all([
        rest('wm_employees?select=id,name,type,hourly_rate,monthly_salary,'
          + 'annual_leave_total,transport_allowance,fixed_clock_in,birthday,hire_date,annual_salary,'
          + 'bank_name,bank_account,bank_holder,active,pin_set_at,app_user_id&order=type,name'),
        rest(`wm_leaves?status=eq.approved&date=gte.${year}-01-01&date=lte.${year}-12-31&select=employee_id,type,reason&limit=3000`),
        rest('app_users?select=id,name'),
      ]);
      // 연결된 정직원의 이름은 대시보드 계정이 원본 (2026-08-27) — 계정 이름이 바뀌면 여기서 따라간다
      const uname: Record<string, string> = {};
      for (const u of users as { id: string; name: string }[]) uname[u.id] = u.name;
      for (const e of emps as Record<string, unknown>[]) {
        const uid = String(e.app_user_id ?? '');
        if (uid && uname[uid] && uname[uid] !== e.name) {
          await rest(`wm_employees?id=eq.${e.id}`, { method: 'PATCH', body: JSON.stringify({ name: uname[uid] }) });
          e.name = uname[uid];
        }
      }
      // 올해 사용 연차 — leaves.js /remaining과 동일 규칙 (여름휴가·사유 하계/여름휴가는 미차감)
      const used: Record<number, number> = {};
      for (const l of approved) {
        if (l.type === 'summer') continue;
        if (l.reason && (l.reason.includes('하계휴가') || l.reason.includes('여름휴가'))) continue;
        used[l.employee_id] = (used[l.employee_id] || 0) + (l.type === 'annual' ? 1 : 0.5);
      }
      return json(emps.map((e: any) => ({ ...e, annual_used: used[e.id] || 0 })));
    }

    if (action === 'attendance_list') {
      const ym = ym2(body.year, body.month);
      const rows = await rest(`wm_attendance?select=*&date=gte.${ym}-01&date=lt.${nextMonthFirst(ym)}`
        + '&order=date.desc,clock_in.desc&limit=3000');
      return json(rows);
    }

    if (action === 'edits_pending') {
      return json(await rest('wm_attendance_edits?select=*&status=eq.pending&order=created_at.desc&limit=200'));
    }

    // ══════════ 쓰기 액션 (3단계) ══════════

    if (action === 'attendance_upsert') {
      const empId = Number(body.employee_id);
      const { date, clock_in, clock_out, note } = body;
      if (!empId || !D_RE.test(String(date)) || !TS_RE.test(String(clock_in))) {
        return json({ error: '필수 항목 누락 또는 형식 오류 (clock_in은 YYYY-MM-DD HH:MM:SS)' }, 400);
      }
      if (clock_out && !TS_RE.test(String(clock_out))) return json({ error: '퇴근 시각 형식 오류' }, 400);
      const work_minutes = (clock_in && clock_out) ? minutesDiff(clock_in, clock_out) : null;
      if (work_minutes !== null && work_minutes <= 0) return json({ error: '퇴근이 출근보다 빠릅니다' }, 400);

      let row;
      if (body.id) {
        const orig = (await rest(`wm_attendance?id=eq.${Number(body.id)}&select=*`))[0];
        if (!orig) return json({ error: '기록 없음' }, 404);
        [row] = await rest(`wm_attendance?id=eq.${Number(body.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            clock_in, clock_out: clock_out || null, work_minutes, note: note || null,
            is_edited: true, edited_at: kstNow(),
            original_clock_in: orig.original_clock_in || orig.clock_in,
            original_clock_out: orig.original_clock_out || orig.clock_out,
            source: 'admin',   // ← 병행 동기화가 이 행을 덮어쓰지 않게 하는 표시
          }),
        });
      } else {
        const dup = await rest(`wm_attendance?employee_id=eq.${empId}&date=eq.${date}&select=id`);
        if (dup.length) return json({ error: '해당 날짜에 이미 기록이 있습니다 (수정으로 처리하세요)' }, 400);
        [row] = await rest('wm_attendance', {
          method: 'POST',
          body: JSON.stringify({
            employee_id: empId, date, clock_in, clock_out: clock_out || null,
            work_minutes, note: note || null, is_edited: true, edited_at: kstNow(), source: 'admin',
          }),
        });
      }
      await auditLog(me.id, body.id ? 'attendance_update' : 'attendance_create', empId, { date, clock_in, clock_out });
      return json(row);
    }

    if (action === 'attendance_delete') {
      const id = Number(body.id);
      const orig = (await rest(`wm_attendance?id=eq.${id}&select=*`))[0];
      if (!orig) return json({ error: '기록 없음' }, 404);
      await rest(`wm_attendance?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      await auditLog(me.id, 'attendance_delete', orig.employee_id, orig);
      return json({ ok: true });
    }

    // 시간 수정 신청 승인/거절 — attendance_edits.js PUT /:id/status의 축자 이식
    if (action === 'edit_review') {
      const status = String(body.status);
      if (!['approved', 'rejected'].includes(status)) return json({ error: '유효하지 않은 상태' }, 400);
      const edit = (await rest(`wm_attendance_edits?id=eq.${Number(body.id)}&select=*`))[0];
      if (!edit) return json({ error: '없음' }, 404);
      if (edit.status !== 'pending') return json({ error: '이미 처리된 신청입니다' }, 400);

      await rest(`wm_attendance_edits?id=eq.${edit.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status, reviewed_at: kstNow() }),
      });

      if (status === 'approved') {
        // 원본 버그 수정(계획서 7단계 승인분): 퇴근 미기입 신청 승인 시 기존 퇴근시각으로
        // work_minutes를 재계산한다. 원본은 null로 만들어 근무시간이 사라졌다(2026-07-20 8건).
        if (edit.attendance_id) {
          const orig = (await rest(`wm_attendance?id=eq.${edit.attendance_id}&select=*`))[0];
          const finalOut = edit.requested_clock_out || orig?.clock_out || null;
          const work_minutes = (edit.requested_clock_in && finalOut)
            ? minutesDiff(edit.requested_clock_in, finalOut) : null;
          await rest(`wm_attendance?id=eq.${edit.attendance_id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              clock_in: edit.requested_clock_in,
              clock_out: finalOut,
              work_minutes,
              is_edited: true, edited_at: kstNow(),
              original_clock_in: orig?.original_clock_in || orig?.clock_in || null,
              original_clock_out: orig?.original_clock_out || orig?.clock_out || null,
              source: 'edit_approval',
            }),
          });
        } else {
          const work_minutes = (edit.requested_clock_in && edit.requested_clock_out)
            ? minutesDiff(edit.requested_clock_in, edit.requested_clock_out) : null;
          await rest('wm_attendance', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              employee_id: edit.employee_id, date: edit.date,
              clock_in: edit.requested_clock_in, clock_out: edit.requested_clock_out || null,
              work_minutes, is_edited: true, edited_at: kstNow(),
              note: `수정 신청 승인 (사유: ${edit.reason})`, source: 'edit_approval',
            }),
          });
        }
      }
      await auditLog(me.id, 'edit_' + status, edit.employee_id, { edit_id: edit.id, date: edit.date });
      return json((await rest(`wm_attendance_edits?id=eq.${edit.id}&select=*`))[0]);
    }

    if (action === 'leave_list') {
      const parts = ['select=*', 'order=date.desc', 'limit=1000'];
      if (body.year && body.month) {
        const ym = ym2(body.year, body.month);
        parts.push(`date=gte.${ym}-01`, `date=lt.${nextMonthFirst(ym)}`);
      } else if (body.year) {
        parts.push(`date=gte.${body.year}-01-01`, `date=lte.${body.year}-12-31`);
      }
      if (body.status) parts.push(`status=eq.${body.status}`);
      return json(await rest(`wm_leaves?${parts.join('&')}`));
    }

    // 휴가 등록 — leaves.js POST의 이식 (기간 등록·주말공휴일 제외·중복 건너뛰기 포함)
    if (action === 'leave_create') {
      const empId = Number(body.employee_id);
      const { date, end_date, type, reason, skip_offdays, auto_approve } = body;
      if (!empId || !date || !type) return json({ error: '필수 항목 누락' }, 400);
      if (!['annual', 'half', 'summer'].includes(type)) return json({ error: '휴가 종류 오류' }, 400);
      const status = auto_approve ? 'approved' : 'pending';

      if (end_date && end_date !== date) {
        if (end_date < date) return json({ error: '종료 날짜가 시작 날짜보다 빠릅니다.' }, 400);
        const holidaySet = new Set((await rest('wm_holidays?select=date&limit=2000')).map((h: any) => h.date));
        const dates: string[] = [];
        for (const d = new Date(`${date}T00:00:00`); ; d.setDate(d.getDate() + 1)) {
          const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          if (s > end_date) break;
          if (dates.length >= 62) return json({ error: '기간이 너무 깁니다. (최대 2개월)' }, 400);
          if (skip_offdays && (d.getDay() === 0 || d.getDay() === 6 || holidaySet.has(s))) continue;
          dates.push(s);
        }
        if (!dates.length) return json({ error: '기간 내 등록할 날짜가 없습니다. (주말·공휴일 제외)' }, 400);

        const existing = new Set(
          (await rest(`wm_leaves?employee_id=eq.${empId}&status=neq.rejected&select=date`)).map((r: any) => r.date));
        const toInsert = dates.filter(s => !existing.has(s));
        const skipped = dates.filter(s => existing.has(s));
        if (!toInsert.length) return json({ error: '기간 내 모든 날짜에 이미 신청 내역이 있습니다.' }, 400);

        const rows = await rest('wm_leaves', {
          method: 'POST',
          body: JSON.stringify(toInsert.map(s => ({ employee_id: empId, date: s, type, status, reason: reason || null }))),
        });
        await auditLog(me.id, 'leave_create_range', empId, { from: date, to: end_date, type, inserted: rows.length });
        return json({ range: true, inserted: rows.length, skipped, rows });
      }

      const dup = await rest(`wm_leaves?employee_id=eq.${empId}&date=eq.${date}&status=neq.rejected&select=id`);
      if (dup.length) return json({ error: '해당 날짜에 이미 신청 내역이 있습니다.' }, 400);
      const [row] = await rest('wm_leaves', {
        method: 'POST',
        body: JSON.stringify({ employee_id: empId, date, type, status, reason: reason || null }),
      });
      await auditLog(me.id, 'leave_create', empId, { date, type, status });
      return json(row);
    }

    if (action === 'leave_review') {
      const status = String(body.status);
      if (!['approved', 'rejected'].includes(status)) return json({ error: '유효하지 않은 상태' }, 400);
      const [row] = await rest(`wm_leaves?id=eq.${Number(body.id)}`, {
        method: 'PATCH', body: JSON.stringify({ status, reviewed_at: kstNow() }),
      });
      if (!row) return json({ error: '없음' }, 404);
      await auditLog(me.id, 'leave_' + status, row.employee_id, { leave_id: row.id, date: row.date });
      return json(row);
    }

    if (action === 'leave_delete') {
      const id = Number(body.id);
      const orig = (await rest(`wm_leaves?id=eq.${id}&select=*`))[0];
      if (!orig) return json({ error: '없음' }, 404);
      await rest(`wm_leaves?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      await auditLog(me.id, 'leave_delete', orig.employee_id, orig);
      return json({ ok: true });
    }

    // 연결 가능한 대시보드 계정 목록 (2026-08-27) — 아직 근무 관리 직원과 연결되지 않은 비관리자 계정
    if (action === 'employee_linkable') {
      const [users, linked] = await Promise.all([
        rest('app_users?select=id,name,role&role=neq.admin&order=name'),
        rest('wm_employees?select=app_user_id&app_user_id=not.is.null'),
      ]);
      const taken = new Set((linked as { app_user_id: string }[]).map((e) => e.app_user_id));
      return json((users as { id: string; role: string }[]).filter((u) => !taken.has(u.id)));
    }

    // 기존 직원 행 ↔ 대시보드 계정 연결 (미연결 정직원용)
    if (action === 'employee_link') {
      const id = Number(body.id);
      const uid = String(body.app_user_id ?? '');
      const [u] = await rest(`app_users?id=eq.${encodeURIComponent(uid)}&select=id,name,role`);
      if (!u) return json({ error: '대시보드 계정을 찾을 수 없습니다' }, 400);
      if (u.role === 'admin') return json({ error: '관리자 계정은 연결할 수 없습니다' }, 400);
      const dup = await rest(`wm_employees?app_user_id=eq.${encodeURIComponent(uid)}&select=id`);
      if (dup.length) return json({ error: '이미 다른 직원과 연결된 계정입니다' }, 400);
      const [row] = await rest(`wm_employees?id=eq.${id}`, {
        method: 'PATCH', body: JSON.stringify({ app_user_id: uid, name: u.name, type: 'employee' }),
      });
      if (!row) return json({ error: '직원 없음' }, 404);
      await auditLog(me.id, 'employee_link', row.id, { app_user_id: uid });
      return json({ ok: true });
    }

    // 직원 등록/수정 — ⚠️ 의도적으로 부분 수정: 보낸 필드만 갱신.
    // (기존 Express PUT은 전체 필드를 다시 써서, 일부만 보내면 월급 등이 0으로 초기화되는
    //  사고가 있었다. 그 함정을 여기서 제거한다.)
    // 신규 등록 규칙 (2026-08-27 사용자 지정): 직접 추가는 **알바만**(type 서버 강제).
    // 정직원은 app_user_id(대시보드 직원 계정) 연결로만 생성 — 이름은 계정에서 오고 계정이 원본.
    if (action === 'employee_upsert') {
      // annual_salary: 계약서상 연봉 — 급여 계산에 쓰는 monthly_salary와 별개(2026-08-27, "급여 1원도
      // 달라지면 안 됨" 규칙 보호). 12로 나눠떨어지지 않는 연봉을 월급×12로 정확히 표시할 수 없어
      // 계약서 원본 금액을 그대로 담아두는 표시 전용 필드 — 실제 지급액(monthly_salary)은 안 건드린다.
      const FIELDS = ['name', 'type', 'hourly_rate', 'monthly_salary', 'annual_salary', 'annual_leave_total',
        'transport_allowance', 'fixed_clock_in', 'birthday', 'hire_date', 'bank_name', 'bank_account', 'bank_holder'];
      const patch: Record<string, unknown> = {};
      for (const f of FIELDS) if (f in body) patch[f] = body[f];
      if ('hire_date' in patch && patch.hire_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(patch.hire_date))) {
        return json({ error: '입사일은 YYYY-MM-DD 형식' }, 400);
      }
      if ('type' in patch && !['employee', 'parttime'].includes(String(patch.type))) {
        return json({ error: '직원 유형 오류' }, 400);
      }
      if ('fixed_clock_in' in patch && patch.fixed_clock_in && !/^\d{2}:\d{2}$/.test(String(patch.fixed_clock_in))) {
        return json({ error: '출근시간 고정은 HH:MM 형식' }, 400);
      }

      let row;
      if (body.id) {
        const [cur] = await rest(`wm_employees?id=eq.${Number(body.id)}&select=app_user_id`);
        if (!cur) return json({ error: '직원 없음' }, 404);
        if (cur.app_user_id) { delete patch.name; delete patch.type; }   // 연결된 정직원의 이름·유형은 계정이 원본
        [row] = await rest(`wm_employees?id=eq.${Number(body.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
        if (!row) return json({ error: '직원 없음' }, 404);
      } else {
        if (body.app_user_id) {   // 정직원 = 계정 연결 생성
          const uid = String(body.app_user_id);
          const [u] = await rest(`app_users?id=eq.${encodeURIComponent(uid)}&select=id,name,role`);
          if (!u) return json({ error: '대시보드 계정을 찾을 수 없습니다' }, 400);
          if (u.role === 'admin') return json({ error: '관리자 계정은 연결할 수 없습니다' }, 400);
          const dup = await rest(`wm_employees?app_user_id=eq.${encodeURIComponent(uid)}&select=id`);
          if (dup.length) return json({ error: '이미 연결된 계정입니다' }, 400);
          patch.app_user_id = uid;
          patch.type = 'employee';
          patch.name = u.name;
        } else {
          patch.type = 'parttime';   // 직접 추가는 알바 고정 (사용자 지정 — 서버 강제)
        }
        if (!patch.name) return json({ error: '이름은 필수입니다.' }, 400);
        [row] = await rest('wm_employees', { method: 'POST', body: JSON.stringify(patch) });
      }
      delete row.pin_hash;   // 해시라도 클라이언트로 내보내지 않는다
      await auditLog(me.id, body.id ? 'employee_update' : 'employee_create', row.id, patch);
      return json(row);
    }

    // 소프트 삭제/복구 — 하드 삭제 없음. 기존 Express DELETE는 출퇴근·휴가 기록까지
    // 지워 급여 기록을 파괴했다. 승계 금지.
    if (action === 'employee_active') {
      const [row] = await rest(`wm_employees?id=eq.${Number(body.id)}`, {
        method: 'PATCH', body: JSON.stringify({ active: !!body.active }),
      });
      if (!row) return json({ error: '직원 없음' }, 404);
      await auditLog(me.id, body.active ? 'employee_activate' : 'employee_deactivate', row.id, null);
      return json({ ok: true, active: row.active });
    }

    if (action === 'set_pin') {
      const pin = String(body.pin ?? '');
      if (!/^\d{4}$/.test(pin)) return json({ error: 'PIN은 숫자 4자리여야 합니다.' }, 400);
      const hash = bcrypt.hashSync(pin, 10);
      const [row] = await rest(`wm_employees?id=eq.${Number(body.employee_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ pin_hash: hash, pin_set_at: kstNow() + '+09', pin_fail_count: 0, pin_locked_until: null }),
      });
      if (!row) return json({ error: '직원 없음' }, 404);
      await auditLog(me.id, 'set_pin', row.id, null);   // PIN 값은 로그에도 남기지 않는다
      return json({ ok: true });
    }

    if (action === 'holiday_create') {
      const { date, name } = body;
      if (!date || !name) return json({ error: '날짜와 이름은 필수입니다.' }, 400);
      if (!D_RE.test(String(date))) return json({ error: '날짜 형식 오류 (YYYY-MM-DD)' }, 400);
      // 원본과 동일하게 날짜 단독 중복을 거부 (프리셋의 겹침 4건은 이관 데이터라 그대로)
      const dup = await rest(`wm_holidays?date=eq.${date}&select=id`);
      if (dup.length) return json({ error: '해당 날짜에 이미 공휴일이 등록되어 있습니다.' }, 400);
      const [row] = await rest('wm_holidays', {
        method: 'POST', body: JSON.stringify({ date, name, hours: Number(body.hours) || 8 }),
      });
      await auditLog(me.id, 'holiday_create', null, { date, name });
      return json(row);
    }

    if (action === 'holiday_delete') {
      const id = Number(body.id);
      const orig = (await rest(`wm_holidays?id=eq.${id}&select=*`))[0];
      if (!orig) return json({ error: '없는 항목입니다.' }, 404);
      await rest(`wm_holidays?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      await auditLog(me.id, 'holiday_delete', null, orig);
      return json({ ok: true });
    }

    if (action === 'holiday_list') {
      return json(await rest('wm_holidays?select=*&order=date&limit=2000'));
    }

    // ══════════ 키오스크 기기 관리 (5단계) ══════════

    // 페어링 코드 발급 — 10분 유효, 1회용. 매장 PC 키오스크 화면에 입력해 등록한다.
    if (action === 'device_pair_code') {
      const label = String(body.label ?? '').trim();
      if (!label) return json({ error: '기기 이름을 입력해주세요 (예: 매장 카운터 PC)' }, 400);
      const code = String(Math.floor(10000000 + Math.random() * 90000000));
      const [row] = await rest('wm_devices', {
        method: 'POST',
        body: JSON.stringify({
          label, pairing_code: code,
          pairing_exp: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        }),
      });
      await auditLog(me.id, 'device_pair_code', null, { device_id: row.id, label });
      return json({ id: row.id, label, pairing_code: code, expires_minutes: 10 });
    }

    if (action === 'device_list') {
      const rows = await rest('wm_devices?select=id,label,active,allowed_ips,enforce_ip,last_seen_at,last_ip,pairing_code,pairing_exp,created_at&order=created_at.desc');
      // 페어링 코드는 발급 응답에서만 보여준다 — 목록에는 대기 여부만
      return json(rows.map((d: any) => ({
        ...d,
        pairing_pending: !!d.pairing_code && !!d.pairing_exp && new Date(d.pairing_exp).getTime() > Date.now(),
        pairing_code: undefined,
      })));
    }

    if (action === 'device_revoke') {
      const [row] = await rest(`wm_devices?id=eq.${body.id}`, {
        method: 'PATCH', body: JSON.stringify({ active: false }),
      });
      if (!row) return json({ error: '기기 없음' }, 404);
      await auditLog(me.id, 'device_revoke', null, { device_id: row.id, label: row.label });
      return json({ ok: true });
    }

    // 매장 IP 승인 — 회선이 바뀌어 키오스크가 거부될 때 대표가 원격에서 한 번 탭해 복구
    if (action === 'device_allow_ip') {
      const ipToAdd = String(body.ip ?? '').trim();
      if (!/^[0-9a-fA-F.:]{3,45}$/.test(ipToAdd)) return json({ error: 'IP 형식 오류' }, 400);
      const [dev] = await rest(`wm_devices?id=eq.${body.id}&select=*`);
      if (!dev) return json({ error: '기기 없음' }, 404);
      const ips: string[] = dev.allowed_ips || [];
      if (!ips.includes(ipToAdd)) ips.push(ipToAdd);
      await rest(`wm_devices?id=eq.${dev.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ allowed_ips: ips }),
      });
      await auditLog(me.id, 'device_allow_ip', null, { device_id: dev.id, ip: ipToAdd });
      return json({ ok: true, allowed_ips: ips });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (err) {
    return json({ error: String(err).slice(0, 400) }, 500);
  }
});
