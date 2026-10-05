-- 취소·반품 접수 (#cxl, 2026-10-05 사용자 요청) — 네이버페이 취소신청을 워크스페이스에서 접수한 기록.
--   접수 버튼을 누를 때마다 한 줄(성공·실패 모두). 서버(cafe24-analytics cancelreq_accept)만 쓰고 읽는다.
create table if not exists cancel_accept_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  order_id text not null,
  items jsonb not null default '[]'::jsonb,      -- [{code, product_name, option, qty}]
  reason_type text,                               -- 네이버페이 취소 구분 코드(51~60)
  reason_label text,                              -- 취소 구분 이름(배송 지연 등)
  reason text,                                    -- 카페24에 보낸 취소 사유
  flags jsonb,                                    -- '직접 확인 권장'으로 분류됐던 이유(확인 후 접수한 경우)
  ok boolean not null,
  result text,                                    -- 접수 뒤 상태 또는 실패 사유
  claim_code text,
  by_id text,
  by_name text
);
create index if not exists cancel_accept_log_created_idx on cancel_accept_log (created_at desc);
create index if not exists cancel_accept_log_order_idx on cancel_accept_log (order_id);
alter table cancel_accept_log enable row level security;   -- anon 정책 없음
