-- 알바 채용·면접비 — 성별 (2026-10-22 사용자 요청: "일일알바에서 성별을 체크, 기본 여자, 남자로 바꿀 수 있게"). F=여 / M=남.
alter table public.wm_hires add column if not exists gender text not null default 'F' check (gender in ('F', 'M'));
