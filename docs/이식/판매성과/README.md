# 판매 성과 메뉴 이식 가이드

> 이 문서는 danarobe/dnrb-dashboard(공개 레포)의 **판매 성과(#perf) 메뉴를 다른 카페24 몰·다른 프로젝트로 옮겨 이어서 개발**하려는 사람(과 그 사람의 Claude)을 위한 지침서다.
> 이 폴더(`docs/이식/판매성과/`)에 **바로 쓸 수 있게 잘라낸 코드**가 들어 있다 — 원본 index.html(1만 줄)을 뒤질 필요 없이 이 폴더만 가져가면 된다.
> 원본 소스: https://github.com/danarobe/dnrb-dashboard · 문서 기준일: 2026-09-04

```
docs/이식/판매성과/
├── README.md                     ← 이 문서
├── server/
│   ├── cafe24-perf/index.ts      ← 판매 성과 계산 함수 (performance · netreturns · returnreasons)
│   ├── cafe24-oauth/index.ts     ← 카페24 OAuth 최초 인증 + 토큰 저장 (그대로 사용)
│   └── _shared/util.ts           ← CORS·JSON·결과 캐시·토큰 저장 공용 코드
├── client/
│   ├── perf-section.html         ← 메뉴 마크업
│   ├── perf.js                   ← 화면 로직 (맨 위 [어댑터] 4가지만 바꾸면 됨)
│   └── perf.css                  ← 필요한 스타일
└── sql/schema.sql                ← 테이블 3개 (api_tokens · api_cache · perf_archive)
```

---

## 0. 이게 뭔가 (아키텍처 한 장)

- **화면**: 프레임워크 없는 순수 HTML/JS. 기간을 고르고 [카페24 불러오기]를 누르면 상품별 표 + 요약 카드가 innerHTML로 통째 그려진다.
- **서버**: Supabase Edge Function(Deno/TypeScript) 1개(`cafe24-perf`) + OAuth 함수 1개(`cafe24-oauth`). **카페24 호출은 전부 서버에서**, 결과는 서버 캐시 10분. 클라이언트는 카페24를 직접 부르지 않는다.
- **외부 API**: 카페24 애널리틱스 API(판매수량·주문금액) + 카페24 Admin API(주문 품목·상품 정보). 토큰은 서버가 자동 갱신.
- **DB**: 테이블 3개 — 토큰, 캐시, 저장 기록(기간별 비교용 요약 스냅샷).

기능 요약: 기간별 상품 판매 성과 표(결제수량·환불수량·순판매량·판매합계·판매가·공급가·마진율), 순반품률(배송완료일 기준)로 우수/주의/위험 판정 + 필터, 옵션별 순반품률 접이식, 상품명 클릭 → 반품 사유 TOP5 모달, '오늘' 조회 시 어제 대비 순위 등락(NEW/↑/↓), 상품명 검색, 결과 저장 → 기간별 비교(차트+표), 직전 3개월 월별 추이(순반품률·마진율·취소반품률).

---

## 1. 데이터가 어떻게 계산되나 (코드가 전제하는 정의 — 바꾸면 숫자가 달라진다)

| 항목 | 출처 | 정의 |
|---|---|---|
| 결제수량 `paid_qty` | 애널리틱스 `/products/sales` | 기간 내 **주문일 기준** 주문 상품 수량 합 (`order_product_count`) |
| 주문금액 `order_amount` | 〃 | 같은 기준의 주문금액 합 |
| 환불(취소·반품)수량 `cancel_qty` | Admin `/admin/orders` 품목 스캔 | 주문일 기준, 품목 상태 **C40(취소완료)·R40(반품완료)** 수량 합 |
| 순판매량 | 클라이언트 계산 | `paid_qty − cancel_qty` (0 미만은 0) |
| 판매합계(순판매금액) | 클라이언트 계산 | `order_amount × 순판매량 ÷ paid_qty` (수량 비율로 안분) |
| 판매가·공급가 | Admin `/admin/products` | `price`, `supply_price` (100개씩 배치 조회) |
| 마진율 | 클라이언트 계산 | `(판매가 − 공급가×1.1) ÷ 판매가` — **공급가에 부가세 10%를 얹어 실원가로 본다**. 전체 평균은 순판매량 가중평균 |
| 순반품률(판정 기준) | `netreturns` 액션 | **품목별 배송완료일(`delivered_date`)이 기간 안**인 품목이 모수, 그중 상태 **R00·R10·R30·R34·R40**(반품 신청~완료)이 반품. 우수 <10% / 주의 <20% / 위험 ≥20%, **배송완료 10개 미만은 '수량 부족'으로 판정 보류** |
| 취소&반품률(참고용) | 클라이언트 계산 | `cancel_qty ÷ paid_qty` — 주문일 기준이라 반품 반영이 늦다. 판정에는 안 쓴다 |

주의: 순반품률은 **주문을 여유 범위(시작−7일 ~ 종료+30일)로 수집한 뒤 품목별 배송완료일로 걸러낸다**. 주문 단위 배송완료일(`shipend_date`)은 부분배송 때 기간 밖 품목까지 딸려와서 틀린다(실측 검증됨).

---

## 2. 서버 — `cafe24-perf/index.ts`

원본 `cafe24-analytics`에서 판매 성과가 쓰는 액션 3개와 그 헬퍼만 잘라낸 **독립 함수**다. 그대로 `supabase/functions/cafe24-perf/index.ts`에 두고 배포하면 된다.

| 액션 | 무엇 | 호출량(대략) |
|---|---|---|
| `performance` | 상품별 결제·취소 수량, 금액, 판매가·공급가 | 애널리틱스 1~2회 + 주문(취소·반품만) 스캔 + 상품 배치 |
| `netreturns` | 배송완료일 기준 순반품률(상품·옵션) | 주문 전체 스캔 — **가장 무겁다** (한 달치 수십 초) |
| `returnreasons` | 반품 사유(신청/접수 분리, 클레임 번호 포함) | 반품 주문만 스캔 |

- **인증 어댑터**: 파일 상단 `[인증 어댑터]` 블록이 `x-api-key` 헤더를 `PERF_API_KEY` secret과 비교한다. 이식처 인증으로 교체할 자리. **키를 브라우저 코드에 넣지 말 것** — 백엔드가 대신 호출하거나 자체 로그인 토큰을 붙여라. (원본은 자체 로그인 토큰 + 역할 검사였고, 역할이 관리자가 아니면 `order_amount`를 0으로 지웠다 — 주석에 위치 표시해 둠.)
- **캐시는 필수**: `api_cache` 테이블에 10분. 인증 검사 **뒤에** 캐시를 읽는다(순서 바꾸면 캐시가 인증 우회 통로가 됨). 강제 재조회는 `&nocache=1`.
- Supabase를 안 쓰면: 순수 fetch 로직이라 Node 등으로 옮기기 쉽다. 유지할 것 두 가지 — ① 토큰은 서버에만 ② 결과 캐시.

### 카페24 쪽 준비 (이식받는 사람이 직접)

1. 카페24 개발자센터 → 앱 등록 → **권한(scope)**: `mall.read_order`, `mall.read_analytics`, `mall.read_product`, `mall.read_category` (OAuth 함수의 `SCOPE` 상수와 동일).
2. Redirect URI에 `https://<프로젝트>.supabase.co/functions/v1/cafe24-oauth` 등록.
3. Supabase secrets: `CAFE24_MALL_ID`(몰 아이디), `CAFE24_CLIENT_ID`, `CAFE24_CLIENT_SECRET`, `PERF_API_KEY`(임의의 긴 난수), 선택 `DASHBOARD_URL`(인증 완료 후 돌아갈 주소).
4. `sql/schema.sql` 실행 → 함수 2개 배포 → 브라우저에서 `…/cafe24-oauth?action=start` 한 번 열어 몰 관리자 계정으로 동의 → `?action=status`가 `connected:true`면 끝.
5. 애널리틱스 API(`ca-api.cafe24data.com`)는 **API 버전 헤더 `X-Cafe24-Api-Version`** 을 요구한다 — 코드의 `API_VERSION` 상수. 카페24가 버전을 폐기하면 올려야 한다.

---

## 3. 클라이언트 — `client/`

`perf.js` 맨 위 **[어댑터] 4가지**만 이식처에 맞게 바꾸면 나머지는 손대지 않아도 된다:

1. `perfApi(params)` — `cafe24-perf`(또는 그 프록시) 호출. 응답 형식은 §2 그대로.
2. `sbList / sbInsert / sbDelete` — 저장 기록(`perf_archive`) CRUD. 원본은 Supabase 프록시였고, 이식처 백엔드로 교체 (호출 지점은 `perf_archive` 검색으로 3곳).
3. `isAdmin / isStaff / isCS` — 역할. 원본은 MD에게 판매합계 열을 숨기고 CS에게 전사 합계를 블러(`.cs-blur`)했다. 역할이 없으면 기본값(전부 관리자)으로 두면 전부 보인다.
4. `$ / fmt / fmtP / escHtml / showToast / btnBusy / btnIdle / qPeriod` — 공용 헬퍼. 이식처에 같은 게 있으면 대체.

진입 시 `perfMenuInit()`을 부르면 기본 기간(최근 7일)·월별 추이 패널·저장 목록이 준비된다. `Chart.js`(CDN)는 월별 추이와 비교 차트에 필요, Font Awesome 아이콘은 선택.

**'오늘' 하루 조회의 순위 등락**: 표를 먼저 그린 뒤 백그라운드로 어제 `performance`를 한 번 더 받아 다시 그린다(서버 캐시 덕에 두 번째부터 즉시). 기간이 바뀌면 늦게 온 응답은 버린다 — 이 순서 지킬 것.

**월별 추이**: 완결된 달의 수치는 변하지 않으므로 `localStorage`에 영구 저장(브라우저당 1회 수집). 단 **월이 끝난 지 10일이 안 됐으면 반품이 덜 들어온 상태라 저장하지 않는다**. 반품 기준을 바꾸면 키의 버전(`dnrb_trend_v2_`)을 올려 무효화.

---

## 4. DB 스키마

`sql/schema.sql` 그대로 실행. 테이블 3개 전부 RLS만 켜고 정책 없음(= 서버 service_role만 접근). `perf_archive`는 표 전체가 아니라 **요약 수치만** 저장한다(기간, 취소반품률, 평균 마진율/원가율, 수량, 상품 수, 메모).

---

## 5. 실측으로 얻은 카페24 함정 목록 (⚠ 코드에 이미 반영돼 있으니 "정리"하다 지우지 말 것)

1. **offset 상한 15,000** — `/admin/orders`는 offset≥15000이면 422. 한 달 주문이 그 이상이라 **기간을 조각내어 조각마다 offset 0부터** 읽는다(`splitOrderRanges`). 조각 크기는 `/count`로 실측해 반으로 쪼갠다.
2. **조회 기간 3개월 제한** — 여유 패딩까지 더하면 두 달 분석도 넘긴다 → 처음부터 80일 이하 조각(`MAX_RANGE_DAYS`).
3. **`/count`에 `embed`·`fields`를 넘기면 `[]`가 와서 건수 0으로 읽힌다** → 조각이 통째로 버려진다(실사고). `countFilter`가 `date_type`·`order_status`만 남긴다.
4. **부분배송 주문은 두 조각에 다 잡힌다**(배송종료일이 여러 개) → 주문번호 `seen` Set으로 중복 제거(`eachOrder`).
5. **429 "Too much requests occur (40/40)"** — 동시 요청 2개(`CHUNK_CONCURRENCY`)로 낮추고, 429면 Retry-After 대기 후 재시도. 여러 메뉴가 한꺼번에 카페24를 부르면 쉽게 걸린다 — 캐시 없이 돌리지 말 것.
6. **토큰 동시 갱신 경쟁** — 인스턴스 둘이 동시에 refresh하면 먼저 받은 토큰이 무효화된다. 401이면 강제 재발급 1회, 갱신 실패 시 1.5초 뒤 DB의 최신 토큰 재사용(`getAccessToken(force)`).
7. **refresh_token 2주 만료** — 2주간 아무도 안 부르면 재인증 필요(`cafe24-oauth?action=start`). 운영 중엔 사실상 안 생기지만 첫 설치 후 방치하면 생긴다.
8. **date_type의 결제일은 `pay_date`** (payment_date는 422). 이 메뉴는 `order_date`(주문일)·`shipend_date`(배송완료)만 쓴다.
9. **반품 사유는 한 필드에 두 사유가 합쳐져 온다** — `"사이즈작음 (구매자 주문취소 : 구매 의사 취소)"`. `splitClaimReason`이 신청/접수로 나누고, 화면은 **신청 사유가 있으면 그것만** 센다(중복 방지). 여러 상품을 한 번에 반품하면 **같은 문장이 모든 상품에 복사**되므로 클레임 번호로 '단독/동반/다른 상품 사유'를 가른다(`rrEnsure`).
10. **'오늘/어제'는 KST로** — `toISOString()`은 UTC라 아침엔 하루 밀린다. `qPeriod`가 `Intl.DateTimeFormat(…Asia/Seoul)`을 쓰는 이유.
11. **`.m-hide`는 700px 이하에서 열 숨김** — 모바일에서 표가 화면을 넘지 않게. 표는 반드시 `.table-wrap`(overflow-x:auto) 안에.

---

## 6. 이식 순서 제안

1. **1단계 — 서버부터**: 스키마 → secrets → 함수 2개 배포 → OAuth 1회 → `curl -H "x-api-key: …" "…/cafe24-perf?action=performance&start_date=…&end_date=…"`로 JSON 확인. (한 달치 첫 호출은 수십 초 걸리는 게 정상, 두 번째는 즉시)
2. **2단계 — 표**: `perf-section.html` + `perf.css` + `perf.js`를 붙이고 어댑터 1·3·4만 채워 [카페24 불러오기]가 표를 그리는 것 확인.
3. **3단계 — 부가 기능**: 저장·비교(어댑터 2 + `perf_archive`), 월별 추이(Chart.js), 반품 사유 모달(`returnreasons`).
4. 검증 팁: 카페24 관리자 화면의 "전체주문조회 → 배송완료일 검색"과 `netreturns`의 총 수량이 맞는지 한 기간만 대조해 보면 기준이 맞는지 바로 안다(우리도 그렇게 검증했다).

---

## 7. 우리 대시보드 전용이라 이미 빼고 준 것

- **ON 광고 열**(Meta 활성 광고 수 매칭) — Meta 연동이 있어야 해서 제거. 필요하면 원본 `paBuildMatch`/`paShow` 참고.
- **역할별 블러·열 숨김**(admin/MD/CS) — 어댑터 3의 기본값으로 무력화.
- **홈 화면 연동**(홈의 월별 추이 패널, "이 메뉴만 별도 기간" 체크) — 제거.
- **CSV 업로드 경로**(카페24 API 연동 전의 옛 방식) — 안내 문구만 남기고 제거.
- 순익 시나리오·실마진율(`realmargin`) — 다른 메뉴.

---

## 8. 참고

- 원본 레포 `CLAUDE.md`의 "판매 성과" 관련 절과 `cafe24-analytics/index.ts` 주석에 "왜 이렇게 돼 있나"가 다 적혀 있다.
- 이 코드는 복사본이다 — 가져가서 고쳐도 원본 대시보드에는 아무 영향이 없다. 반대로 원본이 바뀌어도 자동 반영되지 않으니, 필요하면 이 폴더의 기준일과 원본 커밋을 비교하면 된다.
- 문서에 시크릿·계정·매출 금액은 넣지 않았다(공개 레포 원칙). 이식처에서도 같은 원칙을 권한다.
