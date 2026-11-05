-- (2026-11-05) 도장 허용 목록 seal_users를 만들었다가 같은 날 지움 — 사용자 결정: "허용할 사람을 만드는 순간 보안 허점, 나만".
--   도장은 서버 wm-hire의 SEAL_OWNER(대표 본인 계정) 하나만 쓴다. 이 파일은 지운 기록용.
drop table if exists public.seal_users;
