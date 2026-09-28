-- AI 에이전트 앱 접근 허용 목록 (2026-09-28 사용자 요청): 관리자가 아닌 직원에게도 에이전트 앱(보고서·실행·질문)과 리포트 알림을 열어 준다.
--   관리자는 목록과 무관하게 항상 허용. 보고서에는 매출 금액이 들어 있으므로 허용은 관리자가 직원 관리 화면에서만 한다.
create table if not exists agent_users (
  user_id    text primary key,          -- app_users.id (FK는 두지 않는다 — db 프록시 임베딩 통로 방지)
  notify     boolean not null default true,   -- 리포트 도착 알림(앱 종 + 웹 푸시)을 받을지
  added_by   text,
  created_at timestamptz not null default now()
);
alter table agent_users enable row level security;   -- anon 정책 없음
