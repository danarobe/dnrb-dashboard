-- 고액 반품 관리 — 네이버페이 주문의 반품도 모은다 (2026-10-20 사용자 요청: "주문 건에서 빠지는 게 있으면 안 돼, 모두 집계").
--   카페24 환불 내역(refunds)에는 네이버페이(NCHECKOUT) 주문의 반품이 없어 주문 API(반품 요청일 기준, R… 상태 상품)로 따로 읽는다 — 서버 cafe24-analytics bigret_list.
--   네이버페이 반품은 환불 금액이 카페24에 없어 반품 상품 금액(할인 뺀 판매가×수량)으로 추정한다(estimated).
alter table public.bigret_refunds add column if not exists source text not null default 'cafe24';   -- cafe24 = 카페24 환불 내역 · naver = 네이버페이 주문 반품(주문 API)
alter table public.bigret_refunds add column if not exists estimated boolean not null default false; -- 환불 금액이 추정값(네이버페이)
alter table public.bigret_refunds add column if not exists naver_point integer;                      -- 주문 때 쓴 네이버 포인트(참고)
alter table public.bigret_sync add column if not exists naver_until date;                            -- 네이버페이 반품은 여기까지 읽음
