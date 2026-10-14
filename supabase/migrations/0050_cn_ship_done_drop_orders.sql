-- 중국 사입 관리 — 차수별 검수 완료 + 주문서 기능 제거 (2026-10-14 사용자 요청).
--   ① "주문서는 주문한 수량이고 실제 입고는 주문서와 조금씩 다르게 들어온다 → 주문서는 고려할 필요가 없어졌다.
--      차수별로 올리는 입고 엑셀의 수량이 실제 입고 수량이고, 그 수량에 실물 수량을 맞추기만 하면 된다" → 0049의 주문서 표·연결 칸을 지운다
--      (그 안의 자료는 같은 날 Claude가 첨부 파일로 등록한 주문서 1건뿐이었다 — 원본 엑셀은 사용자 PC에 있음).
--   ② "실물 파악이 끝난 차수는 체크 버튼으로 완료 — 1·2차를 끝냈는데 3차가 들어와 1·2·3차가 합쳐 보이면 꼬인다"
--      → cn_shipments.checked_done: 완료한 차수는 실제 수량·메모를 더 못 고치고(서버 cn_check가 거절), 입고 검수의 기본 보기('검수할 입고')에서 빠진다.
--      완료는 관리자·MD·물류팀, 완료 취소는 관리자·MD(서버 cn_ship). 완료는 모든 옵션의 실제 수량을 적었을 때만.
alter table cn_shipments add column if not exists checked_done boolean not null default false;
alter table cn_shipments add column if not exists checked_done_by_name text;
alter table cn_shipments add column if not exists checked_done_at timestamptz;
alter table cn_shipments drop column if exists order_id;
drop table if exists cn_order_lines;
drop table if exists cn_orders;
