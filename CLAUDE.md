# DNRB 대시보드 — 프로젝트 지침 (CLAUDE.md)

> 이 파일은 Claude Code가 새 세션/새 계정에서 이 프로젝트를 이어받을 때 읽는 핵심 문서다.
> 다나로브(danarobe) 쇼핑몰 운영자용 **성과 분석 대시보드**. 비개발자인 사용자에게는 쉬운 한국어로 설명한다.

---

## 0. 한눈에 보기

- **무엇**: 카페24/네이버/Meta 데이터를 모아 취소·반품, 상품 분석, 판매 성과, 진열 순서, 재고, 광고, 순이익을 보는 단일 페이지 대시보드.
- **소스**: `~/dnrb-dashboard` — `index.html` 단일 정적 페이지 + `supabase/functions/` Edge Functions 7종.
- **배포**: GitHub Pages `https://danarobe.github.io/dnrb-dashboard/` — 공개 레포 `danarobe/dnrb-dashboard`. **git push하면 자동 배포**(반영 30~60초).
- **Supabase**: 프로젝트 ref `eeffmbusaqaadeojjlnc` (서울, 회의보드용 `Meeting_Prapare`에 합사). anon key·URL은 `config.js`에 있고 공개 레포에 노출됨(의도된 것 — 서버가 토큰 검증).
- **기술 스택**: 프레임워크 없음. 순수 HTML/CSS/JS + Chart.js·xlsx-populate(CDN). 백엔드는 Supabase Edge Functions(Deno/TypeScript).

## 1. 작업 관례 (반드시 지킬 것)

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
| `meta-ads` | Meta 광고관리자(Graph v23.0) summary/topads/adstats/preview | 관리자+MD |

- 공용 유틸 `_shared/util.ts`: CORS_HEADERS(**x-auth-token 포함**), verifyAuthToken(서명·만료 검증 + **DB 실계정·현재 role 재확인**), getToken/saveToken(api_tokens, service_role), json/handleOptions.
- **Supabase 게이트웨이는 엣지 함수의 text/html 응답을 text/plain으로 강제 변환** → OAuth 완료는 DASHBOARD_URL(secret) 리다이렉트로 처리.
- **cafe24-oauth의 selfUrl은 SUPABASE_URL 기반**(엣지 런타임 req.url은 프록시 내부 주소라 /functions/v1·https 빠짐).

### cafe24-analytics 액션
- `summary`(조회수+주문율), `categories`, `category_products`, `revenue`(결제 매출), `performance`(판매수량+취소반품+공급가/판매가), `netreturns`(순반품률), `displaymetrics`+`productinfo`(진열용), `paiditems`(결제일 기준 품목별 결제수량 + 전체 상품목록).

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

### db 프록시 화이트리스트 (supabase/functions/db/index.ts의 TABLE_ROLES)
cr=admin, perf/adv/meeting_topics/meeting_notes/note_comments/note_likes=admin+staff, disp_season_out/profit_archive=admin.
AUTHOR_FIELDS(notes/comments=author_id, likes=user_id): POST는 본인 id 필수, PATCH/DELETE는 해당 필터 필수 → 본인 것만 수정·삭제(서버 강제).

---

## 4. 인증·권한 (역할 3종)

- **관리자(admin)**: 전 메뉴. Meta·순익 등 금액 데이터 전체.
- **MD(내부코드 staff)**: 대시보드·상품분석·판매성과·**광고효율**·광고회의록 5개 메뉴. 광고 효율의 광고비·구매전환값·총매출 3타일은 블러(`.role-staff .meta-blur`), ROAS·소재는 봄. 판매 성과에서 금액/판매합계 숨김.
- **CS팀(cs)**: 판매 성과 메뉴만. 전사 합계·마진 블러(`.role-cs .cs-blur`).
- **역할 표시 명칭**: 코드 role은 admin/staff/cs 그대로, UI 라벨만 관리자/MD/CS팀. 직원 관리 셀렉트도 동일.
- **showMenu**: 권한 없는 메뉴는 홈으로 폴백(옛날엔 return→빈 화면 버그). 관리자 전용 메뉴 버튼(cr·disp·stock·stable·profit·users)은 아예 숨김.
- **보안 모델**: 서버 verifyAuthToken이 DB 실계정+role을 매 요청 재확인 → 계정 삭제·권한 변경 즉시 반영. 외부(anon key만)로는 테이블 조회 빈배열·삽입 RLS 거부·함수 401/403. **남은 UI 차단 수준**: 상품분석 summary의 주문금액은 직원에게 서버 미차단(홈 급증 TOP10 금액 표시가 기존 동작), 비공개 회의기록 읽기는 클라이언트 필터.

