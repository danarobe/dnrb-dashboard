-- 중국 사입/제작 관리 — 사이즈 라벨 체크(2026-10-27 사용자 요청: 라벨을 '일반·아우터·사이즈' 세 가지로 체크)
--   일반 = 기존 label(혼용률 라벨), 아우터 = outer_label(0070), 사이즈 = 이 칸.
alter table public.cn_products add column if not exists size_label boolean not null default false;
alter table public.cn_products add column if not exists size_label_by_name text;
alter table public.cn_products add column if not exists size_label_at timestamptz;
