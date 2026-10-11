-- 퇴사 처리한 직원의 워크스페이스 로그인 차단 (2026-10-11 사용자 요청): 근무 관리에서 [퇴사 처리](wm_employees.active=false)한 직원은
--   직원 관리에서 계정을 지우지 않아도 로그인할 수 없다. [복구](active=true)하면 다시 로그인된다.
--   app_users.login_blocked = "이 계정에 연결된 근무 관리 직원이 전부 퇴사 상태" — 아래 트리거가 늘 맞춰 둔다(화면·함수 어느 길로 바꿔도 같음).
--   실제 차단 판단은 서버가 한다(_shared/util.ts verifyAuthToken · auth 함수): login_blocked 이고 역할이 관리자가 아닐 때만 막는다
--   (관리자 계정은 잠기지 않게 — 계정 삭제를 관리자에게 막아 둔 것과 같은 이유).
alter table app_users add column if not exists login_blocked boolean not null default false;

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
  end loop;
  return null;
end $$;

drop trigger if exists wm_employees_login_blocked on wm_employees;
create trigger wm_employees_login_blocked
  after insert or delete or update of active, app_user_id on wm_employees
  for each row execute function wm_sync_login_blocked();

-- 이미 퇴사 처리돼 있던 직원의 계정에도 적용 (2026-10-11 실행 — 임시 계정으로 시험을 끝낸 뒤)
update app_users u set login_blocked = (
  exists (select 1 from wm_employees e where e.app_user_id = u.id and e.active = false)
  and not exists (select 1 from wm_employees e where e.app_user_id = u.id and e.active = true))
where true;