---

## 5. 메뉴별 핵심 로직

### 홈 대시보드 (#home)
- 기준 기간 + "카페24 불러오기" → **전 메뉴 기간 동기화 + 데이터 자동 기입**: 취소반품·상품분석·판매성과 + Meta광고·순익시나리오·재고대조. Meta는 fetchMetaAds 자동 실행, 순익은 fillProfitFromStores로 기수집 데이터 재사용(추가 API는 Meta뿐).
- 각 메뉴 기간 옆 **'이 메뉴만 별도 기간' 체크박스**(own-period-{key}, localStorage `dnrb_own_period`) → 체크 시 홈이 그 메뉴 기간·데이터를 안 건드림, 타일에 '별도 기간 사용 중' 표시.
- KPI 4타일 + 판매량 급증 TOP10 + 조회수/주문율 TOP10 + 취소반품 사유 TOP3 + 수집상태 칩 3종.

### 취소 & 반품 (#cr, 관리자)
- 카페24 API(주문일 기준 C40/R40 등) + 네이버페이 암호 xlsx 직접 업로드. **취소반품 금액 합계 = 카페24 + 네이버 CSV** (순익 시나리오가 이 합계를 그대로 씀).
- 금액/사유 매핑(관리자 CSV 실측 대조): 실제 환불금액은 `embed=cancellation,return`의 refund_amounts[].amount. claim_reason_type: A/O=고객변심 B=배송지연 E/P=상품불만족 G=서비스불만족 H=품절 I=기타 J/L=배송오류 K/V=상품불량. 반품 진행중 포함(R00/R10/R30/R34/R40), 취소는 C40만. 카페24 C40/R40에는 네이버페이 주문 포함되므로 취소반품관리 CSV엔 없음 → 이중집계 방지 위해 구분.

### 상품 분석 (#an) / 판매 성과 (#perf)
- performance: 마진율 = (판매가 − 공급가×1.1)/판매가. **카페24 공급가는 부가세 미포함으로 기입**돼 있음(순익 부가세 계산에 중요). 공급가 미입력 상품은 마진 제외.
- netreturns: **배송완료일(품목 delivered_date) 기준**. 반품 상태 = **R00/R10/R30/R34/R40 (2026-08-09부터 신청·접수 포함** — 반품 관리 메뉴와 기준 통일, 사용자 결정. 그 전에는 R30/R34/R40). 등급 우수<10/주의10~20/위험≥20, 배송완료 10개 미만 보류. 주문 수집은 [s−7d, e+30d] 패딩(부분배송 대비). 옵션별 접이식 상세. **진열(displaymetrics)의 손실률만 아직 R30/R34/R40** — 진열 순서에 영향을 주지 않으려는 사용자 결정.
- **반품 사유 모아보기(2026-08-07)**: 판매 성과 표에서 **상품명 클릭** → 모달. `returnreasons` 액션 — **netreturns와 항상 같은 상태 집합을 써야 함**(현재 R00~R40, 어긋나면 표의 반품 수량과 모달 건수가 달라짐). `order_status` 필터로 스캔량 축소(4,554→486건, **24초→5초**). **콤마 다중 상태 필터 동작함**.
  - **카페24는 '반품 신청 사유'와 '반품 접수 사유'를 `claim_reason` 한 필드에 붙여서 준다**: `"사이즈작음 (구매자 주문취소 : 구매 의사 취소)"`. 서버 `splitClaimReason()`이 정규식 `\((?:구매자|판매자)\s*주문취소\s*:\s*([^)]*)\)$`로 분리. 사용자 규칙 = **둘 다 있으면 신청 사유만 집계**, 신청이 비면 접수 사유 사용(실측 643건 중 신청+접수 89·신청만 456·접수만 98·미기재 88).
  - 분류는 클라이언트 `RR_CATS` 키워드 규칙 7종(불량·하자 → 사이즈·핏 → 원단·소재 → 색상·실물차이 → 배송·품절 → 단순변심 → 기타, **위에서 먼저 걸리는 것이 이김**). **한글 어미 주의**: '두꺼'는 '두껍고'를 못 잡으므로 실제 사용형('두껍','두께')을 함께 등록. `rrNorm`이 공백·문장부호·ㅠㅜㅋㅎ 제거 + 싸이즈/서이즈/사이스→사이즈 통일. 실측 643건 기준 기타 4.5%.
  - **성능**: 상품명 첫 클릭 때만 1회 조회(~3.5초), 기간 단위로 `rrState`에 캐시 → 2번째부터 **0~2ms**. 판매 성과 초기 로딩은 전혀 안 건드림.

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

