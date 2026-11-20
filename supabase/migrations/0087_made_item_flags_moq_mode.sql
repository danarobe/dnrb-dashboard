-- 최소 주문 수량 '각각/통합' (2026-11-21 사용자 요청)
-- each = 옵션마다 그 수량 이상 / total = '통합'으로 표시한 옵션들을 합쳐서 그 수량 이상
alter table made_item_flags add column if not exists moq_mode text not null default 'each';
alter table made_item_flags drop constraint if exists made_item_flags_moq_mode_chk;
alter table made_item_flags add constraint made_item_flags_moq_mode_chk check (moq_mode in ('each', 'total'));
