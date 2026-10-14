-- 알바 채용·면접비 접근 허용 목록 (2026-10-14 사용자 요청: "알바 채용·면접비 메뉴도 권한을 부여할 수 있게").
--   관리자와 물류팀(원래 역할 logistics)은 지금처럼 항상 쓸 수 있고, 그 밖의 직원은 이 목록에 있을 때만(직원 관리 화면의 이름 칩).
--   서버 wm-hire hireRoleOk가 이 표로 강제한다. 화면은 db 프록시로 읽는다(관리자 전체 읽기·쓰기, 그 외는 본인 행 읽기만 — cxl_users와 같은 규칙).
--   허용된 직원은 물류팀과 같은 범위(주민번호·계좌 전체 보기·월별 엑셀 포함, 지급 기록 있는 사람 삭제는 관리자만).
create table if not exists hire_users (
  user_id    text primary key,
  added_by   text,
  created_at timestamptz not null default now()
);
alter table hire_users enable row level security;

-- 퇴사·삭제 시 권한 부여 해제(0046)에 이 표를 더한다
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
    end if;
  end loop;
  return null;
end $$;
