-- 중국 사입 / 제작 주문 점검 — 상품별 '남은 수량 소진 후 품절' 체크·최소 주문 수량(기입 날짜 포함) (2026-11-20 사용자 요청)
-- 키 = 셀메이트 상품명 정규화(stkNorm) — 재고·입고 점검의 제작 상품·중국 상품 묶음과 같은 키. 셀메이트 미등록 중국 상품은 'cn:'+품번.
-- 읽기·쓰기 admin+MD(db 프록시 규칙). RLS 켬·정책 없음.
create table if not exists made_item_flags (
  item_key text primary key,
  item_name text,
  eol boolean not null default false,
  eol_at timestamptz,
  eol_by text,
  moq integer,
  moq_at timestamptz,
  moq_by text,
  updated_at timestamptz not null default now()
);
alter table made_item_flags enable row level security;
revoke all on made_item_flags from anon, authenticated;
alter table made_item_flags add constraint made_item_flags_chk check (
  length(item_key) <= 300 and coalesce(length(item_name),0) <= 300 and coalesce(length(eol_by),0) <= 60 and coalesce(length(moq_by),0) <= 60
  and (moq is null or (moq >= 1 and moq <= 1000000)));
