# DNRB 대시보드 — 프로젝트 지침 (CLAUDE.md)

> 이 파일은 Claude Code가 새 세션/새 계정에서 이 프로젝트를 이어받을 때 읽는 핵심 문서다.
> 다나로브(danarobe) 쇼핑몰 운영자용 **성과 분석 대시보드**. 비개발자인 사용자에게는 쉬운 한국어로 설명한다.

---

## 0. 한눈에 보기

- **무엇**: 카페24/네이버/Meta 데이터를 모아 취소·반품, 상품 분석, 판매 성과, 진열 순서, 재고, 광고, 순이익을 보는 단일 페이지 대시보드 + 근무·급여, 구매요청, 회의·프로젝트까지 담는 통합 업무 시스템.
- **서비스 이름 = "DNRB 워크스페이스"(2026-09-01 사용자 결정 — 옛 "온라인 쇼핑몰 성과 분석 대시보드 by DNRB"에서 개칭)**: title·헤더 h1·로그인 화면·manifest에 반영. **로고 = DR 모노그램**(검정 정사각+흰 DR, `icons/` — 512/192/파비콘 64. 원본은 ~/Downloads의 다나로브 테이프.pdf 벡터에서 고해상 추출·재생성 가능, 사용자 첨부 로고와 동일 디자인). 헤더·로그인·파비콘·apple-touch-icon·manifest icons에 적용.
- **소스**: `~/dnrb-dashboard` — `index.html` 단일 정적 페이지 + `supabase/functions/` Edge Functions 7종.
- **배포**: GitHub Pages `https://danarobe.github.io/dnrb-dashboard/` — 공개 레포 `danarobe/dnrb-dashboard`. **git push하면 자동 배포**(반영 30~60초).
- **Supabase**: 프로젝트 ref `eeffmbusaqaadeojjlnc` (서울, 회의보드용 `Meeting_Prapare`에 합사). anon key·URL은 `config.js`에 있고 공개 레포에 노출됨(의도된 것 — 서버가 토큰 검증).
- **기술 스택**: 프레임워크 없음. 순수 HTML/CSS/JS + Chart.js·xlsx-populate(CDN). 백엔드는 Supabase Edge Functions(Deno/TypeScript).

## 1. 작업 관례 (반드시 지킬 것)

0. **이 문서는 공개 레포에 올라간다 — 개인정보(연봉·생일·입사일·계좌·계정 id)와 경영 절대액(급여 총액·매출·광고비 금액)을 절대 적지 않는다.** 검증 기록이 필요하면 "일치함"처럼 결과만 적고 실값은 DB에만 둔다. (2026-09-01 과거 기재분 비식별화 + git 이력 정리 완료 — 재발 금지)

1. **수정 → 로컬 프리뷰(`.claude/launch.json`의 dnrb-dashboard, 포트 8734)로 검증 → git commit/push → Pages 반영 확인.**
2. **Edge Function 수정 시 배포**: `supabase functions deploy <이름> --project-ref eeffmbusaqaadeojjlnc`
3. **`_shared/util.ts`를 고치면 그것을 쓰는 모든 함수를 재배포**해야 한다(배포 시 util이 각 함수에 번들 복사됨). 과거 이걸 놓쳐 cafe24-oauth만 옛 CORS로 남아 "카페24 확인 실패"가 뜬 사고 있음.
4. **브라우저 테스트에 로그인이 필요하면**: admin 비밀번호를 사용자에게 묻지 말고, 아래 [QA 계정 패턴]대로 임시 계정을 SQL로 만들어 쓰고 **끝나면 반드시 삭제**한다.
5. **카페24 토큰 동시 갱신 경쟁 주의**: 카페24는 새 액세스 토큰 발급 시 기존 토큰을 무효화한다. 함수들에 401 시 강제 재발급+재시도가 내장돼 있고, 홈은 revenue 조회를 선행시켜 직렬화한다. **api_tokens의 access_token을 직접 refresh하지 말 것** — 반드시 getAccessToken 경유.
6. **작업 완료 시 이 파일(CLAUDE.md)을 갱신**한다. (계정 이전 후에는 Claude 메모리 대신 이 파일이 유일한 지식 저장소다.)

### QA 계정 패턴 (관리자 비밀번호를 모르므로)
Supabase 관리 API로 임시 계정을 만들고 지운다. **python urllib은 Cloudflare UA 차단(403) → 반드시 curl**.
```bash
# 토큰: macOS 키체인
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
# 생성 (역할: admin / staff(=MD) / cs)
curl -s -X POST "https://api.supabase.com/v1/projects/eeffmbusaqaadeojjlnc/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"insert into app_users (id,name,role,password_hash) values ('"'"'qa_admin_tmp'"'"','"'"'QA'"'"','"'"'admin'"'"',crypt('"'"'QaTmp-39295!'"'"',gen_salt('"'"'bf'"'"',10))) on conflict (id) do update set password_hash=excluded.password_hash, role='"'"'admin'"'"' returning id;"}'
# 로그인해서 토큰 얻기: POST functions/v1/auth {action:login, id, password}
# 테스트 후: delete from app_users where id='qa_admin_tmp';
```
- 브라우저 검증은 로컬 프리뷰(localhost:8734)에서 하고, 끝나면 `localStorage.removeItem('dnrb_session')`.
- 캐시로 옛 JS가 뜨면 `location.replace('/?v='+Date.now())`로 캐시 버스팅.

---

## 2. Edge Functions (supabase/functions/)

| 함수 | 역할 | 인증 |
|---|---|---|
| `auth` | 로그인·계정 관리(app_users, bcrypt). HMAC 토큰 7일(AUTH_SECRET) | — |
| `cafe24-oauth` | 카페24 OAuth(start/callback/status). **verify_jwt=false** (카페24 리다이렉트) | — |
| `cafe24-claims` | 취소·반품 집계(카페24 주문 C40/R40 등) | 관리자 |
| `cafe24-analytics` | 조회수·주문율·판매성과·진열지표·순반품률·결제품목 | 로그인 필수, 일부 관리자 |
| `naver-claims` | 네이버 커머스API(미사용 — 이 몰은 조회 대상 없음) | 관리자 |
| `db` | 아카이브·회의록·기타 테이블 프록시(anon 정책 제거 후 유일 경로) | 로그인+역할 화이트리스트 |
| `meta-ads` | Meta 광고관리자(Graph v23.0) summary/topads/**dateads/activeads**/adstats/preview는 관리자+MD, **hierarchy/testads/budgethistory/hourlystats(광고관리자 전용 액션)는 관리자만**(2026-08-26) |
| `meta-budget` | **예산 쓰기**(2026-08-26): status/pending/apply/schedule/cancel/**run**(자정 cron). 쓰기 토큰(META_WRITE_TOKEN)은 이 함수만 사용 — 읽기 함수와 분리 | admin+WRITE_USER_IDS+PIN |
| `wm-me` | **마이페이지**(2026-08-27): me/leave_request/leave_cancel. 로그인 계정 → `wm_employees.app_user_id`로 본인 행만 조회·쓰기, 급여·계좌 미포함 | 로그인 전원 |

- 공용 유틸 `_shared/util.ts`: CORS_HEADERS(**x-auth-token 포함**), verifyAuthToken(서명·만료 검증 + **DB 실계정·현재 role 재확인**), getToken/saveToken(api_tokens, service_role), json/handleOptions.
- **Supabase 게이트웨이는 엣지 함수의 text/html 응답을 text/plain으로 강제 변환** → OAuth 완료는 DASHBOARD_URL(secret) 리다이렉트로 처리.
- **cafe24-oauth의 selfUrl은 SUPABASE_URL 기반**(엣지 런타임 req.url은 프록시 내부 주소라 /functions/v1·https 빠짐).

### cafe24-analytics 액션
- `summary`(조회수+주문율), `categories`, `category_products`, `revenue`(결제 매출), `performance`(판매수량+취소반품+공급가/판매가), `netreturns`(순반품률), `displaymetrics`+`productinfo`(진열용), `paiditems`(결제일 기준 품목별 결제수량 + 전체 상품목록 — 안정재고+광고관리자 실결제 수 열 공용, **admin 전용** — 2026-08-26 admgr용으로 admin+staff로 열었다가 같은 날 메뉴가 관리자 전용이 되며 원복).

### `wm-admin` — 근무 관리 (2026-08-26 신설, 관리자 전용)
근무관리 시스템(출퇴근·급여·연차)을 OneDrive JSON에서 Supabase로 이전하며 만든 함수. `verifyAuthToken` + `role === 'admin'`.
액션: `salary_all`/`salary_one`/`labor_total`(급여), `employee_list`/`attendance_list`/`edits_pending`(조회). 쓰기 액션은 3단계에서 추가 예정.
- **`salary.ts`는 work-manager `server/routes/salary.js`의 축자 이식이다.** 실제 급여 지급에 쓰이므로 1원도 달라지면 안 됨. 반올림 방식 "개선", `weeks`/`weekHoursInMonth` 이중 구조 정리, 시간대 처리 추가 전부 금지 — 파일 상단 주석 필독.
- **급여 계산은 시간대 무관**(모든 Date가 문자열 파싱 후 로컬 게터로 재포맷하거나 같은 형식끼리 뺄셈, 한국은 서머타임 없음). UTC로 도는 Edge Function에서 동일 결과. 검증됨.
- 월별 조회 시 `${ym}-31` 같은 고정 31일 금지 — 6월(30일)에서 존재하지 않는 날짜로 400. `nextMonthFirst()` 사용.

### 필요한 secrets (supabase secrets)
- 카페24: `CAFE24_MALL_ID`(wnqka5000), `CAFE24_CLIENT_ID`, `CAFE24_CLIENT_SECRET`, `SUPABASE_URL`, `DASHBOARD_URL`
- 인증: `AUTH_SECRET`
- Meta: `META_ACCESS_TOKEN`(무기한 ads_read 시스템 사용자 토큰), `META_AD_ACCOUNT_ID`(343611764656087). **secrets 변경 후 함수 재배포 필요**.
- 네이버(미사용): `NAVER_CLIENT_ID/SECRET`, `NAVER_PROXY_URL`

---

## 3. DB 테이블 (Supabase, RLS 켜짐·anon 정책 없음 → db 프록시 경유)

- `app_users` (bcrypt password_hash, role: admin/staff/cs — **staff는 UI에서 'MD'로 표시**)
- `api_tokens` (provider cafe24/naver, access/refresh)
- `cr_archive` / `perf_archive` / `adv_archive` (기간별 분석 기록)
- `ad_meeting_topics` (회의 안건, team=`product`/`ad`, status todo/doing/done) — 별도 회의보드 프로젝트의 `topics`와 다름
- `ad_meeting_notes` (회의 기록, 날짜 컬럼 `meeting_date`, shared bool)
- `ad_note_comments` / `ad_note_likes` (공유 회의기록 댓글·좋아요, note_id FK cascade)
- `disp_season_out` (진열 시즌 제외 상품, admin 전용)
- `profit_archive` (순익 시나리오 기간별 기록, admin)
- `ad_test_state` (테스트 소재 숨김·판정 verdict('meh'/'good')·추가소재 요청/제작완료 시각(asset_req_at/asset_done_at)·메모, ad_id PK, admin+staff — recommend 컬럼은 2026-08-28 폐기·잔존)
- `budget_writes` (예산 변경 실행·자정 예약 기록, meta-budget 함수 전용 — RLS on·정책 없음, service_role 직접 접근)

### 근무관리 테이블 `wm_*` (2026-08-26 신설)
`wm_employees` / `wm_attendance` / `wm_leaves` / `wm_holidays` / `wm_attendance_edits` / `wm_devices`(키오스크 기기) / `wm_kiosk_log`(감사 로그) + 뷰 `wm_employees_pub`(pin_hash·계좌 제외).
스키마: `supabase/migrations/0005_wm_tables.sql`. **db 프록시에는 미등록** — 전부 `wm-admin` 함수 경유(급여·계좌가 들어 있어 접근 경로를 하나로 좁힘).
- **id는 정수 보존 + setval로 원본 nextId에 맞춤**(17/622/113/378/19). 이관 전후 행 단위 대조가 검증 전략의 핵심이라 UUID로 바꾸지 말 것.
- **`clock_in`/`clock_out`은 `text`**(`'YYYY-MM-DD HH:MM:SS'` KST naive). `salary.js`가 `substring(11,16)`으로 잘라 `'09:00'`과 문자열 비교하므로 `timestamptz`로 바꾸면 조용히 깨진다.
- `wm_holidays`는 `unique(date)` 불가 — 날짜 중복 4건 실재(2028-10-03 개천절+추석 등). `unique(date,name)` 사용.
- 직원 삭제는 **소프트 삭제**(`active=false`). 기존 Express의 `DELETE /api/employees/:id`는 출퇴근·휴가 기록까지 지워 급여 기록을 파괴했다 — 승계 금지.
- 알려진 데이터 이슈(그대로 이관됨): `clock_out`은 있는데 `work_minutes`가 NULL인 8건(2026-07-20, 전부 `is_edited`). 원인은 `attendance_edits.js:68-70`이 출근시각만 수정하면 근무분을 NULL로 만드는 것. **대조 검증 통과 전에는 고치지 말 것**(진짜 차이와 구분이 안 됨).

### db 프록시 화이트리스트 (supabase/functions/db/index.ts의 TABLE_ROLES)
cr=admin, perf/adv/meeting_topics/meeting_notes/note_comments/note_likes=admin+staff, disp_season_out/profit_archive/ad_test_state=admin.
AUTHOR_FIELDS(notes/comments=author_id, likes=user_id): POST는 본인 id 필수, PATCH/DELETE는 해당 필터 필수 → 본인 것만 수정·삭제(서버 강제).

---

## 4. 인증·권한 (역할 3종)

- **관리자(admin)**: 전 메뉴. Meta·순익 등 금액 데이터 전체.
- **MD(내부코드 staff)**: 대시보드·상품분석·판매성과·**광고효율**·광고회의록 5개 메뉴. 광고 효율의 광고비·구매전환값·총매출 3타일은 블러(`.role-staff .meta-blur`), ROAS·소재는 봄. 판매 성과에서 금액/판매합계 숨김.
- **CS팀(cs)**: 판매 성과 메뉴만. 전사 합계·마진 블러(`.role-cs .cs-blur`).
- **역할 표시 명칭**: 코드 role은 admin/staff/marketer/cs/**logistics**, UI 라벨 관리자/MD/마케터/CS팀/**물류팀**(클라 ROLE_LABEL 맵). 직원 관리 셀렉트도 동일.
- **물류팀(logistics, 2026-08-27)**: **권한은 CS와 완전 동일(판매 성과만), 표시명만 다름.** 구현 = 마케터와 같은 패턴 — util verifyAuthToken이 logistics→cs 정규화(⚠ util 수정이라 wm-kiosk 제외 전 함수 10개 재배포함) + 클라 isCS()가 logistics 포함 + auth set_role 허용 목록 + app_users_role_check 제약에 추가.
- **이번 달 생일 패널(2026-08-27)**: 직원 관리 상단에 이번 달 생일자를 칩으로 표시(이름·월/일·구분 + **오늘**(분홍)/**D-n**/지남). 생일 출처가 둘이라 합친다 — ①`wm_employees.birthday`(근무 관리 직원, 알바 포함) ②**`app_users.birthday` 신설**(대표 3인은 근무 관리에 없어 계정에 보관, `'MM-DD'` 형식 — 연도 미확보). 연결된 정직원은 근무 관리 값 우선(app_user_id로 중복 제거), `bdayMMDD()`가 두 형식(`YYYY-MM-DD`/`MM-DD`) 모두에서 뒤 5자만 취함. auth `list_users`에 birthday 추가. **입력 경로**: 직원·알바는 근무 관리 직원 수정, **대표는 현재 SQL로만**(2026-08-27 대표 3인 입력 완료 — 실값은 DB에만, 공개 문서에 기재 금지). 일부 직원 생일은 근로계약서에서 보충 입력됨. 검증: 오늘/지남/D-n/없는 달 4경우 정상.
- **직원 근무 정보 모달(2026-08-27)**: 직원 관리에서 **비관리자 이름 클릭** → 근무 관리 연동(wm-admin employee_list, app_user_id 매칭) 데이터 모달: 입사일+근무기간("N개월 N일"), 연봉, 생일, 급여 계좌(은행·번호·예금주), 연차(총량+사용/잔여). 미연결 계정은 연결 안내. **wm_employees.hire_date 신설**(legacy_created_at 텍스트에서 날짜 추출해 초기값 — 6/17 몰림 = 옛 시스템 도입일). 수정은 근무 관리 직원 탭에서만.
  - **입사일 실측 교정(2026-08-27)**: 근로계약서 6건(docx 4·pdf 2, `~/01_다나로브/07_채용/01_근로계약서_디앤알비/`) 대조 → 3명의 입사일을 실제 계약서 날짜로 정정, 나머지 3명은 이미 정확했음(실제 날짜는 DB에만 — 공개 문서에 기재 금지).
  - **`annual_salary` 필드 신설(2026-08-27, 계약서 표시 전용 — 급여 계산과 분리)**: 계약서 연봉이 12로 안 나누어떨어지면(예: 연봉이 12로 안 나누어떨어지는 경우) 월급×12로는 정확한 연봉을 못 만든다. **급여 계산에 쓰는 `monthly_salary`는 절대 안 건드리고**(근무관리 3대 원칙 "급여 1원도 달라지면 안 됨" 보호), 계약서 연봉 원본을 별도 컬럼에 담아 상세 모달이 `annual_salary ?? monthly_salary×12`로 표시. 6명 전원 계약서 그대로 입력 완료(실제 금액은 DB에만 — 공개 문서에 기재 금지. 일부는 12로 나누어떨어져 원래도 정확했지만 일관성 위해 함께 채움). 직원 수정 폼에 '연봉(계약서 표시용)' 입력칸 추가(알바 추가 모드는 숨김). 검증: 6명 상세 모달 전부 계약서 금액 정확히 표시, 월급 필드 무변경 확인.
  - ⚠ **직원 1명의 연차 총량이 계약서와 불일치 발견, 미수정**(범위 밖 — 입사 첫해 비례지급 의도라면 정상, 확인 필요 시 사용자에게 재확인. 누구인지는 사용자가 알고 있음).
- **마케터(marketer, 2026-08-24)**: **권한은 MD(staff)와 완전 동일, 표시명만 다름.** 구현 = `_shared/util.ts` verifyAuthToken이 marketer→staff로 **정규화**(모든 함수의 권한 검사가 자동으로 MD와 동일해짐 — 개별 검사 수정 불필요, 단 util 수정이라 전 함수 재배포함) + 클라 isStaff()가 marketer 포함 + auth set_role 허용 목록 + **app_users_role_check 제약에 marketer 추가**(DB constraint가 있었음 — 새 역할 추가 시 잊지 말 것). auth의 관리자 전용 게이트는 DB role 직접 비교라 marketer 통과 불가(안전).
- **showMenu**: 권한 없는 메뉴는 홈으로 폴백(옛날엔 return→빈 화면 버그). 관리자 전용 메뉴 버튼(cr·disp·stock·stable·profit·wm·users)은 아예 숨김.
- **근무 관리(`#wm`, 2026-08-26)**: 관리자 전용. 급여·계좌가 노출되므로 `wm-admin` 함수가 `role !== 'admin'`이면 403. 실측 검증: MD 403 / 비로그인 401 / 위조 토큰 401 / 삭제된 계정 토큰 401.
- **키오스크 인증은 네 번째 경로** (5단계에서 신설 예정): 직원은 app_users 계정이 없다. `wm-kiosk` 함수는 `verifyAuthToken`을 쓰지 않고 **기기 토큰(`x-kiosk-token`) + PIN 세션**으로 검증한다. PIN 세션은 `signAuthToken`을 `{id:'kiosk:'+empId, role:'kiosk'}`로 재사용 — 이 토큰을 `x-auth-token`으로 들이밀어도 `verifyAuthToken`의 app_users 조회에서 걸리므로 두 토큰 네임스페이스는 안전하게 분리된다.
- **보안 모델**: 서버 verifyAuthToken이 DB 실계정+role을 매 요청 재확인 → 계정 삭제·권한 변경 즉시 반영. 외부(anon key만)로는 테이블 조회 빈배열·삽입 RLS 거부·함수 401/403. **남은 UI 차단 수준**: 상품분석 summary의 주문금액은 직원에게 서버 미차단(홈 급증 TOP10 금액 표시가 기존 동작), 비공개 회의기록 읽기는 클라이언트 필터.

