# 쇼핑몰 성과 분석 대시보드 (API 연동 버전)

> **Claude Code로 이 프로젝트를 이어받는 경우 → 먼저 [`CLAUDE.md`](CLAUDE.md)를 읽으세요.**
> 기능 전체·작업 관례·API 상수·검증값·미결정 사항이 거기 정리돼 있습니다.
> 상품팀 배포용 진열 로직 설명서는 [`docs/상품팀-진열로직-가이드.html`](docs/).


Cafe24 + 네이버 스마트스토어 운영자를 위한 **취소·반품 실시간 분석 대시보드**.
젠스파크로 만든 CSV 업로드 버전을 이어받아 다음을 추가/교체했다:

| 항목 | 기존 (젠스파크) | 이번 버전 |
|---|---|---|
| 취소·반품 데이터 | CSV 수동 업로드 | **카페24/네이버 API 실시간 조회** (+CSV 병행 가능) |
| 분석 결과 저장 | 젠스파크 전용 `tables/` API | **Supabase DB** (어디에 배포해도 동작) |
| 토큰 관리 | 없음 | Supabase Edge Functions (자동 갱신) |

## 구조

```
index.html                  대시보드 (정적 파일, 아무 호스팅이나 가능)
config.js                   Supabase URL/anon key 설정   ← 직접 입력 필요
supabase/
  migrations/0001_init.sql  DB 스키마 (토큰 + 아카이브 3종)
  functions/
    cafe24-oauth/           카페24 OAuth 인증 (최초 연동 + 상태 확인)
    cafe24-claims/          카페24 취소·반품 집계 (C40/R40 주문 수집)
    naver-claims/           네이버 취소·반품 집계 (CLAIM_COMPLETED 변경분 수집)
    _shared/util.ts         공용 (CORS, 토큰 저장/조회)
```

## 셋업 순서

### 1. Supabase 프로젝트

1. [supabase.com](https://supabase.com)에서 새 프로젝트 생성
2. SQL Editor에 `supabase/migrations/0001_init.sql` 내용 붙여넣고 실행
3. Settings → API에서 **Project URL**과 **anon key**를 `config.js`에 입력

### 2. Edge Functions 배포

```bash
brew install supabase/tap/supabase   # CLI 설치 (최초 1회)
supabase login
supabase link --project-ref <프로젝트-ref>

# 시크릿 등록
supabase secrets set CAFE24_MALL_ID=<쇼핑몰ID>
supabase secrets set CAFE24_CLIENT_ID=<클라이언트ID>
supabase secrets set CAFE24_CLIENT_SECRET=<시크릿>
supabase secrets set NAVER_CLIENT_ID=<네이버 앱ID>        # 네이버 연동 시
supabase secrets set NAVER_CLIENT_SECRET=<네이버 시크릿>   # 네이버 연동 시

# 배포
supabase functions deploy cafe24-oauth --no-verify-jwt
supabase functions deploy cafe24-claims
supabase functions deploy naver-claims
```

### 3. 카페24 개발자센터 설정

앱 관리 → **Redirect URI**에 아래 주소 등록 (필수):

```
https://<프로젝트-ref>.supabase.co/functions/v1/cafe24-oauth
```

권한(스코프): `mall.read_order` (주문 조회)

### 4. 네이버 커머스API센터 설정

1. [커머스API센터](https://apicenter.commerce.naver.com)에서 애플리케이션 등록
2. API 그룹: **주문 조회(pay-order)** 권한 신청 (승인까지 시간 소요될 수 있음)
3. 발급된 애플리케이션 ID/시크릿을 위의 secrets로 등록

### 5. 대시보드 실행

`index.html`은 정적 파일이라 아무 곳에나 배포 가능 (GitHub Pages, 로컬 등).

최초 1회: **"카페24 최초 연동"** 버튼 → 카페24 로그인/동의 → 완료.
이후 토큰은 Edge Function이 자동 갱신한다 (refresh token 2주 — 2주 이상
아무 조회도 안 하면 재연동 필요).

## 필드 매핑 디버그

첫 실호출에서 금액/사유가 이상하면 API 원본 확인:

```
GET .../functions/v1/cafe24-claims?start_date=2026-07-01&end_date=2026-07-26&raw=1
GET .../functions/v1/naver-claims?start_date=2026-07-25&end_date=2026-07-26&raw=1
```

(anon key를 `apikey`/`Authorization` 헤더에 넣어 호출)

## 주의사항

- **네이버 조회는 기간이 길면 느리다** — last-changed-statuses API가 24시간
  범위 제한이라 1일 단위로 순회한다 (한 달 = 30회 이상 호출).
- 아카이브 테이블은 anon key만 알면 누구나 읽고 쓸 수 있다 (개인 도구 전제).
  anon key를 외부에 공개하지 말 것.
- 카페24 취소·반품 금액은 `actual_refund_amount` → `payment_amount` 순으로
  사용한다. 실데이터와 대조 후 필요 시 `cafe24-claims/index.ts`의 금액 로직 조정.
