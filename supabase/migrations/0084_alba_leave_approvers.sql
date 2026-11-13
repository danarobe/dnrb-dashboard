-- 알바 휴가 승인 담당 목록 (2026-11-13 사용자 요청: "알바 휴가는 물류팀 직원도 승인·반려, 신청이 오면 그 직원에게도 알림").
--   담당자는 알바(wm_employees.type='parttime')의 승인 대기 휴가만 승인·반려(서버 wm-me alba_leave_review).
--   관리자가 인사 명부 › 권한·보안의 이름 칩으로 지정. 화면은 db 프록시로 관리자만 읽고 쓴다(직원 화면은 wm-me가 판단).
--   누구를 넣었는지는 이 파일(공개)에 적지 않는다 — 데이터는 DB에만.
create table if not exists alba_leave_approvers (
  user_id    text primary key,
  added_by   text,
  created_at timestamptz not null default now()
);
alter table alba_leave_approvers enable row level security;

-- 퇴사·삭제 시 권한 부여 해제(0046·0047)에 이 표를 더한다
create or replace function wm_sync_login_blocked() returns trigger language plpgsql security definer set search_path = public as $$
declare
  ids text[] := '{}';
  uid text;
begin
  if tg_op <> 'INSERT' and old.app_user_id is not null then ids := ids || old.app_user_id; end if;
  if tg_op <> 'DELETE' and new.app_user_id is not null then ids := ids || new.app_user_id; end if;
  foreach uid in array ids loop
    update app_users u set login_blocked = (
      exists (select 1 from wm_employees e where e.app_user_id = u.id and e.active = false)
      and not exists (select 1 from wm_employees e where e.app_user_id = u.id and e.active = true))
    where u.id = uid;
    if exists (select 1 from app_users u where u.id = uid and u.login_blocked and u.role <> 'admin') then
      delete from cxl_users where user_id = uid;
      delete from agent_users where user_id = uid;
      delete from ad_dashboard_users where user_id = uid;
      delete from purchase_managers where user_id = uid;
      delete from hire_users where user_id = uid;
      delete from alba_leave_approvers where user_id = uid;
    end if;
  end loop;
  return null;
end $$;
