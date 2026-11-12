-- 중국 사입/제작 관리: 라벨을 체크(일반·아우터·사이즈) 대신 글로 적는다(2026-11-12 사용자 요청).
-- 주문하기 엑셀 J열 '라벨'로 그대로 나간다. 옛 체크 칸(label·outer_label·size_label)은 남겨 두지만 화면에서 안 쓴다.
alter table public.cn_products add column if not exists label_text text;
alter table public.cn_products add column if not exists label_text_by_name text;
alter table public.cn_products add column if not exists label_text_at timestamptz;
