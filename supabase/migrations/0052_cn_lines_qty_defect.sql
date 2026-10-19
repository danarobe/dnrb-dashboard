-- 중국 사입/제작 관리 — 입고 검수 '불량' 수량 (2026-10-19 사용자 요청 "전달, 실제 수량, 차이 옆에 불량")
-- 실제로 받은 수량(qty_actual) 중 불량인 개수. 비어 있으면 아직 안 적음.
alter table public.cn_lines add column if not exists qty_defect integer check (qty_defect is null or qty_defect >= 0);
