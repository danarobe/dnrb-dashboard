-- 직원 구매요청 주문자 분리 (2026-09-10 사용자 요청): 알바 주문도 올릴 수 있도록
--   requester_id/requester_name = 담당자(로그인 계정, 서버 강제·수정 불가) / orderer_name = 주문자(기본 본인 이름, 직접 수정 가능)
alter table purchase_requests add column if not exists orderer_name text;
