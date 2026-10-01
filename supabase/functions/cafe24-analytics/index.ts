// ═══════════════════════════════════════════════
// 카페24 애널리틱스 — 상품 조회수·주문수·주문율
//   GET ?action=summary&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD[&device_type=pc|mobile]
//     → { rows: [{product_no, product_name, views, order_count, order_qty, order_amount, rate}], totals }
//   GET ?action=categories
//     → { categories: [{category_no, category_name, category_depth, parent_category_no}] }
//   GET ?action=category_products&category_no=N
//     → { product_nos: [...] }
//
// 데이터 출처:
//   조회수/주문수 — 카페24 애널리틱스 API (ca-api.cafe24data.com, scope: mall.read_analytics)
//   카테고리     — Admin API (scope: mall.read_category)
// ═══════════════════════════════════════════════
import { cacheGet, cacheSet, handleOptions, json, getToken, saveToken, verifyAuthToken, safeEqual } from "../_shared/util.ts";

const MALL_ID = Deno.env.get("CAFE24_MALL_ID")!;
const CLIENT_ID = Deno.env.get("CAFE24_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("CAFE24_CLIENT_SECRET")!;
const API_BASE = `https://${MALL_ID}.cafe24api.com/api/v2`;
const DATA_BASE = "https://ca-api.cafe24data.com";
const API_VERSION = "2026-03-01";

// ── 액세스 토큰 확보 (만료 임박 시 refresh) — cafe24-claims와 동일 로직 ──
// force=true: 저장된 만료시각과 무관하게 강제 재발급 (401 복구용 — 동시 갱신 경쟁으로
// 다른 인스턴스가 새 토큰을 발급하면 기존 토큰이 무효화되어 만료시각만으론 판단 불가)
async function getAccessToken(force = false): Promise<string> {
  const t = await getToken("cafe24");
  if (!t?.refresh_token) throw new Error("카페24 미연동: 먼저 cafe24-oauth?action=start 로 인증하세요.");

  const expiresAt = t.expires_at ? new Date(t.expires_at).getTime() : 0;
  const stillValid = expiresAt - Date.now() > 5 * 60 * 1000;
  if (!force && stillValid && t.access_token) return t.access_token;

  const basic = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  const body = await res.json();
  if (!res.ok) {
    // 다른 인스턴스가 먼저 갱신했을 수 있음 → 잠시 후 DB의 최신 토큰 재사용
    await new Promise((r) => setTimeout(r, 1500));
    const latest = await getToken("cafe24");
    if (latest?.access_token && latest.access_token !== t.access_token) return latest.access_token;
    throw new Error(`토큰 갱신 실패 ${res.status}: ${JSON.stringify(body)} — 재인증이 필요할 수 있습니다.`);
  }

  const now = Date.now();
  await saveToken({
    provider: "cafe24",
    access_token: String(body.access_token ?? ""),
    refresh_token: String(body.refresh_token ?? t.refresh_token),
    expires_at: body.expires_at
      ? new Date(String(body.expires_at)).toISOString()
      : new Date(now + 2 * 3600 * 1000).toISOString(),
    refresh_expires_at: body.refresh_token_expires_at
      ? new Date(String(body.refresh_token_expires_at)).toISOString()
      : new Date(now + 14 * 24 * 3600 * 1000).toISOString(),
  });
  return String(body.access_token);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Supabase 테이블 직접 접근(서비스 키) — 반품 송장 스캔 인덱스/설정용 (2026-09-22) ──
async function sbRest(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/* ══ 반품 송장 스캔 (2026-09-22 사용자 요청) ══
   문제: 수거된 반품 상자의 송장 바코드를 찍어도 카페24에서 주문을 못 찾고, 불량·오배송 건인지 바로 알 수 없다.
   해법: 최근 N일 반품(R*)·교환(E*) 주문을 embed=return|exchange 로 모아 return_invoice_no → 주문 인덱스를 만들어 두고(rscan_index),
        스캔한 번호로 조회. 네이버페이 주문은 카페24에 반품 송장이 없어(실측 0건) 네이버페이센터 엑셀(rscan_naver)로 보완.
   경고 규칙(기본값, rscan_settings로 조정): 자사몰 claim_reason_type 불량 K·V·D / 배송오류 C·J·W (6개월 실데이터 사유 원문으로 판정),
        사유 원문 키워드(불량·파손·하자·오염·이염·올풀림·박음질·봉제 / 오배송·잘못 발송·다른 상품·타상품), 네이버페이 사유 '오배송'·'상품 파손'·'불량'. */
const RSCAN_DEFAULTS = {
  defect_codes: ["K", "V", "D"], misdeliver_codes: ["C", "J", "W"],
  defect_words: ["불량", "파손", "하자", "오염", "이염", "올풀림", "올 풀림", "박음질", "봉제", "구멍", "얼룩"],
  misdeliver_words: ["오배송", "잘못 발송", "잘못발송", "다른 상품", "다른상품", "타상품", "잘못된 상품", "다른 색상", "다른색상", "누락"],
  naver_words: ["오배송", "상품 파손", "파손", "불량"],
};
async function rscanSettings() {
  try { const rows = await sbRest("rscan_settings?id=eq.1&select=settings"); return { ...RSCAN_DEFAULTS, ...((rows?.[0]?.settings) ?? {}) }; } catch { return RSCAN_DEFAULTS; }
}
function rscanJudge(entry: Record<string, any>, st: typeof RSCAN_DEFAULTS) {
  const reason = String(entry.reason ?? "");
  const has = (words: string[]) => words.find((w) => w && reason.includes(w));
  if (entry.naver) {
    const w = has(st.naver_words);
    if (w) return { level: "alert", type: /오배송/.test(w) ? "오배송" : "불량", by: "네이버 사유", hit: w };
    return null;
  }
  const t = String(entry.reason_type ?? "");
  if (t && st.defect_codes.includes(t)) return { level: "alert", type: "불량", by: "사유 코드", hit: t };
  if (t && st.misdeliver_codes.includes(t)) return { level: "alert", type: "오배송", by: "사유 코드", hit: t };
  let w = has(st.defect_words); if (w) return { level: "warn", type: "불량", by: "사유 문구", hit: w };
  w = has(st.misdeliver_words); if (w) return { level: "warn", type: "오배송", by: "사유 문구", hit: w };
  return null;
}
const rscanDigits = (v: unknown) => String(v ?? "").replace(/[^0-9A-Za-z]/g, "");
// 최근 days일 반품·교환 주문 → 인덱스 행. 창은 30일씩(카페24 조회 범위 제한), 페이지 200.
// 기간은 '어제까지 최근 N일'(주문일 기준, 한국 시간) — 2026-09-22 사용자 요청. 오늘 주문은 반품 수거가 있을 수 없어 제외해도 무해.
function rscanYesterday() {
  const d = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date()) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1); return d;
}
function rscanStartDate(days: number) { const d = rscanYesterday(); d.setUTCDate(d.getUTCDate() - (days - 1)); return d.toISOString().slice(0, 10); }
// 워크스페이스에서 수거 완료 처리한 접수 → { by, at, recover } (2026-09-28 사용자 요청: 누가 눌렀는지·재고 복구 여부를 나중에도 확인)
async function rscanCollectedMap(): Promise<Record<string, { by: string; at: string; recover: string | null; defect: boolean | null }>> {
  const since = new Date(Date.now() - 120 * 24 * 3600e3).toISOString();
  const rows = ((await sbRest(`rscan_actions?select=claim_code,kind,by_name,created_at,recover_inventory,defect&ok=eq.true&action=eq.collect&created_at=gte.${since}&order=created_at.asc&limit=5000`).catch(() => [])) ?? []) as Record<string, any>[];
  const map: Record<string, { by: string; at: string; recover: string | null; defect: boolean | null }> = {};
  for (const r of rows) map[`${r.kind}:${r.claim_code}`] = { by: String(r.by_name ?? ""), at: String(r.created_at), recover: r.recover_inventory ?? null, defect: r.defect ?? null };
  return map;
}

/* ── 반품 불가 품목 표시 (2026-09-28 사용자 지정) ──
   block(반품 불가): 상품명에 비키니·모노키니·swim·수영복 / ACC 카테고리(이름이 정확히 'ACC'인 모든 카테고리) 상품 중 주얼리·양말·모자(상품명 키워드)
                     + 할인 적용 품목(additional_discount_price > 0) 중 1+1·신상 7%가 아닌 것
   check(확인 필요): 주문 당시 할인은 없었지만 지금 세일 카테고리(이름에 sale·세일·할인, 1+1 제외)에 있는 상품
   표시 없음(반품 가능): 1+1 상품, 신상 7% 세일
   카테고리 상품 목록은 30분 캐시(api_cache rscan:nrsets). */
type NrSets = { acc: number[]; sale: Record<string, string[]> };
async function rscanNrSets(token: string): Promise<NrSets> {
  const hit = (await cacheGet("rscan:nrsets", 30 * 60 * 1000)) as NrSets | null;
  if (hit && Array.isArray(hit.acc)) return hit;
  const cats: Record<string, any>[] = [];
  for (let offset = 0; offset <= 1000; offset += 100) {
    const body = await apiGet(`${API_BASE}/admin/categories?limit=100&offset=${offset}&fields=category_no,category_name`, token);
    const items = (body.categories ?? []) as Record<string, any>[];
    cats.push(...items);
    if (items.length < 100) break;
  }
  const plain = (n: unknown) => String(n ?? "").replace(/[^0-9A-Za-z가-힣+%~ ]/g, " ").replace(/\s+/g, " ").trim();
  const productsOf = async (no: number) => (((await apiGet(`${API_BASE}/admin/categories/${Number(no)}/products?display_group=1&limit=1000`, token)).products ?? []) as Record<string, any>[]).map((p) => Number(p.product_no));
  const sets: NrSets = { acc: [], sale: {} };
  for (const c of cats) {
    const name = plain(c.category_name);
    const isAcc = name.toLowerCase() === "acc", isSale = /sale|세일|할인/i.test(name);
    if (!isAcc && !isSale) continue;
    const nos = await productsOf(Number(c.category_no));
    if (isAcc) sets.acc.push(...nos);
    else for (const no of nos) (sets.sale[String(no)] ??= []).push(name);
  }
  sets.acc = [...new Set(sets.acc)];
  await cacheSet("rscan:nrsets", sets);
  return sets;
}
function rscanItemFlags(it: Record<string, any>, sets: NrSets): { level: "block" | "check"; type: string; text: string }[] {
  const flags: { level: "block" | "check"; type: string; text: string }[] = [];
  const name = String(it.product_name ?? it.name ?? "");
  if (/비키니|모노키니|swim|수영복/i.test(name)) flags.push({ level: "block", type: "수영복", text: "수영복 — 반품 불가" });
  const no = Number(it.product_no);
  // ACC 카테고리 중 주얼리·양말·모자만 반품 불가 (2026-09-28 사용자 정정 — 신발·벨트·가방·머플러·헤어핀 등은 반품 가능).
  // '링'은 '스트링'·'셔링' 같은 단어에 걸리지 않게 앞뒤가 띄어쓰기/괄호일 때만.
  if (no && sets.acc.includes(no)) {
    const kind = /목걸이|네크리스|반지|오픈링|(?:^|[\s(])링(?=$|[\s)(])|귀걸이|귀찌|이어링|팔찌|발찌|주얼리|쥬얼리/.test(name) ? "주얼리"
      : /양말|삭스|socks?/i.test(name) ? "양말"
      : /모자|볼캡|버킷햇|벙거지|비니|(?:^|\s)캡(?=$|[\s(])|(?:^|\s)햇(?=$|[\s(])/.test(name) ? "모자" : "";
    if (kind) flags.push({ level: "block", type: kind, text: `${kind}(ACC) — 반품 불가` });
  }
  // 할인 상품 (2026-09-28 사용자 확정): 1+1 과 신상 7% 세일은 반품 가능, 그 밖의 할인은 반품 불가.
  //  · 1+1 = 상품명에 '1+1' 이 있거나 이름에 '1+1' 이 든 카테고리(현재 '1+1 할인')의 상품 — 실데이터상 할인율은 11~51%로 제각각이라 비율로는 못 가림
  //  · 신상 7% = 할인율 6.0~7.6% (실측 6.9~7.1%, 100원 단위 절사 때문에 정확히 7이 아님)
  //  · 주문 당시 할인이 없었는데 지금 세일 카테고리에 있는 상품은 정가 구매일 수 있어 '확인'으로만 표시
  const disc = Number(it.additional_discount_price ?? it.disc ?? 0) || 0;
  const price = (Number(it.product_price ?? it.price ?? 0) || 0) + (Number(it.option_price ?? 0) || 0);
  const pct = price > 0 ? disc / price * 100 : 0;
  const sc = (no ? sets.sale[String(no)] : null) ?? [];
  const onePlusOne = /1\s*\+\s*1/.test(name) || sc.some((n) => /1\s*\+\s*1/.test(n));
  const newArrival7 = disc > 0 && pct >= 6.0 && pct <= 7.6;
  if (disc > 0 && !onePlusOne && !newArrival7) {
    flags.push({ level: "block", type: "할인", text: `할인 상품 ${Math.round(disc).toLocaleString("ko-KR")}원${price > 0 ? ` (${Math.round(pct)}%)` : ""} — 반품 불가` });
  } else if (disc <= 0 && !onePlusOne) {
    const others = sc.filter((n) => !/1\s*\+\s*1/.test(n));
    if (others.length) flags.push({ level: "check", type: "세일", text: `세일 카테고리(${others.join(", ")}) 상품 · 주문 당시 할인 없음 — 확인` });
  }
  return flags;
}
// 카페24 주문 1건 → 인덱스 항목(접수별). rscanBuild와 특별관리 주문 직접 조회(rscanFetchOrders)가 같이 쓴다.
function rscanEntriesOf(o: Record<string, any>, kind: "return" | "exchange", nrSets: NrSets, seen: Set<string>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const claims = (o[kind] ?? []) as Record<string, any>[];
  const items = (o.items ?? []) as Record<string, any>[];
  const recv = ((o.receivers ?? []) as Record<string, any>[])[0] ?? {};
  const naver = o.order_place_id === "NCHECKOUT";
  for (const c of (claims.length ? claims : [{}])) {
    const key = `${kind}:${o.order_id}:${c.claim_code ?? ""}`;
    if (seen.has(key)) continue; seen.add(key);
    // 고객이 반품·교환 접수한 품목만(2026-09-22 사용자 지적 — 전에는 claim_code 없는 정상 품목까지 섞여 주문 상품이 다 보였음):
    // ① 이 클레임 코드가 붙은 품목 → ② 없으면 반품(R)·교환(E) 상태인 품목 → ③ 그래도 없으면 전체(안전망)
    // 교환 접수는 수거 후 새 발송 품목(exchanged_items)도 같은 claim_code를 달고 나온다(2026-09-30 실측 20260918-0004868-04 배송중) → 고객이 보낸 품목만
    const newCodes = new Set(((c.exchanged_items ?? []) as Record<string, any>[]).map((x) => String(x.order_item_code ?? "")).filter(Boolean));
    let its = c.claim_code ? items.filter((it) => it.claim_code === c.claim_code && !newCodes.has(String(it.order_item_code ?? ""))) : [];
    if (!its.length) its = items.filter((it) => /^[RE]\d/.test(String(it.order_status ?? "")));
    if (!its.length) its = items;
    out.push({
      kind, invoice: rscanDigits(c.return_invoice_no), company: c.return_shipping_company_name ?? null,
      order_id: o.order_id, order_date: String(o.order_date ?? "").slice(0, 10), place: o.order_place_name ?? "", naver,
      claim_code: c.claim_code ?? null, reason_type: c.claim_reason_type ?? null, reason: String(c.claim_reason ?? "").trim(),
      claim_date: String(its[0]?.return_request_date ?? its[0]?.exchange_request_date ?? c.claim_due_date ?? "").slice(0, 10),
      status: its[0]?.status_text ?? its[0]?.order_status ?? "", status_extra: its[0]?.order_status_additional_info ?? "",
      buyer: o.billing_name ?? "", receiver: recv.name ?? "",
      address: [recv.address1, recv.address2].filter(Boolean).join(" ").trim(), phone: String(recv.cellphone ?? recv.phone ?? "").replace(/[^0-9]/g, ""),   // 이름·주소 찾기용 (2026-09-23)
      items: its.map((it) => ({ name: it.product_name, option: it.option_value ?? "", qty: Number(it.quantity ?? 0), tracking_no: it.tracking_no ?? "", status: it.status_text ?? "", naver_id: it.naver_pay_order_id ?? null, product_no: it.product_no ?? null, nr: rscanItemFlags(it, nrSets) })),
      naver_ids: [...new Set(its.map((it) => it.naver_pay_order_id).filter(Boolean))],
    });
  }
  return out;
}
// 특별관리 주문(목록 기간 밖)을 카페24에서 주문번호로 직접 조회 (2026-09-28). order_id 여러 개는 날짜 조건 없이 한 번에 조회됨(실측) — 50개씩.
async function rscanFetchOrders(targets: { kind: "return" | "exchange"; order_id: string }[], token: string): Promise<Record<string, unknown>[]> {
  if (!targets.length) return [];
  const nrSets = await rscanNrSets(token).catch(() => ({ acc: [], sale: {} } as NrSets));
  const ids = [...new Set(targets.map((t) => t.order_id).filter((id) => /^\d{8}-\d{7}$/.test(id)))];
  const want = new Set(targets.map((t) => `${t.kind}:${t.order_id}`));
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const body = await apiGet(`${API_BASE}/admin/orders?order_id=${ids.slice(i, i + 50).join(",")}&embed=items,return,exchange,receivers&limit=100`, token);
    for (const o of (body.orders ?? []) as Record<string, any>[]) {
      for (const kind of ["return", "exchange"] as const) if (want.has(`${kind}:${o.order_id}`)) out.push(...rscanEntriesOf(o, kind, nrSets, seen));
    }
  }
  return out;
}
// ── 미발송 관리 (2026-09-28 사용자 요청 — 물류팀): 결제 후 아직 발송 안 된 품목 수집 ──
// 품목 상태 N10 상품준비중·N20 배송준비중·N21 배송대기·N22 배송보류 = 미발송(실측: 이 몰은 거의 N20).
// 지연 일수 = 오늘(한국 날짜) − 결제일(한국 날짜). 주문일 기준 최근 90일 ~ 3일 전 주문을 30일 창·200건씩 조회
// (결제일은 주문일 이후라 3일 전까지만 봐도 지연 3일↑는 빠짐없음 — 화면 기준은 최소 5일).
// 거래처 문의용으로 카페24 품목의 공급사(supplier_name)·공급사 상품명(supplier_product_name, 끝에 공급가가 붙어 있음 — 화면이 제거)을 그대로 넘긴다.
const UNSHIP_STATUSES = new Set(["N10", "N20", "N21", "N22"]);
async function unshipCollect(token: string) {
  const fmtD = (d: Date) => d.toISOString().slice(0, 10);
  const today = rscanYesterday(); today.setUTCDate(today.getUTCDate() + 1);   // 한국 날짜 오늘(UTC 자정 표기)
  const todayStr = fmtD(today);
  const windows: [string, string][] = [];
  let end = new Date(today); end.setUTCDate(end.getUTCDate() - 3);
  let left = 90;
  while (left > 0) { const span = Math.min(30, left); const start = new Date(end); start.setUTCDate(start.getUTCDate() - (span - 1)); windows.push([fmtD(start), fmtD(end)]); end = new Date(start); end.setUTCDate(end.getUTCDate() - 1); left -= span; }
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let exchanges = 0;   // 교환 재발송 품목 수 (교환 접수일 기준으로 셈)
  const npayClaims: Record<string, unknown>[] = [];   // 네이버페이 클레임 상태 미발송 품목(목록 제외, 확인 필요)
  for (const [a, b] of windows) {
    for (let offset = 0; offset < 10000; offset += 200) {
      const body = await apiGet(`${API_BASE}/admin/orders?start_date=${a}&end_date=${b}&order_status=N10,N20,N21,N22&embed=items&limit=200&offset=${offset}&date_type=order_date`, token);
      const orders = (body.orders ?? []) as Record<string, any>[];
      for (const o of orders) {
        const paid = String(o.payment_date ?? "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(paid)) continue;
        const daysSince = (d: string) => Math.round((new Date(todayStr + "T00:00:00Z").getTime() - new Date(d + "T00:00:00Z").getTime()) / 86400000);
        // 교환 접수별 수거 상태: 같은 접수번호의 원래 품목(E* 교환처리중)의 부가 상태(수거전 등)
        const pickupOf = new Map<string, string>();
        // 원래 품목이 E30 교환처리중+'수거전'이면 '수거전', 그 외(E30 수거 후·E40 교환완료 — 실측 '교환완료'로 떠서 교환이 끝난 것처럼 보였음)는 '수거 완료'
        for (const x of (o.items ?? []) as Record<string, any>[]) if (x.claim_code && /^E/.test(String(x.order_status ?? ""))) pickupOf.set(String(x.claim_code), /수거전/.test(String(x.order_status_additional_info ?? "")) ? "수거전" : "수거 완료");
        for (const it of (o.items ?? []) as Record<string, any>[]) {
          if (!UNSHIP_STATUSES.has(String(it.order_status ?? ""))) continue;
          // 교환 재발송 품목 (2026-09-29 사용자 요청): 교환 접수 시 카페24가 새 품목 줄(N10 상품준비중 → 수거 후 N20)을 만들고 claim_code를 붙인다.
          // 원 결제일로 세면 16~17일 '장기 지연'으로 잘못 떴음(베베블라우스 20260912-0002171-04) → **교환 접수일부터** 센다.
          // 접수일 = 접수번호 앞 8자리(B20260918-0040987 → 2026-09-18, 실측 claim_due_date와 같음). 교환 상품도 거래처 입고가 늦으면 지연이 맞다(사용자).
          // ⚠ 교환 판별은 claim_code만: original_item_no는 교환이 아닌 일반 미발송 품목에도 붙어 있음(실측 5건, 예 20260926-0001149).
          // 네이버페이 클레임 상태 (2026-09-29 사용자 결정): 취소·반품·교환 **거부/철회(*_REJECT)**는 결국 보내야 하는 품목 → 지연 목록에 그대로 포함하고
          // 표시만(npay_claim). 요청 진행 중(CANCEL_REQUEST 등)은 취소될 수 있어 목록에서 빼고 'npay_claims'로 따로(화면 '네이버페이센터에서 확인 필요').
          // 실측 90일 전체 2건 모두 CANCEL_REJECT(윙키블라우스 20260914-0002813-03 등).
          const npayClaim = it.naver_pay_claim_status ? String(it.naver_pay_claim_status) : null;
          if (npayClaim && !/REJECT$/.test(npayClaim)) {
            npayClaims.push({ order_id: o.order_id, item_code: String(it.order_item_code ?? ""), paid, product_name: String(it.product_name ?? ""), option: String(it.option_value ?? ""),
              supplier: String(it.supplier_name ?? ""), naver_id: it.naver_pay_order_id ?? null, claim_status: npayClaim });
            continue;
          }
          let base = paid, exchange: Record<string, string> | null = null;
          if (it.claim_code) {
            const m = String(it.claim_code).match(/^[A-Z](\d{4})(\d{2})(\d{2})-/);
            if (!m) continue;
            base = `${m[1]}-${m[2]}-${m[3]}`;
            exchange = { code: String(it.claim_code), date: base, pickup: pickupOf.get(String(it.claim_code)) ?? "" };
          }
          const delay = daysSince(base);
          if (delay < 3) continue;
          const code = String(it.order_item_code ?? `${o.order_id}-${it.item_no}`);
          if (seen.has(code)) continue; seen.add(code);
          if (exchange) exchanges++;
          rows.push({
            order_id: o.order_id, item_code: code, order_date: String(o.order_date ?? "").slice(0, 10), paid, base, delay, exchange,
            place: o.order_place_name ?? "", naver: o.order_place_id === "NCHECKOUT",
            product_no: it.product_no ?? null, product_name: String(it.product_name ?? ""), option: String(it.option_value ?? ""), qty: Number(it.quantity ?? 0),
            supplier_id: String(it.supplier_id ?? ""), supplier: String(it.supplier_name ?? ""), supplier_product: String(it.supplier_product_name ?? ""),
            status: String(it.status_text ?? it.order_status ?? ""), expected: it.shipping_expected_date ?? null, npay_claim: npayClaim,
          });
        }
      }
      if (orders.length < 200) break;
    }
  }
  rows.sort((x, y) => Number(y.delay) - Number(x.delay));
  return { today: todayStr, built_at: new Date().toISOString(), range: { start: windows[windows.length - 1][0], end: windows[0][1] }, items: rows, exchange_items: exchanges, npay_claims: npayClaims };
}
async function rscanBuild(token: string, days: number) {
  const nrSets = await rscanNrSets(token).catch(() => ({ acc: [], sale: {} } as NrSets));   // 카테고리 조회 실패해도 목록 생성은 계속
  const fmtD = (d: Date) => d.toISOString().slice(0, 10);
  const windows: [string, string][] = [];
  let end = rscanYesterday(), left = days;
  while (left > 0) { const span = Math.min(30, left); const start = new Date(end); start.setUTCDate(start.getUTCDate() - (span - 1)); windows.push([fmtD(start), fmtD(end)]); end = new Date(start); end.setUTCDate(end.getUTCDate() - 1); left -= span; }
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const [kind, status, embed] of [["return", "R00,R10,R30,R34,R40", "items,return,receivers"], ["exchange", "E00,E10,E20,E30,E40", "items,exchange,receivers"]] as const) {
    for (const [a, b] of windows) {
      for (let offset = 0; offset < 6000; offset += 200) {
        const body = await apiGet(`${API_BASE}/admin/orders?start_date=${a}&end_date=${b}&order_status=${status}&embed=${embed}&limit=200&offset=${offset}&date_type=order_date`, token);
        const orders = (body.orders ?? []) as Record<string, any>[];
        for (const o of orders) out.push(...rscanEntriesOf(o, kind, nrSets, seen));
        if (orders.length < 200) break;
      }
    }
  }
  await sbRest("rscan_index?on_conflict=kind", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ kind: "cafe24", built_at: new Date().toISOString(), days, row_count: out.length, payload: out }) });
  return out;
}

