-- 품절 재고 점검 → 셀메이트 '판매중(미품절)' 변경 기록 (2026-09-29 사용자 요청). 관리자 브라우저의 연결 스크립트(v1.2.0)가
--   옵션 수정 화면(option_modify_ok.asp)으로 품절분류(option_stock)만 0(미품절)으로 바꾼다. 옵션마다 결과를 남긴다.
create table if not exists soldout_fix_log (
  id           bigint generated always as identity primary key,
  batch_id     text not null,
  p_no         integer not null,              -- 셀메이트 상품번호
  opt_idx      integer not null,              -- 셀메이트 옵션 번호
  code         integer,                       -- 상품코드(= 카페24 상품번호)
  product_name text,
  option_name  text,
  stock_before integer,
  stock_after  integer,
  ok           boolean not null default false,
  skipped      boolean not null default false,
  error        text,
  by_id        text,
  by_name      text,
  created_at   timestamptz not null default now()
);
create index if not exists soldout_fix_log_created_idx on soldout_fix_log (created_at desc);
alter table soldout_fix_log enable row level security;   -- anon 정책 없음 → db 프록시(admin)만
