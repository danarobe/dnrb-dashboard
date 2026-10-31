-- 미송 확인 — '기준' 칸의 '입고 기준'(2026-10-31 사용자 요청: "34+9박스 입고 후"처럼 직접 쓰는 글)
--   파일(행)마다 — 새 미송 엑셀을 올리면 비어서 시작. arrival_note_by/at = 마지막으로 쓴 사람·시각
alter table public.cn_misong add column if not exists arrival_note text;
alter table public.cn_misong add column if not exists arrival_note_by text;
alter table public.cn_misong add column if not exists arrival_note_at timestamptz;
