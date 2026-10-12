-- 중국 사입 관리 — 혼용률 라벨 제작 대상 표시 (2026-10-12 사용자 요청: "혼용률 항목에 '라벨' 체크 — 아우터는 혼용률이 라벨에 들어가야 해서, 라벨을 제작해야 하는 상품을 따로 파악").
--   label = true 면 이 상품은 혼용률 라벨을 만들어야 한다. 쓰기는 cafe24-analytics cn_label(관리자·MD)만.
alter table cn_products add column if not exists label boolean not null default false;
alter table cn_products add column if not exists label_by_name text;
alter table cn_products add column if not exists label_at timestamptz;
