-- 퇴사·삭제한 직원의 권한 부여 해제 (2026-10-13 사용자 요청: "이미 삭제하거나 퇴사한 직원은 권한 부여를 삭제하고, 권한 부여 목록에서 안 보이게").
--   0039의 트리거 함수가 app_users.login_blocked 를 맞춘 직후, 그 계정이 막힌 상태(관리자 제외)면 권한 부여 표 4개에서 그 계정의 줄을 지운다:
--     cxl_users(취소·반품 접수) · agent_users(AI 에이전트) · ad_dashboard_users(광고 대시보드) · purchase_managers(구매요청 상태 변경 담당자)
--   근무 관리의 [퇴사 처리]·[삭제](둘 다 active=false)·SQL 어느 길로 바꿔도 같다. [복구]해도 권한은 되살아나지 않는다(다시 부여).
--   관리자 계정은 건드리지 않는다(로그인도 막지 않는 계정 — 0039와 같은 이유).
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
    end if;
  end loop;
  return null;
end $$;
