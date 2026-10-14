-- 중국 사입 관리 — 미출고 잔여 직접 처리 (2026-10-14 사용자 요청: "1차에서 잔여였다가 2차에서 들어온 것은 다 들어온 걸로 — 헷갈리니 관리하는 방법을").
--   잔여(qty_left)는 입고 엑셀의 '미출고' 값이라 그 입고 시점의 숫자다. 같은 옵션이 **다음 입고에 다시 나오면 화면이 자동으로 '들어옴'으로 본다**(DB 값은 안 바꿈).
--   다음 입고 엑셀에 안 나오는 잔여는 사람이 처리한다: left_closed = 'in'(들어옴으로 처리) | 'cancel'(받지 않기로 함) | null(아직 안 들어옴).
--   쓰기는 cafe24-analytics cn_left(관리자·MD·물류팀)만.
alter table cn_lines add column if not exists left_closed text check (left_closed in ('in', 'cancel'));
alter table cn_lines add column if not exists left_note text;
alter table cn_lines add column if not exists left_by_name text;
alter table cn_lines add column if not exists left_at timestamptz;
