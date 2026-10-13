-- 근무 관리 — 직원 '삭제' = 직원 관리 목록에서만 숨김 (2026-10-13 사용자 요청: "퇴사 처리 말고 삭제 버튼도", 범위는 사용자가 '목록에서만 숨김'으로 선택).
--   hidden = true 인 직원은 근무 관리 › 직원 관리 목록(재직·퇴사·전체)에서 빠진다. 출퇴근·휴가·명세서·급여 기록은 그대로(과거 급여 불변).
--   삭제하면 서버(wm-admin employee_hide)가 active = false 도 같이 넣는다(키오스크·이후 급여에서 빠지고, 연결된 계정은 로그인 차단 트리거가 동작).
--   되살리기 = hidden 만 false (퇴사 상태로 목록에 다시 보임).
alter table wm_employees add column if not exists hidden boolean not null default false;
alter table wm_employees add column if not exists hidden_by_name text;
alter table wm_employees add column if not exists hidden_at timestamptz;
