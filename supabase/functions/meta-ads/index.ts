// ═══════════════════════════════════════════════
// Meta(페이스북·인스타그램) 광고관리자 연동 함수 — 관리자 전용
//   GET ?action=summary&start_date&end_date → 기간 광고비·구매전환값·구매수·meta ROAS
//   GET ?action=topads&start_date&end_date  → 지출 상위 10개 소재 (광고명/지출/구매당비용/구매수/전환값/ROAS/빈도)
//   GET ?action=dateads&start_date&end_date → 광고명 YYMMDD가 기간 내인 활성 광고 (사내 등록일 규칙)
//   GET ?action=activeads                    → 활성 광고 전체 + 시작~어제 누적 성과 (판매 성과 ON 광고 열)
//   GET ?action=adstats&ad_id=...           → 소재 기간별 지출·ROAS (오늘/어제/최근3일/최근7일/이전7일/최근14일/최근30일)
//   GET ?action=preview&ad_id=...           → 소재 미리보기(iframe HTML) + 썸네일
//   GET ?action=hierarchy&preset=...        → 광고관리자 메뉴: 캠페인/세트/광고 전체 현황 (60초 캐시)
//   GET ?action=testads                      → 테스트 소재: 세트명에 test(대소문자 무시) 포함 광고 전체 + 등록 이후 누적 성과
//
// 필요 secrets: META_ACCESS_TOKEN (비즈니스 설정 > 시스템 사용자 토큰, ads_read 권한),
//               META_AD_ACCOUNT_ID (act_ 제외 숫자만 또는 act_숫자)
// ═══════════════════════════════════════════════
import { cacheGet, cacheSet, handleOptions, json, verifyAuthToken } from "../_shared/util.ts";

const GRAPH = "https://graph.facebook.com/v23.0";

function creds(): { token: string; account: string } | null {
  const token = Deno.env.get("META_ACCESS_TOKEN") ?? "";
  let account = Deno.env.get("META_AD_ACCOUNT_ID") ?? "";
  if (!token || !account) return null;
  if (!account.startsWith("act_")) account = "act_" + account;
  return { token, account };
}

async function graphGet(path: string, params: Record<string, string>, token: string): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${GRAPH}/${path}?${qs}`);
  const body = await res.json();
  if (!res.ok) {
    const msg = (body?.error?.message ?? JSON.stringify(body)).slice(0, 300);
    throw new Error(`Meta API ${res.status}: ${msg}`);
  }
  return body;
}

// paging.next를 따라 전부 수집 — Meta의 limit 500 한도(잘림 사고 전력)를 페이지네이션으로 우회.
// maxPages는 폭주 방지 상한 (500×8=4,000행이면 이 계정 규모에 충분).
async function graphGetAll(
  path: string,
  params: Record<string, string>,
  token: string,
  maxPages = 8,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let body = await graphGet(path, params, token);
  for (let i = 0; i < maxPages; i++) {
    rows.push(...((body.data ?? []) as Record<string, unknown>[]));
    const next = (body.paging as Record<string, unknown> | undefined)?.next as string | undefined;
    if (!next) break;
    const res = await fetch(next);
    const nb = await res.json();
    if (!res.ok) break;
    body = nb;
  }
  return rows;
}

const num = (v: unknown) => {
  const n = parseFloat(String(v ?? "0"));
  return isFinite(n) ? n : 0;
};

// 광고계정 시간대(한국) 기준 오늘 — Meta의 date_preset도 계정 시간대로 계산되므로 UTC를 쓰면 하루 어긋난다
function seoulToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

// YYYY-MM-DD ± 일수 (UTC 정오 기준이라 서머타임·경계 영향 없음)
function addDays(ymd: string, d: number): string {
  const t = new Date(`${ymd}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}

// actions/action_values 배열에서 구매 항목 추출 (픽셀 설정에 따라 purchase 또는 omni_purchase)
function pickPurchase(arr: unknown): number {
  const list = (arr ?? []) as { action_type?: string; value?: unknown }[];
  for (const t of ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"]) {
    const hit = list.find((a) => a.action_type === t);
    if (hit) return num(hit.value);
  }
  return 0;
}