### 셀메이트 재고 대조 (#stock, 관리자) / 안정재고 편성 (#stable, 관리자)
- 셀메이트 CSV(EUC-KR, **헤더명 기반 열 인식**: 상품명/옵션명/재고수량·현재재고) ↔ paiditems.
- **옵션 매칭 = 값 토큰 배열 1:1 짝짓기**(셀메이트 "연청,L" ↔ 카페24 "컬러=연청, 사이즈=L", 순서 무관, 토큰 수 다르면 미매칭). 문자열 결합 비교는 "1사이즈"↔"1사이즈 (55~77)"에서 깨짐.
- 재고 대조 상태 4종: 매칭됨/표기차이/결제 0건/미매칭(카페24 없는 상품). 필터 3종(0건/N이하/N이상, OR).
- 안정재고 추천: 1일평균(결제수량÷일수) <1→0 / <3→×3 / <5→×4 / ≥5→×5, 내림(3.0은 ×4). 분홍=변경필요, 노랑=신규편성. 필터 탭(전체/변경/늘릴/줄일) + '차이 N개 이상'. 기본 기간 **어제까지 7일**.
- **카페24 date_type의 결제일은 `pay_date`** (payment_date/paid_date는 422). `/admin/products`는 **limit 최대 100**·offset 정상.

### 광고 효율 (#adv, 관리자+MD)
- Meta 광고관리자 API. summary(광고비/구매전환값/구매수/Meta ROAS) + 카페24 ROAS(결제매출÷광고비) 5타일. 소재 **TOP 20**(행 클릭 → 미리보기 iframe + 기간별 지출·ROAS 이중축 차트).
- 구매 액션은 **omni_purchase**→purchase→fb_pixel_purchase 폴백(이 몰은 omni_purchase).
- **adstats 기간 7종**(소재 클릭 시 모달): 오늘 / 어제 / 최근3일 / 최근7일 / **이전7일** / 최근14일 / 최근30일. 앞 6개는 date_preset(today/yesterday/last_3d/last_7d/last_14d/last_30d, 오늘 외에는 어제까지). **'이전 7일'은 Meta에 프리셋이 없어 time_range로 직접 조회** — 기준일은 last_7d 응답의 `date_start`에서 −7d~−1d 역산(광고계정 시간대 그대로라 어긋나지 않음), last_7d가 빈 응답이면 Asia/Seoul 오늘−7d로 폴백. 응답 stats에 `start`/`end` 포함 → 타일 tooltip·차트 tooltip에 실제 날짜 표시. 검증(2026-08-05, 6개 소재): **이전7일 + 최근7일 = 최근14일** 정확히 일치.
- **Meta 연동 = 시스템 사용자 방식**(개인계정 잠금 문제 회피). 시스템사용자 dnrb-dashboard(비즈니스 Onniverse), 앱 DNRB-Dashboard(1005085742525912), 무기한 ads_read 토큰. 기존 수동 입력/시나리오/세금/아카이브 UI는 삭제됨(adv_archive 데이터는 보존, e89ef28 이전 커밋에서 복원 가능).

### 순익 시나리오 (#profit, 관리자)
- 기간 → **4지표 자동 수집**: 매출(revenue) / 취소반품(취소&반품 메뉴 합계=카페24+네이버, 기간 일치 시) / 마진율(performance 판매수량 가중평균) / 광고비(Meta). 전부 수정 가능.
- **수동 비용 7종**(localStorage `dnrb_profit_costs`): 인건비·사입삼촌(VAT포함)·사무실월세(VAT포함)·관리비(VAT포함)·**택배비(면세)·기타VAT포함·기타VAT미포함**.
- **인건비 자동 수집**: '근무관리에서 불러오기' 버튼 → `http://localhost:3001/api/salary/all?year&month` (근무관리 서버가 도는 컴퓨터에서만 동작). 별도 프로젝트 work-manager 참조.
- **부가세 = 매출세액(순매출×10/110) − 매입세액**. 매입세액 = 상품원가×10/110(공급가가 VAT 미포함 기입이고 마진율이 공급가×1.1 기준이라 P&L 원가는 VAT 포함) + Meta광고비×10%(별도 청구) + VAT포함 경비×10/110. 인건비·택배비(면세)·기타미포함은 공제 없음.
- 법인세 = 과세표준 구간세율(2억 9% / 2억~200억 19% / 초과 21%, 연 구간을 기간 손익에 그대로 — 참고용). 손익분기 광고비 = 이분탐색.
- 손익계산서 + 순이익 카드 + ROAS(200~1000)×취소반품률(10~30) 매트릭스(셀 클릭 상세) + **profit_archive 기록 저장/불러오기/삭제**.

