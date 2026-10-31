-- 중국 사입/제작 관리 — 상품별 '특이사항'(2026-10-31 사용자 요청: 옵션 제거·라벨 특이사항 등 상품마다 참고할 글)
--   입고 검수(상품 줄 이름 아래)에서 적고, 주문하기 엑셀의 I열(라벨 문구) 옆 J열 '특이사항'으로 나간다.
alter table public.cn_products add column if not exists remark text;
alter table public.cn_products add column if not exists remark_by_name text;
alter table public.cn_products add column if not exists remark_at timestamptz;
