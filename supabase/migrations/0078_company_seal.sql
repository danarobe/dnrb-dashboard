-- 회사 도장(직인) 이미지 — 프리랜서 업무위탁계약서 '대표자 (인)' 자리에 찍는다(2026-11-05 사용자 요청).
--   공개 저장소(GitHub Pages)에 두면 누구나 받아 갈 수 있어서 여기(비공개)에 둔다.
--   RLS만 켜고 정책 없음 = 서버(service role)만 읽음. 화면은 wm-hire 'seal' 동작으로만 받는다(알바 채용 권한 있는 사람만, 감사 로그).
--   db 프록시(TABLE_ROLES)에도 넣지 않는다.
create table if not exists public.company_seals (
  key text primary key,                 -- 'ceo' = 대표자 직인
  png_b64 text not null,                -- 배경 투명 PNG (base64)
  updated_at timestamptz not null default now()
);
alter table public.company_seals enable row level security;
revoke all on public.company_seals from anon, authenticated;
