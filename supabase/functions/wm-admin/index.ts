// ═══════════════════════════════════════════════════════════════
// 근무관리 — 관리자 전용 함수 (급여 계산 · 직원/출퇴근/휴가/공휴일 · 키오스크 기기)
//
//   POST { action, ... }  — 로그인 토큰(x-auth-token) 검증 후 role === 'admin'만
//
// 액션 (2단계: 조회·급여만 — 쓰기는 3단계):
//   salary_all      { year, month }               월 전체 급여
//   salary_one      { employee_id, year, month }  개인 급여
//   labor_total     { start_date, end_date }      기간 인건비 합계 (대시보드 순익 메뉴용)
//   employee_list   {}                            직원 목록 (계좌 포함 — 관리자 전용이므로 OK)
//   attendance_list { year, month }               월 출퇴근 기록
//   edits_pending   {}                            승인 대기 중인 시간 수정 신청
//
// 급여 로직은 salary.ts — work-manager salary.js의 축자 이식. 수정 전 그 파일 주석 참조.
// ═══════════════════════════════════════════════════════════════
import { handleOptions, json, verifyAuthToken } from '../_shared/util.ts';
import {
  calcOne, getExtendedRange, sortEmployees,
  type WmAttendance, type WmEmployee, type WmHoliday, type WmLeave,
} from './salary.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function rest(path: string): Promise<any[]> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) throw new Error(`db ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
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
      return json(await rest('wm_employees?select=id,name,type,hourly_rate,monthly_salary,'
        + 'annual_leave_total,transport_allowance,fixed_clock_in,birthday,'
        + 'bank_name,bank_account,bank_holder,active,pin_set_at&order=type,name'));
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

    return json({ error: 'unknown action' }, 400);
  } catch (err) {
    return json({ error: String(err).slice(0, 400) }, 500);
  }
});
