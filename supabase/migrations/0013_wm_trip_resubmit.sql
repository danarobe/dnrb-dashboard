-- 출장 여비 신청서 수정·재제출 (2026-09-21 사용자 요청): 보완 요청(returned)·확인 대기(submitted) 상태에서 직원이 고쳐 다시 제출
alter table wm_trip_claims add column if not exists resubmit_count integer not null default 0;
alter table wm_trip_claims add column if not exists resubmitted_at timestamptz;
alter table wm_trip_claims add column if not exists prev_review_note text;   -- 직전 보완 요청 사유(재제출 뒤에도 관리자가 무엇을 요청했었는지 보이게)
