-- 친구 광고 대시보드(ad-dashboard) 접근 허용 목록 (2026-09-11 사용자 요청): 관리자가 직원 관리에서 지정한 워크스페이스 계정만
--   메뉴 노출 + auth sso_issue(aud) 코드 발급 + auth verify 통과. 관리자(admin)는 항상 허용. 읽기 = 로그인 전원(메뉴 분기용), 쓰기 = admin(db 프록시 규칙).
create table if not exists ad_dashboard_users (
  user_id    text primary key references app_users(id) on delete cascade,
  added_by   text,
  created_at timestamptz not null default now()
);
alter table ad_dashboard_users enable row level security;
