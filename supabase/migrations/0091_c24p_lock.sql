-- 상품 등록 전용 앱(cafe24-product) — 같은 상품을 동시에 두 번 등록하지 못하게 잠금 칸(보안 검토 2026-11-25).
--   잠금 = UPDATE … WHERE (lock_until IS NULL OR lock_until < now()) 한 문장으로 잡는다(원자적).
alter table public.c24p_registry add column if not exists lock_until timestamptz;
-- 잠금 주인 표시(보안 검토 2026-11-25): 잠근 요청만 풀 수 있게
alter table public.c24p_registry add column if not exists lock_by text;