### 광고 회의록 (#meet, 관리자+MD)
- 회의 안건(ad_meeting_topics) + 일자별 회의 기록(ad_meeting_notes, 계정별 작성, 공유 토글). 공유 글에 **댓글·좋아요**(본인만 수정·삭제, 서버 강제).

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
- 8/1~3 Meta: 광고비 1,301만·구매 1,087건·Meta ROAS 5.46·카페24 ROAS 6.09.
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

## 7-1-b. 월별 추이 패널 — 판매 성과 최상단 + 홈 하단 (2026-08-09)

판매 성과 최상단·홈(사유 TOP3 아래) 두 곳(CS 제외)에 **직전 3개 완결 월**(조회 월 기준 자동 — 8월→5·6·7월, 9월→6·7·8월)의 순반품률/평균 마진율/취소반품률 — Chart.js 선그래프 + 값·전월 대비 표.
- 렌더러는 `ptRenderTo(prefix,…)` 하나로 홈(`home-`)·판매성과(`perf-`) 공용, 차트 인스턴스는 `ptCharts[prefix]`. **숨은 섹션의 캔버스에 그리면 폭 0으로 깨지므로**, 수집 후엔 보이는 섹션에만 그리고 다른 메뉴는 진입 시 `ptInitPanel`이 다시 그린다.
- 데이터: 월별 `performance`(마진 가중평균·취소반품률=Σcancel÷Σpaid) + `netreturns`(순반품률). **순차 실행**(429 예방). 최초 수집 ~4분, 이후 localStorage.
- **완결 월은 수치가 불변이라 localStorage 영구 저장**(`dnrb_trend_v2_YYYY-MM`) — 단 **월말+10일 전이면 반품 미성숙이라 저장 안 함**(예: 8/9에 7월은 계산만, 8/10부터 저장). v2 = 신청·접수 포함 기준, 기준 변경 시 버전 올려 무효화.
- 검증: 7월 순반품률 12.8% = 독립 실측 12.80% 일치. 5월 12.8/48.7/20.2, 6월 11.4/49.1/17.6.

## 7-2. UI/UX 개편 (2026-08-09, 사용자 요청 6종 + 글래스모피즘)

1. **서버 결과 캐시 10분** — `api_cache` 테이블(RLS, service_role 전용) + `_shared/util.ts`의 `cacheGet/cacheSet`. 무거운 액션만: netreturns·performance·returnwatch·paiditems·displaymetrics·returnreasons·cafe24-claims. **캐시 조회는 각 액션의 권한 검사 뒤에** 해야 함(권한 우회 방지). performance는 역할별 응답이 달라 **키에 role 포함**. `nocache=1`로 우회 가능. 실측: netreturns 47초→0.4초, claims 8초→0.4초.
2. **조회 버튼 경과초 표시** — `btnBusy(btn,라벨)/btnIdle(btn,html)`. 적용: 홈·취소반품·판매성과·반품관리·진열·재고대조·순익 수집.
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
4. **글래스 강도 하향**: 카드 rgba(255,255,255,.92)+blur 8px+테두리 #e7e8ee+그림자 1단계, 모달 .98 불투명, 메뉴 흰색 무블러, 배경 그라데이션 채도 낮춤.
5. 긴 안내 문구 축약(홈·반품관리·진열 인트로).
- 전부 **파이썬 일괄 치환(count assert)** 으로 수행 — 개별 손 수정 금지 수준의 분량. 검증: 화면 잔여 이모지 0, 12개 메뉴 순회 예외 0, 판매 성과 306상품·사유 모달 정상, 콘솔 오류 0.

## 8. 남은 일 / 미결정

- 긴 기간 조회는 여전히 느리다(동작은 함): 판매 성과 3개월 netreturns ~52초, 취소&반품 6개월 ~65초, **홈 '카페24 불러오기' 3개월 ~127초**(기본 1주일은 ~48초). 동시 처리 수를 올리면 빨라지지만 카페24 429에 걸려 지금이 상한.

- 카테고리별 진열 CSV 실제 카페24 업로드 검증(테스트 카테고리 1개 권장).
- TOP 카테고리 품절 설정 43개 실측 대조.
- Fixie 프록시 유지/해지 결정.
- 시즌 제외 5개 상품 가을 전환 시 '복원' 필요.
- 반품 상품 가치하락분(재판매 불가율) 실측 후 반품비 가산 여지.

---
*상세 커밋 이력은 `git log`. 이 문서는 계정 이전 시점(2026-08-05)까지의 지식을 담고 있으며, 이후 작업마다 갱신할 것.*
