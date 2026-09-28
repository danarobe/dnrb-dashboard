-- 반품 스캔 '수거 완료' 처리 기록 (2026-09-28 사용자 요청): 워크스페이스에서 카페24 반품·교환 접수를 수거 완료로 바꾼 실행 이력.
--   카페24 데이터를 바꾸는 동작이라 누가·언제·무엇을·결과를 전부 남긴다. 쓰기는 cafe24-analytics rscan_collect(service_role)만.
create table if not exists rscan_actions (
  id          bigint generated always as identity primary key,
  action      text not null,              -- 'collect'
  kind        text not null,              -- return | exchange
  order_id    text not null,
  claim_code  text not null,
  items       jsonb,                      -- 처리한 품주코드 목록
  ok          boolean not null default false,
  result      text,                       -- 처리 후 상태 또는 오류 문구
  by_id       text,
  by_name     text,
  created_at  timestamptz not null default now()
);
create index if not exists rscan_actions_order_idx on rscan_actions (order_id, claim_code);
alter table rscan_actions enable row level security;   -- anon 정책 없음
