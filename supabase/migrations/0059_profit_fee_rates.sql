-- 순익 시나리오 — 결제 수수료율 (2026-10-21 사용자 요청 "PG 및 결제 수수료, 네이버페이 수수료는 알아서 체크해서 반영").
--   서버 cafe24-analytics paymix가 기간 주문(결제일 기준)의 실결제액을 결제 수단별로 나누고, 여기 수수료율(%, 부가세 포함 — 세금계산서로 매입세액 공제)을 곱해 수수료를 계산한다.
--   기본값은 일반 가맹점 추정치(카페24 PG 신용카드 3.3%·실시간 계좌이체 1.8%·휴대폰 4%, 네이버페이 카드·포인트 3.74%·계좌이체 1.76%) — 계약서·정산서로 확인해 고칠 것.
create table if not exists public.profit_fee_rates (
  method      text primary key,
  label       text not null,
  rate_pct    numeric not null default 0,
  note        text,
  sort_order  integer not null default 0,
  updated_at  timestamptz not null default now()
);
alter table public.profit_fee_rates enable row level security;
insert into public.profit_fee_rates (method, label, rate_pct, note, sort_order) values
  ('card',          '자사몰 · 신용카드(PG)',        3.30, '추정 — 카페24 PG 일반 가맹점, 계약서 확인', 1),
  ('tcash',         '자사몰 · 실시간 계좌이체',      1.80, '추정', 2),
  ('cash',          '자사몰 · 무통장입금',           0.00, '수수료 없음(가상계좌 건당 비용은 제외)', 3),
  ('cell',          '자사몰 · 휴대폰 결제',          4.00, '추정', 4),
  ('other',         '자사몰 · 그 밖(예치금 등)',     0.00, '', 5),
  ('naver_card',    '네이버페이 · 신용카드',         3.74, '추정 — 네이버페이센터 정산 수수료로 확인', 6),
  ('naver_tcash',   '네이버페이 · 계좌이체',         1.76, '추정', 7),
  ('naver_prepaid', '네이버페이 · 포인트·머니',      3.74, '추정', 8),
  ('naver_other',   '네이버페이 · 그 밖',            3.74, '추정', 9)
on conflict (method) do nothing;
-- 2026-10-21 실측 뒤 추가(이미 적용됨): 자사몰 'prepaid'(간편결제 선불금 — 9월 8.4%) 줄, 'icash'(가상계좌)는 cash 묶음, 네이버페이 휴대폰은 naver_other(3.85%)
insert into public.profit_fee_rates (method, label, rate_pct, note, sort_order) values ('prepaid', '자사몰 · 간편결제 선불금(카카오페이·네이버페이머니 등)', 3.30, '추정 — PG 간편결제 수수료, 계약서 확인', 4) on conflict (method) do nothing;
update public.profit_fee_rates set label = '자사몰 · 무통장입금·가상계좌' where method = 'cash';
update public.profit_fee_rates set label = '네이버페이 · 휴대폰·그 밖', rate_pct = 3.85 where method = 'naver_other' and rate_pct = 3.74;
