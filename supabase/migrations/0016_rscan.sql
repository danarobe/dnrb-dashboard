-- 반품 송장 스캔 (2026-09-22 사용자 요청): 반품 송장번호(바코드)로 카페24 주문건을 찾고, 불량·오배송 사유면 경고
--   rscan_index: 서버(cafe24-analytics rscan_build)가 최근 N일 반품·교환 주문을 모아 둔 인덱스(자사몰은 return_invoice_no 있음, 네이버페이는 없음)
--   rscan_naver: 네이버페이센터 반품/교환 목록 엑셀을 올려 만든 '수거 송장번호 → 상품주문번호' 표 (네이버페이 주문은 API로 송장을 못 받음)
--   rscan_settings: 경고로 볼 사유 코드/키워드 (관리자 조정)
create table if not exists rscan_index (
  kind       text primary key,            -- 'cafe24'
  built_at   timestamptz not null default now(),
  days       integer not null default 90,
  row_count  integer not null default 0,
  payload    jsonb not null default '[]'::jsonb
);
alter table rscan_index enable row level security;
create table if not exists rscan_naver (
  invoice          text primary key,      -- 수거(반품) 송장번호, 숫자만
  product_order_no text,                  -- 네이버 상품주문번호 (카페24 items.naver_pay_order_id 와 대응)
  order_no         text,                  -- 네이버 주문번호
  kind             text,                  -- 반품 | 교환
  reason           text,
  company          text,
  claim_date       text,
  product_name     text,
  option_text      text,
  uploaded_by      text,
  uploaded_at      timestamptz not null default now()
);
alter table rscan_naver enable row level security;
create table if not exists rscan_settings (
  id         integer primary key default 1,
  settings   jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table rscan_settings enable row level security;
