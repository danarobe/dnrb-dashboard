-- 미발송 관리 — 상품별 입고일·특수 관리 (2026-09-28 사용자 요청).
--   key = 카페24 product_no(문자열). 입고일을 바꿀 때마다 arrival_history에 {date, prev, at, by} 추가 → 늦춰지면 화면에 '추가 지연'.
--   쓰기·읽기는 cafe24-analytics(unship_mark / unship_list)만 — 입력자는 서버가 로그인 계정으로 기입.
create table if not exists unship_products (
  key              text primary key,
  product_no       bigint,
  product_name     text,
  supplier         text,
  supplier_product text,
  arrival_date     date,
  arrival_history  jsonb not null default '[]'::jsonb,
  special          boolean not null default false,
  special_note     text,
  special_by       text,
  special_at       timestamptz,
  updated_at       timestamptz not null default now()
);
alter table unship_products enable row level security;   -- anon 정책 없음 → service_role만 접근
