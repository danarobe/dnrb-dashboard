-- 대시보드 사용자 (관리자/직원)
-- 주의: anon 정책 없음 — 비밀번호 해시 보호를 위해 service_role(Edge Function 'auth')로만 접근
create table if not exists app_users (
  id text primary key,                 -- 로그인 아이디
  name text not null,                  -- 이름
  password_hash text not null,         -- bcrypt 해시
  role text not null default 'staff' check (role in ('admin', 'staff')),
  created_at timestamptz default now()
);
alter table app_users enable row level security;
