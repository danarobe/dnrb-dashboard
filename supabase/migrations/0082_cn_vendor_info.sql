-- 중국 사입/제작 관리 › 주문하기 — 매장 옆에 '매장 위치'·'매장 위챗'(2026-11-10 사용자 요청)
--   매장(vendor) = 档口 번호(예: W-1F-10-30), 위치 = 건물(W동·N동·13동 …), 위챗 = 매장 위챗 아이디.
alter table public.cn_products add column if not exists vendor_loc text;
alter table public.cn_products add column if not exists vendor_wechat text;
