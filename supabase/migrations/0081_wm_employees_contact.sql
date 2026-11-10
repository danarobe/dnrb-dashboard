-- 인사 명부(2026-11-10 사용자 요청 "계좌번호·주민번호·핸드폰번호(연락처)도 보이게") — 근무자에 연락처·주민번호 칸.
--   정직원은 연락처·주민번호를 둘 곳이 없었다(알바 채용으로 들어온 알바만 wm_hires에 있음).
--   rrn_enc = 주민번호 암호문(AES-256-GCM, 키 HIRE_ENC_KEY — wm_hires.rrn_enc와 같은 방식). 평문은 어디에도 저장하지 않는다.
--   wm_employees는 RLS 켬·정책 없음(서버 전용) 그대로. 화면에는 wm-admin(관리자 전용)이 가린 값만 주고, 전체 보기는 감사 로그를 남긴다.
alter table public.wm_employees add column if not exists phone text;
alter table public.wm_employees add column if not exists rrn_enc text;
