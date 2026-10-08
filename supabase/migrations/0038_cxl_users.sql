-- 취소·반품 접수(#cxl) 접근 허용 목록 (2026-10-08 사용자 요청): 관리자가 아닌 직원에게도 취소·반품 접수 메뉴를 열어 준다.
--   관리자는 목록과 무관하게 항상 허용. 허용은 관리자가 직원 관리 화면에서만 한다.
--   허용된 직원도 자사몰 취소접수의 '최종 환불까지 한 번에 진행'(환불완료·PG 결제취소)은 할 수 없다 — 서버(selfcancel_run)가 관리자만 받는다.
create table if not exists cxl_users (
  user_id    text primary key,          -- app_users.id (FK는 두지 않는다 — db 프록시 임베딩 통로 방지)
  added_by   text,
  created_at timestamptz not null default now()
);
alter table cxl_users enable row level security;   -- anon 정책 없음
