-- GIF 메이커 › 프로젝트를 '내 프로젝트'와 '공유 프로젝트'로 나눔 (2026-11-26 사용자 요청
--   — "권한을 받아 여러 명이 보는 곳은 '공유 프로젝트', 내가 직접 만든 곳은 '내 프로젝트', [공유하기]를 누르면 공유 프로젝트로 옮겨지게").
--   shared = false : 내 프로젝트 — 만든 사람만 보고 고치고 지운다(프로젝트 권한과 상관없음, 관리자도 남의 것은 안 보임).
--   shared = true  : 공유 프로젝트 — 예전 규칙 그대로(gif_perms 읽기/쓰기, 관리자는 항상 쓰기).
--   새로 만드는 프로젝트는 내 프로젝트(false). 칸을 처음 만들 때 이미 있던 프로젝트는 지금까지처럼 모두가 보던 곳이라 공유 프로젝트(true)로 둔다.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gif_projects' and column_name = 'shared') then
    alter table gif_projects add column shared boolean not null default false;
    alter table gif_projects add column shared_at timestamptz;
    alter table gif_projects add column shared_by_name text not null default '';
    update gif_projects set shared = true, shared_at = now(), shared_by_name = '처음부터 공유';
  end if;
end $$;
create index if not exists gif_projects_owner_idx on gif_projects (created_by) where shared = false;
