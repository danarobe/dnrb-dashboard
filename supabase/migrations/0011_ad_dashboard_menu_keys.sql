-- 친구 앱 실제 메뉴 키 반영 (2026-09-11 친구 확인): list·test → atest(테스트 소재)·abest(베스트소재). 기존 행의 perms도 치환.
alter table ad_dashboard_users alter column perms set default '{"menus":["home","compare","ptest","atest","abest"],"actions":[]}'::jsonb;
update ad_dashboard_users
set perms = jsonb_set(perms, '{menus}', (
  select coalesce(jsonb_agg(distinct case when v = 'list' then 'atest' when v = 'test' then 'abest' else v end), '[]'::jsonb)
  from jsonb_array_elements_text(coalesce(perms->'menus', '[]'::jsonb)) as t(v)
))
where perms->'menus' ?| array['list','test'];
