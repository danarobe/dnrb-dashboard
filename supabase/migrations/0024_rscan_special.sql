-- 반품 스캔 '불량·오배송 처리' 특별관리 (2026-09-28 사용자 요청): 오래 수거되지 않는 주문을 따로 표시해
--   목록 기간(최근 90일)이 지나도 계속 보이게 한다. key = `${kind}:${order_id}` (처리 목록의 주문 묶음 키와 같음).
--   쓰기·읽기는 cafe24-analytics(rscan_special / rscan_issues)만 — 표시한 사람은 서버가 로그인 계정으로 기입.
create table if not exists rscan_special (
  key            text primary key,
  kind           text not null check (kind in ('return', 'exchange')),
  order_id       text not null,
  note           text,
  marked_by      text,
  marked_by_name text,
  marked_at      timestamptz not null default now()
);
alter table rscan_special enable row level security;   -- anon 정책 없음 → service_role만 접근
