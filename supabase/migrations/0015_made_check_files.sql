-- 자체제작 재고·입고 점검 (2026-09-21 사용자 요청): 셀메이트 재고 CSV(stk_stockList)·이지픽 제작상품 엑셀(제작상품관리)을 한 번 올리면
-- 팀 전체가 같은 파일을 보도록 파싱 결과를 저장(셀메이트 API가 유료라 CSV 업로드 방식 유지). 지정 상품 = made/자체제작 외에 함께 볼 상품.
create table if not exists made_check_files (
  kind        text primary key check (kind in ('cell','ez')),   -- cell = 셀메이트 재고 CSV / ez = 이지픽 제작상품 엑셀
  file_name   text not null,
  uploaded_by text,
  uploaded_at timestamptz not null default now(),
  row_count   integer not null default 0,
  rows        jsonb not null default '[]'::jsonb
);
alter table made_check_files enable row level security;
create table if not exists made_watch_products (
  name_key   text primary key,      -- stkNorm(상품명)
  name       text not null,
  added_by   text,
  created_at timestamptz not null default now()
);
alter table made_watch_products enable row level security;