// 인사이트 행 → 표준 광고 행 (topads·dateads 공용)
function mapAdRow(r: Record<string, unknown>) {
  const spend = num(r.spend);
  const purchases = pickPurchase(r.actions);
  const purchaseValue = pickPurchase(r.action_values);
  const roasArr = (r.purchase_roas ?? []) as { value?: unknown }[];
  return {
    ad_id: String(r.ad_id ?? ""),
    ad_name: String(r.ad_name ?? ""),
    spend,
    cost_per_purchase: pickPurchase(r.cost_per_action_type) || (purchases > 0 ? spend / purchases : 0),
    purchases,
    purchase_value: purchaseValue,
    roas: roasArr.length ? num(roasArr[0].value) : (spend > 0 ? purchaseValue / spend : 0),
    frequency: num(r.frequency),
  };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  // 관리자 + MD(staff) 허용 — MD는 UI에서 광고비·전환값·총매출 블러 (CS는 차단)
  const authed = await verifyAuthToken(req);
  if (!authed || !["admin", "staff"].includes(authed.role)) return json({ error: "접근 권한이 없습니다" }, 403);

  const c = creds();
  if (!c) return json({ error: "not_connected", message: "Meta 연동이 설정되지 않았습니다 (META_ACCESS_TOKEN / META_AD_ACCOUNT_ID)" }, 200);

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "summary";

  // 광고관리자(#admgr) 메뉴 전용 액션은 관리자만 (2026-08-26 사용자 지정 — 대표 3인 = admin 전원).
  // 나머지 액션(summary/topads/dateads/activeads/adstats/preview)은 광고 효율·판매 성과가 MD와 공유.
  if (["hierarchy", "testads", "budgethistory", "hourlystats"].includes(action) && authed.role !== "admin") {
    return json({ error: "접근 권한이 없습니다" }, 403);
  }

  try {
    if (action === "summary" || action === "topads") {
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const timeRange = JSON.stringify({ since: s, until: e });

      if (action === "summary") {
        const body = await graphGet(`${c.account}/insights`, {
          time_range: timeRange,
          fields: "spend,actions,action_values,purchase_roas",
        }, c.token);
        const row = ((body.data ?? []) as Record<string, unknown>[])[0] ?? {};
        const spend = num(row.spend);
        const purchases = pickPurchase(row.actions);
        const purchaseValue = pickPurchase(row.action_values);
        const roasArr = (row.purchase_roas ?? []) as { value?: unknown }[];
        const metaRoas = roasArr.length ? num(roasArr[0].value) : (spend > 0 ? purchaseValue / spend : 0);
        return json({ period: { start: s, end: e }, spend, purchases, purchase_value: purchaseValue, meta_roas: metaRoas });
      }

      // topads — 소재(광고) 단위, 지출 내림차순 상위 30
      const body = await graphGet(`${c.account}/insights`, {
        time_range: timeRange,
        level: "ad",
        fields: "ad_id,ad_name,spend,actions,action_values,purchase_roas,frequency,cost_per_action_type",
        sort: "spend_descending",
        limit: "30",
      }, c.token);
      const ads = ((body.data ?? []) as Record<string, unknown>[]).map(mapAdRow);
      return json({ period: { start: s, end: e }, ads });
    }

    // 활성 광고 전체 + '광고 시작~어제' 누적 성과 — 판매 성과의 'ON 광고' 열용.
    // 호출 2번으로 끝낸다: ① 활성 광고 이름 목록(지출 0인 것 포함) ② 어제까지 누적 인사이트.
    // 상품별로 따로 묻지 않는다(상품 300개 × 호출 = 재앙). 매칭은 브라우저가 한다.
    if (action === "activeads") {
      const yesterday = addDays(seoulToday(), -1);
      // 10분 캐시 — 판매 성과를 여러 명이 반복 조회해도 Meta 호출은 10분에 2번.
      // (오늘 실측: 검증 중 반복 호출로 Meta "User request limit reached" 발생 → 캐시로 예방)
      const cacheKey = `meta:activeads:${yesterday}`;
      const hit = await cacheGet(cacheKey, 10 * 60 * 1000);
      if (hit) return json(hit);
      const [list, ins] = await Promise.all([
        graphGet(`${c.account}/ads`, {
          fields: "id,name",
          filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
          limit: "500",
        }, c.token),
        graphGet(`${c.account}/insights`, {
          time_range: JSON.stringify({ since: "2024-01-01", until: yesterday }),
          level: "ad",
          fields: "ad_id,ad_name,spend,actions,action_values,purchase_roas,frequency,cost_per_action_type",
          filtering: JSON.stringify([{ field: "ad.effective_status", operator: "IN", value: ["ACTIVE"] }]),
          limit: "500",
        }, c.token),
      ]);
      const metric = new Map(((ins.data ?? []) as Record<string, unknown>[])
        .map((r) => [String(r.ad_id ?? ""), mapAdRow(r)]));
      const rows = ((list.data ?? []) as Record<string, unknown>[]).map((a) => {
        const id = String(a.id ?? "");
        const m = metric.get(id);
        return m ? { ...m, ad_name: String(a.name ?? m.ad_name) } : {
          ad_id: id, ad_name: String(a.name ?? ""), spend: 0, cost_per_purchase: 0,
          purchases: 0, purchase_value: 0, roas: 0, frequency: 0,
        };
      });
      const truncated = ((list.data ?? []) as unknown[]).length >= 500;
      const body = { until: yesterday, count: rows.length, truncated, ads: rows };
      await cacheSet(cacheKey, body);
      return json(body);
    }

    // 선택 기간 내 '등록된' 활성 광고 — 사내 규칙: 광고명에 등록일 YYMMDD를 기입 (예: 260810)
    // 광고명에서 날짜를 추출해 기간 안에 들어가는 것만 반환. 비활성까지 세면 너무 많아
    // effective_status=ACTIVE 필터를 서버(Meta) 쪽에 건다 (사용자 결정).
    if (action === "dateads") {
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const body = await graphGet(`${c.account}/insights`, {
        time_range: JSON.stringify({ since: s, until: e }),
        level: "ad",
        fields: "ad_id,ad_name,spend,actions,action_values,purchase_roas,frequency,cost_per_action_type",
        filtering: JSON.stringify([{ field: "ad.effective_status", operator: "IN", value: ["ACTIVE"] }]),
        sort: "spend_descending",
        limit: "250",
      }, c.token);
      // YYMMDD: 연 24~29, 월 01~12, 일 01~31. 앞뒤에 숫자가 붙어 있으면(가격 등 긴 숫자열) 제외.
      const DATE_RE = /(?<!\d)(2[4-9])(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/g;
      const rows = ((body.data ?? []) as Record<string, unknown>[]);
      const ads = rows.map((r) => {
        const row = mapAdRow(r);
        const dates = [...row.ad_name.matchAll(DATE_RE)].map((m) => `20${m[1]}-${m[2]}-${m[3]}`);
        const matched = [...new Set(dates.filter((d) => d >= s && d <= e))];
        return { ...row, reg_dates: matched };
      }).filter((r) => r.reg_dates.length > 0);
      return json({ period: { start: s, end: e }, active_count: rows.length, ads });
    }

    // ── 광고관리자 계층 현황 (2026-08-25, 보기 전용 / 2026-08-25b 상향식→하향식 개편) ──
    // 처음엔 /ads(limit 500)에서 거꾸로 조립했더니 광고 500개 한도에 잘린 캠페인이 통째로 누락됨(리타겟팅 등 실사례).
    // 지금은 캠페인·세트 목록을 각각 직접 받아 하향식으로 조립 — 캠페인·세트는 누락 불가.
    // 새로고침 1번 = Meta 호출 4번: /campaigns + /adsets + /ads(활성만) + insights(level=ad).
    // 광고 행 = 활성 광고 전체 ∪ 기간 중 게재된 광고(인사이트 기준 — 중간에 꺼진 광고도 지출이 보임).
    // 60초 서버 캐시 = 새로고침 남발이 호출 한도(실사고 전력)를 못 건드리게 하는 방어선.
    if (action === "hierarchy") {
      const preset = ["today", "yesterday", "last_7d", "last_30d"].includes(url.searchParams.get("preset") ?? "")
        ? url.searchParams.get("preset")! : "today";
      // 실제 날짜 범위(계정 시간대) — last_7d/last_30d는 Meta 표준대로 '오늘 제외, 어제까지'
      const t = seoulToday();
      const range = preset === "today" ? { start: t, end: t }
        : preset === "yesterday" ? { start: addDays(t, -1), end: addDays(t, -1) }
        : preset === "last_7d" ? { start: addDays(t, -7), end: addDays(t, -1) }
        : { start: addDays(t, -30), end: addDays(t, -1) };
      const cacheKey = `meta:hierarchy4:${preset}:${t}`;
      const hit = await cacheGet(cacheKey, 60 * 1000);
      if (hit) return json(hit);

      type Node = Record<string, unknown>;
      const [camps, adsets, adsAct, ins] = await Promise.all([
        graphGet(`${c.account}/campaigns`, { fields: "id,name,effective_status,daily_budget,lifetime_budget", limit: "200" }, c.token),
        graphGet(`${c.account}/adsets`, {
          fields: "id,name,effective_status,daily_budget,lifetime_budget,campaign_id",
          filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
          limit: "500",
        }, c.token),   // 활성 필터 — 무필터 500 한도에 활성 세트가 잘려 상태·예산이 비던 버그 수정(2026-08-25c)
        graphGet(`${c.account}/ads`, {
          fields: "id,name,effective_status,adset_id,campaign_id",
          filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
          limit: "500",
        }, c.token),
        graphGet(`${c.account}/insights`, {
          date_preset: preset, level: "ad",
          fields: "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,clicks,actions,action_values,purchase_roas",
          limit: "500",
        }, c.token),
      ]);

      // 캠페인/세트 뼈대
      const cMap = new Map<string, Node>();
      for (const r of (camps.data ?? []) as Node[]) {
        cMap.set(String(r.id), { id: String(r.id), name: String(r.name ?? ""), status: String(r.effective_status ?? ""),
          budget: num(r.daily_budget), budget_life: num(r.lifetime_budget),
          spend: 0, purchases: 0, value: 0, clicks: 0, adsets: new Map<string, Node>() });
      }
      const sMap = new Map<string, Node>();   // adset_id → node (캠페인에도 연결)
      const ensureCamp = (id: string, name = "") => {
        if (!cMap.has(id)) cMap.set(id, { id, name, status: "", budget: 0, spend: 0, purchases: 0, value: 0, clicks: 0, adsets: new Map() });
        return cMap.get(id)!;
      };
      const ensureAdset = (id: string, campId: string, name = "", status = "", budget = 0, budgetLife = 0) => {
        if (!sMap.has(id)) {
          const node: Node = { id, name, status, budget, budget_life: budgetLife, spend: 0, purchases: 0, value: 0, clicks: 0, ads: new Map<string, Node>() };
          sMap.set(id, node);
          (ensureCamp(campId).adsets as Map<string, Node>).set(id, node);
        }
        return sMap.get(id)!;
      };
      for (const r of (adsets.data ?? []) as Node[]) {
        ensureAdset(String(r.id), String(r.campaign_id ?? ""), String(r.name ?? ""), String(r.effective_status ?? ""), num(r.daily_budget), num(r.lifetime_budget));
      }

      // 광고: 활성 전체 + 기간 중 게재분(인사이트) 합집합
      const ensureAd = (adId: string, adsetId: string, campId: string, name: string, status: string) => {
        const st = ensureAdset(adsetId, campId);
        const ads = st.ads as Map<string, Node>;
        if (!ads.has(adId)) ads.set(adId, { id: adId, name, status, spend: 0, purchases: 0, value: 0, clicks: 0, roas: 0 });
        return ads.get(adId)!;
      };
      for (const r of (adsAct.data ?? []) as Node[]) {
        ensureAd(String(r.id), String(r.adset_id ?? ""), String(r.campaign_id ?? ""), String(r.name ?? ""), String(r.effective_status ?? ""));
      }
      for (const r of (ins.data ?? []) as Node[]) {
        const m = mapAdRow(r);
        const campId = String(r.campaign_id ?? "");
        const camp = ensureCamp(campId, String(r.campaign_name ?? ""));
        if (!camp.name) camp.name = String(r.campaign_name ?? "");
        const st = ensureAdset(String(r.adset_id ?? ""), campId, String(r.adset_name ?? ""));
        if (!st.name) st.name = String(r.adset_name ?? "");
        const ad = ensureAd(String(r.ad_id ?? ""), String(r.adset_id ?? ""), campId, m.ad_name, "");
        const clicks = num(r.clicks);
        ad.spend = m.spend; ad.purchases = m.purchases; ad.value = m.purchase_value; ad.roas = m.roas; ad.clicks = clicks;
        st.spend = num(st.spend) + m.spend; st.purchases = num(st.purchases) + m.purchases; st.value = num(st.value) + m.purchase_value; st.clicks = num(st.clicks) + clicks;
        camp.spend = num(camp.spend) + m.spend; camp.purchases = num(camp.purchases) + m.purchases; camp.value = num(camp.value) + m.purchase_value; camp.clicks = num(camp.clicks) + clicks;
      }

      const campaigns = [...cMap.values()].map((cRow) => ({
        ...cRow,
        adsets: [...(cRow.adsets as Map<string, Node>).values()].map((st) => ({
          ...st, ads: [...(st.ads as Map<string, Node>).values()],
        })),
      }));
      const truncated = [camps, adsets, adsAct, ins].some((r) => ((r.data ?? []) as unknown[]).length >= 500);
      const body = { preset, range, fetched_at: new Date().toISOString(), truncated, campaigns };
      await cacheSet(cacheKey, body);
      return json(body);
    }

    // ── 테스트 소재 현황 (2026-08-26) — 세트명에 "test"(대소문자 무시) 포함 광고세트의 광고 전체 ──
    // 사내 운영: 소재 등록 → 3일 테스트 → 평가(OFF/유지/증액). 테스트 세트는 이름에 test를 넣는 규칙.
    // ON/생존/OFF 판정은 클라이언트가 reg_date(계정 시간대 등록일)로 계산 — 생존 = 등록일+4일부터(예: 8/22 등록 → 8/26).
    // 숨김·추가소재권장·메모는 ad_test_state 테이블(db 프록시)이 담당, 이 액션은 Meta 현황만 준다.
    // 세트 이름 필터를 Meta에 걸지 않는 이유: CONTAIN은 대소문자 변형(Test/TEST)을 놓칠 수 있어
    // 전체 세트를 페이지네이션으로 받아 서버에서 /test/i 로 거른다. 60초 캐시가 호출 한도 방어선.
    if (action === "testads") {
      const today = seoulToday();
      // kw = 세트명 검색어 (기본 "test", 대소문자 무시) — 명명 규칙이 바뀌면 클라이언트에서 바꿔 쓸 수 있는 안전장치
      const kw = (url.searchParams.get("kw") ?? "test").slice(0, 30);
      const cacheKey = `meta:testads:${kw.toLowerCase()}:${today}`;
      const hit = await cacheGet(cacheKey, 60 * 1000);
      if (hit) return json(hit);

      const kwRe = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const allSets = await graphGetAll(`${c.account}/adsets`, { fields: "id,name", limit: "500" }, c.token);
      const testSets = allSets.filter((r) => kwRe.test(String(r.name ?? "")));
      const setName = new Map(testSets.map((r) => [String(r.id), String(r.name ?? "")]));
      const setIds = [...setName.keys()].slice(0, 200);   // filtering IN 값 개수·URL 길이 방어
      if (!setIds.length) {
        const empty = { fetched_at: new Date().toISOString(), until: today, adset_count: 0, truncated: false, ads: [] };
        await cacheSet(cacheKey, empty);
        return json(empty);
      }

      const adsetFilter = JSON.stringify([{ field: "adset.id", operator: "IN", value: setIds }]);
      // 광고 목록(꺼진 것 포함 — 테스트 평가가 목적이라 OFF도 봐야 함) + 등록 이후 누적 성과
      const insParams = {
        time_range: JSON.stringify({ since: "2024-01-01", until: today }),
        level: "ad",
        fields: "ad_id,adset_id,spend,actions,action_values",
        limit: "500",
      };
      const [adRows, insRows] = await Promise.all([
        graphGetAll(`${c.account}/ads`, {
          fields: "id,name,status,effective_status,created_time,adset_id",
          filtering: adsetFilter,
          limit: "500",
        }, c.token),
        // insights의 adset.id IN 필터가 거부되면 무필터 전체를 받아 서버에서 거른다 (성과 누락 방지)
        graphGetAll(`${c.account}/insights`, { ...insParams, filtering: adsetFilter }, c.token)
          .catch(() => graphGetAll(`${c.account}/insights`, insParams, c.token, 12)),
      ]);

      const metric = new Map(insRows
        .filter((r) => setName.has(String(r.adset_id ?? "")))
        .map((r) => [String(r.ad_id ?? ""), r]));
      // created_time(오프셋 포함 ISO) → 한국 날짜. Meta date_preset과 같은 계정 시간대 기준.
      const regDate = (ct: string) => {
        const d = new Date(ct);
        return isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
      };
      const ads = adRows.map((a) => {
        const id = String(a.id ?? "");
        const m = metric.get(id);
        return {
          id,
          name: String(a.name ?? ""),
          adset_id: String(a.adset_id ?? ""),
          adset_name: setName.get(String(a.adset_id ?? "")) ?? "",
          status: String(a.status ?? ""),                       // 소재 자체 스위치 (ACTIVE/PAUSED)
          effective_status: String(a.effective_status ?? ""),   // 실제 상태 (상위 꺼짐·검토중·거부 포함)
          created_time: String(a.created_time ?? ""),
          reg_date: regDate(String(a.created_time ?? "")),
          spend: m ? num(m.spend) : 0,
          purchases: m ? pickPurchase(m.actions) : 0,
          value: m ? pickPurchase(m.action_values) : 0,
        };
      });
      const body = {
        fetched_at: new Date().toISOString(),
        until: today,
        adset_count: setIds.length,
        truncated: setName.size > setIds.length,
        ads,
      };
      await cacheSet(cacheKey, body);
      return json(body);
    }

    // ── 예산 변경 이력 (2026-08-26) — Meta 계정 활동(activities)에서 예산 이벤트만 추출 ──
    // 광고관리자에서 예산을 바꾸면 Meta가 활동 로그에 남긴다(약 90일 보관): 이벤트 시각·대상·old/new 값.
    // 우리가 따로 기록할 필요 없이 실제 변경 시각(분 단위)을 그대로 얻는다. 60초 캐시.
    if (action === "budgethistory") {
      const s = url.searchParams.get("start_date") ?? seoulToday();
      const e = url.searchParams.get("end_date") ?? seoulToday();
      const debug = url.searchParams.get("debug") === "1";
      const cacheKey = `meta:budgethist:${s}:${e}`;
      if (!debug) {
        const hit = await cacheGet(cacheKey, 60 * 1000);
        if (hit) return json(hit);
      }
      const rows = await graphGetAll(`${c.account}/activities`, {
        fields: "event_type,event_time,object_id,object_name,object_type,extra_data",
        since: s,
        until: addDays(e, 1),   // until은 그 날 0시 기준이라 하루 더해 종료일을 포함시킨다
        limit: "500",
      }, c.token, 4);
      if (debug) {   // 이벤트 타입·extra_data 실물 확인용 (검증 후에도 무해하게 유지)
        return json({ count: rows.length, sample: rows.slice(0, 30) });
      }
      // 이벤트 타입 실측(2026-08-26): update_ad_set_budget / update_campaign_budget 두 가지가 금액 변경.
      // (update_campaign_budget_scheduling_state 같은 비금액 budget 이벤트는 제외.)
      // extra_data는 중첩 JSON 문자열: {old_value:{old_value:30000,...}, new_value:{new_value:50000, additional_value:"(일일 기준)"}}
      // object_type은 Meta 옛 명칭이라 헷갈림(CAMPAIGN=광고세트!) — 층 판정은 event_type으로 한다.
      const events = rows
        .filter((r) => /^update_(ad_set|campaign)_budget$/.test(String(r.event_type ?? "")))
        .map((r) => {
          let extra: Record<string, unknown> = {};
          try {
            const raw = r.extra_data;
            extra = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>) ?? {};
          } catch { /* extra_data 없음/비JSON — old/new 없이 반환 */ }
          const ov = (extra.old_value ?? {}) as Record<string, unknown>;
          const nv = (extra.new_value ?? {}) as Record<string, unknown>;
          return {
            time: String(r.event_time ?? ""),
            level: String(r.event_type ?? "").startsWith("update_ad_set") ? "adset" : "campaign",
            object_id: String(r.object_id ?? ""),
            object_name: String(r.object_name ?? ""),
            old_value: num(ov.old_value ?? extra.old_value),
            new_value: num(nv.new_value ?? extra.new_value),
            note: String(nv.additional_value ?? ""),   // "(일일 기준)" 등
          };
        })
        .filter((ev) => ev.old_value > 0 || ev.new_value > 0);
      const body = { period: { start: s, end: e }, count: events.length, events };
      await cacheSet(cacheKey, body);
      return json(body);
    }

    // ── 시간대별 성과 (2026-08-26) — 예산 변경 영향 분석용: 어제~오늘 시간별 지출·구매 ──
    // breakdowns=hourly_stats_...advertiser_time_zone = 광고계정 시간대(한국) 기준 시간 버킷.
    // time_increment=1로 날짜별 분리 → 최대 48행. 5분 캐시.
    if (action === "hourlystats") {
      const objId = url.searchParams.get("object_id");
      if (!objId) return json({ error: "object_id 필수 (광고세트/캠페인 id)" }, 400);
      const t = seoulToday(), y = addDays(t, -1);
      const cacheKey = `meta:hourly:${objId}:${t}`;
      const hit = await cacheGet(cacheKey, 5 * 60 * 1000);
      if (hit) return json(hit);
      const body = await graphGet(`${objId}/insights`, {
        time_range: JSON.stringify({ since: y, until: t }),
        time_increment: "1",
        breakdowns: "hourly_stats_aggregated_by_advertiser_time_zone",
        fields: "spend,actions,action_values",
        limit: "100",
      }, c.token);
      const rows = ((body.data ?? []) as Record<string, unknown>[]).map((r) => ({
        date: String(r.date_start ?? ""),
        hour: parseInt(String(r.hourly_stats_aggregated_by_advertiser_time_zone ?? "0").slice(0, 2), 10) || 0,
        spend: num(r.spend),
        purchases: pickPurchase(r.actions),
        value: pickPurchase(r.action_values),
      }));
      const out = { today: t, yesterday: y, rows };
      await cacheSet(cacheKey, out);
      return json(out);
    }

    // 소재별 기간 통계 — 오늘/어제/최근3일/최근7일/이전7일/최근14일/최근30일의 지출·ROAS
    // (last_7d 등 date_preset은 오늘을 제외하고 어제까지 집계 — Meta 표준)
    // '이전 7일' = 최근 7일 바로 앞 7일. Meta에 해당 프리셋이 없어 time_range로 직접 지정하며,
    // 기준일은 last_7d 응답의 date_start(광고계정 시간대 기준)에서 역산 — 응답이 비면 Asia/Seoul로 폴백.
    if (action === "adstats") {
      const adId = url.searchParams.get("ad_id");
      if (!adId) return json({ error: "ad_id 필수" }, 400);
      const FIELDS = "spend,purchase_roas,action_values,date_start,date_stop";
      const presets = ["today", "yesterday", "last_3d", "last_7d", "last_14d", "last_30d"];
      const results = await Promise.all(presets.map((p) =>
        graphGet(`${adId}/insights`, { date_preset: p, fields: FIELDS }, c.token)
          .catch(() => ({ data: [] }))));
      const rowOf = (r: unknown) =>
        ((((r ?? {}) as Record<string, unknown>).data ?? []) as Record<string, unknown>[])[0] ?? {};

      const last7Start = String(rowOf(results[presets.indexOf("last_7d")]).date_start ?? "") ||
        addDays(seoulToday(), -7);
      const prevRange = { since: addDays(last7Start, -7), until: addDays(last7Start, -1) };
      const prevBody = await graphGet(`${adId}/insights`, {
        time_range: JSON.stringify(prevRange),
        fields: FIELDS,
      }, c.token).catch(() => ({ data: [] }));

      const toStat = (preset: string, r: Record<string, unknown>) => {
        const spend = num(r.spend);
        const roasArr = (r.purchase_roas ?? []) as { value?: unknown }[];
        const pv = pickPurchase(r.action_values);
        return {
          preset,
          spend,
          roas: roasArr.length ? num(roasArr[0].value) : (spend > 0 ? pv / spend : 0),
          start: String(r.date_start ?? ""),
          end: String(r.date_stop ?? ""),
        };
      };
      const byPreset: Record<string, ReturnType<typeof toStat>> = {};
      presets.forEach((p, i) => { byPreset[p] = toStat(p, rowOf(results[i])); });
      // 지출이 0이면 Meta가 빈 응답을 주므로 날짜는 우리가 계산한 범위로 채운다
      const prevStat = { ...toStat("prev_7d", rowOf(prevBody)), start: prevRange.since, end: prevRange.until };

      // 표시 순서: 오늘 → 어제 → 최근3일 → 최근7일 → 이전7일 → 최근14일 → 최근30일
      const stats = [
        byPreset.today, byPreset.yesterday, byPreset.last_3d, byPreset.last_7d,
        prevStat, byPreset.last_14d, byPreset.last_30d,
      ];
      return json({ ad_id: adId, stats });
    }

    // 소재 미리보기 — 실제 게재 형태의 iframe + 썸네일 (이미지·영상 모두 iframe 안에서 재생됨)
    if (action === "preview") {
      const adId = url.searchParams.get("ad_id");
      if (!adId) return json({ error: "ad_id 필수" }, 400);
      const [prev, meta] = await Promise.all([
        graphGet(`${adId}/previews`, { ad_format: "INSTAGRAM_STANDARD" }, c.token)
          .catch(() => graphGet(`${adId}/previews`, { ad_format: "DESKTOP_FEED_STANDARD" }, c.token)),
        graphGet(`${adId}`, { fields: "name,creative{thumbnail_url}", thumbnail_width: "512", thumbnail_height: "512" }, c.token)
          .catch(() => ({})),
      ]);
      const iframe = String(((prev.data ?? []) as { body?: string }[])[0]?.body ?? "");
      const creative = (meta as Record<string, Record<string, unknown>>).creative ?? {};
      return json({
        ad_id: adId,
        name: String((meta as Record<string, unknown>).name ?? ""),
        iframe,
        thumbnail: String(creative.thumbnail_url ?? ""),
      });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e).slice(0, 400) }, 500);
  }
});
