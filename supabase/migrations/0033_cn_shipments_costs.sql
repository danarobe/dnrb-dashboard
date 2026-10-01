-- 중국 사입 관리 — 입고 건별 비용 (2026-10-01 사용자 요청: 입고 엑셀 2번째 시트의 물류비·관부가세·물건 결제를 차수별 소메뉴로).
--   costs = { sheet, title, items:[{name, amount, note, calc}], totals:[{name, amount}], payments:[{name, usd, krw}], pay_total:{usd, krw} }
--   읽기는 관리자·MD만(cafe24-analytics cn_list가 CS·물류팀 응답에서 뺀다).
alter table cn_shipments add column if not exists costs jsonb;
