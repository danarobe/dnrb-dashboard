-- 중국 사입 관리 — 사입상품명별 거래처명 (2026-10-01 사용자 요청: "거래처명은 각각 수동으로 입력").
--   입고 건(엑셀) 단위가 아니라 상품마다 따로 적는다. 한 번 적으면 그 사입상품명이 나오는 모든 입고 건에 같이 보인다.
--   쓰기는 cafe24-analytics cn_vendor(관리자·MD)만, 입력자는 서버가 기입.
create table if not exists cn_products (
  sname           text primary key,
  vendor          text,
  updated_by      text,
  updated_by_name text,
  updated_at      timestamptz not null default now()
);
alter table cn_products enable row level security;   -- anon 정책 없음 → service_role만
