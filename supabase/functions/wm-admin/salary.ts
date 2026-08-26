// ═══════════════════════════════════════════════════════════════
// 급여 계산 — work-manager `server/routes/salary.js`의 축자 이식
//
// ⚠️ 이 파일은 "다시 짠 것"이 아니라 "글자 그대로 옮긴 것"이다.
//    실제 급여 지급에 쓰이므로 1원도 달라지면 안 된다.
//
// 절대 하지 말 것:
//  · Math.round → toFixed 등 반올림 방식 "개선"
//  · weeks / weekHoursInMonth 이중 구조 정리
//    (weeks = 주 15시간 판정용으로 인접 월 포함, weekHoursInMonth = 표시용으로 해당 월만.
//     의도된 이중 구조다. salary.js:56-58 참조)
//  · 시간대 처리 추가 — 이 로직은 시간대 무관하다.
//    모든 Date가 문자열을 파싱해 다시 로컬 게터로 포맷하거나(fmtDate),
//    같은 형식끼리 뺄셈만 한다. 한국은 서머타임도 없다.
//    UTC로 도는 Edge Function에서도 동일한 결과가 나온다. 건드리면 오히려 깨진다.
//  · clock_in/clock_out을 timestamptz로 바꾸기 — substring(11,16)이 깨진다.
// ═══════════════════════════════════════════════════════════════

export interface WmEmployee {
  id: number; name: string; type: string;
  hourly_rate: number; monthly_salary: number;
  transport_allowance: number | null;
  annual_leave_total: number | null;
}
export interface WmAttendance {
  id: number; employee_id: number; date: string;
  clock_in: string | null; clock_out: string | null; work_minutes: number | null;
}
export interface WmLeave {
  id: number; employee_id: number; date: string; type: string; status: string;
}
export interface WmHoliday { date: string; name: string; hours?: number | null }

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return fmtDate(d);
}

function getWeekSunday(weekStartStr: string): string {
  const d = new Date(weekStartStr + 'T00:00:00');
  d.setDate(d.getDate() + 6);
  return fmtDate(d);
}

function getMealInfo(clockIn: string | null, clockOut: string | null) {
  if (!clockIn || !clockOut) return { deductMins: 0, mealAllowance: 0 };
  const inTime = clockIn.substring(11, 16);
  const outTime = clockOut.substring(11, 16);
  if (inTime < '09:00' || inTime >= '12:00') return { deductMins: 0, mealAllowance: 0 };
  if (outTime <= '12:00') return { deductMins: 0, mealAllowance: 0 };
  // 12시 이후 퇴근이면 점심 60분 고정 차감
  return { deductMins: 60, mealAllowance: 8000 };
}

/** ym 월의 전체 주 커버를 위해 인접 월 레코드까지 포함해서 가져옴 */
export function getExtendedRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number);
  const firstDay = new Date(y, m - 1, 1);
  const lastDay = new Date(y, m, 0);
  // 첫 날이 속한 주의 월요일
  const fd = firstDay.getDay();
  const firstMon = new Date(firstDay);
  firstMon.setDate(firstDay.getDate() - (fd === 0 ? 6 : fd - 1));
  // 마지막 날이 속한 주의 일요일
  const ld = lastDay.getDay();
  const lastSun = new Date(lastDay);
  lastSun.setDate(lastDay.getDate() + (ld === 0 ? 0 : 7 - ld));
  return { from: fmtDate(firstMon), to: fmtDate(lastSun) };
}

export function getExtendedRecords(all: WmAttendance[], empId: number, ym: string): WmAttendance[] {
  const { from, to } = getExtendedRange(ym);
  // 원본: db.attendance.all(r => ...) — 유일하게 허용된 변경 (JSON 테이블 → 배열 필터)
  return all.filter(r => r.employee_id === empId && r.date >= from && r.date <= to);
}

