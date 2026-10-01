-- 미발송 관리 — 상품별 직원 메모 (2026-10-01 사용자 요청: "직원들이 메모를 남길 수 있는 칸, 각 상품별로").
--   memos = [{id, text, by, by_id, at}] 최근 50건. 쓰기는 cafe24-analytics unship_mark(memo_add / memo_del)만 — 작성자는 서버가 로그인 계정으로 기입,
--   삭제는 작성자 본인 또는 관리자.
alter table unship_products add column if not exists memos jsonb not null default '[]'::jsonb;
