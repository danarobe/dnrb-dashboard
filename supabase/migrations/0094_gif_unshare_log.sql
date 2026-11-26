-- GIF 메이커 › [내 프로젝트로 되돌리기] 기록 (2026-11-26 보안 점검 — 누가·언제 공유를 멈췄는지 남긴다)
alter table gif_projects add column if not exists unshared_at timestamptz;
alter table gif_projects add column if not exists unshared_by text;
alter table gif_projects add column if not exists unshared_by_name text not null default '';
