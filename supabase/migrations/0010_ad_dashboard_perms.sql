-- 친구 광고 대시보드 사용자별 세부 권한 (2026-09-11 사용자 요청): perms = {"menus":[...], "actions":[...]}
--   menus: home compare ptest list test admgr upload perf data shoot (친구 앱 메뉴 키)
--   actions: toggle(활성/비활성) budget(예산 조정) upload(광고 업로드·생성) creative(소재 등록·수정) delete(삭제)
--   관리자(admin)는 서버가 전부 허용으로 응답. 새로 허용한 직원 기본값 = 보기 메뉴 5개, 동작 없음.
alter table ad_dashboard_users add column if not exists perms jsonb not null default '{"menus":["home","compare","ptest","list","test"],"actions":[]}'::jsonb;
