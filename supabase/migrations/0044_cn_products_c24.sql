-- 중국 사입 관리 — 카페24 상품 직접 연결 (2026-10-12 사용자 요청: "6800·68001처럼 정확히 매칭이 힘든 상품은 주의 표시로 나타내고 직접 설정할 수 있게").
--   c24_nos = null 이면 자동(공급사 상품명으로 맞춤), 배열이면 직접 고른 카페24 상품 번호들([] = '해당 없음'으로 확정 — 주의 표시를 끔).
--   쓰기는 cafe24-analytics cn_c24set(관리자·MD)만.
alter table cn_products add column if not exists c24_nos jsonb;
alter table cn_products add column if not exists c24_by_name text;
alter table cn_products add column if not exists c24_at timestamptz;