// 카페24 요청 한도(429 "Too much requests occur. (40/40)") — 홈처럼 여러 조회가 겹치면 쉽게 걸린다.
// 버킷이 다시 차기를 기다렸다가 재시도한다. Retry-After가 오면 그 값을 우선 따른다.
const RATE_LIMIT_RETRIES = 6;

async function apiGet(url: string, token: string): Promise<Record<string, unknown>> {
  const doFetch = (tk: string) => fetch(url, {
    headers: {
      Authorization: `Bearer ${tk}`,
      "Content-Type": "application/json",
      "X-Cafe24-Api-Version": API_VERSION,
    },
  });
  let tok = token;
  let res = await doFetch(tok);
  if (res.status === 401) {
    // 동시 갱신 경쟁으로 토큰이 무효화된 경우 → 강제 재발급 후 1회 재시도
    tok = await getAccessToken(true);
    res = await doFetch(tok);
  }
  for (let i = 0; res.status === 429 && i < RATE_LIMIT_RETRIES; i++) {
    const ra = Number(res.headers.get("Retry-After"));
    await res.body?.cancel();
    await sleep(isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** i, 8000));
    res = await doFetch(tok);   // 갱신된 토큰으로 재시도 (보안 점검 2026-09-22 — 예전엔 무효화된 원래 토큰을 썼음)
  }
  const body = await res.json();
  if (!res.ok) throw new Error(`GET ${url.replace(/\?.*$/, "")} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// ══ 카페24 쓰기는 이 함수 하나뿐 (2026-09-28 안전장치, 사용자 요청) ══
// 앱 권한 mall.write_order는 주문 수정 전반을 허용하지만, 이 서버가 카페24에 보내는 쓰기는 "반품·교환 접수의 수거 완료 표시" 단 하나로 고정한다.
//  · 범용 쓰기 헬퍼를 두지 않는다 — 주소와 본문을 호출자가 넘기지 못하고, 검증된 주문번호·접수번호·품주코드로 이 함수가 직접 조립한다.
//  · 본문은 { shop_no:1, request:{ pickup_completed:"T", recover_inventory:"T"|"F", items:[{order_item_code}] } } 로 고정(상태 변경·철회·환불 필드 없음).
//    recover_inventory는 카페24가 수거 완료 전환에 필수로 요구(2026-09-28 실사용 422 "recover_inventory is necessary for change to a collected status") —
//    값은 서버가 정한다: 관리자 설정 collect_recover_inventory 기본 'auto'(불량 접수 F, 그 외 T), 'T'/'F'면 고정. 호출자(화면)는 지정할 수 없다.
//  · 다른 쓰기가 필요해지면 여기 허용 목록을 넓히지 말고 사용자 승인부터 받을 것. tools/check_cafe24_writes.sh 가 배포 전 검사한다.
async function cafe24MarkCollected(kind: "return" | "exchange", orderId: string, claimCode: string, itemCodes: string[], recover: "T" | "F", token: string): Promise<Record<string, unknown>> {
  if (kind !== "return" && kind !== "exchange") throw new Error("허용되지 않은 쓰기(kind)");
  if (recover !== "T" && recover !== "F") throw new Error("허용되지 않은 쓰기(재고 복구 값)");
  if (!/^\d{8}-\d{7}$/.test(orderId) || !/^[A-Z]\d{8}-\d{7}$/.test(claimCode)) throw new Error("허용되지 않은 쓰기(번호 형식)");
  if (!Array.isArray(itemCodes) || !itemCodes.length || itemCodes.length > 50 || itemCodes.some((c) => typeof c !== "string" || !c.startsWith(orderId + "-") || !/^\d{8}-\d{7}-\d{2,3}$/.test(c))) throw new Error("허용되지 않은 쓰기(품주코드)");
  const url = `${API_BASE}/admin/orders/${orderId}/${kind}/${claimCode}`;
  const payload = JSON.stringify({ shop_no: 1, request: { pickup_completed: "T", recover_inventory: recover, items: itemCodes.map((c) => ({ order_item_code: c })) } });
  const doFetch = (tk: string) => fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json", "X-Cafe24-Api-Version": API_VERSION }, body: payload });
  let tok = token;
  let res = await doFetch(tok);
  if (res.status === 401) { tok = await getAccessToken(true); res = await doFetch(tok); }
  for (let i = 0; res.status === 429 && i < RATE_LIMIT_RETRIES; i++) {
    const ra = Number(res.headers.get("Retry-After"));
    await res.body?.cancel();
    await sleep(isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** i, 8000));
    res = await doFetch(tok);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`PUT ${res.status}: ${JSON.stringify(body).slice(0, 400)}`), { status: res.status, body });
  return body;
}

// ── 품절 재고 점검 권한 (2026-09-29 사용자 요청): 관리자 + 물류팀. 서버 역할은 logistics→cs로 합쳐져 있어(CS팀과 구분 불가) 원래 역할을 다시 읽는다.
//    서버 간 비밀키(에이전트·자동 갱신·상품관리 연동)로는 허용하지 않는다.
async function soldoutRoleOk(authed: { id: string; role: string }): Promise<boolean> {
  if (["sales-agent", "cron", "npm-sync"].includes(authed.id)) return false;
  if (authed.role === "admin") return true;
  if (authed.role !== "cs") return false;
  const [row] = ((await sbRest(`app_users?id=eq.${encodeURIComponent(authed.id)}&select=role`)) ?? []) as Record<string, any>[];
  return String(row?.role ?? "") === "logistics";
}
// ── 품절 재고 점검 — 카페24 품목 설정 점검(읽기 전용, 2026-09-29) ──
// 처음엔 품목 설정을 고치는 쓰기(cafe24FixVariant, scope mall.write_product)까지 만들었으나 사용자 결정으로 제거:
// '상품 쓰기' 권한은 상품 삭제까지 포함하는 넓은 권한이라 열지 않기로 함 → 점검·표시 + 카페24 상품 수정 화면 바로가기만.
// 옵션값 → 비교용 값 토큰 (화면의 stkOptTokens와 같은 규칙: 쉼표·/·| 로 나누고 '='·':' 뒤 값, 글자·숫자만 소문자, 정렬)
function c24OptTokens(s: string): string {
  return String(s ?? "").split(/[,/|]/).map((part) => { const cut = Math.max(part.lastIndexOf("="), part.lastIndexOf(":")); return (cut >= 0 ? part.slice(cut + 1) : part).replace(/[^0-9a-zA-Z가-힣]/g, "").toLowerCase(); }).filter(Boolean).sort().join("|");
}
function c24VariantIssues(v: Record<string, any>, stock: number | null): string[] {
  const out: string[] = [];
  if (v.use_inventory !== "T") out.push("재고관리 사용안함");
  if (v.display_soldout !== "T") out.push("품절표시 안함");
  if (v.display !== "T") out.push("진열안함");
  if (v.selling !== "T") out.push("판매안함");
  if (stock != null && Number(v.quantity) !== stock) out.push(`재고수량 ${v.quantity ?? "-"} (셀메이트 ${stock})`);
  return out;
}

// 애널리틱스 API 페이지네이션 수집 (limit 최대 1000)
async function collectData(
  path: string, listKey: string, params: URLSearchParams, token: string,
): Promise<Record<string, unknown>[]> {
  const LIMIT = 1000;
  const all: Record<string, unknown>[] = [];
  for (let offset = 0; offset <= 20000; offset += LIMIT) {
    const p = new URLSearchParams(params);
    p.set("limit", String(LIMIT));
    p.set("offset", String(offset));
    const body = await apiGet(`${DATA_BASE}${path}?${p}`, token);
    const items = (body[listKey] ?? []) as Record<string, unknown>[];
    all.push(...items);
    if (items.length < LIMIT) break;
  }
  return all;
}

const num = (v: unknown) => {
  const n = parseFloat(String(v ?? "0"));
  return isFinite(n) ? n : 0;
};

// ── 주문 페이지네이션 (카페24 offset 상한 회피) ────────────────────────────
// 카페24는 offset이 15,000 이상이면 422를 준다:
//   "[Start location of list] must be less than 15000. (parameter.offset)"
// 분석 기간이 한 달만 돼도 패딩 포함 주문이 16,000건을 넘어(실측 7/1~7/31 → 16,321건)
// 조회 도중 422 → 500으로 죽었다. 그래서 **기간을 조각내어 조각마다 offset을 0부터 다시 센다.**
// 조각 크기는 /count로 실측해 정하고(상한을 넘으면 반으로 쪼갬), 조각들은 동시에 처리해 시간을 줄인다.
const CAFE24_MAX_OFFSET = 15000;
// 카페24는 조회 기간도 3개월 이내로 제한한다("...should be within 3 months days..." 422).
// 패딩(e+30일)까지 더하면 두 달짜리 분석도 넘길 수 있으므로 처음부터 80일 이하로 잘라 시작한다.
const MAX_RANGE_DAYS = 80;
// 한 번에 받는 주문 수. 카페24 상한 1,000 (2026-10-01 성능 점검: 500 → 1,000 — 실측 9월 13,083건, 500건 1.4초·1,000건 2.4초 →
// 호출 수가 절반이라 호출 한도(40개 버킷)에 여유가 생기고 전체 시간도 줄어든다. 응답 내용은 같다).
const ORDER_PAGE = 1000;
// 홈은 취소반품·판매성과·재고대조를 한꺼번에 부르므로, 조회 하나가 쓰는 동시 요청 수를 낮게 잡는다
// (전에 3으로 뒀다가 홈에서 3개월을 고르면 카페24 429가 났다)
const CHUNK_CONCURRENCY = 2;

const dayMs = 24 * 3600 * 1000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

// /count에는 **embed·fields를 넘기면 안 된다** — 그러면 카페24가 {count:N} 대신 []를 돌려줘서
// 건수가 0으로 읽히고 조회 범위가 통째로 버려진다(실측). 집계 대상에 영향을 주는 것만 남긴다.
const COUNT_PARAMS = new Set(["date_type", "order_status"]);
const countFilter = (filter: string) =>
  filter.split("&").filter((kv) => COUNT_PARAMS.has(kv.split("=")[0])).join("&");

// 반환값 -1 = 개수를 읽지 못함 (형식이 예상과 다름) → 쪼개지 말고 통째로 읽게 한다
async function countOrders(token: string, qs: string): Promise<number> {
  const body = await apiGet(`${API_BASE}/admin/orders/count?${qs}`, token);
  const c = (body as Record<string, unknown>).count;
  return c === undefined || c === null ? -1 : num(c);
}

// [s,e]를 offset 상한 안에 들어오는 날짜 조각들로 나눈다 (하루까지 쪼개도 넘치면 그대로 두고 상한까지만 읽음)
//  반환 [시작, 끝, 건수] — 건수(-1 = 못 읽음)는 eachOrder가 조각 안의 페이지 수를 미리 알기 위해 쓴다(2026-10-01).
async function splitOrderRanges(token: string, filter: string, s: string, e: string): Promise<[string, string, number][]> {
  const cf = countFilter(filter);
  const out: [string, string, number][] = [];
  // 3개월 제한부터 피하고 시작 — 80일 이하 조각으로 미리 나눈다
  const stack: [string, string][] = [];
  for (let t = new Date(s).getTime(), end = new Date(e).getTime(); t <= end;) {
    const chunkEnd = Math.min(t + (MAX_RANGE_DAYS - 1) * dayMs, end);
    stack.push([ymd(t), ymd(chunkEnd)]);
    t = chunkEnd + dayMs;
  }
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const c = await countOrders(token, `start_date=${a}&end_date=${b}&${cf}`);
    if (c === 0) continue;
    // 개수를 못 읽으면 예전처럼 통째로 읽는다 (데이터가 빈 채로 반환되는 사고 방지)
    if (c < 0 || c < CAFE24_MAX_OFFSET || a === b) { out.push([a, b, c]); continue; }
    const midMs = new Date(a).getTime() + Math.floor((new Date(b).getTime() - new Date(a).getTime()) / dayMs / 2) * dayMs;
    stack.push([a, ymd(midMs)], [ymd(midMs + dayMs), b]);
  }
  return out.sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

/** 기간 내 주문을 조각·페이지 단위로 모두 훑어 onOrders에 넘긴다.
 *  filter는 date_type·order_status·embed·fields 등 start_date/end_date를 뺀 나머지 쿼리스트링. */
async function eachOrder(
  token: string, filter: string, s: string, e: string,
  onOrders: (orders: Record<string, unknown>[]) => void,
): Promise<void> {
  const ranges = await splitOrderRanges(token, filter, s, e);
  // **부분배송 주문은 배송종료일이 여러 개라 두 조각 모두에 잡힌다**(실측: 조각 합계가 전체보다 176건 많음).
  // 조각을 나눈 뒤로 생긴 문제라 주문번호로 걸러 같은 주문을 두 번 세지 않는다.
  const seen = new Set<string>();
  const emit = (orders: Record<string, unknown>[]) => {
    const fresh = orders.filter((o) => {
      const id = String(o.order_id ?? "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (fresh.length) onOrders(fresh);
  };
  const fetchPage = async (a: string, b: string, offset: number) => {
    const body = await apiGet(
      `${API_BASE}/admin/orders?start_date=${a}&end_date=${b}&${filter}&limit=${ORDER_PAGE}&offset=${offset}`, token);
    return (body.orders ?? []) as Record<string, unknown>[];
  };
  // 2026-10-01 성능 점검: 예전엔 조각 '사이'만 동시에(2개) 읽고 조각 안의 페이지는 한 장씩 차례로 읽어, 한 달(조각 1개) 조회가 통째로 직렬이었다.
  //   이제 조각은 날짜순으로 하나씩, 조각 안의 페이지를 CHUNK_CONCURRENCY장씩 동시에 받는다(동시 요청 수 상한은 예전과 같은 2).
  //   건수(/count)로 페이지 수를 미리 알고, 받은 페이지는 **offset 순서대로** onOrders에 넘긴다(중복 제거·집계 순서가 직렬과 같음).
  //   건수를 못 읽었거나(c<0) 조회 중 주문이 늘어 마지막 예상 페이지가 꽉 찼으면 그 뒤는 예전처럼 한 장씩 이어 읽는다.
  for (const [a, b, c] of ranges) {
    const planned: number[] = [];
    if (c > 0) for (let off = 0; off < c && off < CAFE24_MAX_OFFSET; off += ORDER_PAGE) planned.push(off);
    let nextOffset = 0, lastFull = true;
    if (planned.length) {
      const results: (Record<string, unknown>[] | undefined)[] = new Array(planned.length);
      let take = 0, emitted = 0;
      const worker = async () => {
        while (take < planned.length) {
          const i = take++;
          results[i] = await fetchPage(a, b, planned[i]);
          while (emitted < planned.length && results[emitted] !== undefined) {   // 앞에서부터 순서대로 넘긴다
            const page = results[emitted]!;
            results[emitted] = [];   // 메모리 반환(자리 표시는 유지)
            emit(page);
            lastFull = page.length >= ORDER_PAGE;   // 페이지 끝 판정은 걸러내기 전 길이로
            emitted++;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, planned.length) }, worker));
      nextOffset = planned[planned.length - 1] + ORDER_PAGE;
    }
    // 건수를 몰랐거나, 마지막 예상 페이지가 꽉 찼으면(그사이 주문이 늘어남) 짧은 페이지가 나올 때까지 이어 읽는다
    if (!planned.length || lastFull) {
      for (let offset = nextOffset; offset < CAFE24_MAX_OFFSET; offset += ORDER_PAGE) {
        const orders = await fetchPage(a, b, offset);
        emit(orders);
        if (orders.length < ORDER_PAGE) break;
      }
    }
  }
}

// 카페24 claim_reason은 '신청 사유 (구매자|판매자 주문취소 : 접수 사유)' 형태로 두 사유가 합쳐져 온다.
// 실측 예: "사이즈작음 (구매자 주문취소 : 구매 의사 취소)" / "(판매자 주문취소 : )" (신청 사유 없음)
const CLAIM_ACCEPT_SUFFIX = /\((?:구매자|판매자)\s*주문취소\s*:\s*([^)]*)\)\s*$/;
function splitClaimReason(raw: unknown): { request: string; accept: string } {
  const s = String(raw ?? "").trim();
  const m = s.match(CLAIM_ACCEPT_SUFFIX);
  if (!m) return { request: s, accept: "" };
  return { request: s.slice(0, m.index).trim(), accept: (m[1] ?? "").trim() };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "summary";

  try {
    // 외부 차단: 전 액션 로그인 필수 — 서명·만료 + DB 실계정 확인 (역할은 DB 현재값)
    // 예외: madeavg만 상품관리 시스템(newproduct-manager) 서버가 NPM_SYNC_SECRET으로 호출 가능
    // (2026-09-03 사용자 요청 — 자체제작 주문 점검을 상품관리에도. syncexport와 동일 키)
    const syncSecret = Deno.env.get("NPM_SYNC_SECRET") ?? "";
    const viaSecret = action === "madeavg" && !!syncSecret && safeEqual(req.headers.get("x-sync-secret") ?? "", syncSecret);
    // 매출 분석 에이전트(sales-agent 함수)는 AGENT_SECRET으로 admin 권한 호출 (2026-09-10) — 서버 간 전용, 브라우저엔 노출 안 됨
    const agentSecret = Deno.env.get("AGENT_SECRET") ?? "";
    const viaAgent = !!agentSecret && safeEqual(req.headers.get("x-agent-secret") ?? "", agentSecret);
    // 반품 스캔 목록 자동 갱신(2026-09-22): pg_cron 잡 rscan-index-15min 이 x-cron-secret(CRON_SECRET)으로 rscan_build만 호출
    const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
    const viaCron = action === "rscan_build" && !!cronSecret && safeEqual(req.headers.get("x-cron-secret") ?? "", cronSecret);
    const authed = viaSecret
      ? { id: "npm-sync", name: "상품관리 연동", role: "staff", exp: 0 }
      : viaAgent ? { id: "sales-agent", name: "매출 분석 에이전트", role: "admin", exp: 0 }
      : viaCron ? { id: "cron", name: "자동 갱신", role: "admin", exp: 0 }
      : await verifyAuthToken(req);
    if (!authed) return json({ error: "로그인이 필요합니다" }, 401);

    // ── 결과 캐시 (분석 30분 · 미발송 목록 10분) — 무거운 주문 스캔 액션만. 반드시 각 액션의 **권한 검사 뒤에**
    // fromCache()를 불러야 한다 (캐시가 권한 우회 통로가 되면 안 됨).
    // performance는 역할에 따라 응답이 달라서(비관리자 order_amount=0) 키에 역할 포함.
    const qsKey = new URLSearchParams(url.search);
    qsKey.delete("nocache"); qsKey.sort();
    const cacheKey = `an:${qsKey.toString()}` + (action === "performance" ? `:${authed.role}` : "");
    const noCache = url.searchParams.get("nocache") === "1";
    // 저장 시간: 분석용 조회는 30분(2026-10-01 사용자 결정 — 첫 조회가 6~35초라 다시 기다리는 일을 줄임, 그동안 새 주문·취소는 미반영),
    //   미발송 목록은 10분 그대로(물류팀 실시간 작업 — 화면 새로고침 버튼은 nocache). api_cache 행은 1시간 뒤 자동 삭제.
    const CACHE_TTL_MS = (action === "unship_list" ? 10 : 30) * 60 * 1000;
    const fromCache = async () => noCache ? null : await cacheGet(cacheKey, CACHE_TTL_MS);
    const respond = async (body: unknown) => { await cacheSet(cacheKey, body); return json(body); };

    const token = await getAccessToken();

    // ── 품절 재고 점검 — 카페24 품목 설정 점검 (2026-09-29 사용자 요청, 읽기 전용): 관리자만, POST(목록을 본문으로 받음)
    if (action === "c24var_check") {
      if (!(await soldoutRoleOk(authed))) return json({ error: "접근 권한이 없습니다" }, 403);
      if (req.method !== "POST") return json({ error: "POST로 호출해주세요" }, 405);
      const b = await req.json().catch(() => ({})) as Record<string, any>;
      const readVariants = async (no: number) => ((await apiGet(`${API_BASE}/admin/products/${no}/variants?shop_no=1`, token)).variants ?? []) as Record<string, any>[];
      {
        // items: [{code(카페24 상품번호), options:[{opt_idx, option, stock}]}] — 옵션값 토큰으로 품목을 찾고 5가지 설정을 점검
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 60) as Record<string, any>[];
        const results: Record<string, unknown>[] = [];
        for (let k = 0; k < items.length; k += 4) {
          await Promise.all(items.slice(k, k + 4).map(async (it) => {
            const code = Number(it.code);
            if (!Number.isInteger(code) || code < 1) { results.push({ code: it.code ?? null, error: "카페24 상품번호(상품코드)가 없어요" }); return; }
            try {
              const [prod] = ((await apiGet(`${API_BASE}/admin/products?product_no=${code}&fields=product_no,product_name,display,selling`, token)).products ?? []) as Record<string, any>[];
              if (!prod) { results.push({ code, error: "카페24에 이 상품번호가 없어요" }); return; }
              const vars = await readVariants(code);
              const byTok = new Map<string, Record<string, any>[]>();
              for (const v of vars) { const t = c24OptTokens(((v.options ?? []) as Record<string, any>[]).map((o) => o.value).join(",")); byTok.set(t, [...(byTok.get(t) ?? []), v]); }
              const opts = ((it.options ?? []) as Record<string, any>[]).slice(0, 100).map((o) => {
                const stock = Number.isInteger(Number(o.stock)) ? Number(o.stock) : null;
                let hit = byTok.get(c24OptTokens(o.option)) ?? [];
                if (!hit.length && vars.length === 1 && !((vars[0].options ?? []).length)) hit = vars;   // 옵션 없는 상품
                if (hit.length !== 1) return { opt_idx: o.opt_idx, error: hit.length ? "카페24 품목이 여러 개 맞아요" : "카페24에서 같은 옵션을 못 찾았어요" };
                const v = hit[0];
                const issues = c24VariantIssues(v, stock);
                return { opt_idx: o.opt_idx, variant_code: v.variant_code, cur: { display: v.display, selling: v.selling, use_inventory: v.use_inventory, display_soldout: v.display_soldout, quantity: v.quantity }, issues, ok: !issues.length };
              });
              results.push({ code, product_name: prod.product_name, product_warn: [prod.display !== "T" ? "상품 진열안함" : "", prod.selling !== "T" ? "상품 판매안함" : ""].filter(Boolean), options: opts });
            } catch (e) { results.push({ code, error: "카페24 조회 실패 — " + String(e).slice(0, 150) }); }
          }));
        }
        return json({ results });
      }
    }

    // ── 미발송 관리 (2026-09-28 사용자 요청): 관리자·MD·CS/물류팀. 10분 캐시(권한 검사 뒤), 새로고침은 nocache=1
    if (action === "unship_list" || action === "unship_mark") {
      if (!["admin", "staff", "cs"].includes(authed.role)) return json({ error: "접근 권한이 없습니다" }, 403);
      // 상품별 입고일·특수 관리(unship_products)는 캐시하지 않고 매번 읽는다 — 목록(카페24 조회)만 10분 캐시
      const readMarks = async () => ((await sbRest("unship_products?select=key,product_no,product_name,supplier,supplier_product,arrival_date,arrival_history,special,special_note,special_by,special_at,memos,updated_at")) ?? []) as Record<string, any>[];
      if (action === "unship_list") {
        let base = await fromCache() as Record<string, unknown> | null;
        if (!base) { base = await unshipCollect(token); await cacheSet(cacheKey, base); }
        // 입고일 자동 기입 (2026-09-28 사용자 요청): 카페24 발송 예정일(shipping_expected_date)이 있는 상품은 그 날짜로 입고일을 채운다.
        //   상품에 날짜가 여러 개면 가장 늦은 날짜. 사람이 한 번이라도 입고일을 적거나 지웠으면(마지막 이력이 수동) 자동으로 덮지 않는다.
        //   자동 기입도 이력에 {auto:true, by:'카페24 발송 예정일'}로 남아서, 카페24에서 예정일이 늦춰지면 '추가 지연'으로 잡힌다.
        const marks = await readMarks();
        const byKey = new Map(marks.map((m) => [String(m.key), m]));
        const expMax = new Map<string, { date: string; name: string; supplier: string; supplier_product: string }>();
        for (const it of ((base as Record<string, any>).items ?? []) as Record<string, any>[]) {
          const d = String(it.expected ?? "").slice(0, 10);
          if (it.product_no == null || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
          const k = String(it.product_no), cur = expMax.get(k);
          if (!cur || d > cur.date) expMax.set(k, { date: d, name: it.product_name ?? "", supplier: it.supplier ?? "", supplier_product: it.supplier_product ?? "" });
        }
        const now = new Date().toISOString(), ups: Record<string, unknown>[] = [];
        for (const [k, e] of expMax) {
          const m = byKey.get(k);
          const hist = ((m?.arrival_history ?? []) as Record<string, any>[]);
          const last = hist[hist.length - 1];
          if (hist.length && !last?.auto) continue;   // 수동 입력·삭제가 마지막이면 사람 값 우선
          const prev = m?.arrival_date ? String(m.arrival_date).slice(0, 10) : null;
          if (prev === e.date) continue;
          const row = {
            key: k, product_no: Number(k), product_name: m?.product_name ?? e.name, supplier: m?.supplier ?? e.supplier, supplier_product: m?.supplier_product ?? e.supplier_product,
            arrival_date: e.date, arrival_history: [...hist, { date: e.date, prev, at: now, by: "카페24 발송 예정일", auto: true }].slice(-30),
            special: m?.special ?? false, special_note: m?.special_note ?? null, special_by: m?.special_by ?? null, special_at: m?.special_at ?? null, updated_at: now,
          };
          ups.push(row); byKey.set(k, { ...(m ?? {}), ...row });   // 응답엔 기존 메모(memos) 유지 — 저장 행에는 memos를 넣지 않아 DB 값도 그대로
        }
        if (ups.length) await sbRest("unship_products?on_conflict=key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(ups) }).catch(() => null);
        return json({ ...base, marks: [...byKey.values()], auto_filled: ups.length });
      }
      // ── 입고일·특수 관리 저장 (2026-09-28 사용자 요청): POST {key, product_no, product_name, supplier, supplier_product, arrival_date?, special?, special_note?}
      //    arrival_date가 바뀌면 이력에 {date, prev, at, by} 추가(최근 30건). 늦춰진 변경이 있으면 화면이 '추가 지연'으로 표시.
      if (req.method !== "POST") return json({ error: "POST로 호출해주세요" }, 405);
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const key = String(b.key ?? "");
      if (!/^\d{1,12}$/.test(key)) return json({ error: "상품번호가 올바르지 않습니다" }, 400);
      const [cur] = ((await sbRest(`unship_products?key=eq.${key}&select=*`)) ?? []) as Record<string, any>[];
      const now = new Date().toISOString();
      const txt = (v: unknown, n: number) => v == null ? null : String(v).trim().slice(0, n) || null;
      const row: Record<string, unknown> = {
        key, product_no: Number(key),
        product_name: txt(b.product_name, 200) ?? cur?.product_name ?? null, supplier: txt(b.supplier, 120) ?? cur?.supplier ?? null,
        supplier_product: txt(b.supplier_product, 200) ?? cur?.supplier_product ?? null,
        arrival_date: cur?.arrival_date ?? null, arrival_history: cur?.arrival_history ?? [],
        special: cur?.special ?? false, special_note: cur?.special_note ?? null, special_by: cur?.special_by ?? null, special_at: cur?.special_at ?? null, updated_at: now,
      };
      if ("arrival_date" in b) {
        const d = b.arrival_date == null || b.arrival_date === "" ? null : String(b.arrival_date);
        if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: "입고일 형식이 올바르지 않습니다" }, 400);
        const prev = cur?.arrival_date ? String(cur.arrival_date).slice(0, 10) : null;
        if (d !== prev) {
          row.arrival_date = d;
          row.arrival_history = [...((cur?.arrival_history ?? []) as unknown[]), { date: d, prev, at: now, by: authed.name }].slice(-30);
        }
      }
      if ("special" in b) {
        const on = b.special === true;
        if (on && !cur?.special) { row.special_by = authed.name; row.special_at = now; }
        if (!on) { row.special_by = null; row.special_at = null; row.special_note = null; }
        row.special = on;
      }
      if ("special_note" in b && row.special) row.special_note = txt(b.special_note, 200);
      // 직원 메모 (2026-10-01 사용자 요청): memo_add = 새 메모(최대 300자, 작성자 = 로그인 계정) / memo_del = 메모 id(작성자 본인 또는 관리자만).
      //   메모를 건드릴 때만 memos 열을 보낸다(입고일·특수 관리 저장이 동시에 일어나도 메모를 덮어쓰지 않게).
      if ("memo_add" in b || "memo_del" in b) {
        let memos = ((cur?.memos ?? []) as Record<string, any>[]).slice();
        if ("memo_add" in b) {
          const t = txt(b.memo_add, 300);
          if (!t) return json({ error: "메모 내용을 입력해주세요" }, 400);
          memos.push({ id: crypto.randomUUID().slice(0, 12), text: t, by: authed.name, by_id: authed.id, at: now });
          memos = memos.slice(-50);
        }
        if ("memo_del" in b) {
          const id = String(b.memo_del ?? "");
          const target = memos.find((x) => x.id === id);
          if (!target) return json({ error: "이미 지워진 메모예요" }, 404);
          if (target.by_id !== authed.id && authed.role !== "admin") return json({ error: "내가 쓴 메모만 지울 수 있어요" }, 403);
          memos = memos.filter((x) => x.id !== id);
        }
        row.memos = memos;
      }
      if (!cur && ((await sbRest("unship_products?select=key")) ?? []).length >= 3000) return json({ error: "기록이 너무 많아요 — 관리자에게 알려주세요" }, 400);
      await sbRest("unship_products?on_conflict=key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
      return json({ ok: true, mark: { ...row, memos: row.memos ?? cur?.memos ?? [] } });
    }

    // ── 중국 사입 관리 (2026-10-01 사용자 요청): 입고 엑셀(전달 수량) ↔ 현장 실제 수량 비교. 관리자·MD·CS/물류팀 ──
    //   cn_list   GET  — 입고 건·옵션 줄 + 카페24 등록 여부(사입상품명 = 공급사 상품명). 단가는 관리자·MD에게만.
    //   cn_upload POST — 엑셀에서 읽은 줄을 입고 건 하나로 저장 (관리자·MD)
    //   cn_check  POST — 실제 수량·메모 기입 (전원, 확인자는 서버가 로그인 계정으로 기입)
    //   cn_ship   POST — 입고 건 정보 수정·삭제 (관리자·MD)
    //   cn_vendor POST — 사입상품명별 거래처명 수동 입력 (관리자·MD, 2026-10-01 — 입고 건 단위가 아니라 상품마다)
    if (action === "cn_list" || action === "cn_upload" || action === "cn_check" || action === "cn_ship" || action === "cn_vendor") {
      if (!["admin", "staff", "cs"].includes(authed.role)) return json({ error: "접근 권한이 없습니다" }, 403);
      const canPrice = authed.role !== "cs";   // 단가·금액 = 관리자 + MD
      const canEdit = canPrice;                // 엑셀 올리기·입고 건 수정·삭제 = 관리자 + MD
      const txt = (v: unknown, n: number) => v == null ? null : String(v).trim().slice(0, n) || null;
      const intOrNull = (v: unknown, max: number) => {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 && n <= max ? n : NaN;
      };
      if (action === "cn_list") {
        const [ships, lines, prodRows] = await Promise.all([
          sbRest("cn_shipments?select=*&order=id.desc&limit=500"),
          sbRest("cn_lines?select=*&order=shipment_id.desc,seq.asc&limit=20000"),
          sbRest("cn_products?select=sname,vendor,updated_by_name,updated_at&limit=5000"),
        ]) as [Record<string, any>[], Record<string, any>[], Record<string, any>[]];
        const prods: Record<string, unknown> = {};
        for (const r of prodRows) prods[String(r.sname)] = { vendor: r.vendor ?? null, by: r.updated_by_name ?? null, at: r.updated_at ?? null };
        const outLines = canPrice ? lines : lines.map((l) => { const { unit_price: _u, ...rest } = l; return rest; });
        // 카페24 등록 여부: 전 상품의 공급사 상품명(supply_product_name)을 30분 캐시로 받아 사입상품명과 맞춘다.
        //   같은 이름(공백·대소문자 무시)이거나, 공급사 상품명이 '사입상품명 + 구분 문자(공백·괄호 등)'로 시작하면 같은 상품으로 본다.
        const c24: Record<string, unknown[]> = {};
        let c24_error: string | null = null;
        try {
          let prods = (await cacheGet("cn:c24products", 30 * 60 * 1000)) as Record<string, any>[] | null;
          if (!prods || noCache) {
            prods = [];
            for (let offset = 0; offset < 10000; offset += 100) {
              const body = await apiGet(`${API_BASE}/admin/products?shop_no=1&limit=100&offset=${offset}&fields=product_no,product_name,supply_product_name,display,selling`, token);
              const page = (body.products ?? []) as Record<string, any>[];
              prods.push(...page.map((x) => ({ product_no: x.product_no, product_name: x.product_name, supply_product_name: x.supply_product_name ?? "", display: x.display, selling: x.selling })));
              if (page.length < 100) break;
            }
            await cacheSet("cn:c24products", prods);
          }
          const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, "");
          const names = [...new Set(lines.map((l) => String(l.sname ?? "")).filter(Boolean))];
          const withNorm = prods.map((x) => ({ x, n: norm(x.supply_product_name) })).filter((y) => y.n);
          for (const name of names) {
            const k = norm(name); if (!k) continue;
            const hits = withNorm.filter((y) => y.n === k || (y.n.startsWith(k) && /[^0-9a-z가-힣]/.test(y.n.charAt(k.length)))).map((y) => y.x);
            if (hits.length) c24[name] = hits.slice(0, 5);
          }
        } catch (e) { c24_error = "카페24 상품 목록을 읽지 못했어요 — " + String(e).slice(0, 150); }
        return json({ ships, lines: outLines, prods, c24, c24_error, can_price: canPrice, can_edit: canEdit });
      }
      if (req.method !== "POST") return json({ error: "POST로 호출해주세요" }, 405);
      const b = await req.json().catch(() => ({})) as Record<string, any>;
      const now = new Date().toISOString();
      const dateOrNull = (v: unknown) => { const d = txt(v, 10); return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null; };
      if (action === "cn_vendor") {
        if (!canEdit) return json({ error: "거래처명 입력은 관리자·MD만 할 수 있어요" }, 403);
        const sname = txt(b.sname, 100);
        if (!sname) return json({ error: "사입상품명이 없어요" }, 400);
        const row = { sname, vendor: txt(b.vendor, 80), updated_by: authed.id, updated_by_name: authed.name, updated_at: now };
        await sbRest("cn_products?on_conflict=sname", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
        return json({ ok: true, sname, vendor: row.vendor, by: authed.name, at: now });
      }
      if (action === "cn_upload") {
        if (!canEdit) return json({ error: "엑셀 올리기는 관리자·MD만 할 수 있어요" }, 403);
        const title = txt(b.title, 100);
        if (!title) return json({ error: "입고 이름을 입력해주세요" }, 400);
        const src = Array.isArray(b.lines) ? b.lines as Record<string, any>[] : [];
        if (!src.length || src.length > 3000) return json({ error: "옵션 줄은 1~3,000개여야 해요" }, 400);
        const rows: Record<string, unknown>[] = [];
        for (let i = 0; i < src.length; i++) {
          const r = src[i];
          const sname = txt(r.sname, 100);
          const sent = intOrNull(r.qty_sent, 1_000_000), left = intOrNull(r.qty_left, 1_000_000);
          const price = r.unit_price === null || r.unit_price === undefined || r.unit_price === "" ? null : Number(r.unit_price);
          if (!sname || sent === null || Number.isNaN(sent) || Number.isNaN(left) || (price !== null && !(price >= 0 && price <= 10_000_000))) {
            return json({ error: `${i + 1}번째 줄 값이 올바르지 않아요 (사입상품명·수량·단가 확인)` }, 400);
          }
          rows.push({ seq: i, sname, color: txt(r.color, 60), size: txt(r.size, 40), qty_sent: sent, qty_left: left, unit_price: price, line_note: txt(r.line_note, 200) });
        }
        const [ship] = await sbRest("cn_shipments", { method: "POST", body: JSON.stringify({
          title, vendor: txt(b.vendor, 80), order_round: txt(b.order_round, 40), ship_date: dateOrNull(b.ship_date),
          file_name: txt(b.file_name, 200), note: txt(b.note, 300), created_by: authed.id, created_by_name: authed.name,
        }) }) as Record<string, any>[];
        try {
          await sbRest("cn_lines", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows.map((r) => ({ ...r, shipment_id: ship.id }))) });
        } catch (e) {
          await sbRest(`cn_shipments?id=eq.${ship.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => null);   // 줄 저장 실패 → 빈 입고 건을 남기지 않는다
          return json({ error: "저장하지 못했어요 — " + String(e).slice(0, 150) }, 500);
        }
        return json({ ok: true, shipment: ship, line_count: rows.length });
      }
      if (action === "cn_check") {
        // items: [{ line_id, qty_actual?(0 이상 정수 | null = 확인 취소), memo? }] — 한 번에 500줄까지('전달 수량과 같음' 일괄 기입)
        const items = (Array.isArray(b.items) ? b.items : [b]) as Record<string, any>[];
        if (!items.length || items.length > 500) return json({ error: "한 번에 500줄까지 바꿀 수 있어요" }, 400);
        const done: Record<string, unknown>[] = [];
        for (const it of items) {
          const id = Number(it.line_id);
          if (!Number.isInteger(id) || id < 1) return json({ error: "줄 번호가 올바르지 않아요" }, 400);
          const patch: Record<string, unknown> = {};
          if ("qty_actual" in it) {
            const q = intOrNull(it.qty_actual, 1_000_000);
            if (Number.isNaN(q)) return json({ error: "실제 수량은 0 이상의 정수로 적어 주세요" }, 400);
            patch.qty_actual = q;
            patch.checked_by = q === null ? null : authed.id;
            patch.checked_by_name = q === null ? null : authed.name;
            patch.checked_at = q === null ? null : now;
          }
          if ("memo" in it) patch.memo = txt(it.memo, 300);
          if (!Object.keys(patch).length) continue;
          const [row] = await sbRest(`cn_lines?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) }) as Record<string, any>[];
          if (!row) return json({ error: "이미 지워진 줄이에요 — 새로고침해 주세요" }, 404);
          if (!canPrice) delete row.unit_price;
          done.push(row);
        }
        return json({ ok: true, lines: done });
      }
      // cn_ship — 입고 건 정보 수정·삭제
      if (!canEdit) return json({ error: "입고 건 수정·삭제는 관리자·MD만 할 수 있어요" }, 403);
      const sid = Number(b.id);
      if (!Number.isInteger(sid) || sid < 1) return json({ error: "입고 건 번호가 올바르지 않아요" }, 400);
      if (b.delete === true) {
        const gone = await sbRest(`cn_shipments?id=eq.${sid}`, { method: "DELETE" }) as unknown[];
        return json({ ok: true, deleted: (gone ?? []).length });
      }
      const patch: Record<string, unknown> = {};
      if ("title" in b) { const t = txt(b.title, 100); if (!t) return json({ error: "입고 이름을 입력해주세요" }, 400); patch.title = t; }
      if ("vendor" in b) patch.vendor = txt(b.vendor, 80);
      if ("order_round" in b) patch.order_round = txt(b.order_round, 40);
      if ("ship_date" in b) patch.ship_date = dateOrNull(b.ship_date);
      if ("note" in b) patch.note = txt(b.note, 300);
      if (!Object.keys(patch).length) return json({ error: "바꿀 내용이 없어요" }, 400);
      const [row] = await sbRest(`cn_shipments?id=eq.${sid}`, { method: "PATCH", body: JSON.stringify(patch) }) as Record<string, any>[];
      if (!row) return json({ error: "입고 건을 찾지 못했어요" }, 404);
      return json({ ok: true, shipment: row });
    }

    // ── 반품 송장 스캔 (2026-09-22): 관리자·MD·CS/물류팀 ──
    if (action === "rscan_build" || action === "rscan_lookup" || action === "rscan_status" || action === "rscan_issues" || action === "rscan_find" || action === "rscan_collect" || action === "rscan_special") {
      if (!["admin", "staff", "cs"].includes(authed.role)) return json({ error: "접근 권한이 없습니다" }, 403);
      const days = Math.min(180, Math.max(7, Number(url.searchParams.get("days") ?? 14) || 14));   // 7·14·30·90 중 선택(기본 14), 어제까지
      const [row] = (await sbRest("rscan_index?kind=eq.cafe24&select=built_at,days,row_count" + (action === "rscan_lookup" || action === "rscan_issues" || action === "rscan_find" ? ",payload" : ""))) ?? [];
      const ageMin = row ? Math.round((Date.now() - new Date(row.built_at).getTime()) / 60000) : null;
      if (action === "rscan_status") {
        const nv = await sbRest("rscan_naver?select=uploaded_at,uploaded_by&order=uploaded_at.desc&limit=1");
        const nvCount = await sbRest("rscan_naver?select=invoice");
        return json({ built_at: row?.built_at ?? null, days: row?.days ?? null, row_count: row?.row_count ?? 0, age_min: ageMin, naver: { count: (nvCount ?? []).length, last: nv?.[0] ?? null }, settings: await rscanSettings() });
      }
      if (action === "rscan_build") {
        const manual = authed.id !== "cron";
        const bdays = !manual || authed.role === "admin" ? days : Math.min(days, 90);
        // 남용 방지(보안 점검 2026-09-22): 비관리자 수동 갱신은 15분 안에 만든(=cron 주기) 같은 범위 인덱스가 있으면 재사용,
        // 새로 만들 땐 기존 범위보다 줄이지 않는다(남이 쓰는 90일 인덱스를 14일로 덮어쓰지 않게). cron·관리자는 요청대로 생성.
        if (manual && authed.role !== "admin" && row && ageMin !== null && ageMin < 15 && Number(row.days ?? 0) >= bdays) {
          return json({ ok: true, reused: true, row_count: row.row_count, days: row.days, with_invoice: null, built_at: row.built_at });
        }
        const useDays = manual && authed.role !== "admin" ? Math.min(90, Math.max(bdays, Number(row?.days ?? 0))) : bdays;
        const rows = await rscanBuild(token, useDays);
        return json({ ok: true, row_count: rows.length, days: useDays, with_invoice: rows.filter((r: any) => r.invoice).length, built_at: new Date().toISOString() });
      }
      // ── 불량·오배송 처리 목록 (2026-09-22 소메뉴): 최근 1달(어제까지 30일, 주문일 기준) 반품·교환 중 경고 판정(alert/warn) 건 + 처리 상태(rscan_done)
      if (action === "rscan_issues") {
        const DAYS = 90;   // 최근 90일(어제까지) — 2026-09-28 사용자 요청(처음 1달 → 2달 → 90일). 15분 자동 갱신 인덱스도 90일이라 그대로 재사용
        let payload: Record<string, any>[] = (row?.payload ?? []) as Record<string, any>[];
        const fresh = !!row && ageMin !== null && ageMin <= 20 && Number(row.days ?? 0) >= DAYS;
        if (!fresh) payload = await rscanBuild(token, DAYS) as Record<string, any>[];
        const startDate = rscanStartDate(DAYS);
        // 특별관리(2026-09-28 사용자 요청): 오래 수거 안 되는 주문을 표시해 두면 90일이 지나도 계속 보인다.
        //   기간 안 주문은 인덱스에서, 기간 밖 주문은 카페24에서 주문번호로 직접 읽어(최신 상태) 목록에 붙인다(outside — 불량 다발 집계에서는 제외).
        const specialRows = ((await sbRest("rscan_special?select=key,kind,order_id,note,marked_by_name,marked_at")) ?? []) as Record<string, any>[];
        const specialMap = new Map<string, Record<string, any>>(specialRows.map((r) => [String(r.key), r]));
        const inWindow = new Set<string>();
        for (const e of payload) if (!e.order_date || String(e.order_date) >= startDate) inWindow.add(`${e.kind}:${e.order_id}`);
        const outsideTargets = specialRows.filter((r) => !inWindow.has(String(r.key))).map((r) => ({ kind: r.kind, order_id: String(r.order_id) }));
        let outsideEntries: Record<string, any>[] = [];
        let special_error: string | null = null;
        try { outsideEntries = (await rscanFetchOrders(outsideTargets, token)).map((e) => ({ ...e, outside: true })); } catch (e) { special_error = "특별관리 주문 일부를 카페24에서 읽지 못했어요 — " + String(e).slice(0, 150); }
        const st = await rscanSettings();
        // 네이버페이센터 표(상품주문번호 → 사유) — 네이버페이 주문은 카페24 사유가 비어 있을 수 있어 여기 사유로 판정 보강
        const nvMap = new Map<string, Record<string, any>>();
        for (const r of ((await sbRest("rscan_naver?select=invoice,product_order_no,kind,reason")) ?? []) as Record<string, any>[]) {
          for (const pon of String(r.product_order_no ?? "").split(/[,\s]+/).filter(Boolean)) nvMap.set(pon, r);
        }
        // 주문 단위로 묶기(2026-09-22 사용자 요청 — 같은 주문의 접수가 여러 개면 한 줄 안에 나열). 키 = kind:order_id (반품/교환은 따로 줄)
        // 철회된 접수(status_extra '교환철회' 등)는 제외. 수거 완료 판단 = 반품완료 또는 반품처리중+'환불전'(실데이터: 반품처리중은 '수거전'/'환불전' 둘뿐, 반품접수는 '수거접수완료')
        const collectedMap = await rscanCollectedMap();
        const groups = new Map<string, Record<string, any>>();
        for (const e of [...payload, ...outsideEntries]) {
          if (!e.outside && e.order_date && String(e.order_date) < startDate) continue;
          const extra = String(e.status_extra ?? ""), status = String(e.status ?? "");
          if (/철회/.test(extra) || /철회/.test(status)) continue;
          let nv: Record<string, any> | null = null;
          for (const id of (e.naver_ids ?? []) as unknown[]) { const hit = nvMap.get(String(id)); if (hit) { nv = hit; break; } }
          const reason = e.naver ? `${e.reason ?? ""} ${nv?.reason ?? ""}`.trim() : String(e.reason ?? "");
          const sp = specialMap.get(`${e.kind}:${e.order_id}`);
          // 특별관리 주문은 경고 기준을 나중에 바꿔도 목록에서 빠지지 않게(노란 주의로 표시)
          const alert = rscanJudge({ ...e, reason }, st) ?? (sp ? { level: "warn", type: "불량", by: "특별관리", hit: "" } : null);
          if (!alert) continue;
          const collected = e.kind === "return" && (status === "반품완료" || /환불전/.test(extra));
          const exchanged = e.kind === "exchange" && status === "교환완료";
          const claim = {
            collected_by: collectedMap[`${e.kind}:${e.claim_code}`] ?? null,
            key: `${e.kind}:${e.order_id}:${e.claim_code ?? ""}`, claim_code: e.claim_code ?? "", claim_date: e.claim_date ?? "", status, status_extra: extra,
            reason: e.reason ?? "", reason_type: e.reason_type ?? null, naver_reason: nv?.reason ?? null, invoice: e.invoice ?? "", company: e.company ?? null,
            items: ((e.items ?? []) as Record<string, any>[]).map((it) => ({ name: it.name, option: it.option ?? "", qty: it.qty ?? 0, product_no: it.product_no ?? null, nr: it.nr ?? [] })), alert, collected, exchanged,
          };
          const gk = `${e.kind}:${e.order_id}`;
          let g = groups.get(gk);
          if (!g) {
            g = { key: gk, kind: e.kind, order_id: e.order_id, order_date: e.order_date, buyer: e.buyer ?? "", receiver: e.receiver ?? "", place: e.place ?? "", naver: !!e.naver, naver_ids: [] as string[], claims: [] as Record<string, any>[], claim_date: "", alert,
              special: sp ? { by: sp.marked_by_name ?? "", at: sp.marked_at, note: sp.note ?? "" } : null, outside: !!e.outside };
            groups.set(gk, g);
          }
          g.claims.push(claim);
          for (const id of (e.naver_ids ?? []) as unknown[]) if (!g.naver_ids.includes(String(id))) g.naver_ids.push(String(id));
          if (String(claim.claim_date) > String(g.claim_date)) g.claim_date = claim.claim_date;
          if (alert.level === "alert" && g.alert.level !== "alert") g.alert = alert;   // 확실한 판정이 하나라도 있으면 그걸 대표로
        }
        const issues = [...groups.values()].map((g) => ({
          ...g,
          auto_done: g.kind === "return" && g.claims.every((c: Record<string, any>) => c.collected),   // 반품: 전부 수거 완료면 자동 처리완료
          exchanged: g.kind === "exchange" && g.claims.every((c: Record<string, any>) => c.exchanged),  // 교환: 참고 표시만(수동 처리)
          collected_some: g.claims.some((c: Record<string, any>) => c.collected), exchanged_some: g.claims.some((c: Record<string, any>) => c.exchanged),
        }));
        issues.sort((a, b) => String(b.claim_date || b.order_date).localeCompare(String(a.claim_date || a.order_date)) || String(b.order_id).localeCompare(String(a.order_id)));
        const since = new Date(); since.setUTCDate(since.getUTCDate() - 120);
        const doneRows = ((await sbRest(`rscan_done?select=key,done,done_by,done_at,cleared&done_at=gte.${since.toISOString().slice(0, 10)}`)) ?? []) as Record<string, any>[];
        // 특별관리 주문은 처리 체크가 120일보다 오래됐어도 읽는다
        const spKeys = specialRows.map((r) => String(r.key)).filter((k) => /^(return|exchange):\d{8}-\d{7}$/.test(k));
        if (spKeys.length) doneRows.push(...(((await sbRest(`rscan_done?select=key,done,done_by,done_at,cleared&key=in.(${spKeys.map((k) => `"${k}"`).join(",")})`)) ?? []) as Record<string, any>[]));
        const doneMap: Record<string, unknown> = {};
        const cleared = new Set<string>();   // '처리완료 정리'로 목록에서 지운 키 (2026-09-22)
        for (const d of doneRows) { if (d.done) doneMap[String(d.key)] = { by: d.done_by, at: d.done_at }; if (d.cleared) cleared.add(String(d.key)); }
        // 불량 다발 상품(2026-09-22 사용자 요청 6번): 정리된 건도 포함해 상품별 접수 건수 — 접수 안에 같은 상품이 여러 줄이면 접수 1건으로, 수량은 합산
        const prodMap = new Map<string, Record<string, any>>();
        for (const g of issues) for (const c of (g.outside ? [] : g.claims) as Record<string, any>[]) {   // 기간 밖 특별관리 주문은 90일 집계에서 제외
          const seen = new Set<string>();
          for (const it of c.items as Record<string, any>[]) {
            const pk = String(it.product_no ?? it.name ?? ""); if (!pk) continue;
            let p = prodMap.get(pk);
            if (!p) { p = { product_no: it.product_no ?? null, name: it.name ?? "", claims: 0, defect: 0, misdeliver: 0, suspect: 0, returns: 0, exchanges: 0, qty: 0, last_date: "", reasons: [] as string[], orders: new Set<string>() }; prodMap.set(pk, p); }
            p.qty += Number(it.qty ?? 0);
            if (seen.has(pk)) continue; seen.add(pk);
            p.claims++; if (c.alert.level === "warn") p.suspect++; else if (c.alert.type === "오배송") p.misdeliver++; else p.defect++;
            if (g.kind === "return") p.returns++; else p.exchanges++;
            if (String(c.claim_date) > String(p.last_date)) p.last_date = c.claim_date;
            const rs = String(c.reason || c.naver_reason || "").replace(/\s+/g, " ").trim();
            if (rs && p.reasons.length < 3 && !p.reasons.includes(rs.slice(0, 60))) p.reasons.push(rs.slice(0, 60));
            p.orders.add(String(g.order_id));
          }
        }
        const products = [...prodMap.values()].map((p) => ({ ...p, orders: p.orders.size })).sort((a, b) => b.claims - a.claims || b.qty - a.qty);
        const visible = issues.filter((g) => g.special || (!cleared.has(g.key) && !g.claims.some((c: Record<string, any>) => cleared.has(c.key))));   // 특별관리는 '처리완료 정리'로도 안 사라짐
        // 그룹 처리 상태: 그룹 키 또는 (예전 방식) 접수 키 중 하나라도 처리완료면 처리완료
        const done: Record<string, unknown> = {};
        for (const g of visible) { const hit = doneMap[g.key] ?? g.claims.map((c: Record<string, any>) => doneMap[c.key]).find(Boolean); if (hit) done[g.key] = hit; }
        return json({ days: DAYS, start_date: startDate, built_at: fresh ? row!.built_at : new Date().toISOString(), row_count: payload.length, issues: visible, cleared_count: issues.length - visible.length, done, products, special_count: specialRows.length, special_error });
      }
      // ── 특별관리 표시·해제 (2026-09-28 사용자 요청): POST {kind, order_id, on, note}. 표시한 사람은 로그인 계정으로 서버가 기입.
      if (action === "rscan_special") {
        if (req.method !== "POST") return json({ error: "POST로 호출해주세요" }, 405);
        const b = await req.json().catch(() => ({})) as Record<string, unknown>;
        const kind = String(b.kind ?? ""), orderId = String(b.order_id ?? "");
        if (!["return", "exchange"].includes(kind) || !/^\d{8}-\d{7}$/.test(orderId)) return json({ error: "주문번호가 올바르지 않습니다" }, 400);
        const key = `${kind}:${orderId}`;
        if (b.on === false) {
          await sbRest(`rscan_special?key=eq.${encodeURIComponent(key)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
          return json({ ok: true, key, special: null });
        }
        const note = String(b.note ?? "").trim().slice(0, 200);
        const cur = ((await sbRest(`rscan_special?key=eq.${encodeURIComponent(key)}&select=marked_by,marked_by_name,marked_at`)) ?? [])[0] as Record<string, any> | undefined;
        if (!cur && ((await sbRest("rscan_special?select=key")) ?? []).length >= 300) return json({ error: "특별관리는 300건까지예요 — 해결된 주문을 먼저 해제해주세요" }, 400);
        // 메모만 고칠 땐 처음 표시한 사람·시각을 유지
        const rowNew = { key, kind, order_id: orderId, note: note || null, marked_by: cur?.marked_by ?? authed.id, marked_by_name: cur?.marked_by_name ?? authed.name, marked_at: cur?.marked_at ?? new Date().toISOString() };
        await sbRest("rscan_special?on_conflict=key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rowNew) });
        return json({ ok: true, key, special: { by: rowNew.marked_by_name, at: rowNew.marked_at, note: rowNew.note ?? "" } });
      }
      // ── 수거 완료 처리 (2026-09-28 사용자 요청) — 카페24 반품·교환 접수를 '수거 완료'로 바꾼다. POST 전용, 실행마다 rscan_actions에 기록.
      //    PUT orders/{order_id}/return|exchange/{claim_code} { request: { pickup_completed: "T", items } } (scope mall.write_order).
      //    재고 복구(recover_inventory)·상태(status)는 보내지 않는다 = 카페24 기본 동작 그대로. 네이버페이 주문은 카페24에서 못 바꾸므로 거절.
      if (action === "rscan_collect") {
        if (req.method !== "POST") return json({ error: "POST로 호출해주세요" }, 405);
        // 카페24 쓰기는 사람 로그인으로만 (2026-09-29 위험 점검): 에이전트·자동 갱신·상품관리 연동용 비밀키는 관리자로 인정되지만 쓰기는 막는다
        if (viaAgent || viaCron || viaSecret) return json({ error: "이 기능은 로그인한 사람만 쓸 수 있습니다" }, 403);
        const orderId = String(url.searchParams.get("order_id") ?? ""), claimCode = String(url.searchParams.get("claim_code") ?? "");
        const kind = String(url.searchParams.get("kind") ?? "");
        if (!/^\d{8}-\d{7}$/.test(orderId) || !/^[A-Z]\d{8}-\d{7}$/.test(claimCode) || !["return", "exchange"].includes(kind)) return json({ error: "주문번호·접수번호가 올바르지 않습니다" }, 400);
        const logAct = (ok: boolean, result: string, items: unknown, extra: Record<string, unknown> = {}) => sbRest("rscan_actions", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ action: "collect", kind, order_id: orderId, claim_code: claimCode, items, ok, result: String(result).slice(0, 500), by_id: authed.id, by_name: authed.name, ...extra }) }).catch(() => null);
        const readOrder = async () => ((await apiGet(`${API_BASE}/admin/orders/${orderId}?embed=items,${kind}`, token)).order ?? {}) as Record<string, any>;
        const pick = (o: Record<string, any>) => {   // 접수 품목 — 교환으로 새로 생긴 발송 품목(exchanged_items)은 제외(2026-09-30)
          const cl = (((o[kind] ?? []) as Record<string, any>[]).find((c) => c.claim_code === claimCode)) ?? {};
          const newCodes = new Set(((cl.exchanged_items ?? []) as Record<string, any>[]).map((x) => String(x.order_item_code ?? "")).filter(Boolean));
          return ((o.items ?? []) as Record<string, any>[]).filter((it) => it.claim_code === claimCode && !newCodes.has(String(it.order_item_code ?? "")));
        };
        const collectedOf = (its: Record<string, any>[]) => its.length > 0 && its.every((it) => !!(kind === "return" ? it.return_collected_date : it.exchange_collected_date ?? it.return_collected_date) || /환불전|수거완료/.test(String(it.order_status_additional_info ?? "")) || ["반품완료", "교환완료"].includes(String(it.status_text ?? "")));
        let order: Record<string, any>;
        try { order = await readOrder(); } catch (e) { return json({ error: "카페24에서 주문을 읽지 못했어요 — " + String(e).slice(0, 200) }, 502); }
        if (order.order_place_id === "NCHECKOUT") return json({ error: "네이버페이 주문은 네이버페이센터에서 처리해야 해요" }, 400);
        const its = pick(order);
        if (!its.length) return json({ error: "이 주문에서 해당 접수 품목을 찾지 못했어요" }, 404);
        const stateOf = (list: Record<string, any>[]) => ({ status: String(list[0]?.status_text ?? ""), status_extra: String(list[0]?.order_status_additional_info ?? "") });
        if (collectedOf(its)) return json({ ok: true, already: true, ...stateOf(its) });
        const codes = its.map((it) => ({ order_item_code: String(it.order_item_code) }));
        // 반품 불가·확인 필요 품목이 섞여 있으면(최신 주문 기준) 확인(ack=1) 없이는 처리하지 않는다 — 화면이 목록을 보여 주고 다시 요청
        const nrSets = await rscanNrSets(token).catch(() => ({ acc: [], sale: {} } as NrSets));
        const flagged = its.map((it) => ({ name: String(it.product_name ?? ""), option: String(it.option_value ?? ""), flags: rscanItemFlags(it, nrSets) })).filter((x) => x.flags.length);
        if (flagged.length && url.searchParams.get("ack") !== "1") return json({ error: "반품 불가 또는 확인이 필요한 품목이 있어요", need_ack: true, flagged }, 409);
        // ── 안전장치 (2026-09-28) ── ① 관리자 끄기 스위치 ② 사용 한도(사람별 1시간 150건 · 전체 하루 1,000건) — 성공·실패 모두 셈
        const cset = (await rscanSettings()) as Record<string, unknown>;
        if (cset.collect_enabled === false) return json({ error: "수거 완료 처리가 꺼져 있어요 (관리자가 '경고 기준'에서 다시 켤 수 있어요)" }, 403);
        // 카페24 재고 복구 (2026-09-28 사용자 지정): 기본 'auto' = 불량 접수면 복구 안 함(F), 그 외(변심·사이즈·오배송 등)는 복구(T).
        //   불량 판정은 스캔 경고와 같은 rscanJudge(사유 코드 K·V·D 등 + 사유 문구 '불량 의심' 포함) — 최신 주문의 접수 사유로 서버가 판단.
        //   관리자 설정 collect_recover_inventory 가 'T'/'F' 면 그 값으로 고정.
        const claimObj = (((order[kind] ?? []) as Record<string, any>[]).find((c) => c.claim_code === claimCode)) ?? {};
        const judged = rscanJudge({ naver: false, reason_type: claimObj.claim_reason_type ?? its[0]?.claim_reason_type ?? null, reason: String(claimObj.claim_reason ?? its[0]?.claim_reason ?? "") }, cset as typeof RSCAN_DEFAULTS);
        const isDefect = !!judged && judged.type === "불량";
        const mode = String(cset.collect_recover_inventory ?? "auto");
        const recover: "T" | "F" = mode === "T" ? "T" : mode === "F" ? "F" : (isDefect ? "F" : "T");
        const sinceIso = (ms: number) => new Date(Date.now() - ms).toISOString();
        const mine = ((await sbRest(`rscan_actions?select=id,created_at&by_id=eq.${encodeURIComponent(authed.id)}&created_at=gte.${sinceIso(3600e3)}&limit=500`)) ?? []) as Record<string, any>[];
        const allDay = ((await sbRest(`rscan_actions?select=id&created_at=gte.${sinceIso(24 * 3600e3)}&limit=1500`)) ?? []) as unknown[];
        if (mine.length >= 150 || allDay.length >= 1000) {
          await logAct(false, `한도 초과로 거절 (내 1시간 ${mine.length} · 전체 하루 ${allDay.length})`, codes);
          return json({ error: "수거 완료 처리 한도를 넘었어요 — 잠시 뒤 다시 시도하거나 관리자에게 알려주세요" }, 429);
        }
        // ③ 이상 징후: 한 사람이 10분에 40건 이상이면 관리자 전원에게 알림(사람별 1시간에 한 번)
        const recent10 = mine.filter((r) => new Date(r.created_at).getTime() > Date.now() - 600e3).length;
        if (recent10 >= 40 && !(await cacheGet(`collectwarn:${authed.id}`, 3600e3))) {
          await cacheSet(`collectwarn:${authed.id}`, { at: Date.now() });
          const admins = ((await sbRest("app_users?role=eq.admin&select=id")) ?? []) as Record<string, any>[];
          await sbRest("notifications", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(admins.map((a) => ({ user_id: a.id, actor_name: "반품 스캔", message: `${authed.name} 님이 10분 동안 수거 완료를 ${recent10}건 처리했어요 — 평소보다 많아요. 확인해주세요.`, link_menu: "rscan" }))) }).catch(() => null);
        }
        try {
          await cafe24MarkCollected(kind as "return" | "exchange", orderId, claimCode, codes.map((c) => c.order_item_code), recover, token);
        } catch (e) {
          const st = (e as { status?: number }).status ?? 0, raw = String((e as Error).message ?? e);
          const msg = st === 403 || /scope|permission|insufficient/i.test(raw)
            ? "카페24 앱에 '주문 쓰기' 권한이 없어요 — 개발자센터에서 권한을 켠 뒤 '카페24 연동'으로 다시 연동해주세요"
            : "카페24가 처리하지 못했어요 — " + raw.slice(0, 300);
          await logAct(false, raw, codes);
          return json({ error: msg, need_scope: st === 403 || /scope/i.test(raw) }, st === 403 ? 403 : 502);
        }
        // 처리 후 상태를 다시 읽어 응답·인덱스에 반영 (목록·처리 탭이 다음 갱신 전에도 맞게 보이도록)
        let after = { status: "", status_extra: "" };
        try { after = stateOf(pick(await readOrder())); } catch { /* 읽기 실패해도 처리는 성립 */ }
        await logAct(true, (`${after.status} ${after.status_extra}`.trim() || "처리됨") + ` · 재고 복구 ${recover === "T" ? "함" : "안 함"}${mode === "T" || mode === "F" ? "(고정)" : isDefect ? "(불량)" : "(불량 아님)"}` + (flagged.length ? ` · 주의 품목 확인 후 처리: ${flagged.map((f) => f.flags.map((x) => x.type).join("/")).join(", ")}` : ""), codes, { recover_inventory: recover, defect: isDefect });
        try {
          const [full] = (await sbRest("rscan_index?kind=eq.cafe24&select=payload")) ?? [];
          const pl = ((full?.payload ?? []) as Record<string, any>[]).map((e) => e.order_id === orderId && e.claim_code === claimCode && e.kind === kind ? { ...e, status: after.status || e.status, status_extra: after.status_extra } : e);
          if (pl.length) await sbRest("rscan_index?kind=eq.cafe24", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ payload: pl }) });
        } catch { /* 인덱스 반영 실패는 다음 자동 갱신(15분)에 맡긴다 */ }
        return json({ ok: true, ...after, by: authed.name, at: new Date().toISOString(), recover_inventory: recover, defect: isDefect });
      }
      // ── 이름·수령인·배송지 주소·전화로 찾기 (2026-09-23 사용자 요청): 송장이 카페24에 없는 고객 직접 발송 반품용. 수거 전 반품·교환만, 철회 제외
      if (action === "rscan_find") {
        const norm = (v: unknown) => String(v ?? "").replace(/\s+/g, "").toLowerCase();
        const q = norm(url.searchParams.get("q"));
        const qd = q.replace(/[^0-9]/g, "");
        if (q.length < 2) return json({ error: "두 글자 이상 입력해주세요" }, 400);
        let payload: Record<string, any>[] = (row?.payload ?? []) as Record<string, any>[];
        const fresh = !!row && ageMin !== null && ageMin <= 20 && Number(row.days ?? 0) >= days;
        if (!fresh) payload = await rscanBuild(token, days) as Record<string, any>[];
        const startDate = rscanStartDate(days);
        const st = await rscanSettings();
        const hits = payload.filter((e) => {
          if (e.order_date && String(e.order_date) < startDate) return false;
          const status = String(e.status ?? ""), extra = String(e.status_extra ?? "");
          if (/철회/.test(extra) || /철회/.test(status)) return false;
          const pending = e.kind === "return" ? !(status === "반품완료" || /환불전/.test(extra)) : status !== "교환완료";
          if (!pending) return false;
          return norm(e.buyer).includes(q) || norm(e.receiver).includes(q) || norm(e.address).includes(q) || (qd.length >= 4 && String(e.phone ?? "").includes(qd));
        }).slice(0, 30).map((e) => ({ ...e, collected_by: null, phone: e.phone ? String(e.phone).replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1-****-$3") : "", alert: rscanJudge(e, st) }));
        return json({ q: url.searchParams.get("q"), hits, index: { built_at: fresh ? row!.built_at : new Date().toISOString(), row_count: payload.length, days, start_date: startDate } });
      }
      // lookup
      const q = rscanDigits(url.searchParams.get("q"));
      if (q.length < 6) return json({ error: "송장번호를 6자리 이상 입력해주세요" }, 400);
      let payload: Record<string, any>[] = (row?.payload ?? []) as Record<string, any>[];
      // 인덱스가 없거나 20분 넘게 오래됐거나 요청 기간보다 짧으면 요청 기간으로 다시 만든다(짧을수록 빠름 — 90일 43초, 14일 약 7초).
      // 더 긴 인덱스가 신선하면 재사용하고 요청 기간(어제까지 N일)으로 잘라서 본다.
      const fresh = !!row && ageMin !== null && ageMin <= 20 && Number(row.days ?? 0) >= days;
      if (!fresh) payload = await rscanBuild(token, days) as Record<string, any>[];
      const startDate = rscanStartDate(days);
      payload = payload.filter((e) => !e.order_date || String(e.order_date) >= startDate);
      const st = await rscanSettings();
      const matchInv = (inv: string) => inv && (inv === q || inv.endsWith(q) || q.endsWith(inv));
      let hits = payload.filter((e) => matchInv(String(e.invoice ?? "")));
      let naverRow: Record<string, any> | null = null;
      if (!hits.length) {   // 네이버페이센터 엑셀 표에서 수거 송장 → 상품주문번호 → 카페24 주문
        const nv = await sbRest(`rscan_naver?select=*&invoice=like.*${encodeURIComponent(q)}`);
        naverRow = (nv ?? []).find((r: any) => matchInv(String(r.invoice))) ?? null;
        if (naverRow) {
          // 한 수거 송장에 상품 여러 개면 클라이언트가 상품주문번호를 쉼표로 합쳐 저장 → 그중 하나라도 맞으면 그 주문
          const pons = String(naverRow.product_order_no ?? "").split(/[,\s]+/).filter(Boolean);
          hits = payload.filter((e) => pons.length && (e.naver_ids ?? []).some((id: unknown) => pons.includes(String(id))));
          hits = hits.map((e) => ({ ...e, invoice: naverRow!.invoice, company: naverRow!.company ?? e.company, reason: e.reason || naverRow!.reason || "", naver_reason: naverRow!.reason ?? null, naver_kind: naverRow!.kind ?? null }));
        }
      }
      // 철회된 접수의 송장(2026-09-30 사용자 신고 — 주문 20260918-0004868: 교환 신청 → 철회 → 재신청, 고객이 첫 접수의 수거 송장을 붙여 보냄):
      //   철회된 접수는 withdrawn 표시, 같은 주문·같은 구분의 철회 안 된 접수를 linked(스캔 송장 = 철회 접수의 것)로 앞에 붙인다.
      const isWithdrawn = (e: Record<string, any>) => /철회/.test(String(e.status ?? "") + String(e.status_extra ?? ""));
      if (hits.some(isWithdrawn)) {
        const have = new Set(hits.map((e) => `${e.kind}:${e.order_id}:${e.claim_code}`));
        const linked: Record<string, any>[] = [];
        for (const w of hits.filter(isWithdrawn)) {
          for (const e of payload) {
            if (e.order_id !== w.order_id || e.kind !== w.kind || isWithdrawn(e)) continue;
            const k = `${e.kind}:${e.order_id}:${e.claim_code}`;
            if (have.has(k)) continue; have.add(k);
            linked.push({ ...e, linked_from: { claim_code: w.claim_code ?? null, invoice: w.invoice ?? null } });
          }
        }
        hits = [...linked, ...hits.filter((e) => !isWithdrawn(e)), ...hits.filter(isWithdrawn).map((e) => ({ ...e, withdrawn: true }))];
      }
      const cmap = hits.length ? await rscanCollectedMap() : {};
      const result = hits.map((e) => ({ ...e, collected_by: cmap[`${e.kind}:${e.claim_code}`] ?? null, alert: rscanJudge({ ...e, reason: e.naver ? `${e.reason} ${e.naver_reason ?? ""}` : e.reason }, st) }));
      return json({ q, hits: result, naver_row: naverRow && !hits.length ? naverRow : null, index: { built_at: fresh ? row!.built_at : new Date().toISOString(), row_count: payload.length, days, start_date: startDate } });
    }

    // ── 카테고리 목록 ──
    if (action === "categories") {
      const LIMIT = 100;
      const cats: Record<string, unknown>[] = [];
      for (let offset = 0; offset <= 2000; offset += LIMIT) {
        const body = await apiGet(
          `${API_BASE}/admin/categories?limit=${LIMIT}&offset=${offset}` +
          `&fields=category_no,category_name,category_depth,parent_category_no`, token);
        const items = (body.categories ?? []) as Record<string, unknown>[];
        cats.push(...items);
        if (items.length < LIMIT) break;
      }
      return json({ categories: cats });
    }

    // ── 특정 카테고리의 상품번호 목록 ──
    if (action === "category_products") {
      if (!["admin", "staff"].includes(authed.role)) return json({ error: "접근 권한이 없습니다" }, 403);   // 보안 점검 2026-09-22
      const catNo = Number(url.searchParams.get("category_no"));
      if (!Number.isInteger(catNo) || catNo <= 0) return json({ error: "category_no 오류" }, 400);   // 경로 삽입 방지
      // 주의: 이 엔드포인트는 offset을 무시함 (실측) — limit만 크게 잡아 한 번에 조회
      const body = await apiGet(
        `${API_BASE}/admin/categories/${catNo}/products?display_group=1&limit=1000`, token);
      const items = (body.products ?? []) as Record<string, unknown>[];
      const nos = [...new Set(items.map((p) => Number(p.product_no)))];
      return json({ category_no: Number(catNo), product_nos: nos, truncated: items.length >= 1000 });
    }

    // ── 기간 총 매출액 (결제완료 주문 기준 — 시간대별 매출 합산) ──
    // 카페24 관리자 통계의 '결제합계'와 동일 시스템(애널리틱스) 데이터.
    // 주문수는 통계와 정확히 일치하며 금액은 ±0.5% 내외 차이 가능(부분취소 반영 시점 차이).
    if (action === "revenue") {
      // 총 매출액은 관리자 전용 (직원은 서버 차단)
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const p = new URLSearchParams({ mall_id: MALL_ID, start_date: s, end_date: e });
      const times = await collectData("/sales/times", "times", p, token);
      const revenue = times.reduce((t, r) => t + num(r.order_amount), 0);
      const orderCount = times.reduce((t, r) => t + num(r.order_count), 0);
      return json({ period: { start: s, end: e }, revenue, order_count: orderCount });
    }

    // ── 실마진 집계 (2026-09-02 사용자 요청) — 결제일 기준 주문의 실결제·할인 내역 (관리자 전용, 10분 캐시) ──
    // actual_order_amount 사용(부분취소 반영). **자사 부담 할인(쿠폰·적립금·예치금·회원·세트·앱)만 차감 대상**으로 집계하고,
    // 네이버 부담(market_other_discount_amount)은 정산 때 보전되므로 참고로만 반환 (A안 — 사용자 확정 2026-09-02).
    // 결제일(pay_date) 기준이라 미결제 주문은 자연히 빠지고, 전액 취소(order_price 0)는 발송·매출 없음으로 제외.
    if (action === "realmargin") {
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);
      const sum = { orders: 0, gross: 0, coupon: 0, points: 0, credits: 0, member: 0, set: 0, app: 0, naver: 0, ship_income: 0 };
      await eachOrder(token, "date_type=pay_date&fields=order_id,actual_order_amount", s, e, (orders) => {
        for (const o of orders) {
          const a = (o.actual_order_amount ?? {}) as Record<string, unknown>;
          const gross = num(a.order_price_amount);
          if (gross <= 0) continue;
          sum.orders++;
          sum.gross += gross;
          sum.coupon += num(a.coupon_discount_price);
          sum.points += num(a.points_spent_amount);
          sum.credits += num(a.credits_spent_amount);
          sum.member += num(a.membership_discount_amount);
          sum.set += num(a.set_product_discount_amount);
          sum.app += num(a.app_discount_amount);
          sum.naver += num(a.market_other_discount_amount);
          // 고객이 실제 부담한 배송비 (배송비 할인·배송비 쿠폰 차감 후)
          sum.ship_income += Math.max(0, num(a.shipping_fee) - num(a.shipping_fee_discount_amount) - num(a.coupon_shipping_fee_amount));
        }
      });
      const ownDiscount = sum.coupon + sum.points + sum.credits + sum.member + sum.set + sum.app;
      return respond({
        period: { start: s, end: e }, basis: "pay_date",
        ...sum, own_discount: Math.round(ownDiscount), net: Math.round(sum.gross - ownDiscount),
      });
    }

    // ── 진열 계산용 지표 (관리자 전용): 7일/30일 조회수·판매량 + 30일 취소반품수량 ──
    if (action === "displaymetrics") {
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const e = url.searchParams.get("end_date");
      if (!e) return json({ error: "end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);
      const day = 24 * 3600 * 1000;
      const dstr = (t: number) => new Date(t).toISOString().slice(0, 10);
      const endMs = new Date(e).getTime();
      // 트렌드 지표(조회·판매)는 21일 창 — 신상 회전이 빠르고 간절기 영향이 커서 30일은 과거 시즌 노이즈 포함 (상품팀 결정)
      const s7 = dstr(endMs - 6 * day), s21 = dstr(endMs - 20 * day);

      const range = (s: string) => new URLSearchParams({ mall_id: MALL_ID, start_date: s, end_date: e });
      const [v7, v21, q7, q21] = await Promise.all([
        collectData("/products/view", "view", range(s7), token),
        collectData("/products/view", "view", range(s21), token),
        collectData("/products/sales", "sales", range(s7), token),
        collectData("/products/sales", "sales", range(s21), token),
      ]);

      type M = { v7: number; v21: number; q7: number; q21: number; amt7: number; amt21: number; del7: number; ret7: number };
      const map = new Map<number, M>();
      const of = (no: number): M => {
        let m = map.get(no);
        if (!m) { m = { v7: 0, v21: 0, q7: 0, q21: 0, amt7: 0, amt21: 0, del7: 0, ret7: 0 }; map.set(no, m); }
        return m;
      };
      for (const r of v7) of(Number(r.product_no)).v7 += num(r.count);
      for (const r of v21) of(Number(r.product_no)).v21 += num(r.count);
      for (const r of q7) { const m = of(Number(r.product_no)); m.q7 += num(r.order_product_count); m.amt7 += num(r.order_amount); }
      for (const r of q21) { const m = of(Number(r.product_no)); m.q21 += num(r.order_product_count); m.amt21 += num(r.order_amount); }

      // 순반품률 — '판매 성과' 메뉴와 동일 기준: 품목 delivered_date + R40/R30/R34
      // 창은 기준일 3일 전부터 거슬러 7일 (예: 기준일 07/30 → 07/21~07/27) — 최근 3일은 반품 접수가 미확정이라 제외
      const lossS = dstr(endMs - 9 * day), lossE = dstr(endMs - 3 * day);
      const NET_RETURN_STATUSES = new Set(["R40", "R30", "R34"]);
      const fetchStart = dstr(new Date(lossS).getTime() - 7 * day);
      const fetchEnd = dstr(Math.min(new Date(lossE).getTime() + 30 * day, Date.now()));
      await eachOrder(token, "date_type=shipend_date&embed=items&fields=order_id,items", fetchStart, fetchEnd, (orders) => {
        for (const o of orders) {
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            const dd = String(it.delivered_date ?? "").slice(0, 10);
            if (!dd || dd < lossS || dd > lossE) continue;
            const no = Number(it.product_no);
            if (!no) continue;
            const m = of(no);
            const qty = num(it.quantity);
            m.del7 += qty;
            if (NET_RETURN_STATUSES.has(String(it.order_status ?? ""))) m.ret7 += qty;
          }
        }
      });

      const metrics: Record<string, M> = {};
      for (const [no, m] of map) metrics[String(no)] = m;
      return respond({ period: { end: e, start7: s7, start21: s21, loss_start: lossS, loss_end: lossE }, metrics });
    }

    // ── 상품 기본 정보 배치 조회 (관리자 전용): 진열 계산용 ──
    if (action === "productinfo") {
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const nosParam = url.searchParams.get("product_nos") ?? "";
      const nos = nosParam.split(",").map((s) => Number(s)).filter((n) => n > 0);
      if (!nos.length) return json({ error: "product_nos 필수" }, 400);
      const out: Record<string, unknown>[] = [];
      // with_discount=1 (2026-09-12, 상품 전략 에이전트): 할인판매가·태그·대표이미지까지. 할인가는 상품당 1회 호출이라 8 병렬
      const withDiscount = url.searchParams.get("with_discount") === "1";
      const extraFields = withDiscount ? ",product_tag,list_image" : "";
      for (let i = 0; i < nos.length; i += 100) {
        const chunk = nos.slice(i, i + 100).join(",");
        const body = await apiGet(
          `${API_BASE}/admin/products?product_no=${chunk}` +
          `&fields=product_no,product_code,product_name,price,supply_price,created_date,sold_out,display,selling${extraFields}&limit=100`, token);
        out.push(...((body.products ?? []) as Record<string, unknown>[]));
      }
      if (withDiscount) {
        let idx = 0;
        const worker = async () => {
          while (idx < out.length) {
            const p = out[idx++];
            try {
              const b = await apiGet(`${API_BASE}/admin/products/${p.product_no}/discountprice`, token);
              const dp = (b.discountprice ?? {}) as Record<string, unknown>;
              p.discount_price = num(dp.pc_discount_price ?? dp.mobile_discount_price);
            } catch { p.discount_price = null; }
          }
        };
        await Promise.all(Array.from({ length: Math.min(8, out.length) }, worker));
      }
      return json({ products: out });
    }

    // ── 상세페이지 정보 (2026-09-13, 상세 점검 에이전트): description HTML의 이미지 URL 목록 + 해시(바뀌었는지 판정용) ──
    //   GET ?action=productdesc&product_no=N → { product_no, product_name, price, description_len, image_urls, desc_hash }
    if (action === "productdesc") {
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const no = Number(url.searchParams.get("product_no"));
      if (!no) return json({ error: "product_no 필수" }, 400);
      const body = await apiGet(`${API_BASE}/admin/products/${no}?fields=product_no,product_name,price,supply_price,description,detail_image,list_image,created_date,sold_out`, token);
      const p = (body.product ?? {}) as Record<string, unknown>;
      const desc = String(p.description ?? "");
      const urls = [...desc.matchAll(/<img[^>]+(?:src|ec-data-src)=["']([^"']+)["']/gi)].map((m) => m[1].startsWith("//") ? "https:" + m[1] : m[1]);
      const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(desc));
      const hash = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
      return json({
        product_no: no, product_name: String(p.product_name ?? ""), price: num(p.price), supply_price: num(p.supply_price),
        created_date: String(p.created_date ?? "").slice(0, 10), sold_out: String(p.sold_out ?? "") === "T",
        list_image: String(p.list_image ?? p.detail_image ?? ""), description_len: desc.length, image_urls: urls, desc_hash: hash,
      });
    }

    // ── 상품 후기 (2026-09-18, 광고 소재 담당): 후기 게시판(board_no 4 — 알파리뷰가 카페24 게시판에도 동기화) 최근 글 ──
    //   GET ?action=reviews&product_no=N[&limit=100] → { product_no, count, rating_avg, reviews:[{rating, text, date, has_photo}] }
    //   필요 권한 mall.read_community. 권한이 없으면 { error:"scope_missing" }(200) — 에이전트는 '리뷰 없음'이 아니라 '권한 대기'로 처리한다.
    if (action === "reviews") {
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const no = Number(url.searchParams.get("product_no"));
      if (!no) return json({ error: "product_no 필수" }, 400);
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 100)));
      const hit = await fromCache(); if (hit) return json(hit);
      let body: Record<string, unknown>;
      try {
        body = await apiGet(`${API_BASE}/admin/boards/4/articles?product_no=${no}&limit=${limit}`, token);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (/scope|permission|403|insufficient/i.test(msg)) return json({ product_no: no, error: "scope_missing", detail: msg.slice(0, 200) });
        throw e;
      }
      const strip = (h: unknown) => String(h ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
      const arts = ((body.articles ?? []) as Record<string, unknown>[])
        .filter((a) => String(a.deleted ?? "F") !== "T" && Number(a.reply_depth ?? 0) === 0 && String(a.secret ?? "F") !== "T");
      const reviews = arts.map((a) => ({
        rating: num(a.rating) || null,
        text: (strip(a.content) || strip(a.title)).slice(0, 500),   // 제목은 본문 앞부분을 자른 것이라 본문 우선
        date: String(a.created_date ?? "").slice(0, 10),
        has_photo: Array.isArray(a.attach_file_urls) ? a.attach_file_urls.length > 0 : /<img/i.test(String(a.content ?? "")),
      })).filter((r) => r.text.length >= 5);
      const rated = reviews.filter((r) => r.rating);
      return respond({
        product_no: no, count: reviews.length,
        rating_avg: rated.length ? Math.round(rated.reduce((t, r) => t + (r.rating as number), 0) / rated.length * 10) / 10 : null,
        reviews,
      });
    }

    // ── 상품 → 카테고리 매핑 (2026-09-12, 상품 전략 에이전트): 카테고리 33개 × category_products 1회, 10분 캐시 ──
    //   GET ?action=categorymap → { categories: {no: {name, depth, parent}}, products: {product_no: [category_no...]} }
    if (action === "categorymap") {
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const hit = await fromCache(); if (hit) return json(hit);
      const cb = await apiGet(`${API_BASE}/admin/categories?limit=100&fields=category_no,category_name,category_depth,parent_category_no`, token);
      const cats = (cb.categories ?? []) as Record<string, unknown>[];
      const categories: Record<string, unknown> = {};
      for (const c of cats) categories[String(c.category_no)] = { name: String(c.category_name ?? ""), depth: num(c.category_depth), parent: num(c.parent_category_no) };
      const products: Record<string, number[]> = {};
      let idx = 0;
      const worker = async () => {
        while (idx < cats.length) {
          const c = cats[idx++];
          try {
            const b = await apiGet(`${API_BASE}/admin/categories/${c.category_no}/products?display_group=1&limit=1000`, token);
            for (const p of (b.products ?? []) as Record<string, unknown>[]) {
              const no = String(p.product_no);
              (products[no] = products[no] ?? []).push(Number(c.category_no));
            }
          } catch { /* 빈 카테고리 등은 무시 */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, cats.length) }, worker));
      return respond({ categories, products, fetched_at: new Date().toISOString() });
    }

    // ── 혜택(프로모션) 목록 (2026-09-12): 1+1·기간할인 등. scope mall.read_promotion 필요 — 없으면 not_permitted로 응답(에이전트는 무시) ──
    if (action === "benefits") {
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const hit = await fromCache(); if (hit) return json(hit);
      try {
        const b = await apiGet(`${API_BASE}/admin/benefits?limit=100`, token);
        const all = (b.benefits ?? []) as Record<string, unknown>[];
        // 지금 적용 중인 혜택만: use_benefit=T 이고 (기간 없음 또는 오늘이 기간 안)
        const todayKst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
        const active = all.filter((x) => {
          if (String(x.use_benefit) !== "T") return false;
          const sd = String(x.benefit_start_date ?? "").slice(0, 10), ed = String(x.benefit_end_date ?? "").slice(0, 10);
          if (sd && sd > todayKst) return false;
          if (ed && ed < todayKst) return false;
          return true;
        });
        // 혜택 유형 한글 (카페24 benefit_type): DP 기간할인 · DQ 다량구매(1+1류) · DR 재구매 · DM 회원 · DN 신상품 · DS 배송비 · G* 사은품
        const TYPE_KO: Record<string, string> = { DP: "기간할인", DQ: "수량할인(1+1류)", DR: "재구매할인", DM: "회원할인", DN: "신상품할인", DS: "배송비할인" };
        // 상세를 8 병렬로 읽어 상품 목록·할인값을 뽑는다 (product_list는 유형별 하위 객체 안에 있음)
        const byProduct: Record<string, Record<string, unknown>[]> = {};
        const details: Record<string, unknown>[] = [];
        let idx = 0;
        const worker = async () => {
          while (idx < active.length) {
            const x = active[idx++];
            try {
              const d = await apiGet(`${API_BASE}/admin/benefits/${x.benefit_no}`, token);
              const bd = (d.benefit ?? {}) as Record<string, unknown>;
              let productList: number[] = [], discountValue: string | null = null, unit: string | null = null, minQty: number | null = null;
              for (const [k, v] of Object.entries(bd)) {
                if (!v || typeof v !== "object" || Array.isArray(v)) continue;
                const sub = v as Record<string, unknown>;
                if (Array.isArray(sub.product_list)) {
                  productList = (sub.product_list as unknown[]).map((n) => Number(n)).filter((n) => n > 0);
                  discountValue = sub.discount_value != null ? String(sub.discount_value) : null;
                  unit = sub.discount_value_unit != null ? String(sub.discount_value_unit) : null;
                  if (sub.bulk_purchase_begin_quantity != null) minQty = num(sub.bulk_purchase_begin_quantity);
                  if (k !== "gift") break;
                }
              }
              const type = String(bd.benefit_type ?? "");
              const isGift = String(bd.benefit_division ?? "") === "G";
              const label = isGift ? "사은품" : (TYPE_KO[type] ?? type);
              const desc = discountValue
                ? (unit === "P" ? `${Number(discountValue)}% 할인` : `${Math.round(Number(discountValue)).toLocaleString("ko-KR")}원 할인`) + (minQty ? ` (${minQty}개 이상)` : "")
                : label;
              const item = {
                benefit_no: Number(bd.benefit_no), name: String(bd.benefit_name ?? ""), type, label, desc,
                start: String(bd.benefit_start_date ?? "").slice(0, 10) || null, end: String(bd.benefit_end_date ?? "").slice(0, 10) || null,
                product_count: productList.length, binding: String(bd.product_binding_type ?? ""),
              };
              details.push(item);
              for (const no of productList) (byProduct[String(no)] = byProduct[String(no)] ?? []).push(item);
            } catch { /* 개별 실패 무시 */ }
          }
        };
        await Promise.all(Array.from({ length: Math.min(8, active.length) }, worker));
        return respond({ active_count: active.length, total_count: all.length, benefits: details, by_product: byProduct, fetched_at: new Date().toISOString() });
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (/insufficient_scope|403/.test(msg)) return json({ error: "not_permitted", message: "프로모션 읽기 권한(mall.read_promotion)이 없습니다 — 개발자센터 권한 추가 후 카페24 재연동 필요" }, 200);
        throw e;
      }
    }

    // ── 순반품률: 배송완료일 기준 상품별 전체수량 · 반품수량 ──
    // 기존 '순반품률 분석 대시보드 v6'와 동일 정책:
    //   모수  = 기간(배송완료일 date_type=shipend_date) 내 모든 주문 품목 수량 합
    //   반품 = 품목 상태 R40(반품완료-환불완료)·R30(처리중-수거전)·R34(처리중-환불전)만
    //   순반품률 = 반품수량 ÷ 전체수량 × 100
    if (action === "netreturns") {
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);

      // 2026-08-08 사용자 결정: 반품신청(R00)·접수(R10)도 포함 — 반품 관리 메뉴와 기준 통일.
      // 상태는 품목당 하나뿐이라 중복 집계 불가, 철회·반려는 실측 0건(신청 이력 2,730건 기준).
      const NET_RETURN_STATUSES = new Set(["R00", "R10", "R30", "R34", "R40"]);
      type Opt = { option: string; total_qty: number; return_qty: number };
      type Row = {
        product_no: number; product_name: string; total_qty: number; return_qty: number;
        opts: Map<string, Opt>;
      };
      const map = new Map<number, Row>();
      let totalQty = 0, returnQty = 0;
      // 주문 단위 shipend_date는 부분배송 시 기간 밖 품목까지 포함하므로,
      // 주문은 여유 범위로 수집한 뒤 '품목별 배송완료일(delivered_date)'로 정확히 필터
      // (관리자 전체주문조회의 배송완료일 검색과 동일 기준 — 실측 검증 완료)
      const day = 24 * 3600 * 1000;
      const pad = (d: Date) => d.toISOString().slice(0, 10);
      const fetchStart = pad(new Date(new Date(s).getTime() - 7 * day));
      const fetchEnd = pad(new Date(Math.min(new Date(e).getTime() + 30 * day, Date.now())));
      await eachOrder(token, "date_type=shipend_date&embed=items&fields=order_id,items", fetchStart, fetchEnd, (orders) => {
        for (const o of orders) {
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            const dd = String(it.delivered_date ?? "").slice(0, 10);
            if (!dd || dd < s || dd > e) continue;
            const no = Number(it.product_no);
            if (!no) continue;
            let row = map.get(no);
            if (!row) {
              row = {
                product_no: no, product_name: String(it.product_name ?? ""),
                total_qty: 0, return_qty: 0, opts: new Map(),
              };
              map.set(no, row);
            }
            const qty = num(it.quantity);
            const isReturn = NET_RETURN_STATUSES.has(String(it.order_status ?? ""));
            row.total_qty += qty; totalQty += qty;
            if (isReturn) { row.return_qty += qty; returnQty += qty; }
            // 옵션별 집계 (option_value 예: "컬러=아이보리, 사이즈=1사이즈")
            const optKey = String(it.option_value ?? "").trim() || "(단일 옵션)";
            let opt = row.opts.get(optKey);
            if (!opt) { opt = { option: optKey, total_qty: 0, return_qty: 0 }; row.opts.set(optKey, opt); }
            opt.total_qty += qty;
            if (isReturn) opt.return_qty += qty;
          }
        }
      });
      const rows = [...map.values()].map((r) => ({
        product_no: r.product_no, product_name: r.product_name,
        total_qty: r.total_qty, return_qty: r.return_qty,
        net_return_rate: r.total_qty > 0 ? +(r.return_qty / r.total_qty * 100).toFixed(2) : 0,
        options: [...r.opts.values()].map((o) => ({
          ...o,
          net_return_rate: o.total_qty > 0 ? +(o.return_qty / o.total_qty * 100).toFixed(2) : 0,
        })).sort((a, b) => b.total_qty - a.total_qty),
      })).sort((a, b) => b.return_qty - a.return_qty);
      return respond({
        period: { start: s, end: e },
        basis: "item_delivered_date",
        totals: {
          total_qty: totalQty, return_qty: returnQty,
          net_return_rate: totalQty > 0 ? +(returnQty / totalQty * 100).toFixed(2) : 0,
        },
        rows,
      });
    }

    // ── 반품 관리: 결제수량 상위 상품의 창별(7/14/21/30일) 순반품률 (관리자·MD) ──
    // 반품 상태 기준 = R00/R10 + R30/R34/R40 (신청·접수 포함).
    // 2026-08-08부터 netreturns(판매 성과)도 같은 기준 — 진열(displaymetrics)만 R30/R34/R40 유지.
    // 상태는 품목당 하나뿐이라 신청·접수를 더해도 중복 집계되지 않는다(실측: 철회·반려 코드 자체가 없음).
    //
    // 성능: 30일 창의 패딩 범위를 **한 번만** 훑고 delivered_date로 잘라 4개 창을 모두 만든다
    // (창마다 따로 조회하면 123초, 한 번 훑으면 ~50초 — 실측으로 4개 창 수치 완전 일치 확인).
    if (action === "returnwatch") {
      if (!["admin", "staff"].includes(authed.role)) return json({ error: "접근 권한이 없습니다" }, 403);
      const e = url.searchParams.get("end_date");
      if (!e) return json({ error: "end_date 필수 (YYYY-MM-DD)" }, 400);
      const topN = Math.max(1, Math.min(100, Number(url.searchParams.get("top") ?? 30)));
      const minQty = Math.max(0, Number(url.searchParams.get("min_qty") ?? 10));   // 소표본 판정 보류 기준
      const riskAt = Number(url.searchParams.get("risk") ?? 20);                    // '위험' 경계 (%)
      // 관리 상품(watch)도 창 집계에 포함 — 상위 N 밖이어도 관리 탭에서 7/14/30일 수치를 보여주기 위함.
      // 30일 창 주문 스캔은 어차피 전 주문을 훑으므로 추가 비용은 집계 몇 줄뿐이다.
      const extras = (url.searchParams.get("extra") ?? "").split(",")
        .map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 200);
      const hit = await fromCache(); if (hit) return json(hit);

      const RET = new Set(["R00", "R10", "R30", "R34", "R40"]);
      const WINDOWS = [7, 14, 21, 30];
      const endMs = new Date(e).getTime();
      const winStart: Record<number, string> = {};
      for (const w of WINDOWS) winStart[w] = ymd(endMs - (w - 1) * dayMs);
      const scanFrom = ymd(endMs - 29 * dayMs);

      // ① 결제수량 순위 — 애널리틱스(빠름). 7일·14일 각각의 상위 topN을 합집합으로 본다
      const paid: Record<number, Record<number, number>> = {};      // window → product_no → 결제수량
      const nameOf = new Map<number, string>();
      for (const w of [7, 14]) {
        const rows = await collectData("/products/sales", "sales",
          new URLSearchParams({ mall_id: MALL_ID, start_date: winStart[w], end_date: e }), token);
        const m: Record<number, number> = {};
        for (const r of rows) {
          const no = Number(r.product_no);
          if (!no) continue;
          m[no] = (m[no] ?? 0) + num(r.order_product_count);
          if (r.product_name) nameOf.set(no, String(r.product_name));
        }
        paid[w] = m;
      }
      const topOf = (w: number) => Object.entries(paid[w])
        .sort((a, b) => b[1] - a[1]).slice(0, topN).map(([no]) => Number(no));
      const rank7 = topOf(7), rank14 = topOf(14);
      const target = new Set([...rank7, ...rank14, ...extras]);   // extras는 순위 0·flagged 판정 제외(judge 창 없음)
      const rankIdx = (arr: number[], no: number) => { const i = arr.indexOf(no); return i < 0 ? 0 : i + 1; };

      // ② 배송완료·반품 수량 — 30일 창 패딩 범위를 한 번만 훑는다
      type Cell = { del: number; ret: number };
      const mk = (): Record<number, Cell> => ({ 7: { del: 0, ret: 0 }, 14: { del: 0, ret: 0 }, 21: { del: 0, ret: 0 }, 30: { del: 0, ret: 0 } });
      type Row = { name: string; win: Record<number, Cell>; opts: Map<string, Record<number, Cell>> };
      const rows = new Map<number, Row>();
      const fetchStart = ymd(new Date(scanFrom).getTime() - 7 * dayMs);
      const fetchEnd = ymd(Math.min(endMs + 30 * dayMs, Date.now()));

      await eachOrder(token, "date_type=shipend_date&embed=items&fields=order_id,items", fetchStart, fetchEnd, (orders) => {
        for (const o of orders) {
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            const no = Number(it.product_no);
            if (!no || !target.has(no)) continue;                    // 상위 상품만 집계 (응답 가볍게)
            const dd = String(it.delivered_date ?? "").slice(0, 10);
            if (!dd || dd < scanFrom || dd > e) continue;
            let row = rows.get(no);
            if (!row) { row = { name: String(it.product_name ?? nameOf.get(no) ?? ""), win: mk(), opts: new Map() }; rows.set(no, row); }
            const optKey = String(it.option_value ?? "").trim() || "(단일 옵션)";
            let opt = row.opts.get(optKey);
            if (!opt) { opt = mk(); row.opts.set(optKey, opt); }
            const qty = num(it.quantity);
            const isRet = RET.has(String(it.order_status ?? ""));
            for (const w of WINDOWS) {
              if (dd < winStart[w]) continue;
              row.win[w].del += qty; opt[w].del += qty;
              if (isRet) { row.win[w].ret += qty; opt[w].ret += qty; }
            }
          }
        }
      });

      // ③ 위험 판정 — 배송완료 minQty 미만은 '판정 보류'(소표본 요행 배제, 판매 성과와 같은 기준)
      const rate = (c: Cell) => c.del > 0 ? +(c.ret / c.del * 100).toFixed(2) : 0;
      const risky = (c: Cell) => c.del >= minQty && rate(c) >= riskAt;
      const out = [...rows.entries()].map(([no, r]) => {
        const options = [...r.opts.entries()].map(([option, w]) => ({
          option,
          windows: Object.fromEntries(WINDOWS.map((k) => [k, { ...w[k], rate: rate(w[k]), risk: risky(w[k]) }])),
        })).sort((a, b) => b.windows[14].del - a.windows[14].del);
        const windows = Object.fromEntries(WINDOWS.map((k) => [k, { ...r.win[k], rate: rate(r.win[k]), risk: risky(r.win[k]) }]));
        // 판정 창 = 순위에 든 창 (7일 상위면 7일, 14일 상위면 14일 — 둘 다면 둘 중 하나라도)
        const judge = [rank7.includes(no) ? 7 : 0, rank14.includes(no) ? 14 : 0].filter(Boolean) as number[];
        const productRisk = judge.some((w) => risky(r.win[w]));
        const optionRisk = options.filter((o) => judge.some((w) => o.windows[w].risk));
        return {
          product_no: no, product_name: r.name,
          rank7: rankIdx(rank7, no), rank14: rankIdx(rank14, no),
          paid7: paid[7][no] ?? 0, paid14: paid[14][no] ?? 0,
          windows, options,
          product_risk: productRisk,
          risk_options: optionRisk.map((o) => o.option),
          flagged: productRisk || optionRisk.length > 0,
        };
      }).sort((a, b) => (b.windows[14].rate - a.windows[14].rate));

      return respond({
        end_date: e, window_start: winStart, basis: "item_delivered_date",
        statuses: [...RET], min_qty: minQty, risk_at: riskAt, top: topN,
        products: out,
      });
    }

    // ── 상품별 반품 사유 원문 (판매 성과 상세용) ──
    // netreturns와 **완전히 같은 모수**를 쓴다: 품목 delivered_date 기준 기간 내 R00/R10/R30/R34/R40
    // (2026-08-08부터 신청·접수 포함 — netreturns와 동시 변경, 두 기준은 항상 같이 움직여야 함).
    // 다만 order_status 필터로 반품 주문만 받아 스캔량을 크게 줄인다 (실측 4,554건 → 486건).
    //
    // 카페24는 '반품 신청 사유'와 '반품 접수 사유'를 claim_reason 한 필드에 합쳐서 준다:
    //     "사이즈작음 (구매자 주문취소 : 구매 의사 취소)"
    //      └ 신청 사유 ┘ └────── 접수 사유 ──────┘
    // 사용자 규칙: 둘 다 있으면 중복으로 보고 **신청 사유만** 집계, 신청이 비면 접수 사유를 쓴다.
    if (action === "returnreasons") {
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);

      const NET_RETURN_STATUSES = ["R00", "R10", "R30", "R34", "R40"];
      const statusSet = new Set(NET_RETURN_STATUSES);
      const day = 24 * 3600 * 1000;
      const pad = (d: Date) => d.toISOString().slice(0, 10);
      const fetchStart = pad(new Date(new Date(s).getTime() - 7 * day));
      const fetchEnd = pad(new Date(Math.min(new Date(e).getTime() + 30 * day, Date.now())));

      type Out = {
        product_no: number; product_name: string; option: string;
        qty: number; date: string; request: string; accept: string;
        claim: string;   // 클레임 번호 — 여러 상품 동반 반품 시 사유가 공유되므로 클라이언트가 이걸로 구분
      };
      const items: Out[] = [];
      const filter = `date_type=shipend_date&order_status=${NET_RETURN_STATUSES.join(",")}` +
        `&embed=items&fields=order_id,items`;
      await eachOrder(token, filter, fetchStart, fetchEnd, (orders) => {
        for (const o of orders) {
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            if (!statusSet.has(String(it.order_status ?? ""))) continue;
            const dd = String(it.delivered_date ?? "").slice(0, 10);
            if (!dd || dd < s || dd > e) continue;      // netreturns와 동일한 기간 판정
            const no = Number(it.product_no);
            if (!no) continue;
            const { request, accept } = splitClaimReason(it.claim_reason);
            items.push({
              product_no: no,
              product_name: String(it.product_name ?? ""),
              option: String(it.option_value ?? "").trim(),
              qty: num(it.quantity),
              date: dd,
              request, accept,
              claim: String(it.claim_code ?? o.order_id ?? ""),
            });
          }
        }
      });
      return respond({ period: { start: s, end: e }, basis: "item_delivered_date", items });
    }

    // ── 결제 주차별(코호트) 취소·반품률 (2026-09-11 사용자 요청 — 에이전트 반품 감시용) ──
    // "그 주에 결제된 주문 중 몇 %가 (언제든) 취소·반품됐나"를 결제 주에 귀속시킨다. 취소가 다음 주에 일어나도
    // 결제 주로 돌아간다. 주 = 월~일. 최근 주는 아직 취소·반품이 다 안 들어온 상태라 age_days를 같이 준다.
    //   GET ?action=cohortweeks&end_date=YYYY-MM-DD[&weeks=6][&days=14]
    //   → { weeks: [{week_start, week_end, partial, age_days, paid, cancel, cancel_rate, ret, return_rate}], days: [...] }
    // 집계 = 카페24 /orders/count (date_type=pay_date) 3회/구간: 전체 · order_status=C40 · order_status=R00~R40.
    // 취소+반품이 한 주문에 공존(혼합)하면 둘 다에 세어진다(드묾). 네이버페이 주문은 분자·분모에 같이 포함(비율엔 무해).
    if (action === "cohortweeks") {
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const e = url.searchParams.get("end_date");
      if (!e) return json({ error: "end_date 필수 (YYYY-MM-DD)" }, 400);
      const weeks = Math.max(1, Math.min(12, Number(url.searchParams.get("weeks") ?? 6)));
      const days = Math.max(0, Math.min(28, Number(url.searchParams.get("days") ?? 14)));
      const hit = await fromCache(); if (hit) return json(hit);

      const endMs = new Date(`${e}T12:00:00Z`).getTime();
      const dowOf = (ms: number) => new Date(ms).getUTCDay();
      const mondayMs = endMs - ((dowOf(endMs) + 6) % 7) * dayMs;
      const RET = "R00,R10,R30,R34,R40";
      const todayKst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
      const daysSince = (d: string) => Math.round((new Date(`${todayKst}T12:00:00Z`).getTime() - new Date(`${d}T12:00:00Z`).getTime()) / dayMs);
      type Cohort = { start: string; end: string; paid: number; cancel: number; ret: number };
      const spans: { key: string; start: string; end: string; partial?: boolean }[] = [];
      for (let i = 0; i < weeks; i++) {
        const ws = mondayMs - i * 7 * dayMs, weFull = ws + 6 * dayMs;
        spans.push({ key: `w${i}`, start: ymd(ws), end: ymd(Math.min(weFull, endMs)), partial: weFull > endMs });
      }
      for (let i = 0; i < days; i++) { const d = ymd(endMs - i * dayMs); spans.push({ key: `d${i}`, start: d, end: d }); }
      // 건수 조회는 가벼워서 4개씩 병렬
      const results = new Map<string, Cohort>();
      let idx = 0;
      const worker = async () => {
        while (idx < spans.length) {
          const sp = spans[idx++];
          const base = `start_date=${sp.start}&end_date=${sp.end}&date_type=pay_date`;
          const [paid, cancel, ret] = await Promise.all([
            countOrders(token, base), countOrders(token, `${base}&order_status=C40`), countOrders(token, `${base}&order_status=${RET}`),
          ]);
          results.set(sp.key, { start: sp.start, end: sp.end, paid, cancel, ret });
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, spans.length) }, worker));   // 60여 건수 호출 — 8 병렬(실측 4 병렬 32초 → 절반 목표)
      const rate = (n: number, d: number) => d > 0 ? +(n / d * 100).toFixed(2) : null;
      const shape = (sp: typeof spans[number]) => {
        const c = results.get(sp.key)!;
        return {
          start: c.start, end: c.end, partial: !!sp.partial, age_days: daysSince(c.end),
          paid: c.paid, cancel: c.cancel, cancel_rate: rate(c.cancel, c.paid), ret: c.ret, return_rate: rate(c.ret, c.paid),
          claim_rate: rate(c.cancel + c.ret, c.paid),
        };
      };
      return respond({
        end_date: e, basis: "pay_date", week: "mon_sun", statuses: { cancel: "C40", ret: RET },
        weeks: spans.filter((s) => s.key.startsWith("w")).map(shape),
        days: spans.filter((s) => s.key.startsWith("d")).map(shape),
        note: "age_days = 구간 끝일로부터 오늘까지 지난 날. 14일 미만이면 취소·반품이 아직 더 들어올 수 있음",
      });
    }

    // ── 기간 내 품목별 결제수량 (안정재고 편성 + 광고관리자 실결제 수 열) ──
    // 결제일 기준으로 주문을 수집해 product_no + option_value 단위로 수량 합산.
    // 주의: 카페24 date_type의 결제일 값은 payment_date가 아니라 `pay_date` (다른 값은 422 반환).
    // items: [{product_no, product_name, option_value, paid_qty}]
    // 권한: 관리자 전용 (2026-08-26 admgr용으로 admin+staff로 잠깐 열었다가, 같은 날
    // 광고관리자 메뉴가 관리자 전용이 되면서 원래대로 축소 — staff 소비처 없음)
    if (action === "paiditems") {
      // 관리자 + 물류팀(품절 재고 점검의 '최근 14일 판매' — 수량만, 금액 없음. 2026-09-29 사용자 요청으로 물류팀에 품절 재고 점검 공개)
      if (authed.role !== "admin" && !(await soldoutRoleOk(authed))) return json({ error: "접근 권한이 없습니다" }, 403);
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);

      type Item = {
        product_no: number; product_name: string; option_value: string;
        paid_qty: number; canceled_qty: number;
      };
      const map = new Map<string, Item>();
      // 취소·반품으로 되돌아간 수량은 별도 집계 (결제수량 자체는 그대로 유지)
      const CANCELED = new Set(["C40", "R40", "R30", "R34"]);
      let orderCount = 0;
      await eachOrder(token, "date_type=pay_date&embed=items&fields=order_id,items", s, e, (orders) => {
        orderCount += orders.length;
        for (const o of orders) {
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            const no = Number(it.product_no);
            if (!no) continue;
            const opt = String(it.option_value ?? "").trim();
            const key = `${no}|${opt}`;
            let row = map.get(key);
            if (!row) {
              row = {
                product_no: no, product_name: String(it.product_name ?? ""),
                option_value: opt, paid_qty: 0, canceled_qty: 0,
              };
              map.set(key, row);
            }
            const qty = num(it.quantity);
            row.paid_qty += qty;
            if (CANCELED.has(String(it.order_status ?? ""))) row.canceled_qty += qty;
          }
        }
      });

      // 전체 상품명 목록 — 기간 내 결제가 0건인 상품도 "카페24에 존재함"을 판정하려면 필요.
      // (이게 없으면 판매 0건 재고가 '미매칭'과 구분되지 않음)
      // 주의: /admin/products는 limit 최대 100 (초과 시 422), offset은 정상 동작
      const products: { product_no: number; product_name: string }[] = [];
      const PLIMIT = 100;
      for (let offset = 0; offset <= 20000; offset += PLIMIT) {
        const body = await apiGet(
          `${API_BASE}/admin/products?limit=${PLIMIT}&offset=${offset}&fields=product_no,product_name`, token);
        const ps = (body.products ?? []) as Record<string, unknown>[];
        for (const p of ps) {
          products.push({ product_no: Number(p.product_no), product_name: String(p.product_name ?? "") });
        }
        if (ps.length < PLIMIT) break;
      }

      const items = [...map.values()].sort((a, b) => b.paid_qty - a.paid_qty);
      return respond({
        period: { start: s, end: e },
        order_count: orderCount, item_count: items.length,
        product_count: products.length,
        items, products,
      });
    }

    // ── 판매 성과: 기간 판매수량 + 취소·반품완료 수량 + 판매가·공급가 ──
    // rows: [{product_no, product_name, paid_qty(주문수량), order_amount(주문금액),
    //          cancel_qty(취소·반품완료 수량), price(판매가), supply_price(공급가)}]
    // ── 자체제작 주문 점검 (2026-09-03 사용자 요청) — 상품명에 '자체제작'/'made' 포함 상품의 일평균 순판매량 ──
    // 3일·7일 일평균(어제까지) + 신상 보정: 첫 판매가 창 안이면 분모를 실제 판매일수로 (÷7 저평가 방지, 사용자 설계).
    // 구현: 애널리틱스 일별 7회(어제-6~어제) + 30일 합계 1회 + 취소(C40/R40) 30일 스캔 1회. 순판매 = 결제 − 취소 (주문일 기준 — 판매 성과와 동일).
    if (action === "madeavg") {
      if (!["admin", "staff"].includes(authed.role)) return json({ error: "접근 권한이 없습니다" }, 403);
      const e = url.searchParams.get("end_date");   // = 어제 (클라이언트가 KST로 계산해 전달 — v 파라미터와 함께 캐시 키에 포함)
      if (!e) return json({ error: "end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);
      const day = 24 * 3600 * 1000;
      const dstr = (t: number) => new Date(t).toISOString().slice(0, 10);
      const endMs = new Date(e).getTime();
      const s30 = dstr(endMs - 29 * day);
      const MADE_RE = /자체제작|made/i;
      // scope=all (2026-09-30): 재고·입고 점검 탭의 '지정 상품'(made 아님)도 평균이 필요해 상품명 필터 없이 전체 — 캐시 키에 scope 포함
      const scopeAll = url.searchParams.get("scope") === "all";

      // v2 (2026-09-03): 발주는 옵션 단위라 옵션별 집계가 필요 → 애널리틱스 대신 30일 주문 품목 스캔 1회로 전환.
      // 결제수량 = 품목 quantity 전체(취소분 포함 — 판매 성과의 애널리틱스 결제수량과 같은 사상),
      // 취소수량 = 그중 order_status C40/R40. 한 스캔에서 상품·옵션·일별을 동시에 얻는다.
      type Win = { qty3: number; qty7: number; qty30: number; cancel3: number; cancel7: number; cancel30: number };
      const newWin = (): Win => ({ qty3: 0, qty7: 0, qty30: 0, cancel3: 0, cancel7: 0, cancel30: 0 });
      type Row = { product_no: number; product_name: string; daily: number[]; win: Win; opts: Map<string, Win> };
      const map = new Map<number, Row>();

      await eachOrder(token,
        "date_type=order_date&embed=items&fields=order_id,order_date,items", s30, e, (orders) => {
        for (const o of orders) {
          const od = String(o.order_date ?? "").slice(0, 10);
          const age = Math.round((endMs - new Date(od).getTime()) / day);   // 0 = 어제
          if (age < 0 || age > 29) continue;
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            const name = String(it.product_name ?? "");
            if (!scopeAll && !MADE_RE.test(name)) continue;
            const no = Number(it.product_no);
            let r = map.get(no);
            if (!r) { r = { product_no: no, product_name: name, daily: [0, 0, 0, 0, 0, 0, 0], win: newWin(), opts: new Map() }; map.set(no, r); }
            const q = num(it.quantity);
            const canceled = ["C40", "R40"].includes(String(it.order_status ?? ""));
            const opt = String(it.option_value ?? "").trim() || "단일상품";
            let w = r.opts.get(opt);
            if (!w) { w = newWin(); r.opts.set(opt, w); }
            for (const t of [r.win, w]) {
              t.qty30 += q;
              if (age < 7) t.qty7 += q;
              if (age < 3) t.qty3 += q;
              if (canceled) {
                t.cancel30 += q;
                if (age < 7) t.cancel7 += q;
                if (age < 3) t.cancel3 += q;
              }
            }
            if (age < 7) r.daily[6 - age] += q;
          }
        }
      });

      const rows = [...map.values()].map((r) => {
        // 신상 보정: 30일 결제가 전부 최근 7일 안 → 첫 판매일부터 어제까지를 분모로 (사용자 설계 — ÷7 저평가 방지)
        let days7 = 7, days3 = 3, firstSale: string | null = null;
        if (r.win.qty30 <= r.win.qty7 && r.win.qty7 > 0) {
          const firstIdx = r.daily.findIndex((v) => v > 0);
          firstSale = dstr(endMs - (6 - firstIdx) * day);
          days7 = 7 - firstIdx;
          days3 = Math.min(3, days7);
        }
        const nets = (w: Win) => ({
          net3: Math.max(0, w.qty3 - w.cancel3),
          net7: Math.max(0, w.qty7 - w.cancel7),
          net30: Math.max(0, w.qty30 - w.cancel30),
        });
        const p = nets(r.win);
        const options = [...r.opts.entries()].map(([opt, w]) => {
          const n = nets(w);
          return {
            option: opt, ...n,
            avg3: days3 > 0 ? n.net3 / days3 : 0,   // 분모는 상품의 판매 개시일 기준 (옵션 공통)
            avg7: days7 > 0 ? n.net7 / days7 : 0,
          };
        }).sort((a, b) => b.avg7 - a.avg7);
        return {
          product_no: r.product_no, product_name: r.product_name,
          ...p, days3, days7, first_sale: firstSale,
          avg3: days3 > 0 ? p.net3 / days3 : 0,
          avg7: days7 > 0 ? p.net7 / days7 : 0,
          options,
        };
      }).sort((a, b) => b.avg7 - a.avg7);

      return respond({ period: { start: s30, end: e }, count: rows.length, rows });
    }

    if (action === "performance") {
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);   // 키에 역할 포함됨

      // ① 기간 판매(주문) 수량·금액 — 애널리틱스
      const base = new URLSearchParams({ mall_id: MALL_ID, start_date: s, end_date: e });
      const sales = await collectData("/products/sales", "sales", base, token);

      type Perf = {
        product_no: number; product_name: string;
        paid_qty: number; order_amount: number; cancel_qty: number;
        price: number; supply_price: number;
      };
      const map = new Map<number, Perf>();
      for (const r of sales) {
        const no = Number(r.product_no);
        const cur = map.get(no) ?? {
          product_no: no, product_name: String(r.product_name ?? ""),
          paid_qty: 0, order_amount: 0, cancel_qty: 0, price: 0, supply_price: 0,
        };
        cur.paid_qty += num(r.order_product_count);
        cur.order_amount += num(r.order_amount);
        map.set(no, cur);
      }

      // ② 취소·반품 완료 수량 — 주문 품목(C40/R40) 집계 (주문일 기준, 전 채널)
      await eachOrder(token,
        "date_type=order_date&order_status=C40,R40&embed=items&fields=order_id,items", s, e, (orders) => {
        for (const o of orders) {
          for (const it of (o.items ?? []) as Record<string, unknown>[]) {
            const st = String(it.order_status ?? "");
            if (st !== "C40" && st !== "R40") continue;
            const row = map.get(Number(it.product_no));
            if (row) row.cancel_qty += num(it.quantity);
          }
        }
      });

      // ③ 판매가·공급가 — 상품 정보 (100개씩 배치)
      const nos = [...map.keys()];
      for (let i = 0; i < nos.length; i += 100) {
        const chunk = nos.slice(i, i + 100).join(",");
        const body = await apiGet(
          `${API_BASE}/admin/products?product_no=${chunk}` +
          `&fields=product_no,product_name,price,supply_price&limit=100`, token);
        for (const p of (body.products ?? []) as Record<string, unknown>[]) {
          const row = map.get(Number(p.product_no));
          if (!row) continue;
          row.price = num(p.price);
          row.supply_price = num(p.supply_price);
          if (!row.product_name) row.product_name = String(p.product_name ?? "");
        }
      }

      const rows = [...map.values()].sort((a, b) => b.paid_qty - a.paid_qty);
      // 주문금액(판매합계)은 관리자만 — 직원·CS는 UI에서도 숨김/블러 처리되는 값이라 서버에서 0으로 제거
      if (authed.role !== "admin") for (const r of rows) r.order_amount = 0;
      return respond({ period: { start: s, end: e }, product_count: rows.length, rows });
    }

    // ── 조회수 + 주문수 통합 (기본) ──
    const startDate = url.searchParams.get("start_date");
    const endDate = url.searchParams.get("end_date");
    if (!startDate || !endDate) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);

    const base = new URLSearchParams({ mall_id: MALL_ID, start_date: startDate, end_date: endDate });
    const device = url.searchParams.get("device_type");
    if (device && device !== "total") base.set("device_type", device);

    const [views, sales] = await Promise.all([
      collectData("/products/view", "view", base, token),
      collectData("/products/sales", "sales", base, token),
    ]);

    // product_no 기준 조인
    type Row = {
      product_no: number; product_name: string;
      views: number; order_count: number; order_qty: number; order_amount: number; rate: number;
    };
    const map = new Map<number, Row>();
    const rowOf = (no: number, name: string): Row => {
      let r = map.get(no);
      if (!r) {
        r = { product_no: no, product_name: name, views: 0, order_count: 0, order_qty: 0, order_amount: 0, rate: 0 };
        map.set(no, r);
      }
      if (name && !r.product_name) r.product_name = name;
      return r;
    };
    for (const v of views) {
      const r = rowOf(Number(v.product_no), String(v.product_name ?? ""));
      r.views += num(v.count);
    }
    for (const s of sales) {
      const r = rowOf(Number(s.product_no), String(s.product_name ?? ""));
      r.order_count += num(s.order_count);
      r.order_qty += num(s.order_product_count);
      r.order_amount += num(s.order_amount);
    }

    const rows = [...map.values()];
    for (const r of rows) r.rate = r.views > 0 ? +(r.order_count / r.views * 100).toFixed(2) : 0;
    rows.sort((a, b) => b.views - a.views);
    if (authed.role !== "admin") for (const r of rows) r.order_amount = 0;   // 주문금액은 관리자만 — performance와 동일 (보안 점검 2026-09-22)

    const totals = rows.reduce((t, r) => ({
      views: t.views + r.views,
      order_count: t.order_count + r.order_count,
      order_qty: t.order_qty + r.order_qty,
      order_amount: t.order_amount + r.order_amount,
    }), { views: 0, order_count: 0, order_qty: 0, order_amount: 0 });

    return json({
      period: { start: startDate, end: endDate },
      device_type: device ?? "total",
      product_count: rows.length,
      totals: { ...totals, rate: totals.views > 0 ? +(totals.order_count / totals.views * 100).toFixed(2) : 0 },
      rows,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