---

## 5. 메뉴별 핵심 로직

### 홈 대시보드 (#home)
- 기준 기간 + "카페24 불러오기" → **전 메뉴 기간 동기화 + 데이터 자동 기입**: 취소반품·상품분석·판매성과 + Meta광고·순익시나리오. Meta는 fetchMetaAds 자동 실행, 순익은 fillProfitFromStores로 기수집 데이터 재사용(추가 API는 Meta뿐). (재고 대조 동기화는 메뉴 제거와 함께 삭제 2026-08-20)
- 각 메뉴 기간 옆 **'이 메뉴만 별도 기간' 체크박스**(own-period-{key}, localStorage `dnrb_own_period`) → 체크 시 홈이 그 메뉴 기간·데이터를 안 건드림, 타일에 '별도 기간 사용 중' 표시.
- KPI 4타일 + 판매량 급증 TOP10 + 조회수/주문율 TOP10 + 취소반품 사유 TOP3 + 수집상태 칩 3종.

### 취소 & 반품 (#cr, 관리자)
- 카페24 API(주문일 기준 C40/R40 등) + 네이버페이 암호 xlsx 직접 업로드. **취소반품 금액 합계 = 카페24 + 네이버 CSV** (순익 시나리오가 이 합계를 그대로 씀).
- 금액/사유 매핑(관리자 CSV 실측 대조): 실제 환불금액은 `embed=cancellation,return`의 refund_amounts[].amount. claim_reason_type: A/O=고객변심 B=배송지연 E/P=상품불만족 G=서비스불만족 H=품절 I=기타 J/L=배송오류 K/V=상품불량. 반품 진행중 포함(R00/R10/R30/R34/R40), 취소는 C40만. 카페24 C40/R40에는 네이버페이 주문 포함되므로 취소반품관리 CSV엔 없음 → 이중집계 방지 위해 구분.

### 상품 분석 (#an) / 판매 성과 (#perf)
- **판매 성과 기간 칩에 '오늘'·'어제' 추가(2026-09-01 사용자 요청)**: `qPeriod`에 today/yest kind 신설(**KST 기준** — 기존 toISOString은 UTC라 아침엔 하루 밀림, 다른 kind는 기존 동작 유지). **'오늘' 하루 조회 시 '등락' 열**(순위 옆, m-hide): 어제 하루 performance를 백그라운드로 받아(`store.prevRanks`, 기간 바뀌면 응답 버림) **결제수량 순위 등락** 표시 — 어제 10위→오늘 2위면 ↑ 8(빨강), 하락 ↓ n(파랑), 동일 —, 어제 결제 없던 상품 NEW. 셀 tooltip에 '어제 n위 → 오늘 n위'. 열은 prevRanks 있을 때만 생기며 옵션 상세 행 colspan도 +1. 검증(실데이터): 오늘 99상품·어제 118순위, 1위 ↑2·2위 ↓1·동일 — 정확.
- performance: 마진율 = (판매가 − 공급가×1.1)/판매가. **카페24 공급가는 부가세 미포함으로 기입**돼 있음(순익 부가세 계산에 중요). 공급가 미입력 상품은 마진 제외.
- netreturns: **배송완료일(품목 delivered_date) 기준**. 반품 상태 = **R00/R10/R30/R34/R40 (2026-08-09부터 신청·접수 포함** — 반품 관리 메뉴와 기준 통일, 사용자 결정. 그 전에는 R30/R34/R40). 등급 우수<10/주의10~20/위험≥20, 배송완료 10개 미만 보류. 주문 수집은 [s−7d, e+30d] 패딩(부분배송 대비). 옵션별 접이식 상세. **진열(displaymetrics)의 손실률만 아직 R30/R34/R40** — 진열 순서에 영향을 주지 않으려는 사용자 결정.
- **ON 광고 열(2026-08-10, 관리자·MD — CS 숨김)**: 판매 성과 표에 상품별 **현재 활성 Meta 광고 수**. 숫자 클릭 → 광고명·**시작~어제 누적** 지출·구매당 비용·ROAS 팝업(`pa-modal`), 광고명 클릭 → 기존 소재 미리보기.
  - 데이터: `meta-ads?action=activeads` **1회**(Meta 2호출: 활성 광고 목록 + 어제까지 누적 인사이트, ~131개) — 상품별 개별 조회 금지(300호출 재앙). 팝업은 API 0회. limit 500, 넘으면 truncated 플래그. **activeads는 서버 10분 캐시(api_cache)** — 반복 조회 시 Meta 미호출. 실측: 검증 중 반복 호출로 Meta "User request limit reached"(400) 발생 → 캐시로 예방, 실패 시 열에 0 대신 '—' 표시(실패≠광고 없음).
  - **매칭 규칙**(`paKey`/`paVerTok`/`paGroups`/`paPickBest` — 2026-08-26부터 광고관리자 실결제 수와 공용): 핵심명 = **앞·뒤 괄호·대괄호를 전부(반복) 벗긴** 상품명(2026-08-26 수정 — 예전엔 앞 괄호 1개+뒤 괄호만이라 "[Best] (2사이즈) 클레르 블라우스"의 핵심명이 안 나와, 클레르 광고들이 매칭 실패하거나 겨울 '(기모ver.) 클레르'에 오매칭됐음), 공백·'ver.'점 무시 비교, 핵심명 3자 미만 제외. 광고 1개는 **가장 긴 핵심명 1개에만** 배정(부분 겹침 오매칭 방지). **같은 핵심명 상품이 여럿이면**: 광고명에 ver 토큰(여름ver·기모ver 등)이 있으면 그 버전에, **없으면 'ver 없는 기본판'에 배정(그룹에 기본판이 딱 하나일 때만** — 2026-08-26 개선, 예전엔 무조건 미배정이라 기본판 광고가 영영 안 잡혔음), 기본판이 여럿이면 미배정. **⇒ 운영 규칙: ver 상품 광고는 광고명에 ver 표기 필수** (안 쓰면 기본판으로 붙음). 검증(2026-08-26, 활성 114개 전수 신구 비교): 매칭 102→108, 기존 매칭 소실 0, 변경 7건 전부 클레르 오매칭 교정, [Best] 클레르(1383) ON광고 0→5. **실측: 광고명은 상품명 괄호를 그대로 복사하지 않음**("(2사이즈,여름ver.)" → 광고엔 "여름ver"만 또는 생략)이라 괄호 통째 매칭은 전멸함. 'silver'의 ver은 버전 아님((?<![a-z])ver). **비교는 한글을 자모로 풀어서**(paJamo) — 맥에서 광고명이 "ㅍㅡㄹㅔㅅㅣ ㅎㅜㄹ ㅌㅣㅅㅕㅊㅡ"처럼 조합 안 된 자모로 등록되는 실사례가 있어(2026-08-10), "프레시"→"ㅍㅡㄹㅔㅅㅣ"로 풀면 깨진 이름과도 일치한다. 검증: 131개 광고 중 64개가 25개 상품에 배정, 오매칭 0(포켓/쿨프리 분리), 썸머 클레르 13·뉴 내티 3·여름ver 레이스 클레르 1.
- **반품 사유 모아보기(2026-08-07)**: 판매 성과 표에서 **상품명 클릭** → 모달. `returnreasons` 액션 — **netreturns와 항상 같은 상태 집합을 써야 함**(현재 R00~R40, 어긋나면 표의 반품 수량과 모달 건수가 달라짐). `order_status` 필터로 스캔량 축소(4,554→486건, **24초→5초**). **콤마 다중 상태 필터 동작함**.
  - **카페24는 '반품 신청 사유'와 '반품 접수 사유'를 `claim_reason` 한 필드에 붙여서 준다**: `"사이즈작음 (구매자 주문취소 : 구매 의사 취소)"`. 서버 `splitClaimReason()`이 정규식 `\((?:구매자|판매자)\s*주문취소\s*:\s*([^)]*)\)$`로 분리. 사용자 규칙 = **둘 다 있으면 신청 사유만 집계**, 신청이 비면 접수 사유 사용(실측 643건 중 신청+접수 89·신청만 456·접수만 98·미기재 88).
  - 분류는 클라이언트 `RR_CATS` 키워드 규칙 7종(불량·하자 → 사이즈·핏 → 원단·소재 → 색상·실물차이 → 배송·품절 → 단순변심 → 기타, **위에서 먼저 걸리는 것이 이김**). **한글 어미 주의**: '두꺼'는 '두껍고'를 못 잡으므로 실제 사용형('두껍','두께')을 함께 등록. `rrNorm`이 공백·문장부호·ㅠㅜㅋㅎ 제거 + 싸이즈/서이즈/사이스→사이즈 통일. 실측 643건 기준 기타 4.5%.
  - **성능**: 상품명 첫 클릭 때만 1회 조회(~3.5초), 기간 단위로 `rrState`에 캐시 → 2번째부터 **0~2ms**. 판매 성과 초기 로딩은 전혀 안 건드림.
  - **동반 반품 구분(2026-08-10)**: 카페24 사유는 **클레임(반품 신청) 단위 1개**라 여러 상품을 한 번에 반품하면 같은 문장이 전 상품에 복사됨(실측 7/1~8/10: 클레임 22%가 다중 상품·품목 43%·그중 87% 동일 사유 — "남의 사유가 내 상품에" 문제의 원인). 서버가 items에 `claim`(claim_code)을 실어주고 `rrEnsure`가 분류: **sole**(단독 → TOP5 집계) / **shared**(동반 — 노란 접이식 구역, 함께 반품된 상품명 표시, 집계 제외) / **other**(사유에 클레임 내 '다른' 상품 종류 단어가 유일하게 언급 → 그 상품으로 귀속, 이 상품에선 제외). 귀속 우선순위: ① **상품 이름 직접 언급**(핵심명 공백무시 포함, 4자+, 부분문자열 관계면 긴 이름 우선 — "내티 원피스는..."이면 원피스 3개 중에서도 확정) ② 종류 단어(paKey 마지막 단어), **클레임 내 유일할 때만** — 같은 종류가 여럿이면 무작위 배정 없이 shared(사용자 확인 질문에 대한 답). 이름 여러 개 언급 시 언급된 것들 모두 sole. 하위호환: claim 없는 옛 캐시면 전부 sole. 한계: "바지"≠"팬츠" 동의어 미인식, 두 종류 다 언급 시 shared.

### 카테고리별 진열 (#disp, 관리자) — 상품팀 가이드: docs/상품팀-진열로직-가이드.html
- 주간 진열 순서 자동계산. **점수 = 조회당 기대마진 = 0.7×adj7 + 0.3×adj14**(21일 창: 7d + 직전 14d).
- 보정순반품률(사전평활 n20, **사전평균은 조회 시점 전사 평균 자동**: Σret7÷Σdel7) → 실현마진 → K=카테고리평균조회수×0.3 축소추정.
- 실현마진 = 순판매×개당마진 − 판매량×순반품률×반품건당비용(기본 **2,000원**). 개당마진 = 판매가×(1−수수료3%) − 공급가 − 포장물류비(기본 **900원**). (두 기본값은 7월 실측 근거.)
- **BEST 10개**(2026-08-07 변경, 기존 12): 21일 순판매 상위 `bestPool`(20) 자격 → 실현마진 상위 `bestMax`(10). 설정 `dcfg-bestmax`/`dcfg-bestpool`.
- **BEST는 두 파일 모두에 들어간다**(2026-08-07): ① BEST 진열 영역용 CSV(BEST 1위순, 10줄) ② 일반 진열 CSV(카테고리 전체 + BEST가 페이지별로 섞임). 양식 동일, 버튼 2개.
- **BEST 섞어넣기 규칙**(`dispMixBest`): 페이지 `pageSize`(12)칸, 페이지당 `bestPerPage`(3)개. **약한 순위부터 앞 페이지에** — 1p←8·9·10위, 2p←5·6·7위, 3p←2·3·4위, 4p←1위. 상단 BEST 영역에서 이미 보이는 상위 상품일수록 뒤 페이지로 보내 스크롤 내내 새 강자를 만나게 하는 배치(사용자 결정).
  - 페이지 안 위치: **1페이지는 신상이 맨 위, BEST는 신상 다음 자리들 중 무작위**(2026-08-07 변경). **2페이지부터는 1·5·9번째 자리** 고정.
  - 무작위는 `dispRng`(mulberry32) + `dispSeed(카테고리번호, 기준일)` — **씨앗 고정이라 같은 카테고리·기준일이면 항상 같은 배치**. 매번 다르게 섞으면 화면에서 검토한 순서와 내려받은 CSV가 달라져 업로드 사고가 난다.
  - 자리가 모자라면(신상이 1페이지를 다 채우는 등) 남은 BEST는 `carry`로 다음 장에 넘긴다. **2페이지 이후 분기에도 carry가 필요** — 없으면 BEST가 조용히 사라진다(단위테스트로 잡은 실제 버그).
  - 검증: 실데이터 TOP·BOTTOM·blouse 및 엣지 10종(신상 0/3/9/12/20, BEST 0/1/10/12, 일반 부족)에서 중복 0·누락 0.
- 구간 순서: **BEST → 신상(21일) → 랭킹/하위 → 데이터부족 → 시즌제외 → 제외**. 표는 **일반 진열 순서**로 그리고 12행마다 페이지 구분선 표시.
- **신상 신선도 21일**(2026-08-07 변경, 기존 14일 — `dcfg-freshdays`). 21일 창 지표와 기준을 맞춤.
- 표 UI(2026-08-07): **지표 열(등록일~변동) 접기 버튼** — `#disp-result.cols-collapsed .dcol{display:none}` CSS 토글만 하고 **재렌더 금지**(200행+ 재생성이 느림). 접으면 순위·구간·상품명·**시즌**·코드만 남아 가로 스크롤 없이 시즌 지정 가능. **체크박스 다중 선택**(헤더 전체선택 + Shift+클릭 범위) → `선택 시즌 제외`/`선택 복원` 일괄 처리(PostgREST 배열 POST + `resolution=ignore-duplicates` / `product_no=in.(...)` DELETE).
- **시즌 제외 모아보기**(2026-08-07): 진열 메뉴 상단 접이식 패널 — disp_season_out 전체(상품명·번호·지정일) 목록 + 개별 복원 + **전체 복원**(confirm). 카테고리를 고르지 않아도 열람 가능.
- **데이터부족 가드**: 주력에서 21일 조회<max(50,중앙값×0.5) 또는 **21일 판매<10개** → 하강(소표본 요행 방지, 판매량 기준이 핵심). 설정 dcfg-evidence/dcfg-minsales.
- **시즌 제외 토글**: 표 '시즌' 컬럼 버튼 → disp_season_out 저장, 상품 단위 전 카테고리 공통. **현재 6개 지정됨(가을 복원 필요): [Best] 클레르 블라우스(1383), 라이트 모튼 가디건 니트(2217), 메그 루즈핏 가디건 니트 세트(2178), 본느 루즈핏 니트(1266), 은은 스트링 블라우스(2128), 센느 니트 후드 원피스(1613).** 모아보기 패널의 '전체 복원'으로 한 번에 되돌릴 수 있다.
- 주력 판정: 21일 조회 70+ 상품 30개 이상. 조기강등 조회하한 210. **categories/{no}/products는 offset 무시 → limit=1000 단일 호출.** 설계 의도 9항 임의 변경 금지. 사이즈 결품 판정 미지원.
- **신상 보호 토글(2026-08-11, 상품팀 요청)**: 설정 패널 체크박스 `dcfg-protectnew`(기본 꺼짐, 미저장 — 켤 때마다 체크). 켜면 조기 강등 블록을 건너뛰어 **신선도(21일) 이내 신상은 성과평가 없이 신상 블록(최대 newMax=12개) 유지**. 신상이 12개 초과면 최신순 12개만(기존 newMax 동작 그대로). 요약 타일에 '보호 켜짐 — 조기 강등 안 함' 표시. 검증(TOP, 기준일 8/11): OFF 신상 9·조기강등 3(나그랑 맨투맨 포함) → ON 신상 12·강등 0·전원 1페이지(1~12위).

### 자체제작 주문 점검 (#madechk, 2026-09-03 사용자 요청 — 관리자+MD, 제작처 지정도 MD 가능)
- 상품명에 **자체제작/made** 포함 상품(사용자 확인: 항상 포함)의 발주 시점·수량 점검. **주문은 옵션별(2026-09-03 사용자 지정 v2)** — 서버 `cafe24-analytics madeavg`(admin+staff, 10분 캐시, 클라가 `v:'2'`로 캐시 키 분리): **eachOrder 30일 단일 스캔**(`date_type=order_date&embed=items`, 취소=C40/R40) → 상품별 + **옵션별(option_value 단위 Win)** 어제까지 3일·7일 일평균 순판매(결제−취소, 주문일 — 판매 성과와 동일 기준). v1의 애널리틱스 다회 호출 방식은 옵션 분해가 안 돼 폐기.
- **신상 보정(사용자 설계)**: 30일 합계 ≤ 7일 합계면 첫 판매가 7일 창 안 → 일별 시리즈에서 첫 판매일을 찾아 **분모를 실제 판매일수로**(예: 어제 첫 판매 97개 → ÷1 = 97/일. ÷7이면 13.9로 저평가 — 실사례 검증). 옵션 avg 분모도 상품 공통 days3/days7 사용. 표에 '판매 N일' 배지+첫 판매일 표시.
- **제작처 태그 `made_products`**(product_no PK, origin cn/kr, lead_days 덮어쓰기 — db 프록시 읽기·쓰기 admin+staff. 처음엔 admin만 쓰기였다가 2026-09-03 사용자 요청으로 MD에도 개방, 커스텀 차단 규칙 제거). 리드타임 기본 **중국 10일 / 국내 9일(영업일 7일 환산)**.
- **재고는 셀메이트 CSV 업로드**(API 유료라 — 방식 사용자 확정): 헤더 자동 인식(상품명/현재재고·현재고/미발송·미출고 시작 + **옵션명·옵션 열**), EUC-KR은 기존 readFileAsText·stkNorm 재사용. 상품 합산과 함께 **옵션 행 보존**(rows:[{opt,tokens:stableOptTokens,stock,unshipped}]). **가용재고 = 현재고 − 미발송**.
- **옵션 매칭·판정(v2)**: 카페24 option_value ↔ CSV 옵션을 stkOptTokens→stkSameOpt(정확)→stkLooseOpt(느슨, '표기차이' 표시)→옵션 없는 상품은 단일 행 폴백으로 매칭. 옵션별 judgeOne: 소진일수 = 가용÷7일평균 → ≤리드 🔴주문 필요 / ≤리드+3일 🟠임박 / 그 외 🟢, **옵션별 권장 = ceil(7일평균×(리드+커버목표)−가용)**, 커버 기본 14일(localStorage `dnrb_made_cover`). **상품 행 판정 = 옵션 중 최악(과 상품합계 판정 비교), 권장 = 옵션 합('옵션 합계' 표기)**. 상품 행의 `옵션 N개 ▾` 버튼(madeToggleOpts, madeState.open Set) → 접이식 옵션 상세 행(옵션/7일평균/30일/가용/판정/권장). 정렬 = 심각순.
- 검증(v2): 실데이터 19상품·옵션 합 = 상품 합(113=113)·신상 보정 실증(÷1), 가짜 CSV 3옵션 매칭 — 블랙 권장 210=⌈10.857×23−40⌉·차콜 59·베이지 임박 28 수기 일치, 상품 합계 297, MD 조회 200/지정 403, 모바일 표 자체 스크롤 OK, QA 태그·계정 원복 완료. 실제 셀메이트 CSV 헤더·옵션 표기 매칭은 사용자 실사용 확인 대기.

