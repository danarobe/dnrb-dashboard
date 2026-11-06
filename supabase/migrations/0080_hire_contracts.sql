-- 알바 채용 › 채용됨 — 계약서 회차별 서명 완료 기록 (2026-11-06 사용자 요청)
--   계약은 1달 단위(면접일부터 30일 뒤까지 = 1회차, 다음 날부터 다시 30일 뒤까지 = 2회차 …).
--   회차 시작일(period_from)이 그 회차 계약서에 다시 서명해야 할 날짜. 체크하면 다음 회차가 '서명 필요'로 보인다.
create table if not exists public.wm_hire_contracts (
  hire_id        integer not null references public.wm_hires(id) on delete cascade,
  period_from    date not null,
  period_to      date not null,
  signed_by_name text,
  signed_at      timestamptz not null default now(),
  primary key (hire_id, period_from)
);
alter table public.wm_hire_contracts enable row level security;
revoke all on public.wm_hire_contracts from anon, authenticated;
