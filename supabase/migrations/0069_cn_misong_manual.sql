-- 미송 확인 — '품목 구분 없음' 옵션의 물류공장 입고일을 사람이 직접 입력(2026-10-26 사용자 요청)
--   manual = {"묶음번호:줄번호": {"date": "YYYY-MM-DD", "by": 이름, "at": 시각}} — 파일(행)마다, 새 파일을 올리면 새로 시작
alter table public.cn_misong add column if not exists manual jsonb;
