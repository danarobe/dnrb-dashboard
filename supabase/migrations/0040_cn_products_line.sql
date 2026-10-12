-- 중국 사입 관리 — 상품(사입상품명)별 라인 구분 (2026-10-12 사용자 요청: "각 상품별로 made 라인으로 갈지, 일반 상품으로 갈지 나누고, 분류해서도 볼 수 있게").
--   line = 'made'(made 라인) | 'normal'(일반 상품) | null(아직 안 나눔). 한 번 정하면 그 사입상품명이 나오는 모든 입고 건에 같이 적용된다.
--   쓰기는 cafe24-analytics cn_line(관리자·MD)만. 누가·언제 정했는지는 line_by_name·line_at.
alter table cn_products add column if not exists line text check (line in ('made', 'normal'));
alter table cn_products add column if not exists line_by_name text;
alter table cn_products add column if not exists line_at timestamptz;
