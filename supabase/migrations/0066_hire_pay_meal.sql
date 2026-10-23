-- 알바 채용·면접비 — 일일알바 점심시간 공제 + 식대 (2026-10-23 사용자 요청)
--   "점심시간을 끼고 근무 시(12시~13시가 껴 있을 때) 시급 지급에서 1시간 제외하고 8,000원 들어가는 걸로"
--   → 일일알바(kind daily)·시간제(정액 아님)·시작 < 12:00 이고 종료 ≥ 13:00 이면 근무 분에서 60분을 빼고 식대 8,000원.
--     세전 지급액 = 시급 × 인정 시간 + 식대, 3.3%는 식대 포함 금액에(근무 관리 급여 내보내기와 같은 방식). 서버 wm-hire가 계산해 저장.
alter table public.wm_hire_pays add column if not exists meal_amount integer not null default 0 check (meal_amount >= 0);
