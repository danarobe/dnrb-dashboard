-- 주문서 수량에 마이너스 허용 (2026-10-19 사용자 지정) — 주문서 시트에 '-1'처럼 적힌 줄 = 앞선 주문에서 그만큼 취소. 주문 합계에서 뺀다.
alter table public.cn_order_lines drop constraint if exists cn_order_lines_qty_check;
alter table public.cn_order_lines add constraint cn_order_lines_qty_check check (qty between -1000000 and 1000000);
