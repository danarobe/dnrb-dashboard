-- 중국 사입/제작 관리 — 상품 '미진행' 표시 (2026-10-20 사용자 요청: "진행하지 않는 상품이어서 미진행 체크하면 안 보이도록")
--   체크한 상품은 입고 검수·상품별 현황의 기본 보기와 합계(주문·잔여 등)에서 빠지고, 상품별 현황의 '미진행' 칩에서만 보인다.
alter table public.cn_products add column if not exists inactive boolean not null default false;
alter table public.cn_products add column if not exists inactive_by_name text;
alter table public.cn_products add column if not exists inactive_at timestamptz;
