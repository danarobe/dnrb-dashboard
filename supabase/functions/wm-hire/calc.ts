// 알바 채용 — 순수 계산·검증 (DB·암호화 없음). 화면 hire.js에 같은 식이 있다 — 바꾸면 둘 다, dev/dev-server.mjs --test로 일치 확인.

export const MIN_WAGE = 10320;   // 2026년 최저시급. 해가 바뀌면 화면 hire.js의 HIRE_MIN_WAGE와 같이 올릴 것

/** 3.3% 사업소득 — 사용자 엑셀 '사업소득 계산'과 같은 식 (2026-10-12 사용자 지정):
 *    사업소득세 = ROUNDDOWN(세전×3%, -1), 지방소득세 = ROUNDDOWN(세전×0.3%, -1)  예: 31,500 → 940 / 90 / 실 30,470
 *  소액부징수(1,000원 미만 0원)는 적용하지 않는다. 근무관리 wmExportSalary와도 같은 식.
 *  고용보험 0.9%는 선택(원 미만 절사). 정수 연산만 — 0.03 같은 소수 곱은 절사 경계에서 틀린다. */
export function calcPay(p: { minutes: number; hourly_rate: number; fixed_amount?: number | null; emp_ins?: boolean }) {
  const gross = p.fixed_amount != null ? p.fixed_amount : Math.round(p.hourly_rate * p.minutes / 60);
  const income_tax = Math.floor(gross * 3 / 1000) * 10;
  const local_tax = Math.floor(gross * 3 / 10000) * 10;
  const emp_ins_amt = p.emp_ins ? Math.floor(gross * 9 / 1000) : 0;
  return { gross, income_tax, local_tax, emp_ins_amt, net: gross - income_tax - local_tax - emp_ins_amt };
}

/** 주민번호 → { digits, birth:'YYYY-MM-DD' } 또는 오류 문구.
 *  검증숫자(끝자리)는 보지 않는다 — 2020-10 이후 발급분은 뒷자리가 임의 번호라 공식이 안 맞음. */
export function parseRrn(s: string): { digits: string; birth: string } | { error: string } {
  const d = String(s ?? '').replace(/[\s-]/g, '');
  if (!/^\d{13}$/.test(d)) return { error: '주민번호는 숫자 13자리예요 (예: 900101-1234567)' };
  const g = d[6];
  const century = '1256'.includes(g) ? 1900 : '3478'.includes(g) ? 2000 : 0;
  if (!century) return { error: '주민번호 뒷자리 첫 숫자는 1~8이어야 해요' };
  const y = century + Number(d.slice(0, 2)), m = Number(d.slice(2, 4)), day = Number(d.slice(4, 6));
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) return { error: '주민번호 앞자리 생년월일이 올바르지 않아요' };
  return { digits: d, birth: dt.toISOString().slice(0, 10) };
}

/** 휴대폰 번호 → '010-1234-5678' 또는 null */
export function normPhone(s: string): string | null {
  const d = String(s ?? '').replace(/\D/g, '');
  if (!/^01[016789]\d{7,8}$/.test(d)) return null;
  return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/** 계좌번호 → 숫자·하이픈만, 숫자 8~20자리 아니면 null */
export function normAccount(s: string): string | null {
  const t = String(s ?? '').replace(/[^\d-]/g, '');
  const n = t.replace(/-/g, '').length;
  return n >= 8 && n <= 20 ? t : null;
}

/** 'HH:MM' 두 개 + 휴게(분) → 근무 분. 종료가 시작보다 이르면 null */
export function workMinutes(start: string, end: string, breakMin = 0): number | null {
  const toMin = (t: string) => /^\d{2}:\d{2}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : NaN;
  const m = toMin(end) - toMin(start) - (breakMin || 0);
  return Number.isFinite(m) && m >= 0 ? m : null;
}
