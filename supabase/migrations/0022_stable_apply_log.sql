-- 안정재고 편성 → 셀메이트 반영 기록 (2026-09-28 사용자 요청). 셀메이트는 API가 없어 관리자 브라우저의 Tampermonkey 연결 스크립트가
--   재고조정 화면(stock_edit_ok.asp)으로 안정재고만 바꾼다. 바꾸기 전 값·요청 값·바꾼 뒤 읽은 값을 남겨 되돌리기에 쓴다.
create table if not exists stable_apply_log (
  id           bigint generated always as identity primary key,
  batch_id     text not null,                 -- 한 번의 반영 묶음
  kind         text not null default 'apply', -- apply | rollback
  ref_batch    text,                          -- rollback 이면 되돌린 원래 묶음
  p_no         integer not null,              -- 셀메이트 상품번호
  opt_idx      integer not null,              -- 셀메이트 옵션 번호
  product_name text,
  option_name  text,
  before_val   integer,                       -- 반영 직전 셀메이트 안정재고
  after_val    integer,                       -- 요청한 값
  result_val   integer,                       -- 반영 후 다시 읽은 값
  ok           boolean not null default false,
  error        text,
  by_id        text,
  by_name      text,
  created_at   timestamptz not null default now()
);
create index if not exists stable_apply_log_batch_idx on stable_apply_log (batch_id);
alter table stable_apply_log enable row level security;   -- anon 정책 없음 → db 프록시(admin)만
