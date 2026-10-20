-- 고액 반품 관리 (2026-10-20 사용자 요청 — 물류·CS). 환불 금액(결제 수단 환불 + 적립금 + 예치금) 30만 원 이상인 '반품' 환불만 모아 둔다.
--   서버 cafe24-analytics bigret_list가 카페24 환불 내역을 조금씩(처음엔 최근 1년을 나눠서) 읽어 채운다. 고객 이름·휴대전화가 들어 있어 RLS로 막고 서버(서비스 키)만 쓴다.
create table if not exists bigret_refunds (
  refund_code    text primary key,
  order_id       text not null,
  member_id      text,
  buyer_name     text,
  buyer_phone    text,
  customer_key   text not null,          -- 회원 ID(m:…), 비회원은 이름+휴대전화(p:…)
  pay_amount     integer,                -- 실결제금액(처음 결제액 — 결제 수단으로 낸 돈)
  points_spent   integer,                -- 주문 때 쓴 적립금(참고)
  refund_amount  integer not null,       -- 환불 금액 = 결제 수단 환불 + 적립금 + 예치금
  refund_cash    integer,
  refund_points  integer,
  refund_credits integer,
  scope          text check (scope in ('full', 'partial')),
  status         text,                   -- 카페24 환불 상태(T 환불완료 · F 환불전 …)
  accepted_at    timestamptz,
  refunded_at    timestamptz,
  items          jsonb,
  updated_at     timestamptz not null default now()
);
create index if not exists bigret_refunds_customer on bigret_refunds(customer_key);
create table if not exists bigret_sync (
  id            integer primary key default 1 check (id = 1),
  backfill_from date,                    -- 처음 모으기 시작한 날(최근 1년)
  synced_until  date,                    -- 여기까지 읽음
  updated_at    timestamptz
);
alter table bigret_refunds enable row level security;
alter table bigret_sync enable row level security;
