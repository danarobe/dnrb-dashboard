-- 중국 사입 — '아우터라벨' 체크(2026-10-26 사용자 요청). 주문하기 엑셀 맨 오른쪽 열에 '… + 아우터 라벨'로 들어간다.
alter table public.cn_products add column if not exists outer_label boolean not null default false;
alter table public.cn_products add column if not exists outer_label_by_name text;
alter table public.cn_products add column if not exists outer_label_at timestamptz;
