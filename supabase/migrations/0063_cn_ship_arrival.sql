-- 중국 사입/제작 관리 — 입고 예정일·박스 수량·입고 완료 (2026-10-22 사용자 요청: "발주 차수 대신 입고 예정일·박스 수량, 입고 완료 버튼 → 그 뒤 검수 완료, 입고 대기 건만 따로 보기")
--   상태 = 입고 대기(arrived=false) → 입고 완료(arrived=true, 실물 검수 중) → 검수 완료(checked_done=true). 검수 완료는 입고 완료 뒤에만(서버 cn_ship이 막음).
--   order_round(발주 차수)는 남겨 둔다 — 새로 올리는 입고에는 안 받지만 옛 입고의 이름 표시에 쓰인다.
alter table public.cn_shipments add column if not exists arrival_date date;          -- 입고(한국 도착) 예정일
alter table public.cn_shipments add column if not exists box_count integer check (box_count is null or (box_count >= 0 and box_count <= 100000));
alter table public.cn_shipments add column if not exists arrived boolean not null default false;
alter table public.cn_shipments add column if not exists arrived_by_name text;
alter table public.cn_shipments add column if not exists arrived_at timestamptz;
-- 이미 검수 완료한 입고는 당연히 입고된 것
update public.cn_shipments set arrived = true, arrived_by_name = coalesce(arrived_by_name, checked_done_by_name), arrived_at = coalesce(arrived_at, checked_done_at) where checked_done and not arrived;