### 안정재고 편성 (#stable, 관리자)
- **셀메이트 재고 대조(#stock) 메뉴는 2026-08-20 제거됨(사용자 요청).** 단, 공용 헬퍼 4개(stkNorm/stkOptTokens/stkSameOpt/stkLooseOpt)는 안정재고 편성이 계속 쓰므로 유지 — "셀메이트 CSV 공용 헬퍼" 블록. 제거 검증: 전 메뉴 순회 오류 0, #stock 직접 접근은 홈 폴백, stable EUC-KR CSV 파싱·토큰 매칭 정상.
- 셀메이트 안정재고 CSV(EUC-KR, **헤더명 기반 열 인식**: 상품명/옵션명/안정재고/상품등록일자) ↔ paiditems.
- **옵션 매칭 = 값 토큰 배열 1:1 짝짓기**(셀메이트 "연청,L" ↔ 카페24 "컬러=연청, 사이즈=L", 순서 무관, 토큰 수 다르면 미매칭). 문자열 결합 비교는 "1사이즈"↔"1사이즈 (55~77)"에서 깨짐.
- 안정재고 추천: 1일평균(결제수량÷일수) <1→0 / <3→×3 / <5→×4 / ≥5→×5, 내림(3.0은 ×4). 분홍=변경필요, 노랑=신규편성. 필터 탭(전체/변경/늘릴/줄일) + '차이 N개 이상'. 기본 기간 **어제까지 7일**.
- **신규 편성 표 상품별 그룹(2026-08-24)**: 같은 상품의 옵션을 붙여서 나열 — 상품 순서 = 옵션 중 최대 추천 desc→총 결제수량 desc, 상품 안 옵션 = 추천 desc. 첫 행에만 상품명+'옵션 N개', 이후 행 〃, 상품 경계 굵은 상단선.
- **본표(변경 필요)도 같은 그룹 표시(2026-08-24)**: 정렬은 기존 가나다순 유지(같은 상품이 이미 연속) — 표시만 신규 표 방식(첫 행 상품명+'옵션 N개', 이후 〃, 경계선 #dbe0ea). 옵션 N개는 **필터로 걸러진 표시 중 행 기준**으로 계산.
- **카페24 date_type의 결제일은 `pay_date`** (payment_date/paid_date는 422). `/admin/products`는 **limit 최대 100**·offset 정상.

### 광고 효율 (#adv, 관리자+MD)
- Meta 광고관리자 API. summary(광고비/구매전환값/구매수/Meta ROAS) + 카페24 ROAS(결제매출÷광고비) 5타일. 소재 **TOP 20**(행 클릭 → 미리보기 iframe + 기간별 지출·ROAS 이중축 차트).
- 구매 액션은 **omni_purchase**→purchase→fb_pixel_purchase 폴백(이 몰은 omni_purchase).
- **선택 기간 내 광고 효율 확인(dateads, 2026-08-10)**: 사내 규칙 — **광고 등록 시 광고명에 등록일 YYMMDD를 기입**(예: 260810). 조회 기간에 등록일이 걸리는 **현재 활성(effective_status=ACTIVE) 광고만** 소메뉴 표로 표시(사용자 결정 — 비활성 포함 시 과다). 서버가 insights에 `filtering=[{field:"ad.effective_status",...}]`를 걸고(동작 확인), 이름에서 정규식 `(?<!\d)(2[4-9])(MM)(DD)(?!\d)`로 날짜 추출 — 앞뒤 숫자 붙은 긴 숫자열(가격 24500 등)은 제외. 검증: 8/1~10 → 활성 중 35개, 8/3 단일 → 98개 중 12개·오탐 0. 행 클릭은 기존 미리보기 모달 재사용.
- **미리보기 형식 전환(2026-09-01 사용자 신고 해결)**: 릴스 게시물 기반 광고는 기본 피드(INSTAGRAM_STANDARD) 미리보기가 **"지원되는 화면 비율은 9:16..." 안내문만** 나온다(실사고 — 기존릴스_test 소재). 서버 preview `fmt` 파라미터를 4종(feed/reels/story/desktop)으로 확장, 클라 **공용 로더 `metaPrevLoad`**(형식별 메모리 캐시·늦은 응답 버림)가 모달에 **[피드][릴스][스토리] 칩** 표시 + **이름에 '릴스'가 들면 자동으로 릴스 형식** 시작. 성과 모달(showMetaPreview)·베스트소재 경량 모달(admgrBestOpen) 둘 다 이 로더 사용(중복 fill 함수 제거). 검증: 릴스 소재가 실제 영상 프레임으로 렌더, 칩 전환·자동 선택 정상.
- **adstats 기간 7종**(소재 클릭 시 모달): 오늘 / 어제 / 최근3일 / 최근7일 / **이전7일** / 최근14일 / 최근30일. 앞 6개는 date_preset(today/yesterday/last_3d/last_7d/last_14d/last_30d, 오늘 외에는 어제까지). **'이전 7일'은 Meta에 프리셋이 없어 time_range로 직접 조회** — 기준일은 last_7d 응답의 `date_start`에서 −7d~−1d 역산(광고계정 시간대 그대로라 어긋나지 않음), last_7d가 빈 응답이면 Asia/Seoul 오늘−7d로 폴백. 응답 stats에 `start`/`end` 포함 → 타일 tooltip·차트 tooltip에 실제 날짜 표시. 검증(2026-08-05, 6개 소재): **이전7일 + 최근7일 = 최근14일** 정확히 일치.
- **Meta 연동 = 시스템 사용자 방식**(개인계정 잠금 문제 회피). 시스템사용자 dnrb-dashboard(비즈니스 Onniverse), 앱 DNRB-Dashboard(1005085742525912), 무기한 ads_read 토큰. 기존 수동 입력/시나리오/세금/아카이브 UI는 삭제됨(adv_archive 데이터는 보존, e89ef28 이전 커밋에서 복원 가능).

### 광고관리자 (#admgr, **관리자 = 전체 4탭 / MD·마케터 = 테스트 소재 탭만**(2026-08-27 사용자 지정 — 08-26엔 관리자 전용으로 축소했다가 테스트 소재만 다시 열어줌), 2026-08-25 — 시험 도입, 제거 가능성 있음)
- **⚠ 제거 방법(사용자 예고)**: 추가 직전 상태 = 커밋 `14d61ac`. **`14d61ac` 이후의 admgr 커밋들을 revert** 후 meta-ads·db 함수 재배포하면 원상복구. 구성 요소: 메뉴 버튼(menu-admgr)·섹션(sec-admgr)·admgr* JS 블록·MENU_KEYS/applyRole/showMenu 훅·서버 meta-ads `hierarchy`/`testads` 액션·db 프록시 ad_test_state 항목·`ad_test_state` 테이블.
- **메타식 탭 보기, 보기 전용**(켜고 끄기는 메타에서 — 토큰이 ads_read라 불가능하기도 함). 기간 칩 오늘(기본)/어제/최근7일/최근30일(**7일·30일은 오늘 제외 어제까지 — Meta 표준**, 응답 range로 실제 날짜를 라벨에 표시. 캐시 키에 오늘 날짜 포함 — 자정 넘김 대비), '활성만' 기본 켜짐(= 켜짐 또는 기간 중 지출>0), 지출 내림차순, 광고 행 클릭=기존 소재 미리보기 재사용.
- **예산 직접 변경 + 자정 예약(2026-08-26, `meta-budget` 함수 + `budget_writes` 테이블)**: 캠페인/세트 탭에서 **예산 클릭(연필) → 팝업**: 새 일예산 입력 → [즉시 적용] / [자정에 자동 반영](다음 자정 00:00 KST — pg_cron 잡 `budget-midnight-kst`(0 15 * * * UTC)가 run 액션 호출, x-cron-secret 검증). 예약은 대상당 1건(새 예약이 기존 대체), 예약 배지가 예산 셀 아래 표시, 팝업에서 취소.
  - **PIN 세션 인증 + 자정 반영 세팅 모드(2026-08-26b 사용자 요청)**: 팝업마다 PIN 입력 대신 **메뉴의 'PIN 인증' 버튼**(서버 `verify` 액션) 한 번으로 세션 전체 활성화(성공 시 '인증됨', 클릭하면 해제 — PIN은 메모리만). **'자정 반영 세팅' 3단계 버튼**: 시작(미인증이면 PIN 프롬프트부터) → '세팅중 · N건 — 완료하기'(이 모드에선 팝업에 '자정 반영으로 저장' 버튼만, 즉시 적용 숨김) → '세팅 완료 · N건 보기' 클릭=예약 목록 모달(대상·현재→자정값·적용일·신청자·취소 + '새 세팅 시작'). midMode는 세션 상태(새로고침하면 idle, 예약 자체는 DB라 유지).
  - **보안(전부 서버 강제)**: ①admin + **WRITE_USER_IDS secret**(대표 2인의 계정 id — 공개 레포라 코드·문서에 id를 적지 않는다, secret에만) ②**WRITE_PIN**(secret) 매 요청 검증, 15분 5회 실패 잠금(api_cache 카운터), 성공 PIN은 클라 메모리만 ③**일예산 상한 300,000원**(처음 50만→30만 사용자 정정)·하한 1,000원 ④총예산(lifetime) 대상 거부 ⑤모든 실행·예약·취소·실패가 budget_writes에 기록(requested_by 포함 — Meta 활동로그는 시스템사용자로만 남으니 우리 기록이 실행자 추적용).
  - **✅ 셋업 완료(2026-08-27)**: META_WRITE_TOKEN(시스템 사용자 dnrb-dashboard, 캠페인 관리 권한+ads_management, 다른 시스템 사용자 승인 절차 거침)·WRITE_PIN 설정·재배포 완료. 검증: 토큰 /me 정상, 동일값 POST로 쓰기 권한 확인(success:true·예산 무변경), status token_set/pin_set true. 적용 성공 시 서버가 meta:hierarchy*·meta:budgethist* 캐시 삭제 → 화면 즉시 반영. ⚠ 토큰이 zsh에서 따옴표 사고를 낸 전력: 한글 IME 둥근따옴표로 dquote> 멈춤 — secrets 명령은 반드시 영문 상태에서.
  - 검증(2026-08-26, 토큰 제외 전 경로): 잘못된 PIN 카운트다운·30만 초과 거부·예약 생성(old 예산 Meta 자동조회)·pending 목록·취소·cron 비밀 검증·비허용 admin(김다나 케이스) status allowed:false+쓰기 403·UI 팝업/배지/PIN 세션 기억 전부 정상.
- ~~MD·마케터 = 테스트 소재 탭만(2026-08-27)~~ → **MD·마케터 = 테스트 소재 + 기존광고 중 OFF + 베스트소재 3탭(2026-08-28 사용자 지정)**: 허용 탭은 `ADMGR_STAFF_VIEWS` 상수, `admgrSetView`·`admgrRender` 양쪽에서 비관리자면 허용 밖 view를 'test'로 강제(캠페인·세트·광고 계층 3탭은 계속 못 봄). 서버는 offsets·creatives를 admin+staff로 완화(hierarchy/budgethistory/hourlystats는 admin 유지), db 프록시 best_ads는 admin+staff(담기는 광고세트 탭이 admin 전용이라 사실상 admin만, MD는 열람·제거). 베스트소재 빈 화면 문구·intro 안내는 역할별 분기. 검증(staff 계정): 3탭 표시·offad 65행·best 2세트·경량 모달·camp 강제 test·hierarchy 403.
  - 서버: meta-ads의 admin 전용 목록에서 **`testads`만 제외**(hierarchy/budgethistory/hourlystats는 계속 admin 전용), db 프록시 `ad_test_state` → **admin+staff**(숨김·추가소재권장·메모를 MD가 써야 탭이 의미 있음).
  - ~~금액 블러~~ → **테스트 소재 탭만 예외로 블러 해제(2026-08-28 사용자 지정)**: MD·마케터도 테스트 소재의 **누적 지출·구매당 비용을 그대로 본다**(`admgrMoneyPlain`/`admgrCpaPlain` — meta-blur 미사용, 요약 타일 '누적 지출'도 해제). **계층 탭(캠페인·세트·광고)과 광고 효율 메뉴의 블러 정책은 그대로**(admgrMoney/admgrCpaTxt 유지). 예산 변경 컨트롤은 계속 `isAdmin()` 가드로 숨김. 검증: 마케터 화면 블러 0·지출 6,063원/구매당 6,063원 노출.
  - 검증: 마케터 계정 — 탭 '테스트 소재 20' 하나·view 강제 test·hierarchy API 403·testads 200·ad_test_state 읽기 OK·예산 버튼 숨김 / 관리자 계정 — 4탭(캠페인 60·세트 140·광고 156) 정상, 탭 전환·전 메뉴 순회 오류 0.
- **활성·비활성 토글(2026-09-02 사용자 요청)**: 캠페인/세트/광고 탭의 상태 셀에 **끄기/켜기 소형 버튼** — 예산 변경과 동일 보안(admin+WRITE_USER_IDS+**PIN 매 요청**, 미인증 클릭 시 PIN 팝업부터). 서버 `meta-budget setstatus`(level 3종·ACTIVE/PAUSED만 허용, META_WRITE_TOKEN으로 `/{id}` status POST) → **budget_writes에 mode `status_on/off`로 감사 기록**(new_budget은 NULL — NOT NULL 제약 2026-09-02 해제) → hierarchy 캐시 삭제로 화면 즉시 반영. 상태 불명 행('기간 중 게재'·검토중)은 버튼 없음. 켜고 끈 이력은 Meta 활동 로그에도 남아 '기존광고 중 OFF' 탭이 자동 인지. 검증: 비허용 admin 403·비허용자 버튼 미표시·허용자 버튼 렌더·미인증 클릭 PIN 팝업 (⚠ 실제 Meta 적용은 PIN이 secret이라 사용자 최종 확인 필요).
- **'최근 변경' 열 + 예산 변경 히스토리·영향 분석(2026-08-26)**: **Meta 활동 로그(`budgethistory` 액션)가 예산 변경을 이미 기록**(ads_read로 조회 가능, ~90일 보관 — 우리 DB 기록 불필요)하므로 그대로 읽는다. 이벤트 실측: `update_ad_set_budget`/`update_campaign_budget`만 금액 변경(scheduling_state 등 비금액 budget 이벤트 제외), extra_data는 중첩 JSON(`old_value.old_value`→`new_value.new_value`, additional_value "(일일 기준)"), **object_type은 Meta 옛 명칭이라 CAMPAIGN=광고세트! — 층 판정은 event_type으로**, event_time은 UTC(표시 +9h). **'오늘' 칩 + 캠페인/세트 탭에서만 '최근 변경' 열**(예산 열 옆, m-hide): **오늘 변경 내역 전부**(2026-08-26 사용자 요청): 건마다 ↑파랑(증액)/↓빨강(감액)+**변경 후 설정 예산**(new_value, meta-blur — 증감폭 아님, 사용자 확정: 4만→8만이면 80,000 표시)+시각(HH:MM) 배지를 시간순(위=먼저)으로 나란히, 그 **맨 위에 '시작 N' = 오늘 첫 조정 직전 예산**(2026-08-27 요청 — evs가 최신순 배열이라 마지막 원소의 old_value, 회색 소형·old_value 0이면 생략). **오늘 변경이 없는 행은 아무것도 안 띄운다**(빈 '—' — 사용자 확인). 클릭→히스토리 모달(오늘/최근 7일 토글, 시각·기존→변경·증감·(일일 기준)) — 색은 사용자 지정(증액=파란색, 2026-08-26). **분류 칩 '오늘 예산: 전체/변경/증액/감액'**(건수 표시, chgFilter — 같은 조건에서만 노출, 기간 칩 바꾸면 자동 해제, 방향은 최신 이벤트 기준). 검증: 변경 76=증액 18+감액 58, 필터별 행 수 정확 일치. **영향 분석**(모달, 어제·오늘 변경만): `hourlystats` 액션(어제~오늘 시간대별, breakdowns=hourly_stats_aggregated_by_advertiser_time_zone=계정 시간대) — **변경 전 3h vs 적용 후 3h(반영 지연 ~1h 고려, 변경 시간대+다음 1h 건너뜀)** + 어제 같은 시간대 참조선, 완결 시간대만 사용. 판정: ROAS ±10% → 긍정/부정/중립, 적용 후 완결 2h 미만·지출 없음·전후 구매 0 → 판단 보류. 금액은 meta-blur. 검증(8/25 실데이터): 오늘 이벤트 84건·아이콘 캠페인 2+세트 72, 14:44 증액 3만→5만 모달 정확, 적용 후 1h뿐일 때 보류 판정 정상, 7일 388건 중 대상 3건 필터 정상.
- **광고세트 탭 '실결제 수' 열(2026-08-26, 첫 명칭 '결제완료'에서 변경)**: 세트명↔상품명 매칭(판매 성과 ON 광고의 pa* 규칙 그대로 재사용 — 자모 비교·최장 핵심명 우선·동명 계절 버전은 ver 토큰 필수) 시 그 상품의 **기간 내 카페24 결제완료 수량** 표시(기간 = 현재 기간 칩과 동일, 셀 tooltip에 매칭 상품명). 데이터 = `paiditems` 재사용(admin 전용 — 메뉴 자체가 관리자 전용이 되며 staff 완화는 당일 원복). 표 먼저 렌더 후 비동기로 채움(첫 조회 수십 초 가능, 셀 스피너 → 도착 시 재렌더, 기간 바뀌면 늦게 온 응답 버림 — `paid.loading`에 기간 키 보관). 정렬 가능(미매칭=-1로 최하위), **합계 행은 — 표시**(여러 세트가 같은 상품이면 이중 합산이라 고의 생략). 검증(8/25 실데이터): 134세트 중 117 매칭, '클레르 블라우스'(0)와 '썸머 클레르 블라우스'(37) 분리 정확.
- **탭 방식 개편(2026-08-26, 사용자 확정 — 트리 완전 교체)**: 캠페인/광고세트/광고/테스트 소재 4탭. **캠페인·세트 행 체크(또는 행 클릭) → 다음 탭이 그 선택만 표시**(메타 광고관리자 방식), 헤더 체크박스=표시분 전체 선택, 이름 옆 '세트 보기→'/'광고 보기→'=그것만 선택+탭 이동, 선택 칩+해제 버튼. **캠페인 선택 해제 시 그 밖 세트 선택 자동 정리**(admgrPruneSel — 몰래 필터 남는 사고 방지). 검색은 현재 탭 이름 기준(qmode 셀렉트 제거), 요약 타일·합계는 표시분 기준. 세트·광고 행엔 상위 이름 부제 표시. 데이터는 기존 hierarchy 그대로라 탭 전환·선택은 재조회 없음.
- **테스트 소재 탭(2026-08-26)**: 사내 운영(소재 등록 → 3일 테스트 → OFF/유지/증액 평가)의 시스템화. **세트명에 test(대소문자 무시) 포함 → 자동 수집**(서버 `testads` 액션: /adsets 전체 페이지네이션 후 서버 정규식 매칭 — Meta CONTAIN은 대소문자 변형을 놓칠 수 있어 안 씀 — → /ads(꺼진 것 포함)+insights 누적, adset.id IN 필터, 60초 캐시, `kw` 파라미터로 키워드 변경 가능). 성과는 **등록 이후 누적**(지출·구매·CPA·ROAS).
  - **상태 자동 판정**(Meta 데이터만으로, DB 불필요): ON=켜짐·3일 미경과 / **생존=켜짐 유지+등록일+4일부터(사용자 확정: 8/22 등록 → 8/26부터)** / OFF=꺼짐(**'소재 꺼짐'(자체 PAUSED) vs '상위 꺼짐'(캠페인·세트 꺼짐) 부제 구분**) / 검토중·거부 별도 배지. 등록일=Meta created_time의 한국 날짜(reg_date), D+n 표시.
  - **ad_test_state 테이블**(ad_id PK, hidden/recommend/memo/updated_by, **admin 전용** — 2026-08-26 메뉴 축소와 함께): 체크 선택→'목록에서 제거'(hidden=true, confirm) / '제거한 소재 N개 보기'→선택 복원 — 데이터 보존·플래그만. **추가소재권장** 토글은 생존 소재에 '표시하기' 버튼(설정 후엔 어느 상태든 배지 유지·클릭 해제). **메모 인라인 수정**(클릭→input, Enter 저장·Esc/blur 취소, 프리필은 value로 — innerHTML 금지). 저장은 PostgREST upsert(`on_conflict=ad_id`+`resolution=merge-duplicates`), 일괄은 배열 POST.
  - 검증(2026-08-26, kw=리타 실데이터 주입): 생존 1·OFF 5(상위 꺼짐 구분) 판정 정확, 제거 2개→건수 6→4·복원 6, 권장·메모 DB 반영, 모바일 375px iframe 넘침 0(이름·상태·지출·ROAS만), 14개 메뉴 순회 JS 오류 0.
  - **개편(2026-08-28 사용자 요청)**: ① 표 대표명 = **광고세트명**(소재명은 부제로 강등, 열 정렬 키 `aname` 신설 — admgrCmp) ② 상태 칩 = **전체/평가중/OFF(빨간불)/애매(주황불)/우수(초록불)** — OFF·검토중·거부는 메타 자동 감지 유지, **애매·우수는 상태 칸의 [애매][우수] 버튼으로 직접 지정**(`ad_test_state.verdict` = 'meh'/'good', 같은 버튼 재클릭=해제→평가중. 사용자 확정 — ROAS 자동 판정 아님), 켜져 있고 미지정 = 평가중. **기존 ON/생존(등록+4일) 자동 판정은 폐기** ③ '추가소재권장' 열 → **'추가소재'**: 우수 소재에 **요청/제작완료 체크박스 2개**(체크 시각을 `asset_req_at`/`asset_done_at`에 기록, 옆에 MM/DD 소형 표시. 판정을 나중에 바꿔도 체크 기록은 유지·표시) ④ **'추가소재 요청 N' 칩** = 요청 체크된 소재만 모아보기. 기존 recommend 별표는 초기화하고 새로 시작(사용자 결정 — 컬럼은 무해하게 잔존). upsert는 안 바꾸는 필드도 현재값을 실어 보냄(누락 시 null 덮어쓰기 사고 방지 — admgrTestSave/BulkHide 공통). 검증: 판정 지정·해제/요청·완료 체크 날짜/요청 필터 1행/DB 반영/체크 클릭이 행 선택으로 안 샘/모바일 375px 넘침 0/캠페인·세트 탭 무영향/콘솔 오류 0.
  - **상품관리 시스템 연동(2026-08-28d — 운영 일원화, 사용자 확정)**: 평가 입력은 이 대시보드 테스트 소재 탭이 **유일한 원본** — 상품관리(newproduct-manager)가 자동으로 받아간다. 서버 meta-ads **`syncexport` 액션**(사용자 토큰 대신 **`NPM_SYNC_SECRET` secret + x-sync-secret 헤더** 인증, 읽기 전용, 60초 캐시): 테스트 세트 광고 전체 + ad_test_state verdict·hidden 반환. 상품관리 쪽은 `/api/dnrb-sync`(비밀키는 그쪽 비공개 레포 `lib/dnrb-sync.ts`에 보관)가 페이지 진입 시 백그라운드 호출 → ①매칭 test 세트가 생긴 '업로드완료' 상품 자동 '광고테스트' 진입(시작일=메타 등록일) ②성과체크·평가완료 상품 평가 자동 반영(하나라도 우수→우수/전부 꺼짐→OFF/그 외→애매) + 수동 평가 잠금. 매칭은 최장 이름 우선(부분 겹침 방지). **키 교체 시 양쪽 동시**: supabase secrets + 상품관리 lib/dnrb-sync.ts + meta-ads 재배포. 검증: 무키 403/오키 403/정상 38소재+판정, 프로덕션 실행 matched 4·advanced 3·재실행 advanced 0(멱등).
  - **재렌더 스크롤 유지(2026-08-28c 사용자 지적)**: 판정·체크·메모 저장마다 표 innerHTML을 갈아끼워 **표 스크롤이 맨 위로 튀던 것** 수정 — admgrRenderTest 끝에서 기존 `.table-wrap`의 scrollTop/Left를 보관했다 복원. 필터·제거목록 전환은 다른 행 집합이라 의도적으로 맨 위 초기화(admgrTestScrollTop). 검증: 맨 아래(3088px)에서 우수 지정·해제 후 스크롤 그대로, 필터 전환 시 0.
  - **'테스트 종료' 자동 보관(2026-08-30 사용자 요청)**: 광고팀이 세트명에서 test를 지우면(정식 운영 전환 신호) 소재가 소리없이 사라져 **MD팀이 확인을 못 하던 문제** 해결. 서버 testads가 이번에 본 소재를 **`test_ad_snap` 테이블**(ad_id PK, 이름·세트명·상태·성과·first/last_seen — service_role 전용, db 프록시 미등록)에 upsert(60초 캐시라 분당 최대 1회 쓰기)하고, **전에 봤는데 지금 목록에 없는 소재를 `gone:true`+마지막 성과 스냅샷으로 함께 반환**(last_seen 60일 이내만 — 그 뒤 자동 소멸). 클라: **gone이면 st는 항상 'ended'(2026-09-01 분리안 — 사용자 확정: 우수/애매/OFF/평가중 칩·타일은 테스트 중인 소재만 세고, 종료 소재는 '테스트 종료' 칩에서만 보임)**. 배지는 [테스트 종료]+판정(meta.verdict) 병기('판정 없이 종료' 부제로 평가 누락도 보임), 종료 소재에도 [애매][우수] 늦은 판정 가능(버튼 선택 표시·추가소재 체크 가능 여부는 verdict 기준), 정리는 기존 '목록에서 제거'(hidden). 엑셀 상태 열은 '테스트 종료 (우수)' 식 병기. 광고관리자 인트로 문구도 이 규칙 안내로 교체(관리자·MD 양쪽). 검증: 가짜 스냅샷 주입 → 캐시 만료 후 gone 반환·배지·칩·판정 병기·성과 표시 전부 정상(정리 완료). ⚠ 메타 세트명은 아무것도 안 건드림 — 대시보드 표시 전용.
  - **엑셀 추출(2026-08-28b)**: 칩 줄 끝 '엑셀' 버튼(`admgrTestXlsx`, xlsx-populate) — **지금 보이는 표 그대로**(필터·검색·정렬 반영, 파일명에 필터명 포함: `테스트소재_{전체|평가중|OFF|애매|우수|추가소재요청|제거목록}_YYYY-MM-DD.xlsx`). 열 12개: 세트명·소재명·등록일·D+·상태(OFF는 소재/상위 꺼짐 병기)·지출·구매·구매당 비용·ROAS·요청일·완료일·메모. 행 계산은 화면 표와 **`admgrTestRowSets()` 공용**(추출·표가 어긋나지 않게 렌더에서 분리). ⚠ `admgrKstDate(null)`은 `new Date(null)`=1970-01-01을 돌려주므로 날짜 컬럼은 null 가드 필수(주석 있음). 검증: blob 열어서 헤더·값·요청일 대조, 요청 필터 추출 1행, 파일명 2종.
- **'기존광고 중 OFF' 탭(2026-08-28 사용자 요청, admin 전용)**: 기간 지정(date 입력 2개+조회+최근 7/14/30일 칩, 기본 최근 7일) → **기간 내 비활성(OFF)으로 바뀐 광고세트**(테스트 세트 이름 test 제외)를 광고세트명 기준으로 나열. 열 = 세트명·등록일·OFF일(+시각)·누적 지출·구매·구매당 비용·ROAS(성과는 등록 이후 누적 — 테스트 소재와 동일 기준), 기본 정렬 최근 OFF 순, 열 정렬(offd 키 신설)·검색 지원, 모바일은 세트명/OFF일/지출/ROAS만. 서버 `offsets` 액션(admin 전용, 60초 캐시): **Meta 활동 로그(약 90일 보관)의 `update_ad_set_run_status`** — extra_data.run_status.new_value 1=활성, 그 외(실측 7)=비활성, activities는 최신순이라 세트별 첫 이벤트=기간 내 마지막 상태 → **마지막이 비활성인 세트만**(껐다 다시 켠 세트 제외, 이후 다시 켜진 세트는 '현재 다시 켜짐' 배지). 세트 상세는 ids 배치 대신 /adsets 전체 목록(삭제 세트가 섞이면 배치가 통째 실패). **한계: 세트 스위치를 직접 끈 것 기준 — 캠페인을 통째로 끈 경우 세트 이벤트가 없어 안 잡힘.** 검증: 7일 114세트·테스트 세트 0 포함, 기간 축소 16, 지출 정렬·검색·기간 유지·staff 403·모바일 375px 넘침 0.
- 기존광고 중 OFF 기간 칩에 **'오늘'·'어제' 추가**(2026-08-28 사용자 요청, `admgrOffDay(0|-1)` — 하루짜리 기간).
- **'베스트소재' 탭(2026-08-28 사용자 요청, admin 전용)**: 광고세트 탭에서 세트 체크 → 선택 바의 **'베스트소재로' 버튼** → `best_ads` 테이블(adset_id PK·adset_name·added_by, db 프록시 admin)에 저장하고 베스트소재 탭으로 전환 — **소재 이미지·영상 썸네일이 인스타 돋보기식 정사각 격자**(auto-fill minmax 130px)로 나열, 각 타일 하단에 광고세트명 오버레이·영상은 ▶ 아이콘·꺼진 소재는 '꺼짐' 배지, **타일 클릭 = 기존 소재 미리보기 모달**, 세트 칩의 ✕로 제거(데이터 삭제), 검색은 세트명·광고명. 서버 `creatives` 액션(admin 전용, 10분 캐시): /ads + **creative field 수정자 `thumbnail_width(600).thumbnail_height(600)`으로 600px 썸네일**(기본은 64px라 격자에서 흐림 — 실측 600×600 확인, 문법 거부 시 기본 creative 폴백). DB 저장이라 새로고침·관리자 간 공유 유지. ⚠ 격자 이미지는 `loading="lazy"` — 백그라운드 창에서는 로드가 미뤄져 naturalWidth 0으로 측정됨(검증 시 착시 주의, 직접 Image() 로드는 정상).
  - **타일 확대·9:16(2026-08-28b 사용자 요청)**: 타일 minmax 130→**200px(1.5배)**·**aspect-ratio 9/16 세로형**(처음 16:9로 만들었다가 사용자 정정 — 릴스 소재라 세로가 맞음).
  - **호버 재생은 시도 후 폐기(2026-08-28c 사용자 결정 — "어차피 자동재생 안 되니 가볍게")**: 호버 시 아무 동작 없음. **클릭 = 경량 모달**(`admgrBestOpen`) — 이 메뉴에선 **기간별 성과(adstats)를 아예 조회하지 않고** 미리보기만 1회 호출 + 메모리 캐시(`admgrBestPrevCache`) → 첫 클릭 ~0.8초·재클릭 2ms(실측). 다른 메뉴의 showMetaPreview(성과 포함)는 그대로. ⚠ **미리보기 형식은 기본(INSTAGRAM_STANDARD)** — `fmt=reels`를 썼더니 모달에서 소재가 잘리고 영상 재생이 안 되는 실사례(2026-08-28 사용자 신고)로 원복. fmt 파라미터는 서버에 무해하게 잔존.
  - ⚠ **Meta 영상 권한 실측 기록(재도전 시 참고)**: `/{video_id}?fields=source` 직접 조회 = **#10 권한 거부**(읽기·쓰기 토큰 모두), `?ids=` 배치 = **"deprecated in v26.0+"** 오류. `act/advideos` 목록에는 source가 열리지만 **이 몰 광고는 인스타 게시물(릴스) 기반이라 video_id가 라이브러리에 없음** → 매칭 0. 완전 자동재생은 시스템 사용자에 페이지 자산+pages_read_engagement 권한 추가·토큰 재발급이 필요. preview 액션의 `fmt=reels` 파라미터는 유지(경량 모달이 사용).
- **계층 탭(캠페인·세트·광고) 재렌더 스크롤 유지(2026-08-28 사용자 지적)**: 행 체크·정렬 클릭마다 표가 맨 위로 튀던 것 수정 — 테스트 소재 탭과 같은 keep/restore 패턴을 계층 렌더 끝에도 적용. **탭 전환 시에는 맨 위로 초기화**(admgrSetView에서 admgrTestScrollTop 호출 — 이름과 달리 admgr-result 공용).
- **조립은 하향식**(2026-08-25b): 처음 /ads 상향식 조립은 광고 500개 한도에 잘린 캠페인이 통째로 누락됨(리타겟팅·테스트2 실사례) → **/campaigns + /adsets + /ads(활성 필터) + insights(level=ad) 4호출**로 개편. 캠페인·세트 목록은 직접 받아 누락 불가, 광고 행 = 활성 전체 ∪ 기간 중 게재분(인사이트 — 중간에 꺼진 광고도 지출 표시, '기간 중 게재' 배지). 집계는 insights 행 기준(광고 목록 누락과 무관하게 정확). **60초 서버 캐시가 호출 한도 방어선**(과거 실사고), 캐시 키 `meta:hierarchy2:{preset}`, 화면에 'N초 전 기준' 표시.
- ~~MD/마케터 meta-blur~~ → 2026-08-26부터 메뉴 자체가 관리자 전용(클라 menu-admgr/showMenu denied + 서버 액션 4종 admin 게이트, MD·마케터·CS는 버튼 숨김+직접 접근 홈 폴백+서버 403). blur 마크업은 무해하게 잔존.
- **세트 잘림 수정 + 열 보강(2026-08-25c)**: /adsets도 무필터 500 한도에 활성 세트가 잘려 상태·예산이 비었음 → **활성 필터로 수집**(광고와 동일 방식, 캐시 키 hierarchy3). 비활성인데 기간 중 지출 있는 세트는 인사이트 유래로 '기간 중 게재' 배지. **구매당 비용 열**(spend÷purchases, 정렬 가능 — 구매 0은 정렬 시 최하위) + **예산 열**이 일예산/총예산(lifetime) 구분 표시(캠페인·세트 모두).
- **'활성만'의 정확한 의미**: 각 층별로 "effective_status=ACTIVE **또는** 기간 중 지출>0". Meta의 effective_status는 상위 상태가 전파되므로(캠페인 꺼짐→세트 CAMPAIGN_PAUSED) 세트가 '켜짐'이면 캠페인도 켜진 것 — 사실상 둘 다 활성 + 그날 돈 쓴 것들.
- **열 개편 + 합계(2026-08-25d)**: 열 순서 = 이름·상태·예산·지출·구매·구매당 비용·**ROAS·전환값**(교체)·**CPC**(신설, insights clicks 추가 — 캐시 키 hierarchy4). CPC=지출÷클릭, 정렬 가능(클릭 0=최하위). **맨 아래 합계 행**(표시 중 캠페인 기준 — 검색·활성만 반영, 합계의 CPA/ROAS/CPC는 합산값으로 재계산).
- **표 열 너비 조절(2026-08-31 사용자 요청, `admgrColResize`)**: 광고관리자 표 공용(계층·테스트 소재·기존광고 OFF) — 머리글 오른쪽 가장자리 드래그로 조절(최소 46px), **더블클릭 = 원래대로**. 열 식별은 머리글 텍스트(정렬 화살표 제거), 저장은 **탭별 localStorage `dnrb_admgr_colw_{view}`**. 표가 innerHTML로 재생성되므로 **세 렌더러 끝에서 매번 호출**(핸들 재부착+저장 너비 재적용 — 새 표를 그리면 호출을 잊지 말 것). 드래그 중엔 머리글만 움직이고 놓는 순간 그 열 전체 셀에 width/min/max 강제(인라인 min-width 제압). 핸들 click은 stopPropagation — 정렬 클릭과 안 섞임(검증됨). 마우스 전용(모바일 미지원).
- **다중 정렬(2026-08-25)**: 열 제목(이름/지출/구매/전환값/ROAS) 클릭 = 오름차순→내림차순→해제. **먼저 누른 열이 1순위, 다음 열은 그 안에서 2순위**(sort 배열, 헤더에 ▲▼+순위 숫자). 캠페인·세트·광고 3층 공통(admgrCmp). ROAS 정렬 값은 지출 0이면 -1.
- **기본 정렬 = 메타 광고관리자와 동일한 '최근 생성 순'(2026-08-27 사용자 요청, 기존 지출 내림차순에서 변경)**: 실측으로 확인 — Meta API가 주는 자연 순서가 `created_time` 내림차순 = id 내림차순으로 전 캠페인 일치. 서버 hierarchy가 캠페인·세트·광고에 `created`/`updated`(created_time/updated_time) 실어줌(**캐시 키 hierarchy4→hierarchy5**). 클라 `admgrDefaultCmp`가 created 내림차순, created가 없는 행(인사이트 유래 '기간 중 게재')은 id로 대체 — id도 시간순이라 결과 동일. **⚠ Meta id는 17자리라 `Number()`로 비교하면 2^53 초과로 정밀도가 깨진다** → `admgrIdCmp`가 자릿수→사전순 문자열 비교. 헤더 클릭 정렬은 그대로 우선 적용(해제하면 다시 최신순). 검증: 캠페인 탭 화면 순서 = Meta API 순서 완전 일치, 세트 96·광고 112행 created 내림차순 확인, 클릭 정렬(지출 desc) 정상.
- **검색(2026-08-25)**: 기준 셀렉트(광고세트명/광고명)+검색어(200ms 디바운스). 세트명 검색 = 일치 세트만 표시·캠페인 자동 펼침·세트 클릭 시 광고 펼침 / 광고명 검색 = 일치 광고만·캠페인+세트 자동 펼침. 검색 비우면 원래 트리(수동 펼침 상태 유지).

### 순익 시나리오 (#profit, 관리자)
- **실마진율(2026-09-02 사용자 요청)**: 기존 마진율은 정가 기준이라 쿠폰·적립금이 반영 안 됨 → 서버 `cafe24-analytics realmargin` 액션(admin·10분 캐시)이 **결제일(pay_date) 기준** 주문의 `actual_order_amount`(부분취소 반영)를 스캔해 정가 매출·자사 할인(쿠폰/적립금/예치금/회원/세트/앱)·배송비 수입·주문 건수를 집계. **네이버 부담 할인(market_other_discount_amount)은 정산 때 보전되므로 차감 제외(A안 — 사용자 확정)**, 참고 표기만. 클라 카드: 상품 실마진율 = (실매출−원가)÷실매출, **원가는 '계산 시점의 정가 마진율'로 역산**(`d._m0` 캡처 — 실마진 적용 후 재계산 드리프트 방지), **택배 발송비 = 주문 건수 × 단가(기본 1,850원, `pf-ship-unit`·localStorage)**. ⚠ **이중 차감 방지 설계**: 마진율 칸엔 할인만 반영된 상품 실마진율을 적용하고, 택배비는 P&L의 기존 '택배비' 비용 칸에 건수×단가로 따로 적용(참고용 '택배 포함 실마진율'은 표시만). 검증(9/1 실데이터): 330건·정가 2,430만·할인 51만(2.1%)·실마진율 47.9% = 수기 역산 일치, 적용 버튼 2종 정상. ⚠ eachOrder에 fields를 넘겨도 splitOrderRanges의 countFilter가 count 호출에선 제거해줌(기존 함정 방어 확인됨).
- 기간 → **4지표 자동 수집**: 매출(revenue) / 취소반품(취소&반품 메뉴 합계=카페24+네이버, 기간 일치 시) / 마진율(performance 판매수량 가중평균) / 광고비(Meta). 전부 수정 가능.
- **수동 비용 7종**(localStorage `dnrb_profit_costs`): 인건비·사입삼촌(VAT포함)·사무실월세(VAT포함)·관리비(VAT포함)·**택배비(면세)·기타VAT포함·기타VAT미포함**.
- **인건비 자동 수집**: '근무관리에서 불러오기' 버튼 → `http://localhost:3001/api/salary/all?year&month` (근무관리 서버가 도는 컴퓨터에서만 동작). 별도 프로젝트 work-manager 참조.
- **부가세 = 매출세액(순매출×10/110) − 매입세액**. 매입세액 = 상품원가×10/110(공급가가 VAT 미포함 기입이고 마진율이 공급가×1.1 기준이라 P&L 원가는 VAT 포함) + Meta광고비×10%(별도 청구) + VAT포함 경비×10/110. 인건비·택배비(면세)·기타미포함은 공제 없음.
- 법인세 = 과세표준 구간세율(2억 9% / 2억~200억 19% / 초과 21%, 연 구간을 기간 손익에 그대로 — 참고용). 손익분기 광고비 = 이분탐색.
- 손익계산서 + 순이익 카드 + ROAS(200~1000)×취소반품률(10~30) 매트릭스(셀 클릭 상세) + **profit_archive 기록 저장/불러오기/삭제**.

### 프로젝트 관리 (#proj, 관리자 전용)
- `project_tasks` 테이블(db 프록시, admin 전용): category(프로젝트)·section·title·done_criteria·priority(높음/중간/낮음/빈값)·assignee·due_date·status(todo/doing/done/hold)·note·sort_order. **초기 데이터 = ~/01_다나로브/다나로브_프로젝트정리.xlsx 39건(2026-08-19 임포트, 해외판매16·숏츠광고9·중국사입14) — 이후 대시보드가 원본, 엑셀은 스냅샷.**
- UI: 프로젝트별 요약 타일(완료율+진행바, 엑셀 '요약' 시트와 같은 집계) + 프로젝트 탭 + 상태 필터 + 섹션(연속 구간) 그룹 표. **상태는 표에서 셀렉트로 즉시 변경**(PATCH), 업무명 클릭=수정 모달(삭제 포함), 업무 추가 모달. 마감일 지나면 빨간 '지남' 표시.
- 정렬: 렌더가 **프로젝트(첫 등장 순) → sort_order**로 다시 묶으므로 새 업무 sort_order는 전체 최대+1이면 됨. 탭 onclick은 인덱스(projSetCat) — 이름 문자열 인라인 금지(따옴표 사고). 엑셀 상태 빈값은 todo로 임포트.
- **위치 지정 추가/이동(2026-08-20)**: sort_order를 **numeric으로 변경**(사이 삽입용 소수 허용). 모달에 '위치' 셀렉트 — 추가: 맨 아래(기본)/"○○ 다음", 수정: 위치 그대로(기본)/맨 아래로 이동/"○○ 다음". 표의 업무명 옆 **+ 버튼** = 그 업무 다음에 추가(프로젝트·섹션 프리필). 순번 계산: 다음 업무 있으면 중간값((a+b)/2), 없으면 +1(같은 프로젝트 내라 안전 — 렌더가 프로젝트별로 묶어서 프로젝트 간 충돌 무관). PostgREST numeric은 문자열로 오므로 **비교·계산은 반드시 Number() 경유**.
- **마감일 인라인 수정(2026-08-19)**: 표의 마감일 칸 클릭(빈 칸 포함) → 그 자리에서 date input(showPicker로 달력 즉시). 저장=PATCH due_date만, 빈 값=지움(null), 시작일보다 빠르면 거부. blur 시 원복.
- **담당자 인라인 수정(2026-08-21)**: 표의 담당자 칸 클릭 → 그 자리에서 셀렉트(등록 사용자+모두+—, projEnsureUsers 재사용). onchange=PATCH assignee만, blur=원복. 색 점은 재렌더로 갱신.
- **특이사항 인라인 수정 + 명칭 변경(2026-08-19)**: '비고'→'특이사항'(표 헤더·모달·엑셀 양식 — 컬럼명 note 유지, 업로드는 옛 '비고' 헤더도 인식). 칸 클릭(빈 칸 '—' 포함) → text input, **Enter=저장·Esc/blur=취소**, 빈 값 저장=지움.
- **업로드 RichText 버그 수정(2026-08-21 실사례)**: 엑셀 셀에 **부분 서식**(한 칸 안 일부 글자만 색·밑줄 등)이 있으면 xlsx-populate가 문자열 대신 RichText 객체를 반환 → String()이 "[object Object]"로 저장됨. `plain()` 헬퍼(RichText.text() 우선, 조각 이어붙이기 폴백)로 해결 — 헤더·본문 모두 경유. 기존 오염 1행(사운드북)은 SQL로 원문 복구.
- **업로드(일괄 등록) 삭제(2026-08-21)**: 툴바 '업로드 삭제' → 묶음 목록 모달 → 건수·프로젝트 확인 후 통째 삭제. **묶음 식별 = created_at 완전 동일**(PostgREST 배열 POST는 한 문장이라 now()가 전 행 같음 — 별도 컬럼 불필요, 과거 업로드분도 식별됨). 건수 1(수동 추가)은 제외, 가장 오래된 묶음엔 '최초 가져오기' 라벨. 삭제 필터: `created_at=eq.<ISO>` URL 인코딩.
- **엑셀 양식/업로드/다운로드(2026-08-19)**: 툴바 버튼 3개. 양식=예시 2행('(예시)' 접두 — 업로드 시 자동 제외)+'작성 안내' 시트. 업로드는 **헤더명 기반 열 인식**(셀메이트 관례)·**추가만**(같은 프로젝트+업무 조합은 중복 건너뜀·건수 confirm)·날짜는 문자열(YYYY-MM-DD·점·슬래시)과 엑셀 일련번호(numberToDate, 로컬 날짜로 포맷 — toISOString 금지) 모두 처리·상태 한글→코드 매핑(빈값 todo)·PostgREST 배열 POST 일괄 삽입. 다운로드=현재 목록 그대로(재업로드 가능 양식 동일).
- **UI 개편(2026-08-19, 사용자 요청 3종)**: ① title=대표 설명 한 줄 + **subtasks 컬럼 신설**(줄 단위, 표에서 기본 접힘 — '하위 업무 N개' 토글, 펼침 상태는 projState.open Set) — 기존 여러 줄 title은 첫 줄/나머지로 SQL 분리 마이그레이션(7건). 라벨 '완료 기준'→'꼭 포함할 것'(컬럼명 done_criteria 유지). ② **담당자 = 등록 사용자 셀렉트**(authApi list_users, +모두/—) — 기존 값 범준→조범준·민규→박민규·다나→김다나 SQL 매핑(23건). ③ **간트 뷰**(표/간트 토글): start_date 컬럼 신설, 막대=시작~마감(담당자 색: 조범준 보라·박민규 청록·김다나 핑크 — 회의보드 팀 색과 통일), 마감일만 있으면 마름모, 날짜 없으면 하단 '일정 미정' 칩, 오늘 빨간 선·주간 눈금, 순수 HTML/CSS. 완료 업무는 반투명.

### 대표 회의보드 (#board, 관리자 전용) — 자체 기능 (2026-08-19 iframe → 네이티브 전환)
- **`board_topics` 테이블**(db 프록시, admin 전용 — 대표끼리 서로 수정 가능이라 AUTHOR_FIELDS 미적용): title·detail(코멘트)·conclusion(결론)·status(open/discussed/resolved)·pinned·archived·author_id/author_name(로그인 계정)·discussed_at. **옛 meeting-board의 topics 데이터는 이전 안 함(사용자 결정 — 새로 시작)**, 별도 프로젝트 meeting-board(~/meeting-board, danarobe.github.io/meeting-board)는 그대로 존속.
- UI 원칙(옛 회의보드 계승): **한 줄 입력+Enter 등록** · **작성자별 그룹(본인 맨 위 '(나)', 그룹 안 핀 먼저+최신순)** · 탭 5개(전체/대기/논의함/결론/보관함, 건수 표시) · 카드 클릭=펼침 → **입력란 하나가 코멘트/결론 겸용**('논의함으로'=detail 저장+discussed, '결론 저장'=conclusion 저장+resolved) + 핀/보관/복원/삭제(confirm). 결론은 초록 박스, 핀은 노란 테두리.
- 과거 이력: iframe 내장(같은 도메인이라 쿠키 문제 없음) → 네이티브 전환. meeting-board 라이트 테마 고정 이력은 그 프로젝트 CLAUDE.md 참조.

### 상품 관리 (외부 링크, 관리자+MD)
- 메뉴 '운영' 그룹의 **`menu-npm` 버튼 — 별도 프로젝트 newproduct-manager**(https://newproduct-manager.vercel.app/products)를 **새 탭으로 여는 링크일 뿐**, 이 레포에 코드 통합 아님(사용자 결정 2026-08-18 — iframe은 상대 앱 세션 쿠키 SameSite=Lax라 로그인 유지 불가, 코드 통합은 Next.js+Neon이라 재개발 수준이어서 기각). 소스는 OneDrive-개인(2)/work-manager/newproduct-manager, 로그인·배포 전부 별개.

### @멘션 알림 (2026-08-20, 전 역할)
- **댓글·코멘트에 `@이름`(등록 사용자 실명, 예: @조범준)을 쓰면 그 사용자에게 알림** — 적용처: ①광고 회의록 댓글(addNoteComment) ②대표 회의보드 코멘트·결론(boardSaveText) ③**프로젝트 관리 특이사항**(projSaveNote 인라인 + projSave 모달, 2026-08-20 추가 — 메시지에 업무명 포함) ④**광고 회의록 회의 기록 본문**(note-content, 2026-08-28 사용자 요청 — 자동완성은 작성·수정창 모두, **알림은 공유 저장(addMeetNote)·공유 전환(toggleShareNote) 시에만**: 비공개 기록은 상대가 못 봐서 미전송, 수정 저장(saveMeetNote)도 공개 여부를 몰라 미전송 — 공유 전환 때 meet-notes dataset.raw 본문으로 발송). 본인 멘션은 제외, 이름은 auth `list_names` 액션(로그인 누구나, id+name만 — list_users는 admin 전용이라 별도 신설)으로 대조. **전송 시 보낸 사람에게 "○○님에게 알림을 보냈습니다" 토스트**(전송 여부 피드백). 저장할 때마다 @가 있으면 재전송됨(변경 비교 안 함 — 단순성 우선).
- `notifications` 테이블(admin+staff+cs): user_id(수신자)·actor_name·message(80자 발췌)·link_menu·read. **남을 수신자로 POST해야 해서 AUTHOR_FIELDS 미적용 — 읽기 본인 필터는 클라이언트**(내부 신뢰 전제, 비공개 회의기록과 동일 수준).
- UI: 헤더 종 아이콘+빨간 안읽음 배지, 드롭다운(클릭=읽음+해당 메뉴 이동, 모두 읽음). **상시 폴링 없음** — 로그인 시 + 메뉴 이동 시(60초 스로틀) + 종 클릭 시 조회 (성능 점검 원칙 유지).
- **웹 푸시(휴대폰 알림, 2026-08-20)**: 멘션 전송이 dbProxy 직접 삽입 → **`notify` 엣지 함수**로 변경(앱 내 알림 저장 + 구독 기기 웹 푸시 발송 일괄, npm:web-push@3.6.7 — Deno에서 동작 확인). VAPID 키는 secrets(VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT), 공개키는 index.html `PUSH_PUBKEY` 상수. `push_subscriptions` 테이블(endpoint PK, AUTHOR_FIELDS user_id — 본인 것만). 만료 구독(404/410) 자동 삭제. **레포 루트 `sw.js`(서비스 워커)+`manifest.json`** — 종 드롭다운 하단 '휴대폰 알림 켜기/끄기'(기기별). **아이폰은 Safari 공유→홈 화면에 추가 후 그 앱에서만 켜기 가능**(iOS 정책), 안드로이드는 브라우저에서 바로 됨. 실기기 푸시 수신은 사용자 검증 필요(개발 환경은 알림 권한 차단이라 서버 경로·상태 분기까지만 검증).
- **알림함 정리(2026-08-20)**: 기본 화면 = **안 읽은 알림만**. '모두 읽음' 후 목록에서 사라지고, 헤더의 **'읽은 알림 N'** 클릭 → 읽은 목록 별도 보기('새 알림으로' 복귀). 최근 30건 보관.
- **드롭다운은 body 직속 `position:fixed`**(2026-08-20 — 헤더 안에 두면 모바일에서 잘림): notifToggle이 종 버튼 rect 기준으로 배치, **≤480px이면 left/right 10px 화면 폭 맞춤**, maxHeight=뷰포트 잔여. 바깥 클릭 닫기는 드롭다운·종 둘 다 제외하고 판정.
- **@ 자동완성(2026-08-20)**: `.mention-field` 클래스가 붙은 입력란(위 적용처 4곳)에서 @ 입력 시 사용자 목록 드롭다운(`#mention-drop`, **body 직속 — 섹션·헤더 안은 blur 조상 때문에 fixed 기준 깨짐**). 입력란이 동적 생성이라 **document 위임**(input/keydown capture/focusout). ↑↓+Enter/Tab 또는 클릭으로 선택, **드롭다운 열림 중 Enter는 capture에서 가로채 이름 삽입만**(댓글 등록·특이사항 저장으로 안 샘 — 닫힌 뒤 Enter는 정상 동작 검증됨). @ 앞은 문두·공백·구두점일 때만 발동, 조각 12자 초과·공백 포함 시 해제.

### 직원 구매요청 (#purch, 2026-08-31 사용자 요청 — 전 역할, CS·물류팀도)
- 직원이 물품 요청서를 올리면 대표가 보고 주문하는 흐름. 항목: 주문요청일/주문자(로그인 자동)/거래처/사입명/옵션/수량/가격(VAT 10% 포함)/입금여부/상태.
- **상태 4종(2026-09-01 사용자 지정 — 처음 3종에서 주문완료 추가)**: `pending`(대기 — 등록 직후)/`need_order`(주문필요)/`ordered`(주문완료 — 주문 넣고 입고 대기, 파랑)/`released`(불출(재고반영)완료). 필터 탭 5종(전체+4상태). DB CHECK 제약도 갱신됨.
- **주문완료 알림(2026-09-01b)**: 상태를 `ordered`로 바꾸면 **요청 직원에게 notify 함수로 앱 알림+웹 푸시**(link_menu=purch, 본인 요청을 본인이 바꾼 경우 제외, 알림 실패해도 상태 변경은 성립). purchPatch가 성공 여부를 반환하게 바뀜 — 실패 시 미발송. 검증: 관리자 변경 → 요청자 알림 행 생성(발신자·메시지·링크 정확).
- **권한(서버 db 프록시 커스텀 규칙이 강제)**: 등록=전원(본인 명의 강제) · **상태·입금 확정 변경=admin+`purchase_managers` 등재 직원만**(관리자가 메뉴 안 '상태 변경 담당자' 칩 패널에서 지정 — admin 전용 쓰기) · 비담당의 PATCH는 본인 행+내용 필드만(상태·확인·입금 확정 필드 오면 403) · 삭제=본인+admin · **확인 버튼=admin 전용**(confirmed_by/at에 이름 기록, 초록 체크로 표시).
- **입금 3단계(2026-08-31b 사용자 요청)**: 미입금 → **입금완료/확인요청**(`paid_req`/`paid_req_by` — **요청자 본인이 본인 행에 표기**, 노란 배지·표기 취소 가능, 서버 allowed 필드에 포함) → **입금완료**(`paid` — 담당자·관리자만 체크 확정). 담당자 화면엔 확인요청이 노란 글씨로 요청자 이름과 함께 표시. 검증: 본인 표기 204·타인 행 표기 0행·본인 paid 확정 403.
- 테이블 `purchase_requests`(uuid PK)·`purchase_managers`(user_id PK) — db 프록시 전 역할 열람. 메뉴 노출은 'my' 패턴(협업 그룹, CS 예외 3곳: updateAuthUI·showMenu 리디렉션·MENU_KEYS). 모바일은 요청일/사입명/수량/가격/입금/상태만.
- 검증(2026-08-31, admin/staff/cs 3계정): 서버 규칙 10항목(본인 명의 강제 400·비담당 상태변경 403·본인 내용수정 204·담당 지정 후 204·CS 담당지정 403·남 삭제 403 등) + UI(관리자 셀렉트·담당자 패널/비담당 배지·비활성 체크·본인 삭제) + 모바일 375px 넘침 0. 테스트 데이터 정리 완료.

### 광고 회의록 (#meet, 관리자+MD)
- 회의 안건(ad_meeting_topics) + 일자별 회의 기록(ad_meeting_notes, 계정별 작성, 공유 토글). 공유 글에 **댓글·좋아요**(본인만 수정·삭제, 서버 강제).
- **관리자는 남의 공유 기록도 수정 가능(2026-08-28 사용자 요청)**: db 프록시 AUTHOR_FIELDS 검사에 `ad_meeting_notes + PATCH + admin` 예외(삭제·공유 토글은 계속 본인만). 관리자가 남의 글을 고치면 **`edited_by_name` 컬럼(신설)에 이름을 남겨 카드에 '✎ ○○ 수정' 배지** 표시, 작성자 본인이 다시 고치면 배지 해제(null). saveMeetNote/editMeetNote가 `mine` 플래그로 분기 — 본인 글은 기존대로 author 필터, 남의 글은 무필터(admin만 서버 통과). 검증: 관리자 수정 200+배지, MD 무필터 403, 작성자 재수정 시 배지 해제, UI에서 남의 공유 글에 수정 버튼만(공유 해제·삭제 없음).
- **댓글 여러 줄 입력(2026-08-18)**: 입력창은 자동 높이 textarea(최대 140px, 넘으면 스크롤). **Enter=등록, Shift+Enter=줄바꿈**(메신저 방식, placeholder에 안내). 표시는 기존 `white-space:pre-wrap`이라 변경 없음.

---

## 6. 외부 연동 상수·계정

- **카페24**: 몰ID `wnqka5000`, API 버전 **2026-03-01**(2025-06-01 거부). categories/{no}/products는 display_group=1 필수. 애널리틱스 ca-api.cafe24data.com, scope에 read_analytics.
- **카페24 주문 조회 3대 제약 (2026-08-07 실측, 어기면 422)**
  1. **offset < 15,000** — `"[Start location of list] must be less than 15000"`. 한 달 분석도 패딩 포함 16,321건이라 걸린다.
  2. **조회 기간 ≤ 3개월** — `"date range ... should be within 3 months"`.
  1-1. **부분배송 주문은 배송종료일이 여러 개라 여러 날짜 조각에 중복으로 잡힌다** (2026-08-08 발견). 조각 나누기를 도입한 뒤 생긴 문제 — 7월 netreturns가 18,441이어야 하는데 19,183(+4%)으로 부풀었다. `eachOrder`/`eachClaimOrder`가 **주문번호 Set으로 중복 제거**한다. 페이지 끝 판정(`length < PAGE`)은 **걸러내기 전 길이**로 해야 한다.
  2-1. **요청 한도 429** — `"Too much requests occur. (40/40)"`. 앱 단위 버킷이라 **홈 '카페24 불러오기'처럼 여러 조회가 겹치면 바로 걸린다**(실측: 동시 처리 3으로 뒀더니 홈 3개월에서 429). 대응: `apiGet`/`cafe24Get`에 **429 재시도 6회**(Retry-After 우선, 없으면 1→2→4→8초 백오프) + 조회당 동시 요청 수 `CHUNK_CONCURRENCY = 2`.
  3. `/admin/orders/count`에 **`fields`·`embed`를 넘기면 `{count:N}` 대신 `[]`가 올 때가 있다** → 건수를 0으로 읽어 조회가 통째로 비는 사고 발생. count에는 `date_type`·`order_status`만 넘길 것.
  - 그 외: `/admin/products`는 limit 최대 100, `date_type`의 결제일 값은 `pay_date`, `order_status`는 **콤마 다중 지정 가능**(`R40,R30,R34`).
- **대응 = 조각내어 훑기**: 기간을 80일 이하로 미리 자르고(3개월 제한), `/count`로 조각별 건수를 재서 15,000을 넘으면 반으로 쪼갠 뒤, 조각마다 offset을 0부터 다시 세며 3개씩 동시 처리한다. 건수를 못 읽으면(-1) 쪼개지 않고 통째로 읽어 **빈 결과로 끝나지 않게** 방어.
  - cafe24-analytics `eachOrder()` — netreturns·displaymetrics·returnreasons·paiditems·performance(취소반품 스캔)
  - cafe24-claims `eachClaimOrder()` (2026-08-07) — 같은 방식. 이 함수는 `embed=items,cancellation,return`이 무거워 **limit은 100 유지**(limit 500이면 페이지당 8.9MB)하고, 주문을 모으지 않고 **페이지마다 즉시 집계**한다(예전처럼 전부 모으면 3개월치가 100MB를 넘겨 메모리가 터진다). 안 쓰이던 `Bucket.orders` 누적도 제거. `raw=1` 디버그 모드는 조각 나누기 없이 첫 페이지만 반환.
  - 실측 효과: 취소&반품 7월 한 달 **23초 → 5초**(동시 처리), 6개월(2/1~8/7) 12,961건도 65초에 완주 — 독립 count 합계와 정확히 일치(누락·중복 0).
- **Meta**: 광고계정 343611764656087, 비즈니스 Onniverse, 앱 1005085742525912. Graph v23.0.
- **네이버**: 이 몰 주문은 네이버페이 주문형(카페24 결제) — 공개 API 없음, **CSV 업로드가 유일**. 스마트스토어 없음. Fixie 고정IP 프록시(52.87.82.133/52.5.155.132) 미사용(스마트스토어 열면 재활용).
- **근무관리(work-manager)**: 별도 프로젝트, 로컬 Express :3001, `/api/salary/all?year&month` 응답의 totalPay 합계.

## 7. 검증된 기준값 (실측)

- 7월 순반품률 전사 ~11~12%. 반품 사유(811건): 변심 58.9%·불만족 35.9%·불량 4.8%·배송오류 0.2%.
- 반품 건당 2,000원 / 포장물류 900원(주문당 평균 1.70개, 무료배송 44.3%).
- 8/1~3 Meta 실측: Meta ROAS 5.46·카페24 ROAS 6.09 (광고비·구매 절대액은 공개 문서에 기재 금지).
- 배송정책: 배송비 3,000(7만↑ 무료), 교환·전체반품 왕복 6,000, 부분반품 잔여 7만 기준 3,000/6,000.

## 7-1. 반품 관리 메뉴 `#rwatch` (2026-08-08, 관리자 + MD)

목적: 잘 팔리는데 반품이 많은 상품을 잡아 대응하고, '관리 상품'으로 모아 추적.

- 순반품률 = **R00(반품신청)·R10(반품접수) 포함** (2026-08-09부터 netreturns도 같은 기준으로 통일 — 두 메뉴 수치가 같은 창이면 완전히 일치해야 정상. 진열 displaymetrics만 R30/R34/R40 유지).
- **모바일(≤700px)**: `.rw-hm` 열(순위·결제수량·30일·위험사유·지정자) 숨김 → 상품명·7일·14일·관리만 표시, 상세 모달 창 타일은 `.rw-win-grid` 2×2. 전역 "인라인 grid 1열 강제" 규칙에 안 걸리게 **클래스 기반**으로 뺐음.
  - 근거(실측): 상태는 품목당 하나뿐이라 신청·접수를 더해도 **중복 집계 불가**. 데이터에 존재하는 R 코드는 R00/R10/R30/R34/R40 **5개뿐**이고, 반품 신청 이력 2,730건 중 **철회·반려 0건**.
  - 효과: 오래된 기간은 거의 동일(7월 +0.04%p), 최근일수록 크게 보정(최근 7일 +2.43%p).
- **기준일은 오늘 −4일이 기본값**(2026-08-10 사용자 결정, 기존 −7일에서 변경 — 프리셋 칩 4/7/14일 전, 경고는 4일 미만일 때). 반품 신청은 배송완료 후 0~5일에 걸쳐 들어오고(당일 51%·3일 90%·5일 99%) 승인·수거가 더 걸려서, **오늘 날짜로 보면 실제의 절반 이하**로 나온다(실측: 오늘까지 7일 4.97% vs 확정 ~12%). 5일 이내 기준일을 고르면 빨간 경고 표시.
- 액션 `returnwatch&end_date&top&risk&min_qty`: ① 애널리틱스로 7일·14일 결제수량 상위 N(기본 30) **합집합** ② **30일 창 패딩 범위를 한 번만 훑어** delivered_date로 잘라 7/14/21/30일 4개 창을 동시 생성(창마다 따로 조회하면 123초 → 한 번이면 ~30초, 4개 창 수치 개별 호출과 완전 일치 검증). 응답은 상위 상품만 담아 ~46KB.
- 위험 판정 = 순반품률 ≥ risk(기본 20%) **AND 배송완료 ≥ min_qty(기본 10)**. 소표본은 '보류' 표시 — 실측상 7일 옵션 위험 7건 중 4건이 "1개 팔려 1개 반품" 같은 요행이었다. 판정 창은 **순위에 든 창**(7일 상위면 7일 기준).
- 상품명 클릭 → 4개 창 타일 + **옵션별 4개 창** 표 + **반품 사유 TOP5**(2026-08-09 추가 — 30일 창 기준, 판매 성과의 `rrBuildHtml` 공용 렌더러 재사용, `rrEnsure` 캐시 공유라 두 번째 클릭부터 즉시). 비동기 로딩 중 다른 상품을 열면 `rwState.detailNo` 가드로 덮어쓰기 방지. 검증: 30일 창 반품 수량과 사유 건수 일치(16=16).
- `return_watch` 테이블(admin+staff, db 프록시): product_no(PK)·product_name·reason·**watch_rate/watch_qty(지정 시점 수치)**·created_by·created_at. 탭 3개(위험/전체/⭐관리 상품). 해제는 행 삭제.
- **지정 사유 편집(2026-08-18)**: 관리 상품 표 '관리' 열의 **수정** 버튼 → 사유 칸이 그 자리에서 textarea로 전환(기존 사유는 `value`로 프리필 — innerHTML 금지), 저장=PATCH reason만 / 취소=원복. watch_rate·created_by는 지정 시점 기록이라 안 건드림. admin+staff 둘 다 가능(기존 프록시 권한 그대로).
- **명단 즉시 표시 + 기본 탭 = 관리 상품(2026-08-21)**: 메뉴 진입 시 관리 상품 탭이 기본, **상품명 명단은 조회 없이 DB에서 바로 표시**(순반품률 칸만 '—' → 자동 조회 완료 시 채움). rwInit이 rwLoadWatch 후 무조건 재렌더(예전엔 rwState.data 있을 때만이라 명단이 안 떴음). 탭 라벨에 건수 표시.
- **위험·전체 표 '상태' 열(2026-08-21)**: 위험 사유와 관리 사이 — 관리중(초록)/판매중단(회색)/—. **데스크톱=별도 열(rw-hm), 모바일=상품명 아래 미니 배지(.rw-hs, ≤700px에서만 표시)** — 열을 그냥 추가하면 모바일 40px 넘침이라 이원화. 검증: 아뜰리에(중단) 배지 양쪽 표기, 모바일 304/312px.
- **판매 중단 탭(2026-08-21)**: return_watch에 `discontinued` boolean 추가. 관리 상품 행 '중단' 버튼(confirm) → 판매 중단 탭으로 이동(복원·해제 버튼), 데이터는 보존·플래그만. rwRenderWatch(mode)가 watch/stopped 공용, extra 파라미터는 중단 상품도 포함(순반품률 계속 계산됨).
- **관리 상품 탭 자동 조회(2026-08-18)**: 탭 클릭 시 데이터 없으면 `rwAutoFetch()`가 기준일 기본값(오늘−4)으로 rwFetch 자동 실행(중복 방지 `rwFetching` 플래그). 로딩 중 스피너 안내, 실패 시 재시도 안내로 교체. 서버 10분 캐시 덕에 최근 조회 있으면 즉시.
- **관리 상품 탭 = 위험 탭과 같은 7/14/30일 순반품률 표시(2026-08-18)**: 지정 시점 수치 열 삭제(watch_rate 컬럼은 DB에 보존만). 조회 시 `returnwatch`에 **`extra`=관리 상품 번호 목록**을 넘겨 상위 N 밖 상품도 창 집계에 포함(서버는 target에 합치기만 — 스캔 비용 동일, 최대 200개). **extras는 rank7/rank14=0 → 위험·전체 탭과 요약 타일은 `rank7||rank14` 필터로 제외**(관리 탭 전용). 조회 전에는 '—'+안내 문구, 조회 후 상품명 클릭=기존 상세 모달. 검증: 상위 30위 밖 관리 상품(2396 페이브 요루)도 7/14/30일 수치 정상, 전체 탭 오염 0.

## 7-1-b. 월별 추이 패널 — 판매 성과 최상단 + 홈 하단 (2026-08-09)

판매 성과 최상단·홈(사유 TOP3 아래) 두 곳(CS 제외)에 **직전 3개 완결 월**(조회 월 기준 자동 — 8월→5·6·7월, 9월→6·7·8월)의 순반품률/평균 마진율/취소반품률 — Chart.js 선그래프 + 값·전월 대비 표.
- 렌더러는 `ptRenderTo(prefix,…)` 하나로 홈(`home-`)·판매성과(`perf-`) 공용, 차트 인스턴스는 `ptCharts[prefix]`. **숨은 섹션의 캔버스에 그리면 폭 0으로 깨지므로**, 수집 후엔 보이는 섹션에만 그리고 다른 메뉴는 진입 시 `ptInitPanel`이 다시 그린다.
- 데이터: 월별 `performance`(마진 가중평균·취소반품률=Σcancel÷Σpaid) + `netreturns`(순반품률). **순차 실행**(429 예방). 최초 수집 ~4분, 이후 localStorage.
- **완결 월은 수치가 불변이라 localStorage 영구 저장**(`dnrb_trend_v2_YYYY-MM`) — 단 **월말+10일 전이면 반품 미성숙이라 저장 안 함**(예: 8/9에 7월은 계산만, 8/10부터 저장). v2 = 신청·접수 포함 기준, 기준 변경 시 버전 올려 무효화.
- 검증: 7월 순반품률 12.8% = 독립 실측 12.80% 일치. 5월 12.8/48.7/20.2, 6월 11.4/49.1/17.6.

## 7-2. UI/UX 개편 (2026-08-09, 사용자 요청 6종 + 글래스모피즘)

1. **서버 결과 캐시 10분** — `api_cache` 테이블(RLS, service_role 전용) + `_shared/util.ts`의 `cacheGet/cacheSet`. 무거운 액션만: netreturns·performance·returnwatch·paiditems·displaymetrics·returnreasons·cafe24-claims. **캐시 조회는 각 액션의 권한 검사 뒤에** 해야 함(권한 우회 방지). performance는 역할별 응답이 달라 **키에 role 포함**. `nocache=1`로 우회 가능. 실측: netreturns 47초→0.4초, claims 8초→0.4초.
2. **조회 버튼 경과초 표시** — `btnBusy(btn,라벨)/btnIdle(btn,html)`. 적용: 홈·취소반품·판매성과·반품관리·진열·재고대조·순익 수집. ⚠ **같은 버튼에 busy가 겹치면 기존 타이머를 먼저 clear**(2026-08-28 수정 — 광고관리자처럼 여러 조회가 한 버튼을 공유할 때 Map 덮어쓰기로 첫 타이머가 영영 남아 'N초' 무한 카운팅되던 실사례).
3. **메뉴 그룹화** — `.menu-group` 라벨(분석/운영/경영/협업). updateAuthUI 끝에서 **그룹 내 보이는 버튼이 없으면 라벨도 숨김**(CS는 '분석' 하나만 남는 것 확인). 900px↓ 가로 메뉴에선 라벨 숨김.
4. **모바일 열 숨김 공용 클래스 `.m-hide`**(≤700px) — 판매 성과(상품명·순판매량·순반품률·마진율만)·상품 분석(상품·조회수·판매수량·주문율만). 반품 관리는 `.rw-hm`, 진열은 `.dcol` 별도.
5. **기간 프리셋 칩 `.qp`** — `qPeriod(sId,eId,'7d|14d|30d|lastm')`·`qDate(id,daysAgo)`. 홈·취소반품·상품분석·판매성과 + 반품관리(7일 전/14일 전). '지난달'은 **정오 기준 Date 생성**(UTC 변환으로 하루 밀림 방지).
6. **홈 바로가기 타일** — `renderHomeShortcuts()`, 역할별 표시, 반품 관리 타일엔 관리 상품 개수 비동기 표시.
7. **글래스모피즘**(사용자 제공 시안) — 기존 규칙 **뒤에 덮어쓰는 CSS 블록 하나**로만 구현(마크업·레이아웃 불변). 헤더가 어두운 남색→밝은 유리로 바뀌면서 h1/user-info 글자색도 함께 교체됨.

## 7-3. 디자인 정돈 (2026-08-09 — "AI 티 제거", 사용자 요청 전면 진행)

"AI가 만든 느낌"의 원인을 실측(이모지 336개/73종, 글자 크기 37종, 색 106종, 그라데이션 23곳)하고 정리:
1. **이모지 전면 제거(336→0)** — 메뉴·섹션 제목·업로드 카드·홈 바로가기는 Font Awesome로 대체, 나머지는 삭제. **유지 글리프: → ← ↔ ↓ ✕**(닫기 버튼 ✕=U+2715는 스트립 범위에서 제외해야 함). 의미 있던 것들 대체: 좋아요 ❤️/🤍→fa-heart solid/regular, 댓글→fa-comment, 홈 수집 칩 ✅/⬜→fa-circle-check/fa-circle, 메달→순위 숫자 배지, 관리상품 ⭐→fa-star. **주의: 문장 안 이모지를 지우면 문장이 깨질 수 있음**(실사례 "3개가 모두 ✅여야"→"수집돼야"로 재작성).
2. **그라데이션 전멸(23→0, body 배경 제외)** + 보라(#8b5cf6/#7c3aed)→**인디고 #4f46e5 단일 포인트**. 상태색은 빨강/주황/초록 유지.
3. **글자 크기 37→6단계**(.7/.75/.82/.88/1/1.15rem, 1.2rem+ 디스플레이용은 유지) — 정규식 버킷 매핑.
4. **글래스 강도 하향**: 카드 rgba(255,255,255,.95)+테두리 #e7e8ee+그림자 1단계, 모달 .98 불투명, 메뉴 흰색 무블러, 배경 그라데이션 채도 낮춤. **⚠ .section-card에 backdrop-filter 금지**(2026-08-10 실사례): 조상에 blur가 있으면 그 안의 `position:fixed` 팝업 기준이 화면이 아니라 카드가 되어, 384행 표에서 팝업이 카드 한가운데(화면 밖)에 떴다. 같은 이유로 **meta-preview-modal은 로드 시 body 직속으로 이동**(z 220) — 섹션 안에 두면 다른 메뉴(판매 성과 ON 광고)에서 열 때 숨은 섹션에 같이 가려진다.
5. 긴 안내 문구 축약(홈·반품관리·진열 인트로).
- 전부 **파이썬 일괄 치환(count assert)** 으로 수행 — 개별 손 수정 금지 수준의 분량. 검증: 화면 잔여 이모지 0, 12개 메뉴 순회 예외 0, 판매 성과 306상품·사유 모달 정상, 콘솔 오류 0.

## 7-4-b. 모바일 전폭 맞춤 (2026-08-20 — "축소해야 보임" 종결)

- **근본 원인**: ≤900px에서 .layout이 세로 flex로 바뀌는데 ① 데스크톱의 `align-items:flex-start` ② `.container`의 `margin:0 auto`(가로 auto 마진)가 남아 **stretch가 무효화** → 본문 폭 = 내용물 최대 폭(700~900px)이 되어 화면을 넘음. 수정: 미디어 블록에서 `.layout{align-items:stretch}` + `.layout .container{margin:0;width:100%}`.
- 보조 규칙(≤700px): body overflow-x hidden(최후 방어) · 섹션 내 div/입력/셀렉트 max-width 100%·min-width 0(!important — 인라인 min-width 셀렉트 제압) · **인라인 `display:flex` 행 일괄 flex-wrap** · section-header 줄바꿈 · canvas max-width. 표는 기존 .table-wrap 가로 스크롤 그대로.
- **전 메뉴 표 모바일 정리(2026-08-20 사용자 요청 — 데이터 포함 실측 검증)**: ≤900px 전역 — th/td padding 8/5px·폰트 축소, **왼쪽 정렬(텍스트) 셀 줄바꿈 허용 + 인라인 min-width 120px로 제압**(이름·광고명 열이 nowrap/min-width로 표를 밀던 것), 셀 안 flex 버튼 줄바꿈, name-cell max 150px. 개별: **판매성과** ON광고 열+헤더 긴 부연라벨 m-hide(모바일 = 상품명·순판매량·순반품률·마진율) / **광고효율 소재 표 2곳** 순위·광고명·지출·ROAS만 / **직원관리** 등록일 숨김+아이디 줄바꿈+버튼 세로 / **안정재고 2표** 상품명·옵션·추천(+차이)만 / **반품관리 관리탭** 상품명·14일·사유·관리(버튼 세로, rw-actions). 검증(375px iframe, 실데이터): perf 370·an 367·users 304·rwatch 위험 304·관리 344·proj 320 — 전부 화면 내. 숨긴 값은 데스크톱/상세 모달에서 그대로.
- **프로젝트 표 모바일 4열(2026-08-20 사용자 요청)**: ≤900px에서 `.pj-hm`(꼭포함할것·우선순위·특이사항) 숨김 → **업무·담당자·마감일·상태만**. 마감일은 m-hide에서 승격(항상 표시 — 인라인 수정 많이 씀). 업무 셀 `.pj-title`: min-width 190→110 + **white-space normal**(기본 td nowrap이 제목을 262px로 늘리던 게 잘림의 주범) + 셀 padding 8/6px. 검증: 375px에서 표 폭 320px, 간트 뷰도 화면 내.
- **검증법 주의**: 이 세션의 브라우저 페인 뷰포트 에뮬레이션이 불안정(호출 간 innerWidth 375→409→763 요동, rect 단위 뒤섞임) → **페이지 안에 375px iframe을 만들어 그 안에서 측정**하는 방식이 신뢰됨(미디어쿼리는 iframe 뷰포트 기준). 최종: 13개 메뉴 전부 넘침 0px, container=viewport 일치.
- ⚠ 이 과정에서 `</style>` 닫는 태그를 누락해 스크립트 전체가 죽는 사고 1회(즉시 복구) — **style 블록 편집 후 페이지 로드 확인 필수**.

## 7-4-c. UI 접근성·타이포 전수 점검 (2026-09-02 — jakubkrehel better-* 스킬 기준, 사용자 요청)

적용된 전역 수정 (스타일 블록 끝 "UI 전수 점검" 주석 참조):
1. **`:focus-visible` 인디고 2px 링(!important)** — 인라인 outline:none 58곳 때문에 키보드 포커스가 안 보이던 것 복원 (마우스 클릭엔 안 뜸, Tab 실측 검증).
2. **`table { font-variant-numeric: tabular-nums }`** — 표 숫자 자릿수 흔들림 방지.
3. **`prefers-reduced-motion: reduce` 전역 감속** — 시스템 '동작 줄이기' 존중 (스피너도 멈추지만 '불러오는 중' 텍스트가 항상 동반).
4. **≤700px에서 input/select/textarea 16px 강제** — iOS 사파리 입력 탭 시 화면 확대 방지 (모바일 입력이 약간 커짐 — 의도).
5. **회색 텍스트 대비 상향(토큰성 일괄 치환)**: 캡션 `color:#9ca3af`(2.54:1, AA 실패) → `#6b7280`(4.83:1) 247곳, 최하위 장식 `#c4c9d4`(1.66:1) → `#9ca3af` 23곳(장식 '—' 전용 — 의미 있는 텍스트에 쓰지 말 것). **새 회색 위계: 본문 #4b5563 / 캡션 #6b7280 / 장식 #9ca3af 3단계.**
6. **ESC 전역 핸들러** — `[id$="-modal"]` 열린 오버레이·모바일 서랍을 ESC로 닫음 (IME 조합 중 제외).
7. 로그인 입력 2곳·종 버튼에 aria-label (placeholder는 라벨이 아님).

**보고만 하고 남긴 것**: ①(HIGH·시스템적) `<span/div/tr onclick>` 클릭 요소 다수가 키보드로 도달 불가 — 전면 수정은 별도 작업(버튼화 or tabindex+키핸들러), 사용자 승인 대기 ②(MEDIUM) `transition: all` 10곳 — 속성 명시 권장 ③(MEDIUM) 모달에 포커스 트랩/inert 없음 ④(LOW) 장식 회색은 여전히 AA 미만(장식이라 허용). 검증: Tab 포커스 링 실측·320px 홈/구매요청 넘침 0·모바일 입력 16px·ESC 닫기·화면 톤 유지.

## 7-4. 성능 점검 (2026-08-19 전수 점검 — 기능 무변경 원칙)

- **Pretendard 구글폰트 링크 제거**: 구글 폰트에 없는 서체라 매 접속 로드 실패(콘솔 오류 4개) + **실패하는 CSS 링크는 첫 페인트를 블로킹**. 대체 서체 목록이 동일 적용되므로 화면 변화 없음. 다시 넣으려면 jsdelivr의 pretendard 패키지 CSS 사용할 것.
- **preconnect 추가**: cdn.jsdelivr.net(FA·Chart.js·xlsx-populate) + Supabase 호스트.
- **진열 설정 패널 디바운스**: `dcfg-*` 20개 입력의 oninput이 키 입력마다 dispRender(384행 재계산·재렌더)를 불러 타이핑 렉 → `dispRenderSoon()`(250ms 디바운스)으로 교체. 체크박스(onchange)는 즉시 유지.
- 점검 결과 건강한 것들(건드리지 말 것): Chart.js 인스턴스 destroy 전부 처리됨(meta/pt/perf/cr), btnBusy 타이머 btnIdle에서 clear, 큰 표는 innerHTML 통짜 생성(빠름), 상시 타이머 없음. 검증: 14개 메뉴 전 순회 JS 오류 0·콘솔 오류 0, 디바운스 연속 5입력→렌더 1회.

## 7-5. 근무 관리 `#wm` — 근무관리 시스템 이전 (2026-08-26 시작, 진행 중)

매장 근무관리 시스템(출퇴근·급여·연차, 소스 `~/Library/CloudStorage/OneDrive-개인(2)/work-manager`)을 OneDrive JSON 동기화에서 이 Supabase로 옮기고 관리 화면을 대시보드 메뉴로 통합하는 작업. **전체 계획서: `~/.claude/plans/shiny-wondering-badger.md` — 이어서 작업할 때 먼저 읽을 것.**

**사용자가 못 박은 3가지 (절대 훼손 금지)**
1. **키오스크는 6번 터치 그대로** — 이름 탭 → PIN 4자리(4번째에 자동 진행) → 출근/퇴근. 직원 로그인 없음. 이 간편함이 시스템의 핵심 가치다.
2. **매장에서만 출퇴근 등록 가능** — 실제 출근하지 않고 집에서 누르는 걸 막아야 함(사용자 명시 요구). 기기 토큰(등록된 매장 PC만) + 매장 IP 확인 두 겹.
3. **급여 1원도 달라지면 안 됨** — 실제 지급에 쓰인다.

**진행 상황**
- ✅ 1단계: `wm_*` 테이블 생성, 1,082행 이관(전 행·전 필드 대조 통과), `wm-admin` 배포, 급여 대조 39개 직원-월 완전 일치(월 총액 3개월분 1원 단위 일치 — 실제 금액은 공개 문서에 기재 금지)
- ✅ 2단계: `#wm` 메뉴(관리자 전용) — 출퇴근 조회·급여 계산 탭 + 명세서 모달. `fetchLaborFromWM()`이 **localhost:3001 → `wm-admin` labor_total**으로 교체됨. 사용자가 8월 대시보드 급여 = 실제 이체 금액 일치 확인함 (2026-08-27).
- ✅ 3단계 관리 쓰기 (2026-08-27): 탭 5개(출퇴근/급여/휴가/직원/공휴일). **관리자 수정의 원본은 이제 대시보드.** 기존 Express는 `WM_READONLY=1`(시작 스크립트에 반영)로 관리 쓰기 403 — 키오스크 경로(출퇴근 체크·PIN·휴가/수정 신청)만 열림. 검증 23항목 통과(부분수정 필드보존·PIN·수동등록·기간휴가·승인/반려·비활성·edit_review 2케이스·가드 12경로·동기화 비덮어쓰기).
- ✅ 5단계 키오스크 (2026-08-27): `kiosk.html`(Kiosk.jsx 이식, 저장소 루트) + `wm-kiosk` 함수. **API 30항목 + 브라우저 6터치 완주 검증 통과.** 프로덕션 주소: `https://danarobe.github.io/dnrb-dashboard/kiosk.html` (배포됨).
- ✅ 사용자 발견 문제 2건 수정 (69b0e19): ① 직원 잔여 연차 표시 — employee_list에 `annual_used`(기존 leaves.js /remaining 규칙 재현: 여름휴가 type·'하계/여름휴가' 사유 미차감), 직원 관리 연차 열 잔여/총량(사용), 휴가 관리 탭 잔여 칩+'올해 전체 보기'(기본 이번 달 필터라 1월 내역이 안 보였음). 휴가 등록·승인·삭제 후 `wmState.emps=null`로 캐시 무효화(잔여 즉시 갱신). ② 키오스크 기기 등록 모달에 '대시보드로 이동' 버튼(등록창이 전체를 덮어 관리자 버튼 접근 불가였음). **교훈: 데이터 이관 완료 ≠ 구 화면의 파생값(잔여 연차 등) 재현 — 구 UI가 보여주던 목록 기준으로 점검.**
- ✅ 직원 계정 연동 + 키오스크 버튼 (2026-08-27 사용자 요청): ① #wm 헤더에 '키오스크 열기' 버튼(kiosk.html 새 탭 — 상대경로라 로컬/Pages 공용, 미등록 PC에선 기기 등록 화면). ② **wm_employees.app_user_id(unique) 신설 — 정직원의 원본은 대시보드 직원 관리(app_users)**: 이름 일치 6명 전원 자동 연결(백예린·조혜영은 사용자가 계정 추가 직후 연결됨). 직원 탭 '직원 추가'→'알바 추가'(**서버가 type=parttime 강제** — 직접 추가는 알바만, 사용자 지정) + '직원 연결 추가'(employee_linkable: 비관리자·미연결 계정 목록 → 선택 등록, type=employee·이름은 계정에서) + 미연결 정직원 행 '연결' 버튼(employee_link). **연결된 정직원의 이름·유형은 잠금**(employee_upsert PATCH가 서버에서 strip, 모달도 disabled) — 급여·연차·계좌·PIN은 계속 근무 관리에서. **이름 동기화는 employee_list가 lazy로**(계정 이름 변경 → 다음 목록 조회 때 wm_employees.name 갱신, 키오스크 표시도 따라감). 검증: 강제 규칙 6종(직접추가 employee 요청→parttime 강제·연결 생성·이름 변경 무시·중복 연결 거부·관리자 연결 거부·linkable 필터) + 이름 동기화 + UI 3모드 모달 전부 통과. 테스트 행 정리 시 **wm_kiosk_log FK 때문에 로그 먼저 삭제해야 함 — 주의**.
- ✅ 마이페이지 `#my` (2026-08-27 사용자 요청 — 직원 셀프서비스 1차, **알바 제외** 정직원 6명 대상): 새 서버 함수 **`wm-me`**(로그인 계정 → `wm_employees.app_user_id`로 본인 행만, 클라이언트가 employee_id를 못 정함 · 급여·계좌·시급은 응답에 미포함). 메뉴는 '내 정보' 그룹으로 **로그인한 전원에게 표시**(CS·물류팀도 — `updateAuthUI`의 CS 전용 숨김과 `showMenu`의 `isCS()→perf` 강제 리디렉션 두 곳 모두 'my' 예외 처리 필요했음).
  - **서류 발급 3종(2026-08-27c 사용자 요청)**: 탭 이름 '재직증명서 발급' → **'서류 발급'**, 안에서 알약 칩으로 서류를 고른다(하위 선택은 칩 — 밑줄 탭은 화면 전환용이라는 §7-6 규칙 유지). 공용 인쇄 틀 `myDocOpen(title, docNoPrefix, inner, opt)` — A4·문서번호(`DNRB-{CERT|CAR|TRIP}-YYYYMMDD-직원ID`)·회사 정보·직인 자리 공통, `opt.stmt`로 증명 문구 교체, `opt.applicant`면 신청서형(신청자 서명란).
    - **재직증명서**: 기존과 동일(인적사항+재직기간+용도).
    - **차량 등록 요청서**: 재직증명서와 같은 양식 + **차량 번호**(필수)·차종(선택)·용도, 문구는 "위 직원은 본사에 재직 중이며, 상기 차량의 등록을 요청합니다".
    - **출장 여비 신청서**: 사내 [출장 규정] 반영 — 구분 3종(국내 숙박 10,000 / 국외 비행 10h 이하 20,000 / 국외 10h 초과 40,000, **1박당**)·출장지·목적·기간(복귀일 입력 시 **숙박 일수 자동 계산**)·비고. **초과 근로 내역 입력**(2026-08-27d 사용자 요청으로 개편 — 처음엔 '몇 시간 몇 분' 입력이었음): 행마다 **날짜 + 시작~종료 시각(time) + '식사시간 포함' 체크 + 업무 내용(비고)**. 계산 = 종료−시작(**종료가 더 이르면 자정 넘긴 야근으로 +24h**) → **식사 포함이면 60분 먼저 공제**(음수면 0) → `ceil15`로 **15분 올림**, 행 옆에 실시간 표시하고 합계. 화면 안내와 문서 적용 규정에 **'식사시간(1시간) 및 이동시간은 공제됩니다'** 명시. 문서 표 = 날짜·근로 시간(구간)·식사·실제 근로·15분 올림·업무 내용 + 합계 행. 검증: 18:00~21:03 → 3시간15분, 식사 체크 시 2시간15분, 21:00~01:00 → 4시간, 19:00~19:30+식사 → 0, 모바일 375px 넘침 0. 문서에 신청자·출장내역·출장비 산정표·초과근로표(원시/올림/합계)·적용 규정 3항 포함. 식사는 법인 카드 결제 안내. 검증: 3박×40,000=120,000원, 2시간3분→2시간15분·1시간20분→1시간30분(합 3시간45분), 3종 출력물 전 항목 확인, 필수값 누락·복귀일 역전 시 발급 차단, 모바일 375px 넘침 0.
  - **가로 탭 3개(2026-08-27b 사용자 요청 — 세로 나열에서 변경)**: `내 근무 현황` / `재직증명서 발급` / `비밀번호 변경`(MY_TABS·mySetTab, 패널 `my-pane-{work|cert|pw}`. 재조회(myLoad) 후에도 보던 탭 유지, 375px에서 탭 폭 310px로 넘침 없음).
  - 구성: ①소속 팀(역할 라벨)·입사일+근무기간 ②연차 총량/사용/잔여(+대기 일수, 진행바) ③**휴가 신청**(연차 1일·반차 0.5일, 연차는 기간 신청+주말·공휴일 제외 옵션, 반차는 기간 불가) + 내 신청 내역(대기/승인/반려 배지, 대기 건 본인 취소) ④**서류 발급**(2026-08-27b 확장 — 처음엔 재직증명서 전용 탭)(인쇄용 새 창 → 브라우저 PDF 저장, **직인은 인쇄 후 실물 날인** — 사용자 결정. 회사 정보는 `CERT_COMPANY` 상수 — **대표이사 김다나 · 사업자등록번호 545-87-03592**(2026-08-27 사용자 확인), 빈 값이면 해당 줄 자동 생략) ⑤비밀번호 변경(기존 auth `change_password` 재사용) — **대시보드 비밀번호(app_users.password_hash)와 키오스크 출퇴근 PIN(wm_employees.pin_hash)은 완전히 별개**(저장 위치·사용 시스템 모두 다름, 한쪽을 바꿔도 다른 쪽 영향 없음). 사용자 질문이 있었어 화면에도 안내 문구를 넣음.
  - 신청 규칙은 키오스크 `request_leave` 이식(항상 pending·중복 날짜 차단·최대 2개월). 신청 시 **관리자 전원에게 앱 알림**(notifications, link_menu=wm) — 알림 실패해도 신청은 성립.
  - **키오스크 신청 vs 마이페이지 신청**: 같은 `wm_leaves`에 pending으로 들어가 같은 화면에서 승인·반려되고 연차 차감·중복 차단도 공통(= 직원은 어디서 신청해도 동일). 다른 점 4가지 — ①~~관리자 알림은 마이페이지만~~ → **2026-08-27 키오스크에도 추가**(`notifyAdminsLeave`, 단일·기간 신청 양쪽. 6터치·응답 형태 불변, 알림 실패는 try로 무시). 검증: 키오스크 전 흐름(기기 페어링→PIN→신청) 실행 후 관리자 4명 전원 알림 생성 확인. ⚠ wm-kiosk는 **action을 쿼리스트링이 아니라 본문(body.action)으로 받는다** — 테스트 시 주의 ②취소는 마이페이지만 가능 ③여름휴가(summer)는 키오스크만 ④키오스크는 매장 기기+PIN, 마이페이지는 로그인만(집·휴대폰 가능).
  - **관리자 휴가 탭에 '승인 대기 N건' 배너 신설(wmLoadPendingLeaves)**: 휴가 탭 기본 필터가 '이번 달'이라 직원이 다음 달 휴가를 신청하면 관리자 화면에 안 보여 승인이 누락된다 — 월 필터와 무관하게 **올해 전체 pending을 항상 상단에 표시**하고 배너에서 바로 승인/반려. (검증 중 실제로 발견한 구멍)
  - 검증: 직원(CS) 로그인 → 메뉴 2개(판매 성과·마이페이지)만 노출 → 연차 신청 → 관리자 알림 배지 1 + 휴가 탭 배너 표시 → 승인 → 직원 화면 '승인'·잔여 15→14일, 반려 건은 미차감. 중복 신청 차단·남의 신청 취소 거부·비밀번호 변경(오답 거부→변경→새 비번 로그인)·재직증명서 항목 6종·모바일 375px 넘침 0 전부 통과. 테스트 계정·행 정리 완료(wm_kiosk_log FK 주의).
- ✅ 4단계 개인별 PIN 배포 (2026-08-26): 활성 직원 13명 **전원 pin_set_at 설정 완료**(미설정 0).
- ✅ **6단계 매장 전환 완료 (2026-08-27, 사용자 확인)**: 현장PC가 새 웹 키오스크로 가동 중(당일 clock_in/clock_out·verify_pin 기록, `wm_attendance.source='kiosk'` 유입 확인). **기존 Express/JSON 프로그램은 더 이상 사용하지 않음** → `sync.sh` 야간 동기화도 중단(더 돌릴 필요 없음. 다시 돌리면 옛 JSON 기준으로 `source='migration'` 행을 덮어쓸 수 있으니 실행 금지). #wm 상단 병행 안내 배너는 '매장 전환 완료' 문구로 교체함.
- ✅ **병가(무급) 2026-08-27**: `wm_leaves.type`에 `'sick'` 추가(CHECK 제약 갱신). 관리자는 근무 관리 → 휴가 관리 → 휴가 등록에서 병가 선택, 직원도 마이페이지에서 신청 가능(승인은 기존 흐름 동일). **표기 문구는 2026-08-30 사용자 요청으로 '병가(연차우선사용/서류제출)'로 변경(셀렉트 2곳 + 목록 라벨 '병가(무급)'→'병가') — 문구만 변경, 실제 처리(무급 공제·연차 미차감)는 그대로**(동작 변경은 급여 대조 검증이 필요해 별도 확인 대기 — '연차 우선 사용' 운영은 관리자가 연차로 따로 등록하는 방식). 급여명세서의 '병가 무급 (N일)' 공제 줄은 실동작 표기라 유지.
  - **연차 미차감**: `employee_list`/`wm-me`의 사용 연차 집계에서 summer와 함께 sick 제외. ⚠ 이 처리를 빼면 기존 식 `type==='annual' ? 1 : 0.5` 때문에 **병가가 연차 0.5일씩 깎였다**(신설 시 반드시 확인할 함정).
  - **무급 처리(급여 공제)**: 사용자 지적대로 무급이면 그날치 월급이 빠져야 한다. 종전 `calcEmployee`는 `totalPay = 월급` 고정이라 어떤 휴가도 공제하지 않았음 → **`sickDeduction = round(월급 ÷ 그 달 소정근로일수 × 병가일수)`** 신설(`workingDaysOf()` = 평일 − 공휴일, '소정근로일 기준' 일할계산). `totalPay = 월급 − sickDeduction`. **알바는 원래 출근 기록 기반이라 결근하면 시급이 안 붙어 자동 무급**(로직 변경 없음).
  - **기존 급여 불변 검증(최우선 항목)**: 병가 0건이면 공제 0이라 종전과 동일 — 실측으로 **2026-06·07 월 총액이 기록값과 1원까지 완전 일치**(사용자가 만든 '테스트용' 직원 제외 기준). 병가 2일 등록 시 '월급÷소정근로일×2' 공제가 명세서에 정확히 반영, 다른 직원 합계 변동 0.
  - 급여 명세서에 `병가 무급 (N일) / 월급 ÷ 소정근로일 N일 × N일 / -N원` 줄 표시. 라벨은 `WM_LV_TYPE.sick='병가(무급)'`.
  - **노동법 검토(사용자 질문)**: 업무 외 개인 상병 병가는 **법정 유급 의무가 없어 무급 처리 가능**(근로기준법에 병가 규정 없음, 무노동무임금). 단 ⚠①**업무상 재해(산재)는 무급 불가** — 산재보험 휴업급여(평균임금 70%)/근기법 79조 휴업보상 대상 ②**취업규칙·근로계약에 유급 병가를 정했다면 그 규정이 우선** ③연차 대체는 **근로자 본인 청구·동의** 필요(회사 일방 차감 불가) ④결근 처리 시 그 주 **주휴수당 미발생** 가능(알바는 출근 기록 기반이라 자동 반영) ⑤일할계산 방식(소정근로일/역일수/209시간)은 취업규칙에 명시해 두는 것이 안전 — 현재 구현은 **소정근로일 기준**.
- ⬜ 7단계 정리 (이관된 2026-07-20 work_minutes NULL 8건 수리 등)

**키오스크 구조 (`kiosk.html` + `wm-kiosk`):**
- **6터치 동결**: 이름 탭 → PIN 4자리(자동 진행) → 출근/퇴근. 액션 10개 동결(register_device/today/week_leaves/verify_pin/clock_in/clock_out/my_records/my_leaves/request_edit/request_leave). 기능 추가 전에 6터치를 지킬 수 있는지부터 따질 것.
- **인증 3겹**: ① 기기 토큰(localStorage `wm_kiosk_token`, 서버는 sha256만 보관, 대시보드 직원관리 탭에서 8자리 페어링 코드 발급·해지·IP 승인) ② PIN 세션 3분('wmk:' 접두 서명 — 대시보드 x-auth-token과 서명 비호환, 상호 재사용 불가 실측 확인) ③ 매장 IP(출퇴근 등록만, 등록 시 IP 자동 등재, 거부 화면에 현재 IP 표시 → 대시보드에서 원탭 승인). anon key는 인증 아님.
- **직원 ID는 세션에서만 읽는다** — 기존 Express의 "clock-in이 PIN 미검증" 보안 결함의 직접 수정. 남의 attendance_id로 수정 신청도 403.
- PIN 5회 오입력 → 5분 잠금. `today` 응답은 id/name/type/status/today_in/is_birthday만(실물 payload로 민감정보 부재 확인).
- 오프라인 큐: 출퇴근만, localStorage `wm_kiosk_queue`, request_id(UUID)로 서버 멱등(wm_kiosk_log.request_id unique — 같은 id 재전송 시 duplicate:true, 기록 1건 실측). 세션 만료 후에도 출퇴근 재전송만 24h 유예.
- 자동 갱신: today 60초/휴가 10분(모달 열림 중엔 건너뜀), **서버 날짜 기준** 자정 초기화, 연결 상태 칩, 6시간 자동 새로고침(새 배포 반영).
- ⚠️ **CORS 함정**: `x-kiosk-token` 헤더는 util.ts CORS_HEADERS에 없다 — wm-kiosk는 **자체 CORS/json/handleOptions를 내장**(util 미의존). util에 헤더를 추가하려면 전 함수 재배포가 필요하므로 이 구조를 유지할 것. (처음 브라우저 시험에서 preflight 거부로 Failed to fetch — x-auth-token 때와 동일 패턴의 재발이었음)

**3단계 병행 규칙 (split-brain 방지):**
- **id 대역 분리**: Supabase 시퀀스를 출퇴근/휴가/수정신청/공휴일 100000+, 직원 1000+로 올려둠. 기존 키오스크(JSON, ~1000 미만)와 대시보드 생성 행이 충돌하지 않는다. **증분 동기화는 setval을 건드리지 않는다(gen_migration.py delta 모드)** — 다시 낮추면 충돌 재발.
- **비덮어쓰기**: 동기화는 `source='migration'`인 출퇴근 행만 갱신(대시보드 수정 행은 `source='admin'`/`'edit_approval'`), 휴가·수정신청은 Supabase status가 `pending`일 때만 갱신 — 대시보드의 승인/거절이 JSON의 옛 pending으로 되돌아가지 않는다.
- 대시보드에서 승인한 결과는 기존 키오스크 화면에는 안 보인다(JSON은 그대로) — 6단계 전환까지 감수하는 한시적 표시 불일치.
- `edit_review` 승인은 원본 버그를 수정한 채 이식됨: 퇴근 미기입 신청 승인 시 기존 퇴근시각으로 work_minutes 재계산(원본은 null로 만들어 2026-07-20 8건의 근무시간이 사라졌다). 이관된 8건 NULL 데이터 자체는 7단계에서 별도 수리.
- `employee_upsert`는 **의도적 부분 수정**(보낸 필드만 갱신) — 기존 Express PUT의 "일부만 보내면 월급 0 초기화" 함정 제거.

**주휴수당 이월(`deferredToNext`) 검증 완료 (2026-08-26).** 처음엔 "급여일을 한 번 넘겨야 검증된다"고 봤으나 **사용자 지적대로 과거 데이터(6→7월, 7→8월)에 이미 월 경계가 있어 지금 전부 확인 가능했다.** `verify_carryover2.py` 결과: 이월 13건 전부 ①다음 달에 정확히 한 번 지급 ②이월한 달에는 0원(중복 없음) ③출퇴근 원본 '분'에서 파이썬으로 독립 재계산한 금액과 1원 단위까지 일치 ④지급된 78개 주 전체에 중복 0건 ⑤실근무 시간이 두 달로 올바르게 분할.
- ⚠️ **검증 시 `weekHoursTotal`(표시값)로 역산하지 말 것** — 소수 2자리로 반올림된 값이라 7~9원 어긋난다. 실제 계산은 반올림 전 원본 분을 쓴다. 1차 검증(`verify_carryover.py`)이 이 함정에 빠져 오탐 5건을 냈다.

**3단계 진입 전 남은 것:** 급여 수식·이월 로직은 위로 정리됐다. 남은 건 대표님이 **최근 한 달치 대시보드 숫자를 실제 이체 금액과 눈으로 대조**하는 것뿐(코드 동등성이 아니라 "기존 시스템 자체가 맞았나"를 보는 것). 한 달 기다릴 필요 없음.

**병행 기간 운영 도구** (`~/work-manager-이전백업-2026-08-26/`, 개인정보 포함이라 저장소 밖):
`sync.sh`(증분 동기화 — 점검→SQL생성→적용→대조 한 번에), `preflight.js`, `gen_migration.py`(`--delta`), `verify_migration.py`, `diff_salary.py`(기존 vs 신규 급여 대조), `verify_carryover2.py`(이월 사슬 — 원본 분으로 독립 재계산). ~~병행 기간엔 매일 밤 `sync.sh` 실행~~ → **2026-08-27 매장 전환 완료로 동기화 종료**. 이후 실행 금지(옛 JSON이 최신 데이터를 덮어쓸 위험). 도구는 이력·검증용으로만 보관.
- 검증 도구는 QA 임시 관리자 계정을 인자로 받는다: `python3 verify_carryover2.py <id> <pw> 2026-06 2026-07 2026-08` (§1의 임시계정 생성·삭제 패턴 사용).

**주의**
- 급여 SQL·데이터 SQL에는 이름·급여·계좌번호가 들어간다. **이 저장소는 공개 레포 — 절대 커밋 금지.**
- 키오스크 액션은 10개로 동결 예정(계획서 §4). 기능 추가 시 6터치를 지킬 수 있는지부터 따질 것.
- 기존 Express의 보안 결함 2건은 이전하며 고친다: ① `attendance.js:42-63`이 로그인 없는 키오스크에 **전 직원 PIN·시급·계좌를 그대로 응답** ② `attendance.js:89-125`가 **출퇴근 등록 시 PIN을 검증하지 않음**(PIN 확인이 별개 호출이라 서버가 클라이언트를 신뢰).

## 7-6. UI 정리 (2026-08-27 — 기능 무변경 원칙)

한 달 새 기능이 두 배로 늘며(30일간 커밋 122개) 화면이 어수선해져 전수 점검 후 정리. **실측 진단**: 메뉴 16개·섹션 16개·모달 12개, index.html 10,219줄, 탭 구현이 5벌로 제각각, 버튼 스타일 3종 혼재.

1. **모바일 메뉴 = 서랍(햄버거)**: ≤900px에서 메뉴가 가로 한 줄이라 **스크롤 폭 2,157px(화면 360px의 6배)** — 끝 메뉴(마이페이지·직원 관리)까지 6화면을 넘겨야 했다. 헤더 `#btn-menu`(☰) → `.side-menu`가 왼쪽에서 슬라이드(262px, `transform` 토글), `#menu-backdrop` 덮개 클릭·메뉴 선택 시 자동 닫힘(`showMenu` 진입부에서 `menuDrawer(false)`), 서랍에선 그룹 소제목(분석/운영/경영/협업/내 정보)을 되살려 길잡이로 씀. ⚠ 배경 덮개는 **`.side-menu` 바깥**에 둬야 함(안에 넣으면 서랍과 함께 밀려남 — 실수 1회).
   - ⚠ **검증 함정**: 브라우저 페인이 백그라운드면 CSS transition이 멈춰 열림 위치가 -267px로 측정된다. `menu.style.transition='none'` 후 측정할 것(정상: 열림 left=0, 닫힘 -267).
2. **공용 탭 부품 `uiTabs(containerId, defs, activeKey, onclick)`**: 광고관리자·근무관리·마이페이지·대표회의보드 4곳이 각자 밑줄 2px/2.5px·알약칩으로 달랐던 것을 밑줄형 하나로 통일(배지·아이콘 지원). **원칙: 밑줄 탭 = 화면 전환, 알약 칩(.qp 등) = 필터** — 프로젝트 카테고리·기간 프리셋은 칩 유지.
3. **홈 다이어트**: 모바일 홈 세로 **3,864px(약 10화면) → 2,448px(-37%)**. `homeFold(key)` + `hf-body-{key}`로 접기 — 급증 TOP10 기본 펼침, 조회수·주문율 TOP10/취소·반품 사유 TOP3 기본 접힘, 상태는 localStorage `dnrb_home_folds`. ⚠ **월별 추이는 접기 대상에서 제외** — 지연 로딩(불러오기 버튼) 구조라 굳이 필요 없고, 숨은 캔버스에 차트를 그리면 폭 0으로 깨지는 기존 함정(§7-1-b)을 피하기 위함.
4. **직원 정보 동선**: 근무 정보 모달(직원 관리)에 **`userDetailEdit(empId)` 딥링크 버튼** — 근무 관리 → 직원 탭 → 해당 직원 수정창까지 한 번에. "계정은 직원 관리, 급여·연차·계좌·PIN은 근무 관리" 문구 명시.
5. **용어**: 광고관리자 안에서 타일 '구매 전환값' vs 열 '전환값'으로 갈리던 것만 **'구매 전환값'으로 통일**. 광고관리자의 '지출'과 광고 효율의 '광고비'는 **의도적 차이로 판단해 유지**(광고관리자는 Meta 표기를 그대로 따르는 화면 — 사용자가 메뉴 분리도 의도라고 확인).
- **범위 밖(사용자 결정)**: 광고 효율·광고관리자 통합은 **하지 않음** — 두 메뉴 분리는 의도된 설계(2026-08-27 사용자 확인).
- 검증: 16개 메뉴 전 순회 화면 정상·JS 오류 0·콘솔 오류 0, 탭 4곳 스타일 동일(2px/800), 서랍 열림·닫힘·자동 닫힘, 홈 접기 상태 저장, 딥링크(김도희 수정창 자동 오픈), 전환값 열 정렬 정상.

## 8. 남은 일 / 미결정

### 진행 중 논의 (2026-08-28 세션 종료 시점 — 다음 세션이 이어받을 것)

> 2026-08-26~28 세션 작업분은 전부 본문 각 섹션에 상세 기록돼 있음(#admgr 탭 개편·테스트 소재·실결제 수·예산 변경/자정 예약·pa* 매칭 수정 / §7-5 마이페이지·서류 발급 3종·병가·직원 계정 연동·생일 패널 / §7-6 UI 정리). 여기는 **대기 중인 것만** 모음.

0. **[최우선 대기] 광고관리자(#admgr) 고도화 — 회의 전사 대기**: 사용자가 광고 담당 친구와의 회의 녹음 전사를 붙여넣을 예정 — 받으면 ①요구사항 목록화 ②분류(바로 가능/결정 필요/기술 제약+대안) ③공수 대비 효과 순 구현 순서 제안 → 확정 후 개발. 현재 admgr: 4탭(관리자)/테스트 소재만(MD·마케터), 예산 직접 변경+자정 예약 활성화 완료(PIN·상한 30만).
1. **[사용자 확인 대기] 잔여 질문들** (답 오면 처리):
   - `sync.sh` 야간 자동 실행이 걸려 있는지 — **걸려 있으면 반드시 꺼야 함**(매장 전환 완료로 실행 금지, §7-5. 어디에 설정했는지 사용자에게 물어둔 상태).
   - 사용자가 만든 **'테스트용' 계정(id `test`, staff) + wm_employees 1010(테스트용 월급 입력됨, 계정 연결됨)** — 삭제 여부. ⚠ 지우기 전까지 **월 급여 합계에 테스트 월급이 섞임**(급여 대조 시 '테스트용' 제외하고 볼 것).
   - 테스트 소재 관리 기능(목록 제거·추가소재권장·메모)을 MD·마케터에게 열어둔 것 유지 여부(현재 열림).
   - 출장 여비: **당일 출장(0박)** 지급 규칙 있는지(현재 1박당 단가라 0박=0원).
   - 병가 일할계산이 **소정근로일 기준**인데 취업규칙 명시 방식과 일치하는지(노무사 확인 권고 전달함).
2. **FLOW 대체 논의(2026-08-24)**: 프로젝트·업무·알림은 대시보드 흡수 가능(권고), 채팅은 카톡 유지 권고. 사용자 결정 대기.
3. 프로젝트 관리 메뉴를 직원에게 열지(참여자 개념) 결정 대기. (직원 계정은 9개 등록 완료 — admin 3·cs 4·marketer 1·staff 1 + 사용자 테스트용 1)
4. **소소한 미완**: 알바 7명 생일 미입력(근무 관리 직원 수정에서 넣으면 생일 패널에 뜸) · 대표 3인 생일 수정은 현재 SQL로만 가능 · 근무관리 7단계 정리(2026-07-20 work_minutes NULL 8건 수리) 남음.

### 이전 논의 (2026-08-11 — 일부 해소)

1. **재구매율 / MD KPI 논의 — 사용자 결정 대기**
   - 배경: 사용자가 "지정 기간 구매 후 90일 내 재구매율"을 MD KPI로 쓰려 했음.
   - 실측 제약: **회원 주문만 추적 가능(57.5%)** — 비회원(네이버페이 포함 42.5%)은 member_id 없고 buyer_cellphone도 주문 목록 API에 안 옴(실측 0%) → 식별 불가. 회원 주문 비율은 5월 61.5% → 6월 59.9% → 7월 58.6%로 **매달 ~1.5%p 하락 추세**(고객이 네이버페이로 이동 중) → 코호트 구성이 달마다 변해 KPI로는 왜곡 위험.
   - 내 권고(전달 완료): MD 개인 KPI로는 부적합(귀속 불가·90일 피드백 지연·측정 편향). **MD KPI는 담당 상품 순반품률+마진율(+주문율) 권장**. 재구매율은 ①회사 모니터링 지표로 구현 또는 ②"담당 상품별 재구매 견인율"(그 상품 첫 구매 회원의 90일 내 몰 재구매)로 변형해 보조 지표화 — 사용자 선택 대기.
   - 구현 설계(확정 시 바로 착수 가능): 코호트 방식 — [기간~기간+90일] 주문을 fields=order_id,member_id,order_date,paid만으로 스캔(embed 불필요, 4개월 4만건 ~30-60초 + api_cache 10분), 회원별 기간 내 첫 주문일 t0, t0+90일 내 추가 주문 여부. 30/60/90일 단계별·평균 재구매 소요일 동시 산출. 90일 미성숙 코호트는 '관찰 진행 중' 구분(월별 추이의 성숙도 처리와 동일 사상).
2. **진열 조기 강등 룰 — 1차 대응 완료(2026-08-11)**: 상품팀 요청("신상은 뒤로 밀리지 않게")으로 **신상 보호 토글** 구현(#disp 섹션 참조). 켜면 조기 강등 자체가 꺼지므로 기준값 조정 논의는 보호를 안 쓸 때만 유효.
   - 남은 열린 제안(보호 꺼짐 전제): ⓐ 조기 강등 기본값(dcfg-demote 210) 조정 ⓑ "N일 지나도 조회 X회 미만이면 강등" 같은 저노출 신상 처리 규칙 — 현재는 조회 못 받는 신상이 21일 내내 신상 블록에 남음.
   - 참고(사례 분석, 2026-08-11 이전): 나그랑 맨투맨 조기 강등·멜리 레이어드 나시 신상 유지 둘 다 설계 의도대로 동작 확인.

### 기존 미결

- 긴 기간 조회는 여전히 느리다(동작은 함): 판매 성과 3개월 netreturns ~52초, 취소&반품 6개월 ~65초, **홈 '카페24 불러오기' 3개월 ~127초**(기본 1주일은 ~48초). 동시 처리 수를 올리면 빨라지지만 카페24 429에 걸려 지금이 상한.

- 카테고리별 진열 CSV 실제 카페24 업로드 검증(테스트 카테고리 1개 권장).
- TOP 카테고리 품절 설정 43개 실측 대조.
- Fixie 프록시 유지/해지 결정.
- 시즌 제외 5개 상품 가을 전환 시 '복원' 필요.
- 반품 상품 가치하락분(재판매 불가율) 실측 후 반품비 가산 여지.

---
*상세 커밋 이력은 `git log`. 이 문서는 계정 이전 시점(2026-08-05)까지의 지식을 담고 있으며, 이후 작업마다 갱신할 것.*
