-- 보안 점검 (2026-09-22): 초기 마이그레이션(0001·0002·0004)에 남아 있던 anon 전체 허용 정책을 파일 차원에서도 제거.
--   운영 DB에서는 이미 삭제돼 있어(db 프록시가 유일 경로) 이 파일은 멱등(drop if exists) — 새 프로젝트에 재적용해도 공개 쓰기 정책이 되살아나지 않게 한다.
drop policy if exists "anon all cr_archive"   on cr_archive;
drop policy if exists "anon all perf_archive" on perf_archive;
drop policy if exists "anon all adv_archive"  on adv_archive;
drop policy if exists "anon all ad_meeting_topics" on ad_meeting_topics;
drop policy if exists "anon all ad_meeting_notes" on ad_meeting_notes;
