-- 로그인 세대 번호 (2026-11-27 사용자 요청 — 비밀번호를 바꿔도 이미 로그인된 기기가 최대 3일 남던 문제).
--   토큰의 gen이 이 값과 같아야 유효(_shared/util.ts authGenOk). 비밀번호를 바꾸면 auth 함수가 1 올린다.
--   ⚠ 함수 배포보다 먼저 적용할 것 — verifyAuthToken이 이 칸을 읽는데 칸이 없으면 조회가 실패해 전원 로그아웃된다.
alter table public.app_users add column if not exists session_gen integer not null default 0;
