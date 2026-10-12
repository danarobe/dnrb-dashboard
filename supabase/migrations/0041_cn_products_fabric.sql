-- 중국 사입 관리 — 상품(사입상품명)별 혼용률 (2026-10-12 사용자 요청: "각 상품별로 혼용률을 기입할 수 있는 란 + 엑셀에 적어 둔 혼용률을 끌어오기").
--   한 번 적으면 그 사입상품명이 나오는 모든 입고 건에 같이 보인다. 쓰기는 cafe24-analytics cn_fabric(직접 입력)·cn_upload(엑셀의 혼용률 열)만, 관리자·MD.
alter table cn_products add column if not exists fabric text;
alter table cn_products add column if not exists fabric_by_name text;
alter table cn_products add column if not exists fabric_at timestamptz;
