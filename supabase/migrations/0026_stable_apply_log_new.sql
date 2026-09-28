-- 셀메이트 반영 기록에 '신규 편성' 구분 (2026-09-28 사용자 요청): 셀메이트 안정재고 CSV에 없던 판매 품목(신규 안정재고 편성 필요)을
--   반영한 옵션은 is_new = true. 반영 내역 화면에서 늘림·줄임 옆 '신규'로 따로 본다. 기존 기록은 false.
alter table stable_apply_log add column if not exists is_new boolean not null default false;
