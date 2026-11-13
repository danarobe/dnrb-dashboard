-- 휴대폰 알림 켜기 진단 기록 (2026-11-13) — 아이폰에서 '켜기'가 어디서 막히는지(단계·오류 이름·권한 상태·기기 정보)를 남긴다.
-- 직원은 본인 명의로 추가만, 읽기·수정·삭제는 관리자만(db 프록시 규칙). RLS 켬·정책 없음.
create table if not exists push_diag (
  id bigserial primary key,
  user_id text not null,
  ok boolean not null default false,
  step text,
  err_name text,
  err_msg text,
  perm_before text,
  perm_after text,
  method text,
  standalone boolean,
  ua text,
  created_at timestamptz not null default now()
);
alter table push_diag enable row level security;
revoke all on push_diag from anon, authenticated;
