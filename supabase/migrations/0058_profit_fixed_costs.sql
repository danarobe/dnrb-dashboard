-- 순익 시나리오 — 월 고정비 항목표 (2026-10-21 사용자 요청: "월 고정비를 먼저 파악" — 수동 7칸 대신 항목별로, 브라우저가 아니라 DB에 저장).
--   amount = 월 금액(부가세 미포함 공급가, 사용자 지정 "지금 적은 건 모두 vat 비포함"). vat = 'taxable'(부가세 10% 별도 — 매입세액 공제) / 'none'(부가세 없음 — 해외 결제·면세·인적 용역).
--   관리자만(db 프록시 allowlist). 인건비·택배비는 그대로 입력 칸(직원 급여는 따로 계산 — 사용자 지정).
create table if not exists public.profit_fixed_costs (
  id          bigserial primary key,
  name        text not null,
  amount      integer not null default 0,
  vat         text not null default 'taxable' check (vat in ('taxable', 'none')),
  note        text,
  active      boolean not null default true,
  sort_order  numeric not null default 0,
  updated_at  timestamptz not null default now()
);
alter table public.profit_fixed_costs enable row level security;
