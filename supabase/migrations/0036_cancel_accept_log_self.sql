-- 취소·반품 접수 2단계 (2026-10-05 사용자 요청) — 자사몰 취소접수의 환불 처리 기록을 같은 표에 남긴다.
--   kind: 'npay' = 네이버페이 취소신청 접수(기존 줄) / 'self' = 자사몰 취소접수 → 환불.
--   expected_amount·refund_amount: 워크스페이스가 계산한 환불 예정액과 카페24가 계산한 환불액(원). 둘이 같을 때만 환불을 끝낸다.
alter table cancel_accept_log add column if not exists kind text not null default 'npay';
alter table cancel_accept_log add column if not exists expected_amount numeric;
alter table cancel_accept_log add column if not exists refund_amount numeric;
alter table cancel_accept_log add column if not exists points numeric;      -- 돌려준 적립금
alter table cancel_accept_log add column if not exists detail jsonb;        -- 결제 수단·PG 취소 상태 등
