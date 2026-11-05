-- 알바 지급 주기 (2026-11-05 사용자 요청 — "주급으로 받기 희망하는 알바, 매주 금요일 지급, 주휴수당은 기존 규칙 그대로").
-- 표시·관리용 칸일 뿐 급여 계산(wm-admin/salary.ts)은 바꾸지 않는다. monthly = 월급(기본), weekly = 주급.
alter table wm_employees add column if not exists pay_cycle text not null default 'monthly';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'wm_employees_pay_cycle_check') then
    alter table wm_employees add constraint wm_employees_pay_cycle_check check (pay_cycle in ('monthly', 'weekly'));
  end if;
end $$;