// ym = "YYYY-MM" (제공 시 마지막 주 주휴수당 이월 로직 적용)
// records에 인접 월 레코드가 섞여도 OK — 기본급은 ym 내 기록만, 주휴수당은 일요일이 ym 내인 주만
export function calcParttime(
  records: WmAttendance[], hourlyRate: number,
  holidays: WmHoliday[] = [], ym: string | null = null, transportAllowance = 0,
) {
  const weeks: Record<string, number> = {};            // 주휴수당 15h 충족 판단용 (인접 월 포함)
  const weekHoursInMonth: Record<string, number> = {}; // 표시용: 해당 월 기록만
  const weekHolidays: Record<string, { name: string; hours: number }[]> = {};
  let totalMinutes = 0;
  let totalMealAllow = 0;
  let mealDays = 0;

  for (const r of records) {
    if (!r.clock_in || !r.clock_out) continue;
    const rawMins = Math.floor(
      (new Date(r.clock_out.replace(' ', 'T')).getTime() - new Date(r.clock_in.replace(' ', 'T')).getTime()) / 60000,
    );
    if (rawMins <= 0) continue;

    const { deductMins, mealAllowance } = getMealInfo(r.clock_in, r.clock_out);
    const effectiveMins = rawMins - deductMins;

    const wk = getWeekStart(r.date);
    weeks[wk] = (weeks[wk] || 0) + effectiveMins;

    // 기본급·식대·표시용 주간시간은 해당 월 기록만
    if (!ym || r.date.startsWith(ym)) {
      weekHoursInMonth[wk] = (weekHoursInMonth[wk] || 0) + effectiveMins;
      if (mealAllowance > 0) { totalMealAllow += mealAllowance; mealDays++; }
      totalMinutes += effectiveMins;
    }
  }

  // 공휴일은 표시만 (알바는 공휴일 미근무이므로 주간 시간에 합산 안 함)
  for (const h of holidays) {
    const wk = getWeekStart(h.date);
    if (weeks[wk] !== undefined) {
      if (!weekHolidays[wk]) weekHolidays[wk] = [];
      weekHolidays[wk].push({ name: h.name, hours: h.hours || 8 });
    }
  }

  const totalHours = totalMinutes / 60;
  const basePay = Math.round(totalHours * hourlyRate);

  const weeklyBreakdown = Object.entries(weeks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, totalMins]) => {
      // 15h 충족 판단은 인접 월 포함한 전체 주 시간으로
      const weekHoursTotal = totalMins / 60;
      const qualifies = weekHoursTotal >= 15;
      // 주휴수당 귀속: 해당 주의 일요일이 ym에 속하는지 여부로 결정
      const sunday = getWeekSunday(weekStart);
      const sunInMonth = !ym || sunday.startsWith(ym);
      const holidayPay = qualifies && sunInMonth
        ? Math.round((Math.min(weekHoursTotal, 40) / 40) * 8 * hourlyRate)
        : 0;
      // 표시용 주간 근무시간은 해당 월 기록만
      const displayMins = weekHoursInMonth[weekStart] || 0;
      return {
        weekStart,
        weekSunday: sunday,
        weekHours: Math.round(displayMins / 60 * 100) / 100,
        weekHoursTotal: Math.round(weekHoursTotal * 100) / 100,
        qualifies: qualifies && sunInMonth,
        holidayPay,
        deferredToNext: qualifies && !sunInMonth,  // 다음 달로 이월된 주
        publicHolidays: weekHolidays[weekStart] || [],
      };
    });

  const holidayPay = weeklyBreakdown.reduce((s, w) => s + w.holidayPay, 0);

  return {
    totalHours: Math.round(totalHours * 100) / 100,
    basePay,
    holidayPay,
    mealAllowance: totalMealAllow,
    mealDays,
    transportAllowance,
    totalPay: basePay + holidayPay + totalMealAllow + transportAllowance,
    weeklyBreakdown,
  };
}

export function calcEmployee(emp: WmEmployee, records: WmAttendance[], approvedLeaves: WmLeave[]) {
  const totalHours = records.reduce((s, r) => s + (r.work_minutes || 0) / 60, 0);
  const leaveDays = approvedLeaves.reduce((s, l) => s + (l.type === 'half' ? 0.5 : 1), 0);
  return {
    monthlySalary: emp.monthly_salary,
    workDays: records.length,
    leaveDays,
    totalHours: Math.round(totalHours * 100) / 100,
    mealAllowance: 0,
    mealDays: 0,
    totalPay: emp.monthly_salary,
  };
}

/** salary.js의 GET / 와 GET /all 이 쓰는 직원 정렬 순서 */
export function sortEmployees(rows: WmEmployee[]): WmEmployee[] {
  return [...rows].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, 'ko'));
}

/** 한 직원의 한 달 급여 (salary.js router.get('/') 본문과 동일 분기) */
export function calcOne(
  emp: WmEmployee, ym: string,
  attendance: WmAttendance[], leaves: WmLeave[], holidays: WmHoliday[],
) {
  if (emp.type === 'parttime') {
    const extRecords = getExtendedRecords(attendance, emp.id, ym);
    return { employee: emp, ...calcParttime(extRecords, emp.hourly_rate, holidays, ym, emp.transport_allowance || 0) };
  }
  const records = attendance.filter(r => r.employee_id === emp.id && r.date.startsWith(ym));
  const approvedLeaves = leaves.filter(r => r.employee_id === emp.id && r.date.startsWith(ym) && r.status === 'approved');
  return { employee: emp, ...calcEmployee(emp, records, approvedLeaves) };
}
