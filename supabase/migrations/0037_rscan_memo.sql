-- 반품 스캔 '불량·오배송 처리' 메모 (2026-10-06 사용자 요청) — 주문 줄마다 팀 전체가 같이 보는 메모.
--   key = 목록의 주문 줄 키 `${kind}:${order_id}` (rscan_done·rscan_special과 같은 키). 메모를 지우면 행을 삭제한다.
--   처리 체크(rscan_done)와 따로 두는 이유: rscan_done.done 기본값이 true라 메모만 적어도 처리완료로 바뀌면 안 되기 때문.
create table if not exists rscan_memo (
  key        text primary key,
  order_id   text,
  memo       text not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table rscan_memo enable row level security;   -- anon 정책 없음 → db 프록시(service_role)만 접근
