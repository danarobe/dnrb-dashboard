-- 품절 재고 점검: 바꾼 상태 구분 (2026-09-29 사용자 요청 — 판매중/소진시품절 둘 다 버튼, 소진시품절로 바꾼 목록 따로 보기)
--   target = 'selling'(미품절·판매중, option_stock 0) | 'exhaust'(소진시품절, option_stock 3). 기존 기록은 모두 판매중 변경이라 'selling'.
alter table soldout_fix_log add column if not exists target text not null default 'selling';
