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
// ── 변심인데 반품 배송비 차감이 없는 반품 → 수거 완료 막기 (2026-10-23 사용자 요청 "무조건 카페24 주문을 먼저 확인하도록")
//   대상 사유 = 자사몰 접수 사유 코드 A·O(카페24 '고객변심' — 사유 문구 '변심·단순변심·사이즈 미스' 등) + P(상품불만족 — 같은 날 사용자 요청으로 추가). 네이버페이는 카페24에서 수거 완료를 못 해서 대상 아님.
//   차감액 = 반품 접수의 return_shipping_fee(카페24는 음수로 줌 — 환불 대조와 같은 기준, 절댓값). 이미 수거된 건·철회 건은 대상 아님.
const RSCAN_FEE_HOLD_LABEL: Record<string, string> = { A: "변심", O: "변심", P: "상품불만족" };
const RSCAN_CHANGE_MIND = Object.keys(RSCAN_FEE_HOLD_LABEL);
const rscanFeeHoldMsg = (t: unknown) => `${RSCAN_FEE_HOLD_LABEL[String(t ?? "")] ?? "변심"}인데 배송비 차감이 안되어있어요. 카페24에서 확인해주세요`;
function rscanRetFee(c: Record<string, any>): number | null {
  if (!c || !("return_shipping_fee" in c)) return null;
  return Math.abs(Math.round(Number(c.return_shipping_fee ?? 0) || 0));
}
function rscanFeeHold(e: Record<string, any>): boolean {
  if (e.kind !== "return" || e.naver || e.withdrawn) return false;
  if (!RSCAN_CHANGE_MIND.includes(String(e.reason_type ?? ""))) return false;
  const st = String(e.status ?? ""), ex = String(e.status_extra ?? "");
  if (/철회/.test(st + ex) || st === "반품완료" || /환불전/.test(ex)) return false;
  return e.ret_fee === 0;
}
// 막힐 후보(변심 반품인데 인덱스상 차감 0 또는 모름)는 카페24에서 주문을 다시 읽어 차감액·상태를 새로 고친다 —
// 카페24에서 배송비를 고친 직후 다시 스캔하면 바로 풀리게(인덱스는 15분마다 갱신). 최대 max건.
async function rscanFeeRefresh(hits: Record<string, any>[], token: string, max = 5): Promise<Record<string, any>[]> {
  const cand = (e: Record<string, any>) => e.kind === "return" && !e.naver && !e.withdrawn && RSCAN_CHANGE_MIND.includes(String(e.reason_type ?? "")) && (e.ret_fee == null || e.ret_fee === 0)
    && !(String(e.status ?? "") === "반품완료" || /환불전/.test(String(e.status_extra ?? "")));
  const ids = [...new Set(hits.filter(cand).map((e) => String(e.order_id)))].slice(0, max);
  const live = new Map<string, Record<string, any>>();
  for (const id of ids) {
    try { const o = ((await apiGet(`${API_BASE}/admin/orders/${id}?embed=items,return`, token)).order ?? {}) as Record<string, any>; live.set(id, o); } catch { /* 못 읽으면 인덱스 값 그대로 */ }
  }
  return hits.map((e) => {
    const o = live.get(String(e.order_id)); if (!o || !cand(e)) return e;
    const c = (((o.return ?? []) as Record<string, any>[]).find((x) => x.claim_code === e.claim_code)) ?? null;
    if (!c) return e;
    const its = ((o.items ?? []) as Record<string, any>[]).filter((it) => it.claim_code === e.claim_code);
    return { ...e, ret_fee: rscanRetFee(c), reason_type: c.claim_reason_type ?? e.reason_type, status: its[0]?.status_text ?? e.status, status_extra: its[0]?.order_status_additional_info ?? e.status_extra, fee_live: true };
  });
}
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
      ret_fee: kind === "return" ? rscanRetFee(c) : null,   // 반품 배송비 차감액(양수, 원) — 변심인데 0이면 수거 완료를 막음(2026-10-23)
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
// ── 네이버페이 취소신청 접수는 서버가 하지 않는다 (2026-10-05) ──
// 처음엔 여기서 공개 API(POST orders/{id}/cancellation, status accepted)로 접수하려 했으나(cafe24AcceptNaverCancel) 실사용 두 번 모두 422:
//   품목 지정 → "Partial cancellation is unavailable for NAVER Pay orders." / 품목 없이 → "Partial return is unavailable for NAVER Pay orders."
// 공개 API는 '관리자가 새로 넣는 취소'만 처리하고, 고객이 넣은 취소신청(C00) 품목은 취소 가능한 상품으로 보지 않는다(관리자 화면 order_cancel_list.php도
// "현재 취소 가능한 상품이 없습니다"). 접수는 관리자 화면 '취소 처리' 창(order_cancel_handling.php → do_order_ncheckout.php)으로만 되므로,
// 이 PC 브라우저의 연결 스크립트(window.CAFE24_CANCEL)가 한다. 서버는 분류·준비·확인·기록만 — **카페24 쓰기는 다시 수거 완료 하나뿐.**
const NPAY_CANCEL_TYPES: Record<string, string> = { "구매 의사 취소": "51", "색상 및 사이즈 변경": "52", "다른 상품 잘못 주문": "53", "서비스 및 상품 불만족": "54", "배송 지연": "55", "상품 품절": "56", "상품 정보 상이": "60" };

// ══ 카페24 쓰기 ②③ — 자사몰 취소접수의 환불 처리 (2026-10-05 사용자 요청·승인) ══
// 고객이 자사몰에서 넣어 이미 '취소접수'(C10)인 주문을 ② 취소처리중(환불전)으로 넘기고 ③ 환불완료(PG 결제취소 포함)로 끝낸다. 수거 완료와 같은 원칙:
//  · 주소와 본문을 호출자가 넘기지 못한다 — 검증된 주문번호·접수번호로 이 함수들이 직접 조립한다. **금액은 보내지 않는다(카페24가 계산)**.
//  · ② 본문 고정 { shop_no:1, requests:[{ order_id, claim_code, status:"canceling", recover_inventory, add_memo_too:"F", refund_method_code:[F|G] }] } — 철회(undone)·계좌 필드 없음.
//    환불 수단(refund_method_code)은 필수였다: 2026-10-05 첫 실사용에서 빼고 보내자 422 "The refund amount exceeds the available amount for this refund method.
//    Select an additional payment method for refund. The available method is [T, M, G]"(주문은 취소접수 그대로). 값은 호출자가 아니라 서버가 주문의 결제 수단으로 정한다 —
//    신용카드 = "F", 계좌이체 = "G" 하나만(관리자 '취소 처리' 화면이 고르는 환불 방식 값과 같음: 자동 대상 40건 실측 F 38·G 2).
//    2026-10-06 사용자 지정으로 선불금(네이버페이 포인트·머니) = "O" 추가 — 지난달 선불금 취소 89건 실측: 환불 방식 '선불금 환불', 환불 수단 값 prepaid, 전체 취소 73건 환불액 = 처음 결제액.
//    "M"(적립금으로 환불)·"T"(현금 환불)은 보내지 않는다 — 쓴 적립금은 환불 수단이 아니라 카페24가 따로 돌려준다(used_points).
//  · ③ 본문 고정 { shop_no:1, request:{ status:"complete", payment_gateway_cancel:"T", send_sms:"T", send_mail:"T" } } — 고객 알림은 카페24 자동 알림 설정대로.
//  · ③은 반드시 ②와 ③ 사이의 금액 확인(카페24가 계산한 환불액 = 워크스페이스가 계산한 환불액, 원 단위)을 통과한 뒤에만 부른다(selfcancel_run).
//  · 다른 쓰기가 필요해지면 여기 허용 목록을 넓히지 말고 사용자 승인부터 받을 것. tools/check_cafe24_writes.sh 가 배포 전 검사한다.
async function cafe24Write(method: "PUT", url: string, payload: string, token: string): Promise<Record<string, unknown>> {
  if (!/^https:\/\/[a-z0-9]+\.cafe24api\.com\/api\/v2\/admin\/(cancellation|orders\/\d{8}-\d{7}\/refunds\/[A-Z]\d{8}-\d{7})$/.test(url)) throw new Error("허용되지 않은 쓰기(주소)");
  const doFetch = (tk: string) => fetch(url, { method, headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json", "X-Cafe24-Api-Version": API_VERSION }, body: payload });
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
async function cafe24CancelToRefunding(orderId: string, claimCode: string, recover: "T" | "F", refundMethod: "F" | "G" | "O", token: string): Promise<Record<string, unknown>> {
  if (!/^\d{8}-\d{7}$/.test(orderId) || !/^C\d{8}-\d{7}$/.test(claimCode)) throw new Error("허용되지 않은 쓰기(번호 형식)");
  if (recover !== "T" && recover !== "F") throw new Error("허용되지 않은 쓰기(재고 복구 값)");
  if (refundMethod !== "F" && refundMethod !== "G" && refundMethod !== "O") throw new Error("허용되지 않은 쓰기(환불 수단)");
  const payload = JSON.stringify({ shop_no: 1, requests: [{ order_id: orderId, claim_code: claimCode, status: "canceling", recover_inventory: recover, add_memo_too: "F", refund_method_code: [refundMethod] }] });
  return await cafe24Write("PUT", `${API_BASE}/admin/cancellation`, payload, token);
}
async function cafe24CompleteRefund(orderId: string, refundCode: string, token: string): Promise<Record<string, unknown>> {
  if (!/^\d{8}-\d{7}$/.test(orderId) || !/^[A-Z]\d{8}-\d{7}$/.test(refundCode)) throw new Error("허용되지 않은 쓰기(번호 형식)");
  const payload = JSON.stringify({ shop_no: 1, request: { status: "complete", payment_gateway_cancel: "T", send_sms: "T", send_mail: "T" } });
  return await cafe24Write("PUT", `${API_BASE}/admin/orders/${orderId}/refunds/${refundCode}`, payload, token);
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
// ── 취소·반품 접수 권한 (2026-10-08 사용자 요청): 관리자 + 허용 목록(cxl_users)의 직원. 목록은 관리자가 직원 관리 화면에서만 고친다(db 프록시).
//    허용된 직원도 자사몰 취소의 최종 환불(환불완료·PG 결제취소)은 못 한다 — selfcancel_run이 refund:true를 관리자에게서만 받는다.
async function cxlRoleOk(authed: { id: string; role: string }): Promise<boolean> {
  if (authed.role === "admin") return true;
  if (["sales-agent", "cron", "npm-sync"].includes(authed.id)) return false;
  const rows = ((await sbRest(`cxl_users?user_id=eq.${encodeURIComponent(authed.id)}&select=user_id`)) ?? []) as unknown[];
  return rows.length > 0;
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

// ── 취소·반품 접수 (#cxl, 2026-10-05 사용자 요청) — 네이버페이 취소신청(C00) 분류 ──
// 한 주문의 취소신청 품목을 '사유가 같은 것끼리' 한 건으로 묶고, 고객이 고른 사유("… (구매자 주문취소 : 배송 지연)")를
// 네이버페이 취소 구분(NPAY_CANCEL_TYPES)으로 옮긴다. 자동으로 접수해도 되는지 애매하면 flags에 이유를 적는다:
//   level 'block' = 이 화면에서 접수할 수 없음(카페24에서 직접) / 'check' = 직접 확인 권장(확인 뒤 한 건씩 접수 가능).
const CXL_ASK_WORDS = /연락|전화|통화|문의|주소|합배송|묶음|배송비|교환|부탁|주세요|주실|가능한가요|가능할까요|되나요|될까요|\?/;
const CXL_WAIT = new Set(["N10", "N20"]);            // 취소 전 상태가 이 둘이면 아직 안 보낸 상품
const CXL_UNSHIPPED = new Set(["N10", "N20", "N21", "N22"]);
type CxlFlag = { level: "block" | "check"; text: string; tag?: string };
// '확인할 점' 문장 → 짧은 꼬리표(화면에서 한눈에 보이게, 2026-10-05 사용자 요청). 문장은 그대로 두고 꼬리표만 붙인다.
const CXL_TAGS: [RegExp, string][] = [
  [/일부만 취소|일부 상품만/, "부분 취소"], [/이미 처리된 다른 상품/, "다른 상품 처리됨"], [/접수가 여러 건|사유가 여러 가지/, "접수 여러 건"],
  [/사유가 품절/, "품절 사유"], [/상품별 추가할인/, "상품별 할인"], [/1\+1/, "1+1 상품"], [/예치금/, "예치금"], [/결제가 끝나지/, "미결제"], [/취소 (신청 )?전 상태/, "발송 단계"],
  [/송장번호/, "송장 있음"], [/수량 중 일부/, "수량 일부"], [/결제 금액을 읽지/, "금액 확인"], [/네이버페이 주문이 아니/, "네이버페이 아님"], [/네이버페이 주문이에요/, "네이버페이"],
  [/취소 구분 목록에 없는|취소 사유를 읽지/, "구분 없음"], [/판매자 쪽/, "판매자 취소"], [/'취소 요청'이 아니/, "철회 가능성"], [/교환·반품이 함께/, "교환·반품 진행"], [/요청이나 문의/, "고객 요청 글"],
];
function cxlTagOf(text: string): string {
  const pm = text.match(/^결제 수단\(([^+)]+)/);
  if (pm) return `${pm[1]} 결제`;
  return (CXL_TAGS.find(([re]) => re.test(text)) ?? [null, "확인"])[1] as string;
}
function cxlGroupsOf(o: Record<string, any>): Record<string, any>[] {
  const all = (o.items ?? []) as Record<string, any>[];
  const req = all.filter((it) => String(it.order_status ?? "") === "C00");
  if (!req.length) return [];
  const naver = o.order_place_id === "NCHECKOUT" || o.market_id === "NCHECKOUT";
  const byReason = new Map<string, Record<string, any>[]>();
  for (const it of req) { const k = String(it.claim_reason ?? "").trim(); byReason.set(k, [...(byReason.get(k) ?? []), it]); }
  const reqCodes = new Set(req.map((it) => String(it.order_item_code ?? "")));
  const others = all.filter((it) => !reqCodes.has(String(it.order_item_code ?? "")));
  const othersWaiting = others.filter((it) => CXL_UNSHIPPED.has(String(it.order_status ?? "")));
  const othersClaim = others.filter((it) => /^[ER][0-3]/.test(String(it.order_status ?? "")));
  const groups: Record<string, any>[] = [];
  for (const [raw, its] of byReason) {
    const { request, accept } = splitClaimReason(raw);
    const bySeller = /\(판매자\s*주문취소/.test(raw);
    const type = NPAY_CANCEL_TYPES[accept] ?? null;
    const flags: CxlFlag[] = [];
    if (!naver) flags.push({ level: "block", text: "네이버페이 주문이 아니에요 — 이 화면에서는 접수할 수 없어요" });
    if (!type) flags.push({ level: "block", text: accept ? `취소 구분 목록에 없는 사유예요("${accept}") — 카페24에서 직접 접수해주세요` : "고객이 고른 취소 사유를 읽지 못했어요 — 카페24에서 직접 접수해주세요" });
    if (bySeller) flags.push({ level: "check", text: "고객이 아니라 판매자 쪽에서 넣은 취소예요" });
    if (naver && its.some((it) => String(it.naver_pay_claim_status ?? "") !== "CANCEL_REQUEST")) flags.push({ level: "check", text: "네이버페이 쪽 상태가 '취소 요청'이 아니에요 — 고객이 철회했을 수 있어요" });
    const beforeBad = [...new Set(its.map((it) => String(it.order_status_before_cs ?? "")).filter((b) => !CXL_WAIT.has(b)))];
    if (beforeBad.length) flags.push({ level: "check", text: `취소 신청 전 상태가 배송준비중이 아니에요(${beforeBad.map((b) => b || "알 수 없음").join(", ")}) — 이미 발송 단계일 수 있어요` });
    if (its.some((it) => !!it.tracking_no)) flags.push({ level: "check", text: "송장번호가 이미 등록돼 있어요 — 발송됐는지 확인이 필요해요" });
    if (o.paid !== "T") flags.push({ level: "check", text: "결제가 끝나지 않은 주문이에요" });
    // 관리자 '취소 처리' 창은 취소신청 품목만 접수한다 → 일부만 취소 신청한 주문도 접수는 되지만, 남은 상품이 발송되므로 확인 권장
    if (othersWaiting.length) flags.push({ level: "check", text: `주문의 일부만 취소 신청했어요 — 남은 상품 ${othersWaiting.length}개는 그대로 발송돼요` });
    if (othersClaim.length) flags.push({ level: "check", text: "같은 주문에 교환·반품이 함께 진행 중이에요" });
    if (its.some((it) => Number(it.claim_quantity) > 0 && Number(it.claim_quantity) !== Number(it.quantity))) flags.push({ level: "block", text: "주문 수량 중 일부만 취소 신청했어요 — 카페24에서 직접 접수해주세요" });
    if (byReason.size > 1) flags.push({ level: "block", text: "한 주문 안에 취소 사유가 여러 가지예요 — 카페24에서 직접 접수해주세요" });
    if (request && CXL_ASK_WORDS.test(request)) flags.push({ level: "check", text: "고객이 사유에 요청이나 문의를 적었어요 — 읽어 보고 접수하세요" });
    const items = its.map((it) => ({ code: String(it.order_item_code ?? ""), product_name: String(it.product_name ?? ""), option: String(it.option_value ?? ""), qty: Number(it.quantity ?? 0),
      price: (Number(it.product_price ?? 0) + Number(it.option_price ?? 0)) * Number(it.quantity ?? 0), supplier: String(it.supplier_name ?? ""), before: String(it.order_status_before_cs ?? "") }))
      .sort((a, b) => a.code.localeCompare(b.code));
    groups.push({
      key: items.map((x) => x.code).join(","), order_id: String(o.order_id ?? ""), naver, place: String(o.order_place_name ?? ""), naver_order_no: o.market_order_no ?? null,
      buyer: String(o.billing_name ?? ""), paid_at: String(o.payment_date ?? "").slice(0, 16).replace("T", " "),
      requested_at: its.map((it) => String(it.cancel_request_date ?? "").slice(0, 16).replace("T", " ")).sort().pop() ?? "",
      label: accept, reason_type: type, reason_text: request, reason_raw: raw, items, amount: items.reduce((a, x) => a + x.price, 0),
      other_items: others.length, flags: flags.map((f) => ({ ...f, tag: cxlTagOf(f.text) })),
    });
  }
  return groups;
}

// ── 취소·반품 접수 2단계 (2026-10-05 사용자 요청) — 자사몰 취소접수(C10) 분류 ──
// 한 접수번호(claim_code)가 한 건. **1차 자동 범위 = 주문 전체 취소뿐**: 지난 한 달 전체 취소 591건의 환불액이 100% '처음 결제액 그대로'였다(배송비 포함,
// 쓴 적립금은 전액 반환) → 환불 예정액을 '처음 결제액'으로 못 박을 수 있는 건만 자동. 그 밖은 manual(직접 확인 권장 — 카페24에서 처리)로 이유를 적는다.
// 사용자 규칙(2026-10-05): 부분 취소는 사유·잔여 금액에 따라 배송비 3,000원 차감·쿠폰 취소·적립금 회수가 갈리고, 상품별 추가할인 품목이나 1+1 상품이
// 든 주문은 변수가 많아 당분간 직접 본다 → 전부 manual. 품절 취소(H)는 재고 복구 안 함, 그 밖은 복구.
const SELF_MAIN_OK = new Set(["card", "tcash", "prepaid"]);   // 신용카드·실시간 계좌이체 + 선불금(네이버페이 포인트·머니, 2026-10-06 사용자 지정 — 전체 취소면 자동 목록에)
const SELF_AUX_OK = new Set(["coupon", "point", "mileage"]);   // 같이 쓸 수 있는 보조 수단: 쿠폰·적립금
const SELF_REFUND_CODE: Record<string, "F" | "G" | "O"> = { card: "F", tcash: "G", prepaid: "O" };   // 결제 수단 → 환불 수단 코드(관리자 화면의 '신용카드 결제 취소'·'계좌이체 결제 취소')
const SELF_PAY_LABEL: Record<string, string> = { card: "신용카드", tcash: "계좌이체", cash: "무통장입금", prepaid: "선불금", coupon: "쿠폰", point: "적립금", mileage: "적립금", deposit: "예치금", cell: "휴대폰" };
function selfGroupsOf(o: Record<string, any>, nrSets: NrSets): Record<string, any>[] {
  const all = (o.items ?? []) as Record<string, any>[];
  const acc = all.filter((it) => String(it.order_status ?? "") === "C10" && it.claim_code);
  if (!acc.length) return [];
  const n = (v: unknown) => Math.round(Number(v ?? 0) || 0);
  const init = (o.initial_order_amount ?? {}) as Record<string, any>;
  const pay = ((o.payment_method ?? []) as unknown[]).map((x) => String(x));
  const main = pay.filter((m) => !SELF_AUX_OK.has(m)), claims = [...new Set(acc.map((it) => String(it.claim_code)))];
  const onePlusOne = (it: Record<string, any>) => /1\s*\+\s*1/.test(String(it.product_name ?? "")) || ((nrSets.sale[String(Number(it.product_no))] ?? []) as string[]).some((c) => /1\s*\+\s*1/.test(c));
  const groups: Record<string, any>[] = [];
  for (const claim of claims) {
    const its = acc.filter((it) => String(it.claim_code) === claim);
    const codes = new Set(its.map((it) => String(it.order_item_code ?? "")));
    const others = all.filter((it) => !codes.has(String(it.order_item_code ?? "")));
    const clm = (((o.cancellation ?? []) as Record<string, any>[]).find((c) => c.claim_code === claim)) ?? {};
    const reasonType = String(clm.claim_reason_type ?? its[0].claim_reason_type ?? "");
    const manual: string[] = [];
    if (o.order_place_id === "NCHECKOUT" || o.market_id === "NCHECKOUT") manual.push("네이버페이 주문이에요");
    if (others.length) manual.push(others.some((it) => CXL_UNSHIPPED.has(String(it.order_status ?? ""))) ? `주문의 일부만 취소해요(남은 상품 ${others.filter((it) => CXL_UNSHIPPED.has(String(it.order_status ?? ""))).length}개) — 배송비·쿠폰·적립금을 따져야 해요` : "같은 주문에 이미 처리된 다른 상품이 있어요 — 환불액을 따져야 해요");
    if (claims.length > 1) manual.push("한 주문에 취소 접수가 여러 건이에요");
    if (reasonType === "H") manual.push("사유가 품절이에요 — 재고 복구 여부와 환불을 직접 확인해주세요");   // 2026-10-06 사용자 지정: 품절 취소는 직접 확인
    if (all.some((it) => n(it.additional_discount_price) > 0)) manual.push("상품별 추가할인이 적용된 상품이 있어요");
    if (all.some((it) => n(it.app_item_discount_amount) > 0)) manual.push("할인코드가 적용된 상품이 있어요");   // 카페24 '할인코드'(예: live1019 5%)는 상품별 app_item_discount_amount에 찍힘(2026-10-20 실측·사용자 지정: 세 단계 모두 직접 확인)
    if (all.some(onePlusOne)) manual.push("1+1 할인 상품이 들어 있어요");
    if (main.length !== 1 || !SELF_MAIN_OK.has(main[0])) manual.push(`결제 수단(${pay.map((m) => SELF_PAY_LABEL[m] ?? m).join("+") || "알 수 없음"})은 아직 자동 환불 대상이 아니에요`);
    if (n(init.credits_spent_amount) > 0) manual.push("예치금을 쓴 주문이에요");
    if (o.paid !== "T") manual.push("결제가 끝나지 않은 주문이에요");
    const beforeBad = [...new Set(its.map((it) => String(it.order_status_before_cs ?? "")).filter((b) => !CXL_WAIT.has(b)))];
    if (beforeBad.length) manual.push(`취소 전 상태가 배송준비중이 아니에요(${beforeBad.map((b) => b || "알 수 없음").join(", ")})`);
    if (its.some((it) => !!it.tracking_no)) manual.push("송장번호가 이미 등록돼 있어요");
    // claim_quantity는 실데이터에서 늘 0(쓰이지 않는 값 — 취소접수 82개·취소완료 1,157개 전부) → 0보다 클 때만 수량 일부 취소로 본다
    if (its.some((it) => Number(it.claim_quantity) > 0 && Number(it.claim_quantity) !== Number(it.quantity))) manual.push("주문 수량 중 일부만 취소해요");
    if (n(init.payment_amount) <= 0) manual.push("결제 금액을 읽지 못했어요");
    const items = its.map((it) => ({ code: String(it.order_item_code ?? ""), product_name: String(it.product_name ?? ""), option: String(it.option_value ?? ""), qty: Number(it.quantity ?? 0),
      price: (n(it.product_price) + n(it.option_price)) * Number(it.quantity ?? 0) })).sort((a, b) => a.code.localeCompare(b.code));
    groups.push({
      order_id: String(o.order_id ?? ""), claim_code: claim, buyer: String(o.billing_name ?? ""), paid_at: String(o.payment_date ?? "").slice(0, 16).replace("T", " "),
      requested_at: its.map((it) => String(it.cancel_request_date ?? it.cancel_date ?? "").slice(0, 16).replace("T", " ")).sort().pop() ?? "",
      reason_type: reasonType, reason: String(clm.claim_reason ?? its[0].claim_reason ?? "").trim(), items, other_items: others.length,
      pay, pay_label: pay.map((m) => SELF_PAY_LABEL[m] ?? m).join(" + "), main: main[0] ?? "",
      goods: n(init.order_price_amount), shipping: n(init.shipping_fee), coupon: n(init.coupon_discount_price),
      // 환불 예정(전체 취소 기준): 결제 수단으로 돌려줄 돈 = 처음 결제액, 적립금 = 쓴 만큼 전액
      expect: { amount: n(init.payment_amount), points: n(init.points_spent_amount) },
      recover: reasonType === "H" ? "F" : "T", manual: manual.map((text) => ({ tag: cxlTagOf(text), text })),
    });
  }
  return groups;
}

// ── 중국 사입 ↔ 카페24 상품 맞추기 · 실질 단가 (cn_list·종합 판매 데이터(performance) 공용, 2026-10-16) ──
const cnNorm = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, "");
const cnHead = (n: string) => (n.match(/^[0-9a-z]+/) ?? [""])[0];   // 앞머리의 영문·숫자 묶음(품번 몸통)
// 카페24 전 상품의 공급사 상품명(30분 캐시)
async function cnC24LoadShared(token: string, noCache: boolean): Promise<Record<string, any>[]> {
  let cps = (await cacheGet("cn:c24products", 30 * 60 * 1000)) as Record<string, any>[] | null;
  if (!cps || noCache) {
    cps = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const body = await apiGet(`${API_BASE}/admin/products?shop_no=1&limit=100&offset=${offset}&fields=product_no,product_name,supply_product_name,display,selling`, token);
      const page = (body.products ?? []) as Record<string, any>[];
      cps.push(...page.map((x) => ({ product_no: x.product_no, product_name: x.product_name, supply_product_name: x.supply_product_name ?? "", display: x.display, selling: x.selling })));
      if (page.length < 100) break;
    }
    await cacheSet("cn:c24products", cps);
  }
  return cps;
}
// 사입상품명 → 카페24 상품 (2026-10-12 규칙 — 사용자 지정 반영): 카페24 상품의 '공급사 상품명'(공백·대소문자 무시)과 사입상품명(품번)을 맞춘다.
//   ① 직접 연결(cn_products.c24_nos 배열)이 있으면 그것만 쓴다([] = '해당 없음'으로 확정).
//   ② 확실(exact): 같은 이름이거나, 공급사 상품명이 품번으로 시작하고 바로 뒤가 영문·숫자가 아님 ("26K07가디건(네이비) 79위안" ↔ 26K07).
//   ③ 몸통 일치(base): 품번에 꼬리가 붙은 것('6800短款'·'26833-1短'·'801#')은, 공급사 상품명의 앞머리 영문·숫자가 품번 몸통('6800'·'26833'·'801')과 같으면 같은 상품
//      — 사용자 지정: "6800과 6800短款은 카페24에 상품 1개로 등록하고 옵션으로 나눈다, 공급사 상품명은 6800". 그래서 한 카페24 상품이 여러 사입상품명에 붙을 수 있다.
//   ④ 헷갈림(maybe): 위에 안 걸렸는데 앞머리가 서로 앞부분만 같은 상품이 있으면('6800' ↔ '68001…', 짧은 쪽 4자 이상) 등록으로 치지 않고 주의 후보로만.
function cnMatchC24(names: string[], manualOf: (name: string) => unknown, cps: Record<string, any>[]) {
  const pub = (x: Record<string, any>, how: string) => ({ product_no: x.product_no, product_name: x.product_name, supply_product_name: x.supply_product_name ?? "", display: x.display, selling: x.selling, how });
  const c24: Record<string, ReturnType<typeof pub>[]> = {}, c24_warn: Record<string, ReturnType<typeof pub>[]> = {};
  const byNo = new Map(cps.map((x) => [Number(x.product_no), x]));
  const withNorm = cps.map((x) => ({ x, n: cnNorm(x.supply_product_name) })).filter((y) => y.n).map((y) => ({ ...y, h: cnHead(y.n) }));
  for (const name of names) {
    const k = cnNorm(name); if (!k) continue;
    const manual = manualOf(name);
    if (Array.isArray(manual)) {
      const hits = manual.map((no: unknown) => byNo.get(Number(no))).filter(Boolean).map((x) => pub(x as Record<string, any>, "manual"));
      if (hits.length) c24[name] = hits.slice(0, 5);
      continue;
    }
    const base = cnHead(k);
    const exact = withNorm.filter((y) => y.n === k || (y.n.startsWith(k) && !/[0-9a-z]/.test(y.n.charAt(k.length))));
    const variant = exact.length ? [] : withNorm.filter((y) => base.length >= 3 && base !== k && y.h === base);
    if (exact.length || variant.length) { c24[name] = (exact.length ? exact.map((y) => pub(y.x, "exact")) : variant.map((y) => pub(y.x, "base"))).slice(0, 5); continue; }
    const maybe = withNorm.filter((y) => y.h !== base && Math.min(y.h.length, base.length) >= 4 && (y.h.startsWith(base) || base.startsWith(y.h)));
    if (maybe.length) c24_warn[name] = maybe.slice(0, 8).map((y) => pub(y.x, "maybe"));
  }
  return { c24, c24_warn };
}
// 카페24 상품별 실질 단가(원, 부가세 제외) — 중국 사입 관리 화면의 '실질 단가'와 같은 계산(cn_export와 같음):
//   줄마다 위안 × 환율 200 × (1 + 그 입고의 들여오는 비용 비율)을 원 단위로 반올림 → 입고(전달) 수량으로 가중 평균, 비용 시트가 있는 입고가 하나라도 있으면 그 줄들만으로.
//   한 카페24 상품에 사입상품명이 여럿 붙으면(6800 + 6800短款) 그 줄들을 합쳐 가중 평균. 연결은 직접 연결·확실·몸통 일치만(헷갈림 후보는 안 씀).
// ── 중국 사입 환전 모델 (2026-10-22 사용자 요청 — '원>달러>위안 환전' 소메뉴, migrations/0062) ──
//   ① 달러 통장(선입선출): 원→달러 환전(cn_fx_buys, 체결 원화 ÷ 달러)이 쌓이고, 달러→위안 송금(cn_remits)이 차례로 꺼내 쓴다 → 송금마다 원화 원가.
//   ② 위안 통장(선입선출): 송금마다 에이전시 실수령 위안(포워딩 100위안·에이전시 0.003% 뺀 값 — 사용자 입력)이 쌓이고,
//      입고(출고 서류 '총 합계' 위안 = 물건값 + 에이전시 10% + 경비·특송 등, cn_shipments.doc)가 중국 출고일 순으로 꺼내 쓴다 → 입고마다 1위안 원가.
//   송금이 출고 서류와 1:1로 맞지 않아도(일부씩 송금 — 사용자 지적) 이 방식은 매칭이 필요 없다(외화 통장 선입선출과 같음).
//   위안이 모자라면(아직 송금 기록이 없거나 모자람) 모자란 만큼은 마지막 1위안 원가(없으면 200원)로 '추정'하고 표시한다.
//   입고의 물건값 1위안당 원가 base = 총 합계 × 1위안 원가 ÷ 물건값, 들여오는 비용 비율 ratio = 부가세 제외 비용 ÷ (총 합계 × 1위안 원가).
//   실질 단가 = 단가(위안) × base × (1 + ratio) — 화면 cnRealWon·종합 판매 데이터(cnRealCostByProduct)·상품관리 내보내기(cn_export)가 모두 이 값.
const CN_FX_FALLBACK = 200;
function cnCostExVat(costs: Record<string, any> | null) {
  const items = ((costs?.items ?? []) as Record<string, any>[]);
  const sum = items.reduce((t, x) => t + (Number(x.amount) || 0), 0), vat = items.filter((x) => /부가세/.test(String(x.name ?? ""))).reduce((t, x) => t + (Number(x.amount) || 0), 0);
  return { has: !!costs, exVat: sum - vat, vat };
}
function cnFxModel(ships: Record<string, any>[], lines: Record<string, any>[], buysIn: Record<string, any>[], remitsIn: Record<string, any>[]) {
  const n = (v: unknown) => Number(v ?? 0) || 0, r2 = (v: number) => Math.round(v * 100) / 100;
  const buys = [...(buysIn ?? [])].sort((a, b) => String(a.traded_at).localeCompare(String(b.traded_at)) || n(a.id) - n(b.id));
  const remits = [...(remitsIn ?? [])].sort((a, b) => String(a.remit_date).localeCompare(String(b.remit_date)) || n(a.id) - n(b.id));
  // ① 달러 통장
  const usdQ = buys.map((x) => ({ id: n(x.id), left: n(x.usd), rate: n(x.usd) > 0 ? n(x.krw) / n(x.usd) : 0 }));
  let lastUsdRate: number | null = null;
  const remitOut = remits.map((x) => {
    const usd = n(x.usd), cny = n(x.cny);
    let need = usd, krw = 0;
    const from: { buy_id: number; usd: number; rate: number }[] = [];
    while (need > 1e-9 && usdQ.length) {
      const q = usdQ[0], take = Math.min(need, q.left);
      krw += take * q.rate; q.left -= take; need -= take; lastUsdRate = q.rate; from.push({ buy_id: q.id, usd: r2(take), rate: q.rate });
      if (q.left <= 1e-9) usdQ.shift();
    }
    const short = need > 1e-9 ? need : 0;
    if (short && lastUsdRate != null) krw += short * lastUsdRate;
    const known = !short || lastUsdRate != null;
    return { id: n(x.id), remit_date: x.remit_date, usd, cny, memo: x.memo ?? null, created_by_name: x.created_by_name ?? null,
      krw: known ? Math.round(krw) : null, usd_rate: known && usd > 0 ? krw / usd : null, rate: known && cny > 0 ? krw / cny : null,
      cny_per_usd: usd > 0 ? cny / usd : null, usd_short: r2(short), from };
  });
  // ② 위안 통장
  const cnyQ = remitOut.map((x) => ({ id: x.id, left: x.cny, rate: x.rate }));
  const goodsBy = new Map<number, number>();
  for (const l of lines ?? []) { if (l.unit_price == null) continue; const k = n(l.shipment_id); goodsBy.set(k, (goodsBy.get(k) ?? 0) + n(l.qty_sent) * n(l.unit_price)); }
  const shipsSorted = [...(ships ?? [])].sort((a, b) => String(a.ship_date ?? "9999").localeCompare(String(b.ship_date ?? "9999")) || n(a.id) - n(b.id));
  const known = remitOut.filter((x) => x.rate != null);
  const avgAll = known.reduce((t, x) => t + x.cny, 0) > 0 ? known.reduce((t, x) => t + (x.krw ?? 0), 0) / known.reduce((t, x) => t + x.cny, 0) : null;
  let lastRate: number | null = null;
  const shipOut: Record<string, any> = {};
  for (const sh of shipsSorted) {
    const id = n(sh.id), goods = goodsBy.get(id) ?? 0;
    const d = (sh.doc ?? null) as Record<string, any> | null;
    const docGoods = d && n(d.goods) > 0 ? n(d.goods) : null;
    const agency = d && d.agency != null ? n(d.agency) : r2(goods * 0.1);
    const items = d && Array.isArray(d.items) ? (d.items as Record<string, any>[]).map((x) => ({ name: String(x.name ?? ""), cny: n(x.cny) })) : [];
    const total = d && n(d.total) > 0 ? n(d.total) : r2(goods + agency + items.reduce((t, x) => t + x.cny, 0));
    let need = total, krw = 0, est = 0;
    const parts: { remit_id: number; cny: number; rate: number | null }[] = [];
    while (need > 1e-9 && cnyQ.length) {
      const q = cnyQ[0], take = Math.min(need, q.left);
      const rt = q.rate ?? lastRate ?? avgAll ?? CN_FX_FALLBACK;
      if (q.rate == null) est += take;
      krw += take * rt; q.left -= take; need -= take; lastRate = q.rate ?? lastRate; parts.push({ remit_id: q.id, cny: r2(take), rate: q.rate });
      if (q.left <= 1e-9) cnyQ.shift();
    }
    if (need > 1e-9) { est += need; krw += need * (lastRate ?? avgAll ?? CN_FX_FALLBACK); }
    const rate = total > 0 ? krw / total : (lastRate ?? avgAll ?? CN_FX_FALLBACK);
    const c = cnCostExVat((sh.costs ?? null) as Record<string, any> | null);
    const goodsKrw = total * rate;
    shipOut[String(id)] = {
      goods, doc_goods: docGoods, agency, items, total, doc: !!d, rate, krw: Math.round(krw), parts, estimated_cny: r2(est),
      base: goods > 0 ? goodsKrw / goods : rate * 1.1,   // 물건값 1위안당 원화(에이전시·경비 포함, 들여오는 비용 전)
      ratio: c.has && goodsKrw > 0 ? c.exVat / goodsKrw : null, vat_ratio: c.has && goodsKrw > 0 ? c.vat / goodsKrw : null, ex_vat: c.has ? c.exVat : null,
    };
  }
  return {
    buys: buys.map((x) => ({ id: n(x.id), order_no: x.order_no, traded_at: x.traded_at, usd: n(x.usd), krw: n(x.krw), rate: n(x.rate), created_by_name: x.created_by_name ?? null,
      used: r2(n(x.usd) - (usdQ.find((q) => q.id === n(x.id))?.left ?? 0)) })),
    remits: remitOut.map((x) => ({ ...x, left: r2(cnyQ.find((q) => q.id === x.id)?.left ?? 0) })),
    ships: shipOut,
    usd_left: r2(usdQ.reduce((t, q) => t + q.left, 0)), usd_left_krw: Math.round(usdQ.reduce((t, q) => t + q.left * q.rate, 0)),
    cny_left: r2(cnyQ.reduce((t, q) => t + q.left, 0)), cny_left_krw: Math.round(cnyQ.reduce((t, q) => t + q.left * (q.rate ?? avgAll ?? CN_FX_FALLBACK), 0)),
    avg_rate: avgAll, fallback: CN_FX_FALLBACK,
  };
}
// 마진율용 부가세(2026-10-22 사용자 지적 — "실질 단가 × 1.1은 모든 부대비용에 부가세를 붙이는 셈, 물건값의 부가세만 더해야"):
//   vat = 그 줄 몫의 **실제 수입 부가세** = 단가 × 물건값 1위안당 원화(base) × (비용 시트 부가세 ÷ 물건값 원화). 실측 10.42~10.73%(수입 부가세는 물건값 + 운임 + 관세에 10%).
//   비용 시트가 없으면 물건값 원화의 10%. 마진 원가 = 실질 단가 + vat (일반 상품의 공급가 × 1.1에 해당).
function cnLineWon(fx: ReturnType<typeof cnFxModel>, shipId: unknown, unitPrice: unknown): { won: number; ratio: number | null; vat: number } {
  const sh = fx.ships[String(Number(shipId))], base = Number(unitPrice) * (sh ? sh.base : CN_FX_FALLBACK * 1.1), r = sh ? sh.ratio : null;
  const vr = sh && sh.vat_ratio != null ? sh.vat_ratio : 0.1;
  return { won: Math.round(r != null ? base * (1 + r) : base), ratio: r, vat: Math.round(base * vr) };
}

async function cnRealCostByProduct(token: string, noCache: boolean): Promise<Map<number, { won: number; vat: number; snames: string[]; qty: number; with_cost: boolean }>> {
  const [ships, lines, prodRows, buys, remits] = await Promise.all([
    sbRest("cn_shipments?select=id,costs,ship_date,doc&limit=500"),
    sbRest("cn_lines?select=shipment_id,sname,qty_sent,unit_price&limit=20000"),
    sbRest("cn_products?select=sname,c24_nos&limit=5000"),
    sbRest("cn_fx_buys?select=*&limit=5000"),
    sbRest("cn_remits?select=*&limit=5000"),
  ]) as [Record<string, any>[], Record<string, any>[], Record<string, any>[], Record<string, any>[], Record<string, any>[]];
  const fx = cnFxModel(ships, lines, buys, remits);   // 2026-10-22: 고정 200원 → 환전 내역 선입선출 1위안 원가 × 출고 서류 총 합계(에이전시 10% 등 포함)
  const by = new Map<string, { cost: { sum: number; qty: number; vat: number }; all: { sum: number; qty: number; vat: number } }>();
  for (const l of lines ?? []) {
    const name = String(l.sname ?? ""), q = Number(l.qty_sent) || 0;
    if (!name || l.unit_price == null || q <= 0) continue;
    const g = by.get(name) ?? { cost: { sum: 0, qty: 0, vat: 0 }, all: { sum: 0, qty: 0, vat: 0 } };
    const { won, ratio: r, vat } = cnLineWon(fx, l.shipment_id, l.unit_price);
    g.all.sum += q * won; g.all.qty += q; g.all.vat += q * vat;
    if (r != null) { g.cost.sum += q * won; g.cost.qty += q; g.cost.vat += q * vat; }
    by.set(name, g);
  }
  const manual = new Map((prodRows ?? []).map((r) => [String(r.sname), Array.isArray(r.c24_nos) ? r.c24_nos : null]));
  const { c24 } = cnMatchC24([...by.keys()], (n) => manual.get(n) ?? null, await cnC24LoadShared(token, noCache));
  const acc = new Map<number, { cost: { sum: number; qty: number; vat: number }; all: { sum: number; qty: number; vat: number }; snames: string[] }>();
  for (const [sname, hits] of Object.entries(c24)) {
    const g = by.get(sname); if (!g) continue;
    for (const h of hits) {
      const no = Number(h.product_no);
      const a = acc.get(no) ?? { cost: { sum: 0, qty: 0, vat: 0 }, all: { sum: 0, qty: 0, vat: 0 }, snames: [] };
      a.cost.sum += g.cost.sum; a.cost.qty += g.cost.qty; a.cost.vat += g.cost.vat; a.all.sum += g.all.sum; a.all.qty += g.all.qty; a.all.vat += g.all.vat;
      if (!a.snames.includes(sname)) a.snames.push(sname);
      acc.set(no, a);
    }
  }
  const out = new Map<number, { won: number; vat: number; snames: string[]; qty: number; with_cost: boolean }>();
  for (const [no, a] of acc) {
    const use = a.cost.qty > 0 ? a.cost : a.all;
    if (use.qty > 0) out.set(no, { won: Math.round(use.sum / use.qty), vat: Math.round(use.vat / use.qty), snames: a.snames, qty: use.qty, with_cost: a.cost.qty > 0 });
  }
  return out;
}

// ── 취소·반품 접수 3단계 (2026-10-06 사용자 요청) — 자사몰 반품접수(R10) → 반품처리중(수거전) ──
// 한 접수번호(claim_code)가 한 건. 이 단계에서 환불 금액(반품 배송비 차감·쿠폰할인 취소·적립금 반환)이 정해진다.
// 공개 API(PUT return status=processing)에는 배송비 차감·쿠폰 취소 금액을 넣는 자리가 없어서, 넘기는 일은 이 PC의 연결 스크립트(window.CAFE24_RETURN)가
// 관리자 '반품 처리' 창(order_back_list.php?mode=step2)에서 한다. 서버는 목록·분류·예정액 계산(retacc_list) / 준비(retacc_prepare) / 확인·기록(retacc_record)만 — 카페24 쓰기 없음.
// 사용자 규칙(2026-10-06 — 지난 60일 반품 1,326건과 실제 '반품 처리' 창 51건으로 대조):
//  · 자동 = 사유가 변심·사이즈·상품불만족(코드 A·O·P)뿐. 불량·오배송·그 밖의 사유는 직접 확인.
//  · 반품 배송비('환불액에서 차감'): 배송비를 낸 주문 3,000 / 무료배송 주문은 전체 반품이거나 남는 상품 금액이 7만 원 미만이면 6,000, 7만 원 이상이면 3,000.
//  · 쿠폰: 조건이 읽히는 정액 주문서 쿠폰 1장만 자동 — 전체 반품이거나 남는 상품 금액이 기준(쿠폰 최소 구매 금액과 3만 원 중 큰 값)보다 적으면 쿠폰할인 취소, 아니면 그대로.
//  · 적립금(3만 원 이상 주문에만 사용 가능): 전체 반품이거나 남는 상품 금액이 3만 원 미만이면 쓴 적립금 전액 반환(그만큼 결제 수단 환불이 줄어듦), 3만 원 이상이면 그대로.
//  · 상품별 할인: 반품 상품에 적용된 할인액은 환불에서 뺀다. 반품 상품이 10% 이상 할인·1+1이면 직접 확인(반품하는 상품만 본다).
//  · 직접 확인: 같은 주문의 다른 취소·교환·반품 / 수거 신청이 아닌 접수 / 반품 불가 품목 / 카드·계좌이체·선불금 밖의 결제 / 예치금 / 그 밖의 할인 / 기준 금액이 경계에 걸린 주문.
type RetCoupons = { byOrder: Record<string, { code: string; name: string; value: number }[]>; policy: Record<string, Record<string, any> | null> };
const RET_AUTO_REASON = new Set(["A", "O", "P"]);
const RET_DEFECT_REASON = new Set(["V", "K", "W", "J", "D", "F"]);
const RET_REASON_LABEL: Record<string, string> = { A: "고객변심", O: "고객변심", P: "상품불만족", V: "상품불량", K: "상품불량", W: "배송오류", J: "배송오류", B: "배송지연", C: "배송불가지역", D: "포장불량", E: "상품불만족", F: "상품정보상이", G: "서비스불만족", H: "품절", I: "기타" };
const RET_DEFECT_WORDS = /불량|오배송|하자|오염|얼룩|찢|구멍|잘못\s*(왔|옴|배송|보내)|다른\s*(상품|색|사이즈|옷)|누락/;
const RET_FREE_SHIP = 70000, RET_POINT_MIN = 30000, RET_FEE = 3000;
// 쿠폰은 쿠폰 자체에 금액 조건이 없어도 남는 상품 금액이 3만 원 미만이면 취소한다(2026-10-07 사용자 지적 — 조건 없는 1,000원 쿠폰이 '유지'로 나옴.
// 과거 기록도 조건 없는 쿠폰 + 남는 금액 3만 원 미만 2건이 모두 취소였다). 쿠폰 최소 금액이 3만 원보다 크면 그 금액이 기준.
const RET_COUPON_FLOOR = 30000;
const RET_MOVED = new Set(["R30", "R31", "R34", "R36", "R40"]);   // 반품처리중(수거전·수거완료·환불전·환불보류)·반품완료
async function retCouponInfo(orders: Record<string, any>[], token: string): Promise<RetCoupons> {
  const n = (v: unknown) => Math.round(Number(v ?? 0) || 0);
  const out: RetCoupons = { byOrder: {}, policy: {} };
  const ids = orders.filter((o) => n(o.initial_order_amount?.coupon_discount_price) > 0 || n(o.initial_order_amount?.coupon_shipping_fee_amount) > 0 || ((o.payment_method ?? []) as unknown[]).map(String).includes("coupon"))
    .map((o) => String(o.order_id ?? "")).filter((id) => /^\d{8}-\d{7}$/.test(id));
  for (let i = 0; i < ids.length; i += 10) {
    const part = ids.slice(i, i + 10);
    try {
      const list = ((await apiGet(`${API_BASE}/admin/orders/coupons?shop_no=1&limit=100&order_id=${part.join(",")}`, token)).coupons ?? []) as Record<string, any>[];
      if (list.length >= 100) continue;   // 다 못 읽었을 수 있음 → 이 묶음은 '읽지 못함'으로 둔다(직접 확인으로 빠짐)
      for (const id of part) out.byOrder[id] = [];
      for (const c of list) (out.byOrder[String(c.order_id ?? "")] ??= []).push({ code: String(c.coupon_code ?? ""), name: String(c.coupon_name ?? ""), value: n(c.coupon_value) });
    } catch { /* 읽지 못한 주문은 byOrder에 없음 → 직접 확인 */ }
  }
  const nos = [...new Set(Object.values(out.byOrder).flat().map((c) => c.code).filter((c) => /^\d{6,25}$/.test(c)))];
  for (const no of nos) {
    const key = `ret:coupon:${no}`;
    let p = (await cacheGet(key, 30 * 60 * 1000)) as Record<string, any> | null;
    if (!p) {
      try {
        p = { found: false };
        for (const q of ["", "&deleted=T"]) {
          const c = (((await apiGet(`${API_BASE}/admin/coupons?shop_no=1&coupon_no=${no}${q}`, token)).coupons ?? []) as Record<string, any>[])[0];
          if (c) { p = { found: true, name: String(c.coupon_name ?? ""), benefit_type: String(c.benefit_type ?? ""), benefit_price: n(c.benefit_price), scope: String(c.available_scope ?? ""), price_type: String(c.available_price_type ?? ""), order_price_type: String(c.available_order_price_type ?? ""), min: n(c.available_min_price) }; break; }
        }
        await cacheSet(key, p);
      } catch { p = null; }
    }
    out.policy[no] = p && p.found ? p : null;
  }
  return out;
}
function retGroupsOf(o: Record<string, any>, nrSets: NrSets, cp: RetCoupons): Record<string, any>[] {
  const all = (o.items ?? []) as Record<string, any>[];
  const acc = all.filter((it) => String(it.order_status ?? "") === "R10" && it.claim_code);
  if (!acc.length) return [];
  if (o.order_place_id === "NCHECKOUT" || o.market_id === "NCHECKOUT") return [];   // 네이버페이 주문은 이 탭에서 다루지 않는다(2026-10-06 사용자 지정)
  const n = (v: unknown) => Math.round(Number(v ?? 0) || 0);
  const orderId = String(o.order_id ?? "");
  const init = (o.initial_order_amount ?? {}) as Record<string, any>;
  const pay = ((o.payment_method ?? []) as unknown[]).map((x) => String(x));
  const main = pay.filter((m) => !SELF_AUX_OK.has(m)), claims = [...new Set(acc.map((it) => String(it.claim_code)))];
  const qty = (it: Record<string, any>) => Number(it.quantity ?? 0) || 0;
  const unit = (it: Record<string, any>) => n(it.product_price) + n(it.option_price);
  const price = (it: Record<string, any>) => unit(it) * qty(it);
  // 상품별 할인 = 상품 추가할인(additional_discount_price) + 할인코드 할인(app_item_discount_amount — 카페24 '할인코드' 5% 등이 여기에 찍힘, 2026-10-20 실측: 주문 단위 app_discount_amount는 0으로 남음)
  const disc = (it: Record<string, any>) => n(it.additional_discount_price) + n(it.app_item_discount_amount);
  const onePlusOne = (it: Record<string, any>) => /1\s*\+\s*1/.test(String(it.product_name ?? "")) || ((nrSets.sale[String(Number(it.product_no))] ?? []) as string[]).some((c) => /1\s*\+\s*1/.test(c));
  const sum = (list: Record<string, any>[], f: (it: Record<string, any>) => number) => list.reduce((t, it) => t + f(it), 0);
  const won = (v: number) => v.toLocaleString("ko-KR") + "원";
  const groups: Record<string, any>[] = [];
  for (const claim of claims) {
    const its = acc.filter((it) => String(it.claim_code) === claim);
    const codes = new Set(its.map((it) => String(it.order_item_code ?? "")));
    const others = all.filter((it) => !codes.has(String(it.order_item_code ?? "")));
    const ret = (((o.return ?? []) as Record<string, any>[]).find((r) => r.claim_code === claim)) ?? {};
    const reasonType = String(ret.claim_reason_type ?? its[0].claim_reason_type ?? "");
    const reason = String(ret.claim_reason ?? its[0].claim_reason ?? "").trim();
    const manual: { tag: string; text: string }[] = [];
    const M = (tag: string, text: string) => { manual.push({ tag, text }); };
    if (!RET_AUTO_REASON.has(reasonType)) {
      if (RET_DEFECT_REASON.has(reasonType)) M("불량·오배송", `사유가 ${RET_REASON_LABEL[reasonType] ?? reasonType}이에요 — 물건을 확인한 뒤 배송비를 정해주세요`);
      else M("그 밖의 사유", `사유가 ${RET_REASON_LABEL[reasonType] ?? (reasonType || "없음")}이에요 — 변심·사이즈·상품불만족만 여기서 처리해요`);
    } else if (RET_DEFECT_WORDS.test(reason)) M("사유 글 확인", "고객이 사유에 불량·오배송으로 보이는 내용을 적었어요 — 읽어 보고 처리해주세요");
    if (its.some(onePlusOne)) M("1+1 상품", "반품 상품에 1+1 할인 상품이 있어요");
    if (its.some((it) => disc(it) > 0 && ((unit(it) > 0 && disc(it) / unit(it) >= 0.1) || (price(it) > 0 && disc(it) / price(it) >= 0.1)))) M("10% 이상 할인", "반품 상품에 10% 이상 할인된 상품이 있어요");
    if (its.some((it) => disc(it) > 0 && qty(it) !== 1)) M("할인 상품 수량", "할인된 상품을 2개 이상 반품해요 — 할인 금액을 따져야 해요");
    if (its.some((it) => n(it.app_item_discount_amount) > 0)) M("할인코드", "할인코드가 적용된 상품이 있어요 — 할인 금액이 환불액에 반영됐는지 직접 확인해주세요");   // 2026-10-20 사용자 지정: 할인코드 주문은 직접 확인
    if (others.some((it) => /^[CER]/.test(String(it.order_status ?? "")) || !!it.claim_code) || claims.length > 1) M("다른 취소·교환·반품", "같은 주문에 다른 취소·교환·반품이 있어요 — 남는 금액을 따져야 해요");
    const pk = (ret.pickup ?? {}) as Record<string, any>;
    if (pk.use_pickup !== "T" || ret.pickup_request_state !== "T") M("수거 신청 아님", "수거 신청으로 접수된 반품이 아니에요(고객 직접 발송 등) — 배송비를 따져야 해요");
    for (const it of its) for (const f of rscanItemFlags(it, nrSets)) if (f.level === "block" && f.type !== "할인") M("반품 불가 품목", `${String(it.product_name ?? "").slice(0, 30)} — ${f.text}`);
    if (main.length !== 1 || !SELF_MAIN_OK.has(main[0])) M(`${SELF_PAY_LABEL[main[0] ?? ""] ?? (main[0] || "알 수 없는")} 결제`, `결제 수단(${pay.map((m) => SELF_PAY_LABEL[m] ?? m).join("+") || "알 수 없음"})은 여기서 처리하지 않아요`);
    if (n(init.credits_spent_amount) > 0) M("예치금", "예치금을 쓴 주문이에요");
    if (o.paid !== "T") M("미결제", "결제가 끝나지 않은 주문이에요");
    const extra = ([["membership_discount_amount", "회원등급할인"], ["shipping_fee_discount_amount", "배송비할인"], ["set_product_discount_amount", "세트할인"], ["app_discount_amount", "앱할인"], ["coupon_shipping_fee_amount", "배송비 쿠폰"], ["market_other_discount_amount", "마켓 할인"]] as [string, string][]).filter(([k]) => n(init[k]) > 0).map(([, label]) => label);
    if (extra.length) M("그 밖의 할인", `${extra.join("·")}이 적용된 주문이에요`);
    const ship = n(init.shipping_fee);
    if (ship !== 0 && ship !== RET_FEE) M("배송비 확인", `처음 낸 배송비가 ${won(ship)}이에요(지역 추가 배송비 등)`);
    if (ship === 0 && sum(all, price) < RET_FREE_SHIP && !extra.includes("배송비 쿠폰") && !extra.includes("배송비할인")) M("배송비 확인", "7만 원 미만인데 배송비를 내지 않은 주문이에요");
    if (((ret.return_shipping_fee_detail ?? []) as unknown[]).length > 1) M("배송 묶음", "배송 묶음이 여러 개인 주문이에요");
    if (its.some((it) => Number(it.claim_quantity) > 0 && Number(it.claim_quantity) !== qty(it))) M("수량 일부", "주문 수량 중 일부만 반품해요");
    const beforeBad = [...new Set(its.map((it) => String(it.order_status_before_cs ?? "")).filter((b) => b !== "N30" && b !== "N40"))];
    if (beforeBad.length) M("배송 전 상태", `반품 접수 전 상태가 배송중·배송완료가 아니에요(${beforeBad.map((b) => b || "알 수 없음").join(", ")})`);
    // 쿠폰 — 조건이 읽히는 정액 주문서 쿠폰 1장만 자동
    const cpn = n(init.coupon_discount_price), list = cp.byOrder[orderId];
    const coupon = { mode: "none" as "none" | "keep" | "cancel", amount: 0, name: "", min: 0, own: 0 };   // min = 판단 기준(쿠폰 최소 금액과 3만 원 중 큰 값), own = 쿠폰 자체의 최소 금액
    if (cpn > 0 || (list && list.length) || pay.includes("coupon")) {
      if (!list) M("쿠폰 확인", "이 주문에 쓰인 쿠폰을 읽지 못했어요");
      else if (list.length !== 1) { if (list.length > 1 || cpn > 0) M("쿠폰 확인", list.length > 1 ? `쿠폰이 ${list.length}장 쓰인 주문이에요` : "쿠폰 할인이 있는데 쿠폰 정보가 없어요"); }
      else {
        const c = list[0], p = cp.policy[c.code];
        if (!p) M("쿠폰 확인", `쿠폰 '${c.name}'의 사용 조건을 읽지 못했어요`);
        else if (p.benefit_type !== "A") M("쿠폰 확인", `정액 할인 쿠폰이 아니에요 — '${c.name}'`);
        else if (p.scope !== "O" || !(p.price_type === "U" || (p.price_type === "O" && p.order_price_type === "U"))) M("쿠폰 확인", `사용 조건이 특수한 쿠폰이에요 — '${c.name}'`);
        else if (n(p.benefit_price) !== cpn || cpn <= 0) M("쿠폰 확인", `쿠폰 할인액이 쿠폰 금액과 달라요 — '${c.name}'`);
        else { coupon.mode = "keep"; coupon.amount = cpn; coupon.name = c.name; coupon.own = p.price_type === "O" ? n(p.min) : 0; coupon.min = Math.max(coupon.own, RET_COUPON_FLOOR); }
      }
    }
    // 예정 계산 — 기준 금액 = 남는 상품의 판매가 합계. 남는 상품에 할인이 있어 '할인 전/후'가 기준선을 사이에 두고 갈리면 직접 확인으로.
    const full = others.length === 0;
    const remain = sum(others, price), remainNet = remain - sum(others, disc);
    const straddle = (th: number) => !full && th > 0 && (remain >= th) !== (remainNet >= th);
    const fee = ship > 0 ? RET_FEE : (full || remain < RET_FREE_SHIP ? RET_FEE * 2 : RET_FEE);
    if (ship === 0 && straddle(RET_FREE_SHIP)) M("경계 금액", "남는 금액이 할인 전후로 7만 원 기준에 걸려요 — 배송비 차감을 직접 정해주세요");
    if (coupon.mode !== "none") {
      if (full || remain < coupon.min) coupon.mode = "cancel";
      if (straddle(coupon.min)) M("경계 금액", `남는 금액이 할인 전후로 쿠폰 최소 금액(${won(coupon.min)})에 걸려요`);
    }
    const pts = n(init.points_spent_amount);
    const pointsReturn = pts > 0 && (full || remain < RET_POINT_MIN) ? pts : 0;
    if (pts > 0 && straddle(RET_POINT_MIN)) M("경계 금액", "남는 금액이 할인 전후로 적립금 기준 3만 원에 걸려요");
    const goods = sum(its, price), goodsDisc = sum(its, disc);
    // 자동으로 다루지 않는 쿠폰(직접 확인으로 빠진 것)도 전체 반품이면 쿠폰할인 전액 취소로 계산한다(전체 반품은 과거 기록상 늘 전액 취소) — 예상 환불액(참고)용
    const couponUnknown = coupon.mode === "none" && cpn > 0;
    const couponCancel = coupon.mode === "cancel" ? coupon.amount : (couponUnknown && full ? cpn : 0);
    const total = goods - goodsDisc - fee - couponCancel, cash = total - pointsReturn;
    if (cash <= 0 || n(init.payment_amount) <= 0) M("금액 확인", "환불 예정액을 계산하지 못했어요");
    // 직접 확인 권장 접수에도 '예상 환불액(참고)'을 보여 준다(2026-10-07 사용자 요청 — 카페24 창의 금액과 견줘 보는 더블 체크용).
    // 계산은 위의 변심 규칙 그대로라, 직접 확인으로 빠진 이유마다 '이 숫자에서 무엇이 달라질 수 있는지'를 함께 적는다.
    const tags = new Set(manual.map((m) => m.tag)), estNotes: string[] = [];
    const defect = tags.has("불량·오배송") || tags.has("사유 글 확인");
    const defectAdd = fee + (full && ship > 0 ? ship : 0);   // 불량·오배송으로 인정하면: 반품 배송비 차감 없음 + (배송비를 낸 주문의 전체 반품이면) 낸 배송비도 환불
    if (defect) estNotes.push(`변심 기준(배송비 ${won(fee)} 차감)으로 계산했어요 — 불량·오배송으로 인정하면 차감이 없어${full && ship > 0 ? `지고 낸 배송비 ${won(ship)}도 돌려줘서` : "져서"} ${won(defectAdd)} 늘어요`);
    if (tags.has("그 밖의 사유")) estNotes.push("변심 기준으로 계산했어요 — 사유에 따라 배송비 차감이 달라질 수 있어요");
    if (couponUnknown) estNotes.push(full ? `쿠폰할인 ${won(cpn)}은 전체 반품이라 취소하는 것으로 계산했어요` : `쿠폰할인 ${won(cpn)}을 취소할지는 넣지 않았어요 — 취소하면 그만큼 줄어요`);
    else if (tags.has("쿠폰 확인")) estNotes.push("쿠폰 정보를 읽지 못해 쿠폰할인 취소는 넣지 않았어요");
    if (tags.has("1+1 상품") || tags.has("10% 이상 할인") || tags.has("할인 상품 수량")) estNotes.push(goodsDisc > 0 ? `반품 상품의 할인 ${won(goodsDisc)}을 그대로 뺐어요 — 1+1·세일 상품은 카페24 창의 할인 취소 금액과 견줘 보세요` : "1+1·세일 상품이라 할인 취소 금액이 달라질 수 있어요");
    if (tags.has("다른 취소·교환·반품")) estNotes.push("같은 주문의 다른 취소·교환·반품은 넣지 않았어요 — 남는 금액 기준(배송비·쿠폰·적립금)이 달라질 수 있어요");
    if (tags.has("수거 신청 아님")) estNotes.push("고객이 직접 보낸 반품이면 배송비 차감이 달라질 수 있어요");
    if (tags.has("그 밖의 할인")) {
      const rest = extra.filter((x) => x !== "배송비 쿠폰");
      if (extra.includes("배송비 쿠폰")) estNotes.push("무료배송 쿠폰을 쓴 주문이에요 — 카페24 창에서는 그 배송비가 쿠폰할인에 들어 있어요. 배송비 차감이 기준에 맞는지 봐주세요");
      if (rest.length) estNotes.push(`${rest.join("·")}은 넣지 않았어요`);
    }
    if (tags.has("배송비 확인") || tags.has("배송 묶음")) estNotes.push("배송비 조건이 보통과 달라 차감액이 다를 수 있어요");
    if (tags.has("경계 금액")) estNotes.push("남는 금액이 기준선에 걸려 배송비·쿠폰·적립금 처리가 달라질 수 있어요");
    if (tags.has("예치금")) estNotes.push("예치금 반환은 넣지 않았어요");
    if (tags.has("수량 일부") || tags.has("미결제") || tags.has("배송 전 상태")) estNotes.push("접수 상태가 보통과 달라 금액이 다를 수 있어요");
    const est = manual.length ? { ok: cash > 0 && n(init.payment_amount) > 0, notes: estNotes, alt: defect ? { label: "불량·오배송으로 인정하면", amount: cash + defectAdd } : null } : null;
    const items = its.map((it) => ({ code: String(it.order_item_code ?? ""), no: n(it.item_no), product_name: String(it.product_name ?? ""), option: String(it.option_value ?? ""), qty: qty(it), price: price(it), disc: disc(it) }))
      .sort((a, b) => a.code.localeCompare(b.code));
    groups.push({
      order_id: orderId, claim_code: claim, buyer: String(o.billing_name ?? ""), paid_at: String(o.payment_date ?? "").slice(0, 16).replace("T", " "),
      requested_at: its.map((it) => String(it.return_request_date ?? it.return_confirmed_date ?? "").slice(0, 16).replace("T", " ")).sort().pop() ?? "",
      reason_type: reasonType, reason_label: RET_REASON_LABEL[reasonType] ?? "", reason, items, other_items: others.length, full, remain,
      pay, pay_label: pay.map((m) => SELF_PAY_LABEL[m] ?? m).join(" + "), main: main[0] ?? "",
      plan: { fee, coupon: coupon.mode, coupon_amount: coupon.amount, coupon_name: coupon.name, coupon_min: coupon.min, coupon_own_min: coupon.own, points_used: pts, points_return: pointsReturn,
        add_sale: goodsDisc > 0 ? (full ? "T" : "M") : "none", add_sale_amount: goodsDisc, refund_type: SELF_REFUND_CODE[main[0] ?? ""] ?? "" },
      calc: { goods, disc: goodsDisc, rest_disc: sum(others, disc), fee, coupon_cancel: couponCancel, ship_paid: ship },
      expect: { total, amount: cash, points: pointsReturn }, manual, est,
    });
  }
  return groups;
}

// ── 환불전 목록의 '규칙 점검'(2026-10-15 사용자 요청 — "환불전 메뉴에서 우리 취소·반품 접수 규칙에 어긋나게 접수된 게 있으면 주의 표시") ──
// 카페24에 접수된 환불 금액(actual_refund_amount + used_points)을 우리 규칙으로 다시 계산한 값과 견준다. 읽기만 — 아무것도 바꾸지 않는다.
//  · 반품: 반품접수 탭과 같은 계산(retGroupsOf — 배송비 3,000/6,000 · 쿠폰 3만 원 기준 · 적립금 3만 원 기준 · 상품별 할인 차감)을 이 접수에 그대로 돌린다.
//    불량·오배송·그 밖의 사유는 '배송비 차감 없음'도 맞는 것으로 본다(사람이 인정했을 수 있음). 반품 불가 품목(수영복·ACC 주얼리·양말·모자·할인 상품)이 들어 있으면 주의.
//  · 취소: 전체 취소 = 처음 결제액 그대로(실측 591/591). 부분 취소 = 사용자 규칙(§7-9-b, 2026-10-05) — 변심이고 무료배송 주문인데 남는 상품 7만 원 미만이면
//    배송비 3,000 차감(배송지연·품절은 차감 없음이 기본이지만 사람이 차감했을 수 있어 둘 다 인정, '기타'는 아직 미정이라 둘 다 인정), 쿠폰·적립금은 반품과 같은 기준.
//  · level: ok(규칙대로) / warn(규칙과 다름 — 계산이 확실한데 금액이 다르거나 반품 불가 품목) / note(계산이 불확실한 주문인데 금액이 다름 — 참고) / skip(교환 등 점검 안 함)
const RF_SOFT_TAGS = new Set(["불량·오배송", "사유 글 확인", "그 밖의 사유", "쿠폰 확인", "경계 금액", "다른 취소·교환·반품", "수거 신청 아님", "그 밖의 할인", "배송비 확인", "배송 묶음",
  "1+1 상품", "10% 이상 할인", "할인 상품 수량", "할인코드", "예치금", "수량 일부", "배송 전 상태", "금액 확인", "미결제"]);
function rfRuleOf(r: Record<string, any>, o: Record<string, any> | null, nrSets: NrSets, cp: RetCoupons, orderRefunds: Record<string, any>[] = []) {
  const n = (v: unknown) => Math.round(Number(v ?? 0) || 0);
  const won = (v: number) => v.toLocaleString("ko-KR") + "원";
  const got = { amount: n(r.actual_refund_amount), points: n(r.used_points) };
  type Issue = { level: "warn" | "note"; tag: string; text: string };
  const issues: Issue[] = [];
  const out = (level: "ok" | "warn" | "note" | "skip", basis: string, expect: { amount: number; points: number } | null, okText = "") =>
    ({ level: issues.some((x) => x.level === "warn") ? "warn" : level === "ok" && issues.length ? "note" : level, basis, expect, got, ok_text: okText, issues });
  if (!o) { issues.push({ level: "note", tag: "점검 못 함", text: "주문을 읽지 못해 규칙과 맞는지 보지 못했어요" }); return out("note", "", null); }
  const codes = new Set(((r.order_item_code ?? []) as unknown[]).map(String));
  const all = (o.items ?? []) as Record<string, any>[];
  const its = all.filter((it) => codes.has(String(it.order_item_code)));
  const st = its.map((it) => String(it.order_status ?? ""));
  const kind = st.length && st.every((x) => x.startsWith("R")) ? "return" : st.length && st.every((x) => x.startsWith("C")) ? "cancel" : "";
  if (!kind) return out("skip", "", null);
  const claims = [...new Set(its.map((it) => String(it.claim_code ?? "")).filter(Boolean))];
  if (claims.length !== 1) { issues.push({ level: "note", tag: "점검 못 함", text: "접수번호가 여러 개이거나 없어 규칙 계산을 못 했어요" }); return out("note", "", null); }
  const claim = claims[0];
  // 반품 불가 품목(반품 스캔과 같은 기준) — 반품으로 접수됐으면 그 자체가 규칙 위반
  if (kind === "return") for (const it of its) for (const f of rscanItemFlags(it, nrSets)) if (f.level === "block") issues.push({ level: "warn", tag: "반품 불가 품목", text: `${String(it.product_name ?? "").slice(0, 30)} — ${f.text}` });
  // 반품접수 탭의 계산을 그대로 쓰려고 이 접수의 상품만 '반품접수(R10)'로 보고 돌린다(남는 상품·다른 접수는 그대로)
  const fake = { ...o, items: all.map((it) => codes.has(String(it.order_item_code)) ? { ...it, order_status: "R10" } : it), return: kind === "return" ? o.return : [{ ...((((o.cancellation ?? []) as Record<string, any>[]).find((c) => c.claim_code === claim)) ?? {}), claim_code: claim, pickup: { use_pickup: "T" }, pickup_request_state: "T" }] };
  if (kind === "cancel") fake.items = fake.items.map((it: Record<string, any>) => codes.has(String(it.order_item_code)) ? { ...it, order_status_before_cs: "N40" } : it);
  const g = retGroupsOf(fake, nrSets, cp).find((x) => x.claim_code === claim);
  if (!g) { issues.push({ level: "note", tag: "점검 못 함", text: o.order_place_id === "NCHECKOUT" || o.market_id === "NCHECKOUT" ? "네이버페이 주문은 규칙 점검을 하지 않아요" : "규칙 계산을 하지 못했어요" }); return out("note", "", null); }
  const tags = new Set((g.manual as { tag: string }[]).map((m) => m.tag));
  const init = (o.initial_order_amount ?? {}) as Record<string, any>;
  const ship = n(init.shipping_fee);
  const reasonType = String(g.reason_type ?? "");
  // 맞는 금액 후보들 — [이름, 결제 수단 환불, 적립금 반환, 설명]
  const cands: { amount: number; points: number; text: string }[] = [];
  let soft: string[] = [];
  let basis = "";
  if (kind === "return") {
    const e = g.expect as { amount: number; points: number };
    const fee = n(g.calc.fee);
    cands.push({ amount: e.amount, points: e.points, text: "" });
    const defect = tags.has("불량·오배송") || tags.has("사유 글 확인");
    if (defect) cands.push({ amount: e.amount + fee + (g.full && ship > 0 ? ship : 0), points: e.points, text: "불량·오배송으로 인정해 반품 배송비를 차감하지 않았어요" });
    else if (tags.has("그 밖의 사유")) cands.push({ amount: e.amount + fee, points: e.points, text: `사유(${RET_REASON_LABEL[reasonType] ?? reasonType})를 우리 쪽 사정으로 보고 배송비를 차감하지 않았어요` });
    soft = (g.manual as { tag: string; text: string }[]).filter((m) => RF_SOFT_TAGS.has(m.tag) && m.tag !== "불량·오배송" && m.tag !== "사유 글 확인" && m.tag !== "그 밖의 사유").map((m) => m.text);
    basis = `규칙 계산: 상품 ${won(n(g.calc.goods))}${n(g.calc.disc) ? ` − 할인 ${won(n(g.calc.disc))}` : ""} − 반품 배송비 ${won(fee)}${n(g.calc.coupon_cancel) ? ` − 쿠폰 취소 ${won(n(g.calc.coupon_cancel))}` : ""}${e.points ? ` − 적립금 반환 ${won(e.points)}` : ""} = ${won(e.amount)}${e.points ? ` + 적립금 ${won(e.points)}` : ""}`;
  } else {
    const others = all.filter((it) => !codes.has(String(it.order_item_code)));
    if (!others.length) {
      // 전체 취소 — 처음 결제액 그대로, 쓴 적립금 전액 반환(실측 591/591)
      cands.push({ amount: n(init.payment_amount), points: n(init.points_spent_amount), text: "" });
      basis = `규칙 계산: 전체 취소 = 처음 결제액 ${won(n(init.payment_amount))}${n(init.points_spent_amount) ? ` + 적립금 ${won(n(init.points_spent_amount))}` : ""}`;
      if (n(init.credits_spent_amount) > 0) soft.push("예치금을 쓴 주문이에요");
    } else {
      const remain = n(g.remain), goods = n(g.calc.goods) - n(g.calc.disc), cpc = n(g.calc.coupon_cancel), pts = n((g.expect as { points: number }).points);
      const needFee = ship === 0 && remain < RET_FREE_SHIP;   // 무료배송 주문인데 남는 상품이 7만 원 미만 → 변심이면 배송비 3,000 차감
      const fee = needFee && reasonType !== "B" && reasonType !== "H" ? RET_FEE : 0;
      const base = goods - cpc - pts;
      cands.push({ amount: base - fee, points: pts, text: "" });
      if (needFee && reasonType === "I") cands.push({ amount: base, points: pts, text: "사유가 '기타'라 배송비를 차감하지 않았어요(기타를 변심으로 볼지는 아직 정하지 않음)" });
      if (needFee && (reasonType === "B" || reasonType === "H")) cands.push({ amount: base - RET_FEE, points: pts, text: "배송지연·품절 취소인데 배송비 3,000원을 차감했어요(사람이 판단했을 수 있음)" });
      soft = (g.manual as { tag: string; text: string }[]).filter((m) => ["쿠폰 확인", "경계 금액", "다른 취소·교환·반품", "그 밖의 할인", "배송비 확인", "1+1 상품", "10% 이상 할인", "할인 상품 수량", "할인코드", "예치금", "수량 일부"].includes(m.tag)).map((m) => m.text);
      if (others.some((it) => /^[CER]/.test(String(it.order_status ?? "")))) soft.push("같은 주문에 먼저 처리된 취소·반품이 있어요");
      // 규칙 5: 할인 상품·1+1 상품이 든 주문의 부분 취소는 사람이 본다(상품별 할인을 취소할지에 따라 금액이 달라짐)
      if (all.some((it) => n(it.additional_discount_price) > 0 || n(it.app_item_discount_amount) > 0) && !soft.some((t) => /할인/.test(t))) soft.push("상품별 할인·할인코드가 적용된 상품이 든 주문이에요 — 할인 취소 여부에 따라 금액이 달라요");
      if (cands[0].amount <= 0) soft.push("규칙대로 빼면 환불액이 0원 이하가 돼요");
      basis = `규칙 계산(부분 취소): 상품 ${won(goods)}${needFee ? ` − 배송비 ${won(fee)}(무료배송 주문 · 남는 상품 ${won(remain)})` : ""}${cpc ? ` − 쿠폰 취소 ${won(cpc)}` : ""}${pts ? ` − 적립금 반환 ${won(pts)}` : ""} = ${won(cands[0].amount)}${pts ? ` + 적립금 ${won(pts)}` : ""}`;
    }
  }
  // ── 같은 주문에 반품을 따로 접수한 경우(2026-10-15 사용자 지정) ──
  //  접수마다 따로 계산하면 남는 금액·배송비가 서로 엇갈려 '규칙과 다름'처럼 보인다 → 접수별 비교 대신, 같은 주문의 반품 접수를 한 번의 반품으로 합쳐 계산하고
  //  그 환불들의 합과 견준다. 합배송이면 반품 배송비가 중복 차감되지 않는 게 맞고, 개별 배송이면 편도 3,000원을 추가 부과(사용자 규칙) → 둘 다 맞는 것으로 보고 어느 쪽인지 알려 준다.
  //  어느 쪽인지는 사람이 정할 일이라 늘 '확인해 보세요'(note).
  if (kind === "return") {
    const sibClaims = [...new Set(all.filter((it) => !codes.has(String(it.order_item_code)) && /^R/.test(String(it.order_status ?? "")) && it.claim_code && String(it.claim_code) !== claim).map((it) => String(it.claim_code)))];
    if (sibClaims.length) {
      const allClaims = [claim, ...sibClaims];
      const rets = ((o.return ?? []) as Record<string, any>[]).filter((x) => allClaims.includes(String(x.claim_code)));
      const invoices = [...new Set(rets.map((x) => String(x.return_invoice_no ?? "").trim()).filter(Boolean))];
      const msg = `같은 주문건에 반품 접수를 각각 따로 했어요(${allClaims.length}건). 합배송이면 반품 배송비가 중복 차감되지 않는 게 맞고, 개별 배송이면 편도 3,000원을 추가 부과해야 해요.` +
        (invoices.length ? ` (회수 송장 ${invoices.length}개${invoices.length > 1 ? " — 서로 달라요" : " — 같아요"})` : "");
      const sibCodes = new Set(all.filter((it) => sibClaims.includes(String(it.claim_code ?? ""))).map((it) => String(it.order_item_code)));
      // 형제 접수의 환불 내역(환불전·환불완료) — 각 형제 접수의 상품이 전부 어떤 환불에 들어 있어야 합칠 수 있다
      const sibRefunds = orderRefunds.filter((x) => String(x.refund_code) !== String(r.refund_code) && String(x.status ?? "F") !== "M" && ((x.order_item_code ?? []) as unknown[]).some((c) => sibCodes.has(String(c))));
      const covered = new Set(sibRefunds.flatMap((x) => ((x.order_item_code ?? []) as unknown[]).map(String)));
      const issuesSplit: Issue[] = [{ level: "note", tag: "반품 따로 접수", text: msg }];
      let basis2 = "", okLine = "";
      if ([...sibCodes].every((c) => covered.has(c))) {
        const merged = { ...fake, items: all.map((it) => codes.has(String(it.order_item_code)) || sibCodes.has(String(it.order_item_code)) ? { ...it, order_status: "R10", claim_code: claim, order_status_before_cs: it.order_status_before_cs } : it) };
        const g2 = retGroupsOf(merged, nrSets, cp).find((x) => x.claim_code === claim);
        if (g2) {
          const e2 = g2.expect as { amount: number; points: number };
          const want = e2.amount + e2.points, extra = RET_FEE * sibClaims.length;
          const sum = [r, ...sibRefunds].reduce((t, x) => t + n(x.actual_refund_amount) + n(x.used_points), 0);
          basis2 = `합쳐서 계산(반품 ${allClaims.length}건 = 한 번의 반품): 상품 ${won(n(g2.calc.goods))}${n(g2.calc.disc) ? ` − 할인 ${won(n(g2.calc.disc))}` : ""} − 반품 배송비 ${won(n(g2.calc.fee))}${n(g2.calc.coupon_cancel) ? ` − 쿠폰 취소 ${won(n(g2.calc.coupon_cancel))}` : ""} = ${won(want)} · 접수된 환불 ${allClaims.length}건 합계 ${won(sum)}`;
          const soft2 = (g2.manual as { tag: string; text: string }[]).filter((m) => RF_SOFT_TAGS.has(m.tag) && !["불량·오배송", "사유 글 확인", "그 밖의 사유"].includes(m.tag)).map((m) => m.text);
          if (sum === want) okLine = `합치면 합배송 기준으로 규칙대로예요(반품 배송비 한 번만 차감). 개별 배송이었다면 ${won(extra)}을 더 빼야 해요.`;
          else if (sum === want - extra) okLine = `합치면 개별 배송 기준으로 규칙대로예요(편도 ${won(RET_FEE)} 추가 부과됨). 합배송이었다면 ${won(extra)}을 더 돌려줘야 해요.`;
          else issuesSplit.push({ level: "note", tag: "합쳐도 규칙과 다름", text: `반품 ${allClaims.length}건을 합쳐도 규칙(합배송 ${won(want)} · 개별 배송 ${won(want - extra)})과 달라요 — 접수된 합계 ${won(sum)}` + (soft2.length ? ` — 계산이 정확하지 않을 수 있어요: ${soft2.join(" / ")}` : "") });
        }
      } else issuesSplit.push({ level: "note", tag: "합쳐서 계산 못 함", text: "다른 반품 접수가 아직 환불전이 아니라 합쳐서 계산하지 못했어요" });
      if (okLine) issuesSplit[0].text += " " + okLine;
      const keepWarn = issues.filter((x) => x.level === "warn");
      return { level: keepWarn.length ? "warn" : "note", basis: basis2 || basis, expect: null, got, ok_text: "", issues: [...keepWarn, ...issuesSplit] };
    }
  }
  const expect = { amount: cands[0].amount, points: cands[0].points };
  const hit = cands.find((c) => c.amount === got.amount && c.points === got.points);
  if (hit) return out("ok", basis, expect, hit.text);
  const d = got.amount + got.points - (expect.amount + expect.points);
  const diffText = `규칙대로면 ${won(expect.amount)}${expect.points ? ` + 적립금 ${won(expect.points)}` : ""}인데 접수는 ${won(got.amount)}${got.points ? ` + 적립금 ${won(got.points)}` : ""}이에요` +
    (d ? ` (고객에게 ${won(Math.abs(d))} ${d > 0 ? "더" : "덜"} 나가요)` : got.points !== expect.points ? " (카드·현금과 적립금 나눔이 달라요)" : "");
  // 반품은 접수 내역의 항목별 금액으로 어디가 다른지 짚어 준다
  const parts: string[] = [];
  if (kind === "return") {
    const ret = (((o.return ?? []) as Record<string, any>[]).find((x) => x.claim_code === claim)) ?? {};
    const neg = (v: unknown) => 0 - n(v) || 0;
    const fee = neg(ret.return_shipping_fee), cpn = neg(ret.coupon_discount_amount), rpt = neg(ret.point_used);
    if (fee !== n(g.calc.fee) && !(cands.length > 1 && fee === 0)) parts.push(`반품 배송비 차감 — 규칙 ${won(n(g.calc.fee))} · 접수 ${won(fee)}`);
    if (cpn !== n(g.calc.coupon_cancel)) parts.push(`쿠폰할인 취소 — 규칙 ${won(n(g.calc.coupon_cancel))} · 접수 ${won(cpn)}`);
    if (rpt !== n(expect.points)) parts.push(`적립금 반환 — 규칙 ${won(expect.points)} · 접수 ${won(rpt)}`);
  }
  const firm = soft.length === 0 && issues.every((x) => x.tag !== "점검 못 함");
  issues.unshift({ level: firm ? "warn" : "note", tag: firm ? "규칙과 금액 다름" : "규칙 계산과 다름(참고)", text: diffText + (parts.length ? " — " + parts.join(" / ") : "") + (firm ? "" : ` — 이 주문은 계산이 정확하지 않을 수 있어요: ${soft.join(" / ")}`) });
  return out(firm ? "warn" : "note", basis, expect);
}

// ── 환불 안전장치(2026-10-15 사용자 요청 — "잘못 입력해서 주문금액보다 더 많이, 또는 거의 다 환불되는 불상사가 두렵다") ──
// 이 탭은 금액을 넣지 않는다(카페24에 접수된 금액 그대로 완료) → 위험 = 접수 때 사람이 잘못 넣은 금액이 그대로 나가는 것. 보내기 직전 서버가 막는다.
//  · block(절대 안 보냄, 넘길 방법 없음): 이 환불 + 이 주문에서 이미 끝난 환불 > 고객이 낸 돈(결제액 + 쓴 적립금 + 예치금)
//    — 지난 60일 환불완료 3,235건 중 0건(정상 환불에서는 생길 수 없는 일).
//  · ack(사람이 한 번 더 확인해야 보냄): 고객에게 남는 상품이 있는데 이 환불이 환불 상품의 판매가(상품 할인 뺀 값)보다 많음
//    — 같은 기간 11건(상품 할인을 안 뺐거나 다른 상품 몫까지 돌려준 경우 등). 마지막 남은 상품 환불은 앞서 뺀 배송비가 돌아오므로 결제액 한도만 본다.
function rfGuardOf(r: Record<string, any>, o: Record<string, any> | null, orderRefunds: Record<string, any>[]) {
  const n = (v: unknown) => Math.round(Number(v ?? 0) || 0);
  const won = (v: number) => v.toLocaleString("ko-KR") + "원";
  const block: string[] = [], ack: string[] = [];
  if (!o) { block.push("주문을 읽지 못해 금액 한도를 확인할 수 없어요"); return { block, ack, paid: 0, prior: 0, me: 0, items_net: 0 }; }
  const init = (o.initial_order_amount ?? {}) as Record<string, any>;
  const paid = n(init.payment_amount) + n(init.points_spent_amount) + n(init.credits_spent_amount);
  const amt = (x: Record<string, any>) => n(x.actual_refund_amount) + n(x.used_points) + n(x.used_credits);
  const me = amt(r);
  const prior = orderRefunds.filter((x) => String(x.refund_code) !== String(r.refund_code) && String(x.status ?? "") === "T").reduce((t, x) => t + amt(x), 0);
  const codes = new Set(((r.order_item_code ?? []) as unknown[]).map(String));
  const all = (o.items ?? []) as Record<string, any>[];
  const its = all.filter((it) => codes.has(String(it.order_item_code)));
  const net = its.reduce((t, it) => t + (n(it.product_price) + n(it.option_price)) * (Number(it.quantity ?? 0) || 0) - n(it.additional_discount_price) - n(it.app_item_discount_amount), 0);
  const staying = all.filter((it) => !codes.has(String(it.order_item_code)) && !/^[CR]/.test(String(it.order_status ?? "")));
  if (paid <= 0) block.push("고객이 낸 금액을 읽지 못했어요");
  else if (prior + me > paid) block.push(`고객이 낸 돈(${won(paid)})보다 많이 환불돼요 — 이미 환불 ${won(prior)} + 이번 ${won(me)} = ${won(prior + me)}`);
  if (staying.length && me > net) ack.push(`고객에게 남는 상품이 ${staying.length}개 있는데, 이번 환불(${won(me)})이 환불하는 상품 값(${won(net)})보다 ${won(me - net)} 많아요`);
  return { block, ack, paid, prior, me, items_net: net };
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
    const viaSecret = (action === "madeavg" || action === "cn_export") && !!syncSecret && safeEqual(req.headers.get("x-sync-secret") ?? "", syncSecret);
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
    const cacheKey = `an:${qsKey.toString()}` + (action === "performance" ? `:${authed.role}:cn4` : "");   // cn3 = 환전 내역·출고 서류 총 합계 반영(2026-10-22)   // cn1 = 중국 사입 실질 단가 반영(2026-10-16) 전 캐시를 쓰지 않게
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

    // ── 취소·반품 접수 (#cxl, 2026-10-05 사용자 요청): 관리자 + 허용 목록(cxl_users, 2026-10-08). 네이버페이 취소신청(C00) 목록·분류 / 접수(쓰기) / 처리 내역.
    //    목록은 캐시하지 않는다(접수 직전 상태가 곧 기준). 접수는 서버가 아니라 화면의 연결 스크립트가 한 건씩 한다 — 서버는 준비(prepare)·기록(record).
    if (action === "cancelreq_list" || action === "cancelreq_prepare" || action === "cancelreq_record" || action === "cancelreq_log") {
      if (!(await cxlRoleOk(authed))) return json({ error: "접근 권한이 없습니다" }, 403);   // 관리자 + 허용 목록(cxl_users)
      const CXL_RECENT_MS = 30 * 60 * 1000;   // 접수 직후 카페24 조회에 늦게 반영될 수 있어, 30분 안에 접수한 품목은 '방금 접수'로 보고 다시 보내지 않는다
      const recentOk = async () => {
        const rows = ((await sbRest(`cancel_accept_log?select=order_id,items,created_at,by_name&ok=is.true&created_at=gte.${new Date(Date.now() - CXL_RECENT_MS).toISOString()}&limit=1000`)) ?? []) as Record<string, any>[];
        const m = new Map<string, { at: string; by: string }>();
        for (const r of rows) for (const x of (r.items ?? []) as Record<string, any>[]) m.set(String(x.code ?? ""), { at: String(r.created_at ?? ""), by: String(r.by_name ?? "") });
        return m;
      };
      if (action === "cancelreq_log") {
        const since = new Date(Date.now() - 30 * 86400e3).toISOString();
        const rows = (await sbRest(`cancel_accept_log?select=id,created_at,order_id,items,reason_type,reason_label,reason,flags,ok,result,claim_code,by_name,kind,expected_amount,refund_amount,points,stage:detail->>stage,fee:detail->>fee,coupon_cancel:detail->>coupon_cancel&created_at=gte.${since}&order=created_at.desc&limit=1000`)) ?? [];
        return json({ rows });
      }
      if (action === "cancelreq_list") {
        const end = rscanYesterday(); end.setUTCDate(end.getUTCDate() + 1);   // 한국 날짜 오늘
        const start = new Date(end); start.setUTCDate(start.getUTCDate() - 89);
        const fmtD = (d: Date) => d.toISOString().slice(0, 10);
        const groups: Record<string, any>[] = [];
        for (let offset = 0; offset < 5000; offset += 200) {
          const body = await apiGet(`${API_BASE}/admin/orders?start_date=${fmtD(start)}&end_date=${fmtD(end)}&date_type=order_date&order_status=C00&embed=items&limit=200&offset=${offset}`, token);
          const orders = (body.orders ?? []) as Record<string, any>[];
          for (const o of orders) groups.push(...cxlGroupsOf(o));
          if (orders.length < 200) break;
        }
        const recent = await recentOk();
        for (const g of groups) { const hit = (g.items as Record<string, any>[]).map((x) => recent.get(x.code)).find(Boolean); if (hit) g.just_accepted = hit; }
        groups.sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)));
        return json({ today: fmtD(end), fetched_at: new Date().toISOString(), range: { start: fmtD(start), end: fmtD(end) }, labels: Object.keys(NPAY_CANCEL_TYPES), groups });
      }
      // ── 접수 준비·기록 — 접수 자체는 화면이 이 PC의 연결 스크립트(window.CAFE24_CANCEL)에 맡긴다(위 '서버가 하지 않는다' 참고).
      //    prepare: 보내기 직전 최신 주문으로 다시 분류해 '어떤 품목을 어떤 취소 구분·사유로' 접수할지 서버가 정해 준다(화면이 보낸 것은 주문번호·품목뿐).
      //    record : 끝난 뒤 주문을 다시 읽어 취소신청에서 빠졌는지 확인하고 cancel_accept_log에 기록(성공·실패 모두).
      if (req.method !== "POST") return json({ error: "POST로 호출해주세요" }, 405);
      if (viaAgent || viaCron || viaSecret) return json({ error: "이 기능은 로그인한 사람만 쓸 수 있습니다" }, 403);
      const orderId = String(url.searchParams.get("order_id") ?? "");
      if (!/^\d{8}-\d{7}$/.test(orderId)) return json({ error: "주문번호가 올바르지 않습니다" }, 400);
      const b = await req.json().catch(() => ({})) as Record<string, any>;
      const want = (Array.isArray(b.codes) ? b.codes : []).map((c: unknown) => String(c)).sort();
      if (!want.length || want.length > 50 || want.some((c: string) => !/^\d{8}-\d{7}-\d{2,3}$/.test(c) || !c.startsWith(orderId + "-"))) return json({ error: "접수할 품목이 올바르지 않습니다" }, 400);
      const readOrder = async () => ((await apiGet(`${API_BASE}/admin/orders/${orderId}?embed=items`, token)).order ?? {}) as Record<string, any>;
      const wantItems = (o: Record<string, any>) => ((o.items ?? []) as Record<string, any>[]).filter((it) => want.includes(String(it.order_item_code ?? "")));
      const stateOf = (o: Record<string, any>) => [...new Set(wantItems(o).map((it) => String(it.status_text ?? it.order_status ?? "")))].join(", ");
      let order: Record<string, any>;
      try { order = await readOrder(); } catch (e) { return json({ error: "카페24에서 주문을 읽지 못했어요 — " + String(e).slice(0, 200) }, 502); }
      if (action === "cancelreq_prepare") {
        const g = cxlGroupsOf(order).find((x) => x.key === want.join(","));
        if (!g) {
          const its = wantItems(order);
          if (its.length === want.length && its.every((it) => /^C[1-4]/.test(String(it.order_status ?? "")))) return json({ ok: true, already: true, status: stateOf(order) });
          return json({ error: "그 사이 주문 상태가 바뀌었어요 — 새로고침한 뒤 다시 확인해주세요", stale: true, status: stateOf(order) }, 409);
        }
        const flags = g.flags as CxlFlag[];
        const blocks = flags.filter((f) => f.level === "block");
        if (blocks.length) return json({ error: blocks.map((f) => f.text).join(" / "), blocked: true }, 400);
        if (flags.length && b.ack !== true) return json({ error: "직접 확인이 필요한 주문이에요", need_ack: true, flags }, 409);
        const recent = await recentOk();
        if ((g.items as Record<string, any>[]).some((x) => recent.has(x.code))) return json({ ok: true, already: true, status: "방금 접수함(카페24 반영 대기)" });
        // 안전장치: 사람별 1시간 300건 · 전체 하루 1,000건 (성공·실패 모두 셈)
        const sinceIso = (ms: number) => new Date(Date.now() - ms).toISOString();
        const mine = ((await sbRest(`cancel_accept_log?select=id&by_id=eq.${encodeURIComponent(authed.id)}&created_at=gte.${sinceIso(3600e3)}&limit=500`)) ?? []) as unknown[];
        const allDay = ((await sbRest(`cancel_accept_log?select=id&created_at=gte.${sinceIso(24 * 3600e3)}&limit=1500`)) ?? []) as unknown[];
        if (mine.length >= 300 || allDay.length >= 1000) return json({ error: "취소 접수 한도를 넘었어요 — 잠시 뒤 다시 시도해주세요" }, 429);
        return json({ ok: true, job: { order_id: orderId, codes: want, type: String(g.reason_type), label: String(g.label), reason: String(g.reason_raw).trim() }, flags });
      }
      // record — 연결 스크립트가 끝난 뒤. 화면이 보낸 결과(b.ok·b.message)는 참고이고, 서버가 주문을 다시 읽어 확인한다.
      const its = wantItems(order);
      const verified = its.length === want.length && its.every((it) => String(it.order_status ?? "") !== "C00");
      // 연결 스크립트는 관리자 창을 다시 읽어 '취소신청 목록에서 빠졌는지' 직접 확인한 뒤 ok를 준다 — 공개 API 조회는 반영이 조금 늦을 수 있어 둘 중 하나면 접수로 본다
      const ok = verified || b.ok === true;
      const job = (b.job ?? {}) as Record<string, any>;
      const txt = (v: unknown, n: number) => String(v ?? "").slice(0, n);
      await sbRest("cancel_accept_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
        order_id: orderId,
        items: (Array.isArray(b.items) ? b.items : []).slice(0, 50).filter((x: any) => want.includes(String(x?.code ?? ""))).map((x: any) => ({ code: txt(x.code, 30), product_name: txt(x.product_name, 200), option: txt(x.option, 200), qty: Number(x.qty) || 0 })),
        reason_type: Object.values(NPAY_CANCEL_TYPES).includes(String(job.type)) ? String(job.type) : null, reason_label: txt(job.label, 40) || null, reason: txt(job.reason, 2000) || null,
        flags: Array.isArray(b.flags) && b.flags.length ? b.flags.slice(0, 12).map((f: any) => ({ level: f?.level === "block" ? "block" : "check", text: txt(f?.text, 200) })) : null,
        ok, result: ok ? (verified ? (stateOf(order) || "접수됨") : "접수됨(카페24 반영 대기)") : (txt(b.message, 450) || "접수되지 않음"), by_id: authed.id, by_name: authed.name }) }).catch(() => null);
      return json({ ok, verified, status: stateOf(order) });
    }

    // ── 취소·반품 접수 2단계 — 자사몰 취소접수(C10) → 환불 (2026-10-05 사용자 요청): 관리자 + 허용 목록(최종 환불은 관리자만).
    //    selfcancel_list: 목록·분류(캐시 없음) / selfcancel_run(POST, 사람 로그인만): 한 건 처리 = ② 취소처리중으로 넘김 → 금액 확인(여기까지가 기본)
    //    → [요청에 refund:true가 있을 때만] ③ 환불완료 → 재확인·기록.
    // ── 취소·반품 접수 ④ 환불전 → 환불완료 (2026-10-15 사용자 요청 — "카페24 환불전에 있는 걸 일괄 환불완료. 카페24 환불전에서 처리 → 환불완료하면
    //    접수된 환불 수단의 PG 취소도 함께 되는데 이것도 같게. 단 무통장은 직접 입금하고 완료해야 하니 따로 분류") ──
    //   · 관리자만(최종 환불은 관리자만 — 2026-10-08 규칙). 쓰기는 이미 승인된 cafe24CompleteRefund 하나(본문 고정: status complete · PG 결제취소 T · 문자·메일 T).
    //   · 목록 = 카페24 환불 내역 refund_status=F(환불전), 환불 접수일 최근 180일(60일씩 나눠 읽음). 주문을 같이 읽어 상품·취소/반품 구분을 붙인다.
    //   · 분류: cash(무통장 — 현금 환불, 사람이 계좌로 입금해야 함: 처리하지 않고 계좌만 보여 줌) / auto(환불 수단이 card·tcash·prepaid뿐, 예치금 없음,
    //     네이버페이 주문 아님, 금액 > 0) / check(그 밖 — 카페24에서 직접).
    //   · 처리(한 건씩): 보내기 직전 다시 읽어 '환불전 그대로 · 분류 auto · 금액 = 화면 금액'일 때만 보냄 → 환불완료·PG 취소·금액 재확인 → cancel_accept_log(kind 'refund').
    // ── 고액 반품 관리 (2026-10-20 사용자 요청 — 물류·CS 메뉴) ──
    //   고액 = 환불 금액(결제 수단 환불 + 적립금 + 예치금) 30만 원 이상인 '반품' 환불(환불 상품이 모두 반품 상태 R…). 취소 환불은 뺀다.
    //   보여 주기: 50만 원 이상은 1회여도 표시, 30만~50만 원 미만은 그 고객의 고액 반품이 2회 이상일 때만(1회성은 너무 많아서 — 사용자 지정).
    //   누적 횟수 = 같은 고객(회원 ID, 비회원은 이름+휴대전화)의 30만 원 이상 반품 환불 건수(모은 기간 안 — 처음 최근 1년부터).
    //   모으기: bigret_refunds 표에 30만 원 이상만 저장. 처음엔 최근 1년을 89일씩 나눠(한 번 호출에 구간 1~2개) 읽고, 그 뒤로는 부를 때마다 최근 14일을 다시 읽어 갱신(10분 안에 다시 부르면 생략).
    //   카페24 환불 내역(refunds)에는 네이버페이 주문의 반품이 없다(자사몰 결제분만) → 네이버페이 주문(order_place_id NCHECKOUT)의 반품은 주문 API로 따로 모은다(2026-10-20 사용자 요청 "빠지는 게 있으면 안 돼").
    //   반품 요청일(return_request_date) 기준으로 같은 구간을 읽어 주문마다 R… 상태 상품을 한 줄로(열쇠 N:주문번호, bigret_sync.naver_until까지 읽음). 환불 금액은 카페24에 없어
    //   반품 상품 금액(판매가+옵션가)×수량 − 상품 할인 − 쿠폰 할인으로 추정(estimated — 배송비·네이버 포인트 처리는 모름). 실측(2026-10-20): 최근 60일 반품완료 주문 2,361건 중 822건이 네이버페이.
    if (action === "bigret_list") {
      if (!["admin", "staff", "cs"].includes(authed.role)) return json({ error: "접근 권한이 없습니다" }, 403);
      const MIN = 300_000, ALWAYS = 500_000, t0 = Date.now(), BUDGET = 35_000;   // 89일 한 구간 ≈ 30~50초 — 새 구간은 35초 안에서만 시작(벽시계 150초 한도, 2026-10-20 첫 실행 99초)
      const n = (v: unknown) => Math.round(Number(v ?? 0) || 0);
      const day = (off: number) => { const d = rscanYesterday(); d.setUTCDate(d.getUTCDate() + 1 + off); return d.toISOString().slice(0, 10); };
      const addD = (ymd: string, k: number) => { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
      const today = day(0);
      const [st0] = (((await sbRest("bigret_sync?id=eq.1&select=*")) ?? []) as Record<string, any>[]);
      let st = st0 ?? null;
      if (!st) { st = { id: 1, backfill_from: day(-365), synced_until: null, updated_at: null }; await sbRest("bigret_sync", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(st) }); }
      const backfilled = !!st.synced_until && st.synced_until >= today;
      const naverBackfilled = !!st.naver_until && st.naver_until >= today;
      const fresh = backfilled && naverBackfilled && st.updated_at && Date.now() - new Date(st.updated_at).getTime() < 10 * 60_000 && !noCache;
      let windows = 0, scanned = 0, saved = 0;
      if (!fresh) {
        // 읽을 구간: 처음 모으는 중이면 이어서, 다 모았으면 최근 14일
        let cur = backfilled ? addD(today, -14) : (st.synced_until ? addD(st.synced_until, 1) : st.backfill_from);
        while (cur <= today && Date.now() - t0 < BUDGET) {
          const end = addD(cur, 88) > today ? today : addD(cur, 88);
          const amt = (r: Record<string, any>) => n(r.actual_refund_amount) + n(r.used_points) + n(r.used_credits);
          const cand: Record<string, any>[] = [], seen = new Set<string>();
          for (let offset = 0; offset < 20000; offset += 100) {
            const body = await apiGet(`${API_BASE}/admin/refunds?start_date=${cur}&end_date=${end}&date_type=accepted_refund_date&limit=100&offset=${offset}`, token);
            const rs = (body.refunds ?? []) as Record<string, any>[];
            scanned += rs.length;
            for (const r of rs) { seen.add(String(r.refund_code)); if (amt(r) >= MIN) cand.push(r); }
            if (rs.length < 100) break;
          }
          // 주문(상품 상태·구매자) — 50개씩
          const orders = new Map<string, Record<string, any>>();
          const ids = [...new Set(cand.map((r) => String(r.order_id)))];
          for (let i = 0; i < ids.length; i += 50) {
            const body = await apiGet(`${API_BASE}/admin/orders?shop_no=1&order_id=${ids.slice(i, i + 50).join(",")}&embed=items,buyer&limit=100`, token);
            for (const o of (body.orders ?? []) as Record<string, any>[]) orders.set(String(o.order_id), o);
          }
          const rows: Record<string, unknown>[] = [];
          for (const r of cand) {
            const o = orders.get(String(r.order_id)); if (!o) continue;
            const codes = new Set(((r.order_item_code ?? []) as unknown[]).map(String));
            const all = (o.items ?? []) as Record<string, any>[], its = all.filter((it) => codes.has(String(it.order_item_code)));
            if (!its.length || !its.every((it) => String(it.order_status ?? "").startsWith("R"))) continue;   // 취소 환불·섞인 것은 뺀다
            const rest = all.filter((it) => !codes.has(String(it.order_item_code)) && !String(it.order_status ?? "").startsWith("C"));
            const buyer = (o.buyer ?? {}) as Record<string, any>;
            const memberId = String(o.member_id ?? buyer.member_id ?? "").trim();
            const name = String(buyer.name ?? o.billing_name ?? "").trim(), phone = String(buyer.cellphone || buyer.phone || "").trim();
            const init = (o.initial_order_amount ?? {}) as Record<string, any>;
            rows.push({
              refund_code: String(r.refund_code), order_id: String(r.order_id), member_id: memberId || null, buyer_name: name || null, buyer_phone: phone || null,
              customer_key: memberId ? "m:" + memberId : "p:" + name + "|" + phone.replace(/\D/g, ""),
              pay_amount: n(init.payment_amount), points_spent: n(init.points_spent_amount),
              refund_amount: n(r.actual_refund_amount) + n(r.used_points) + n(r.used_credits), refund_cash: n(r.actual_refund_amount), refund_points: n(r.used_points), refund_credits: n(r.used_credits),
              scope: rest.length ? "partial" : "full", status: String(r.status ?? ""), accepted_at: r.accepted_refund_date || null, refunded_at: r.refund_date || null,
              items: its.map((it) => ({ product_name: String(it.product_name ?? ""), option: String(it.option_value ?? ""), qty: n(it.quantity) })), updated_at: new Date().toISOString(),
            });
          }
          if (rows.length) { await sbRest("bigret_refunds?on_conflict=refund_code", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) }); saved += rows.length; }
          // 저장해 둔 것 중 이번에 30만 원 아래로 바뀌었거나 반품이 아니게 된 환불은 지운다(이 구간에 저장된 것만 확인)
          const keep = new Set(rows.map((x) => String(x.refund_code)));
          const stored = (((await sbRest(`bigret_refunds?accepted_at=gte.${cur}T00:00:00%2B09:00&accepted_at=lte.${end}T23:59:59%2B09:00&select=refund_code`)) ?? []) as Record<string, any>[]).map((x) => String(x.refund_code));
          const gone = stored.filter((c) => seen.has(c) && !keep.has(c));
          for (let i = 0; i < gone.length; i += 100) {
            const list = gone.slice(i, i + 100).map((c) => '"' + c.replace(/"/g, "") + '"').join(",");
            await sbRest(`bigret_refunds?refund_code=in.(${encodeURIComponent(list)})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
          }
          windows++;
          const prevUntil = st.synced_until;
          st.synced_until = !prevUntil || end > prevUntil ? end : prevUntil;
          st.updated_at = new Date().toISOString();
          await sbRest("bigret_sync?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ synced_until: st.synced_until, updated_at: st.updated_at }) });
          cur = addD(end, 1);
        }
        // ── 네이버페이 주문의 반품(주문 API, 반품 요청일 기준) — 주문마다 한 줄, 환불 금액은 반품 상품 금액으로 추정 ──
        const naverRow = (o: Record<string, any>) => {
          const all = (o.items ?? []) as Record<string, any>[], its = all.filter((it) => String(it.order_status ?? "").startsWith("R"));
          if (!its.length) return null;
          const rest = all.filter((it) => !/^[RC]/.test(String(it.order_status ?? "")));
          const buyer = (o.buyer ?? {}) as Record<string, any>;
          const memberId = String(o.member_id ?? buyer.member_id ?? "").trim();
          const name = String(buyer.name ?? o.billing_name ?? "").trim(), phone = String(buyer.cellphone || buyer.phone || "").trim();
          const init = (o.initial_order_amount ?? {}) as Record<string, any>;
          const amount = its.reduce((sum, it) => sum + Math.max(0, n((Number(it.product_price ?? 0) + Number(it.option_price ?? 0)) * Number(it.quantity ?? 0) - Number(it.additional_discount_price ?? 0) - Number(it.app_item_discount_amount ?? 0) - Number(it.coupon_discount_price ?? 0))), 0);
          const req = its.map((it) => String(it.return_request_date ?? "")).filter(Boolean).sort();
          const fin = its.map((it) => String(it.refund_date ?? "")).filter(Boolean).sort();
          return {
            refund_code: "N:" + String(o.order_id), order_id: String(o.order_id), member_id: memberId || null, buyer_name: name || null, buyer_phone: phone || null,
            customer_key: memberId ? "m:" + memberId : "p:" + name + "|" + phone.replace(/\D/g, ""),
            pay_amount: n(init.payment_amount), points_spent: n(init.points_spent_amount), naver_point: n(o.naver_point),
            refund_amount: amount, refund_cash: null, refund_points: null, refund_credits: null,
            scope: rest.length ? "partial" : "full", status: its.every((it) => String(it.order_status) === "R40") ? "R40" : "R",
            accepted_at: req[0] || o.order_date || null, refunded_at: fin[fin.length - 1] || null,
            items: its.map((it) => ({ product_name: String(it.product_name ?? ""), option: String(it.option_value ?? ""), qty: n(it.quantity) })),
            source: "naver", estimated: true, updated_at: new Date().toISOString(),
          };
        };
        let curN = naverBackfilled ? addD(today, -14) : (st.naver_until ? addD(st.naver_until, 1) : st.backfill_from);
        while (curN <= today && Date.now() - t0 < BUDGET) {
          const end = addD(curN, 88) > today ? today : addD(curN, 88);
          const rows: Record<string, unknown>[] = [];
          for (let offset = 0; offset <= 8000; offset += 1000) {   // 89일 구간에 1,000~1,500건(2026-10-20 실측 1,000건 한 장 10MB·3.5초)
            const body = await apiGet(`${API_BASE}/admin/orders?shop_no=1&start_date=${curN}&end_date=${end}&date_type=return_request_date&order_status=R10,R20,R30,R34,R36,R40&order_place_id=NCHECKOUT&embed=items,buyer&limit=1000&offset=${offset}`, token);
            const os = (body.orders ?? []) as Record<string, any>[];
            scanned += os.length;
            for (const o of os) { const row = naverRow(o); if (row && n(row.refund_amount) >= MIN) rows.push(row); }
            if (os.length < 1000) break;
          }
          if (rows.length) { await sbRest("bigret_refunds?on_conflict=refund_code", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) }); saved += rows.length; }
          // 이 구간(반품 요청일)의 네이버페이 저장분 중 이번에 안 나온 것은 지운다(구간 전체를 다시 읽었으므로 — 반품이 철회됐거나 30만 원 아래로 바뀐 것)
          const keep = new Set(rows.map((x) => String(x.refund_code)));
          const stored = (((await sbRest(`bigret_refunds?source=eq.naver&accepted_at=gte.${curN}T00:00:00%2B09:00&accepted_at=lte.${end}T23:59:59%2B09:00&select=refund_code`)) ?? []) as Record<string, any>[]).map((x) => String(x.refund_code));
          const gone = stored.filter((c) => !keep.has(c));
          for (let i = 0; i < gone.length; i += 100) {
            const list = gone.slice(i, i + 100).map((c) => '"' + c.replace(/"/g, "") + '"').join(",");
            await sbRest(`bigret_refunds?refund_code=in.(${encodeURIComponent(list)})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
          }
          windows++;
          st.naver_until = !st.naver_until || end > st.naver_until ? end : st.naver_until;
          st.updated_at = new Date().toISOString();
          await sbRest("bigret_sync?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ naver_until: st.naver_until, updated_at: st.updated_at }) });
          curN = addD(end, 1);
        }
      }
      const all = (((await sbRest("bigret_refunds?select=*&order=accepted_at.desc&limit=20000")) ?? []) as Record<string, any>[]);
      // 같은 고객 묶기(2026-10-20 밤): 휴대전화 번호가 있으면 번호로(회원 주문·비회원 주문·네이버페이 주문이 섞여도 한 사람), 없으면 customer_key(회원 ID 또는 이름)
      const gkey = (r: Record<string, any>) => { const ph = String(r.buyer_phone ?? "").replace(/\D/g, ""); return ph.length >= 9 ? "t:" + ph : String(r.customer_key); };
      const cnt = new Map<string, number>();
      for (const r of all) cnt.set(gkey(r), (cnt.get(gkey(r)) ?? 0) + 1);
      const rows = all.filter((r) => n(r.refund_amount) >= ALWAYS || (cnt.get(gkey(r)) ?? 0) >= 2).map((r) => ({ ...r, group_key: gkey(r), count: cnt.get(gkey(r)) ?? 1 }));
      const done = !!st.synced_until && st.synced_until >= today && !!st.naver_until && st.naver_until >= today;
      const until = [st.synced_until, st.naver_until].filter(Boolean).sort()[0] ?? null;   // 둘(카페24 환불·네이버페이 반품) 중 덜 읽은 쪽
      return json({
        rows, stored: all.length, naver_stored: all.filter((r) => r.source === "naver").length, customers: cnt.size, repeat_customers: [...cnt.values()].filter((v) => v >= 2).length,
        sync: { done, from: st.backfill_from, until, cafe24_until: st.synced_until, naver_until: st.naver_until, today, windows, scanned, saved, ms: Date.now() - t0 },
        rule: { min: MIN, always: ALWAYS },
      });
    }

    // ── 특별 관리 회원 / 불량회원 (고액 반품 관리의 소메뉴, 2026-10-20 사용자 요청 "특별 관리 회원으로 설정된 사람만 볼 수 있는 소메뉴") ──
    //   ① mode "privacy": 카페24 '회원 개인정보 목록 조회' GET /admin/customersprivacy?member_type=vip(특별관리회원) — scope mall.read_privacy. **이 권한은 카페24가 사업자등록·개인정보 서약서
    //      심사 뒤에만 열어 준다**(2026-10-20 실측: 개발자센터 권한 목록에 '개인정보(Privacy)' 항목이 없어 invalid_scope). 권한이 생기면 자동으로 이 모드.
    //   ② mode "customer"(지금): '회원 읽기' GET /admin/customers?member_id=a,b,c(scope mall.read_customer, 개발자센터 '회원(Customer) 읽기권한')로 고액 반품 저장분의 회원들을
    //      ID로 찾아 불량회원 설정(use_blacklist T, blacklist_type P 구매 차단/L 로그인 차단)을 붙인다 — 이름·휴대전화는 우리 저장분에서. 둘 다 권한이 없으면 { error:"scope_missing" }(200, 캐시 안 함).
    //   결과에 우리 고액 반품 누적(회원 ID 또는 휴대전화 번호 일치)을 붙인다.
    if (action === "bigret_special") {
      if (!["admin", "staff", "cs"].includes(authed.role)) return json({ error: "접근 권한이 없습니다" }, 403);
      const cached = await fromCache(); if (cached) return json(cached);
      const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
      const scopeErr = (e: unknown) => /scope|permission|403|insufficient/i.test(String((e as Error)?.message ?? e));
      const refs = (((await sbRest("bigret_refunds?select=member_id,buyer_name,buyer_phone,refund_amount,accepted_at,order_id,source&order=accepted_at.desc&limit=20000")) ?? []) as Record<string, any>[]);
      const byKey = new Map<string, Record<string, any>[]>();
      const add = (k: string, r: Record<string, any>) => { if (!k) return; const l = byKey.get(k) ?? []; l.push(r); byKey.set(k, l); };
      for (const r of refs) { if (r.member_id) add("m:" + r.member_id, r); const ph = digits(r.buyer_phone); if (ph.length >= 9) add("t:" + ph, r); }
      const pick = (c: Record<string, any>) => ({ use_blacklist: String(c.use_blacklist ?? ""), blacklist_type: String(c.blacklist_type ?? ""), group_no: c.group_no ?? null, created_date: c.created_date ?? null, last_login_date: c.last_login_date ?? null });
      let mode = "privacy";
      const members: Record<string, any>[] = [];
      try {
        for (let offset = 0; offset <= 8000; offset += 100) {
          const body = await apiGet(`${API_BASE}/admin/customersprivacy?shop_no=1&member_type=vip&limit=100&offset=${offset}`, token);
          const list = (body.customersprivacy ?? []) as Record<string, any>[];
          for (const c of list) members.push({ member_id: String(c.member_id ?? ""), name: String(c.name ?? ""), cellphone: String(c.cellphone ?? ""), special: true, ...pick(c) });
          if (list.length < 100) break;
        }
      } catch (e) { if (!scopeErr(e)) throw e; mode = "customer"; }
      if (mode === "customer") {
        const ids = [...new Set(refs.map((r) => String(r.member_id ?? "").trim()).filter(Boolean))];
        const info = new Map<string, Record<string, any>>();
        try {
          for (let i = 0; i < ids.length; i += 50) {
            const body = await apiGet(`${API_BASE}/admin/customers?shop_no=1&member_id=${ids.slice(i, i + 50).map(encodeURIComponent).join(",")}`, token);
            for (const c of (body.customers ?? []) as Record<string, any>[]) info.set(String(c.member_id ?? ""), c);
          }
        } catch (e) {
          if (scopeErr(e)) return json({ error: "scope_missing", detail: String((e as Error)?.message ?? e).slice(0, 200) });
          throw e;
        }
        for (const id of ids) {
          const c = info.get(id); if (!c) continue;
          const r0 = refs.find((r) => String(r.member_id ?? "").trim() === id) ?? {};
          members.push({ member_id: id, name: String(r0.buyer_name ?? ""), cellphone: String(r0.buyer_phone ?? ""), special: null, ...pick(c) });
        }
      }
      const n0 = (v: unknown) => Math.round(Number(v ?? 0) || 0);
      const out = members.map((m) => {
        const seen = new Set<string>(), hits: Record<string, any>[] = [];
        for (const r of [...(byKey.get("m:" + m.member_id) ?? []), ...(byKey.get("t:" + digits(m.cellphone)) ?? [])]) { const k = String(r.order_id) + "|" + String(r.source); if (!seen.has(k)) { seen.add(k); hits.push(r); } }
        return { ...m, bigret_count: hits.length, bigret_total: hits.reduce((a, r) => a + n0(r.refund_amount), 0), bigret_last: hits.map((r) => String(r.accepted_at ?? "")).sort().pop() || null };
      });
      return await respond({ mode, members: out, count: out.length, blacklisted: out.filter((m) => m.use_blacklist === "T").length, at: new Date().toISOString() });
    }

    if (action === "refundpend_list" || action === "refundpend_run") {
      if (authed.role !== "admin" || viaAgent || viaCron || viaSecret) return json({ error: "환불완료 처리는 관리자만 할 수 있어요" }, 403);
      const RF_AUTO = new Set(["card", "tcash", "prepaid"]);
      const rfNum = (v: unknown) => Math.round(Number(v ?? 0) || 0);
      const rfMethods = (r: Record<string, any>) => ((r.refund_payment_methods ?? []) as unknown[]).map(String);
      const rfDay = (off: number) => { const d = rscanYesterday(); d.setUTCDate(d.getUTCDate() + 1 + off); return d.toISOString().slice(0, 10); };
      const rfRow = (r: Record<string, any>, o: Record<string, any> | null) => {
        const codes = ((r.order_item_code ?? []) as unknown[]).map(String);
        const its = ((o?.items ?? []) as Record<string, any>[]).filter((it) => codes.includes(String(it.order_item_code)));
        const st = its.map((it) => String(it.order_status ?? ""));
        const kind = st.length && st.every((x) => x.startsWith("R")) ? "return" : st.length && st.every((x) => x.startsWith("C")) ? "cancel" : st.length ? "mixed" : "unknown";
        const methods = rfMethods(r), amount = rfNum(r.actual_refund_amount), points = rfNum(r.used_points), credits = rfNum(r.used_credits);
        const naver = !!o && (o.order_place_id === "NCHECKOUT" || o.market_id === "NCHECKOUT");
        const why: string[] = [];
        let group = "auto";
        if (methods.includes("cash")) group = "cash";
        else {
          if (!o) why.push("주문을 읽지 못했어요");
          if (naver) why.push("네이버페이 주문이에요");
          if (!methods.length) why.push("환불 수단이 비어 있어요");
          const other = methods.filter((m) => !RF_AUTO.has(m));
          if (other.length) why.push(`자동으로 다루지 않는 환불 수단(${other.join(", ")})`);
          if (credits > 0) why.push(`예치금 ${credits.toLocaleString("ko-KR")}원이 섞여 있어요`);
          if (amount <= 0) why.push("환불 금액이 0원이에요");
          if (kind === "mixed" || kind === "unknown") why.push("취소·반품 구분이 섞였거나 읽히지 않아요");
          if (its.some((it) => rfNum(it.app_item_discount_amount) > 0)) why.push("할인코드가 적용된 상품이에요 — 할인 반영을 직접 확인");   // 2026-10-20 사용자 지정
          // 상품 상태가 '취소처리중·환불전'(C34) 또는 '반품처리중·환불전'(R34 — 수거 완료)일 때만. 반품이 아직 수거 전(R30 등)이면 돈만 먼저 나가므로 자동에서 뺀다
          if (st.length && !st.every((x) => x === "C34" || x === "R34")) why.push(`상품 상태가 환불전이 아니에요(${[...new Set(its.map((it) => String(it.status_text ?? it.order_status ?? "") + (it.order_status_additional_info ? "·" + it.order_status_additional_info : "")))].join(", ")})`);
          if (why.length) group = "check";
        }
        return {
          refund_code: String(r.refund_code ?? ""), order_id: String(r.order_id ?? ""), accepted_at: String(r.accepted_refund_date ?? ""), order_date: String(r.order_date ?? ""),
          amount, points, credits, methods, refund_methods: ((r.refund_methods ?? []) as unknown[]).map(String), pay_methods: ((r.payment_methods ?? []) as unknown[]).map(String),
          kind, naver, buyer: String(o?.buyer_name ?? ""), group, why,
          items: its.map((it) => ({ code: String(it.order_item_code), product_name: String(it.product_name ?? ""), option: String(it.option_value ?? ""), qty: rfNum(it.quantity), status: String(it.status_text ?? it.order_status ?? "") })),
          bank: group === "cash" ? { name: String(r.refund_bank_name ?? ""), holder: String(r.refund_bank_account_holder ?? ""), account: String(r.refund_bank_account_no ?? "") } : null,
        };
      };
      const rfOrders = async (ids: string[], embed = "items") => {
        const m = new Map<string, Record<string, any>>();
        for (let i = 0; i < ids.length; i += 50) {
          const body = await apiGet(`${API_BASE}/admin/orders?shop_no=1&order_id=${ids.slice(i, i + 50).join(",")}&embed=${embed}&limit=100`, token);
          for (const o of (body.orders ?? []) as Record<string, any>[]) m.set(String(o.order_id), o);
        }
        return m;
      };
      const rfOrderRefunds = async (ids: string[]) => {
        const m = new Map<string, Record<string, any>[]>();
        if (!ids.length) return m;
        const first = ids.map((id) => id.slice(0, 4) + "-" + id.slice(4, 6) + "-" + id.slice(6, 8)).sort()[0];
        const today = rfDay(0), seen = new Set<string>();
        for (let s0 = new Date(first + "T00:00:00Z"); s0.toISOString().slice(0, 10) <= today; s0.setUTCDate(s0.getUTCDate() + 89)) {
          const e0 = new Date(s0); e0.setUTCDate(e0.getUTCDate() + 88);
          const st = s0.toISOString().slice(0, 10), en = e0.toISOString().slice(0, 10) > today ? today : e0.toISOString().slice(0, 10);
          for (let i = 0; i < ids.length; i += 20) {
            for (let offset = 0; offset < 1000; offset += 100) {
              const body = await apiGet(`${API_BASE}/admin/refunds?start_date=${st}&end_date=${en}&date_type=accepted_refund_date&order_id=${ids.slice(i, i + 20).join(",")}&limit=100&offset=${offset}`, token);
              const rs = (body.refunds ?? []) as Record<string, any>[];
              for (const x of rs) { const k = String(x.refund_code); if (seen.has(k)) continue; seen.add(k); const l = m.get(String(x.order_id)) ?? []; l.push(x); m.set(String(x.order_id), l); }
              if (rs.length < 100) break;
            }
          }
        }
        return m;
      };
      // 안전장치를 행에 붙인다: block → '직접 확인'으로(보낼 수 없음), ack → 규칙 점검 칸에 빨간 줄 + 보낼 때 한 번 더 확인(need_ack)
      const rfApplyGuard = (row: Record<string, any>, rule: Record<string, any> | null, guard: ReturnType<typeof rfGuardOf> | null) => {
        if (guard) {
          if (guard.block.length && row.group !== "cash") { row.group = "check"; row.why = [...guard.block, ...row.why]; }
          if (guard.block.length && row.group === "cash") row.cash_block = guard.block;
          if (rule && guard.ack.length) { rule.level = "warn"; rule.issues = [...guard.ack.map((text) => ({ level: "warn", tag: "상품 값보다 많은 환불", text })), ...rule.issues]; }
        }
        row.paid = guard ? guard.paid : 0;
        row.need_ack = !guard || !rule || !!guard.ack.length || rule.level === "warn" || rule.level === "note";
        return row;
      };
      if (action === "refundpend_list") {
        const all: Record<string, any>[] = [];
        for (let back = 0; back < 180; back += 60) {
          const end = rfDay(-back), start = rfDay(-back - 59);
          for (let offset = 0; offset < 3000; offset += 100) {
            const body = await apiGet(`${API_BASE}/admin/refunds?start_date=${start}&end_date=${end}&date_type=accepted_refund_date&refund_status=F&limit=100&offset=${offset}`, token);
            const rs = (body.refunds ?? []) as Record<string, any>[];
            all.push(...rs);
            if (rs.length < 100) break;
          }
        }
        const seen = new Set<string>(), uniq = all.filter((r) => { const k = String(r.refund_code); if (seen.has(k)) return false; seen.add(k); return true; });
        const orders = await rfOrders([...new Set(uniq.map((r) => String(r.order_id)))], "items,return,cancellation");
        // 규칙 점검(2026-10-15 사용자 요청) — 접수된 금액이 우리 취소·반품 규칙과 맞는지. 못 읽으면 rule:null(목록은 그대로)
        const nrSets = await rscanNrSets(token).catch(() => null);
        const cp = nrSets ? await retCouponInfo([...orders.values()], token).catch(() => null) : null;
        const oref = await rfOrderRefunds([...orders.keys()]).catch(() => null);
        const ruleOf = (r: Record<string, any>) => { if (!nrSets || !cp) return null; try { return rfRuleOf(r, orders.get(String(r.order_id)) ?? null, nrSets, cp, oref?.get(String(r.order_id)) ?? uniq.filter((x) => String(x.order_id) === String(r.order_id))); } catch { return null; } };
        const guardOf = (r: Record<string, any>) => oref ? rfGuardOf(r, orders.get(String(r.order_id)) ?? null, oref.get(String(r.order_id)) ?? [r]) : null;
        const rows = uniq.map((r) => { const rule = ruleOf(r); return { ...rfApplyGuard(rfRow(r, orders.get(String(r.order_id)) ?? null) as Record<string, any>, rule, guardOf(r)), rule }; }).sort((a, b) => String(a.accepted_at).localeCompare(String(b.accepted_at)));
        return json({ fetched_at: new Date().toISOString(), rows });
      }
      // ── 한 건 처리 ──
      if (req.method !== "POST") return json({ error: "POST로 호출해주세요" }, 405);
      const b = await req.json().catch(() => ({})) as Record<string, any>;
      const orderId = String(b.order_id ?? ""), code = String(b.refund_code ?? ""), acc = String(b.accepted_at ?? "").slice(0, 10);
      if (!/^\d{8}-\d{7}$/.test(orderId) || !/^[A-Z]\d{8}-\d{7}$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(acc)) return json({ error: "주문번호·환불번호가 올바르지 않습니다" }, 400);
      const expectAmount = Number(b.expect_amount);
      if (!Number.isInteger(expectAmount) || expectAmount <= 0) return json({ error: "환불 금액이 올바르지 않습니다" }, 400);
      // 환불 접수일 앞뒤로만 찾는다(카페24 조회 기간 제한·같은 주소 60초 캐시를 피하려고 화면 목록과 다른 주소)
      const accD = new Date(acc + "T00:00:00Z"); const from = new Date(accD); from.setUTCDate(from.getUTCDate() - 1); const to = new Date(accD); to.setUTCDate(to.getUTCDate() + 60);
      const today = rfDay(0), toS = to.toISOString().slice(0, 10) > today ? today : to.toISOString().slice(0, 10);
      const findRefund = async (status: "F" | "T") => {
        const body = await apiGet(`${API_BASE}/admin/refunds?start_date=${from.toISOString().slice(0, 10)}&end_date=${toS}&date_type=accepted_refund_date&order_id=${orderId}&refund_status=${status}&limit=100`, token);
        return (((body.refunds ?? []) as Record<string, any>[]).find((r) => String(r.refund_code) === code)) ?? null;
      };
      const readOrder = async () => ((await apiGet(`${API_BASE}/admin/orders/${orderId}?embed=items,return,cancellation`, token)).order ?? null) as Record<string, any> | null;
      let rf: Record<string, any> | null, order: Record<string, any> | null;
      try { [rf, order] = await Promise.all([findRefund("F"), readOrder()]); } catch (e) { return json({ error: "카페24에서 환불 내역을 읽지 못했어요 — " + String(e).slice(0, 200) }, 502); }
      if (!rf) {
        const done0 = await findRefund("T").catch(() => null);
        if (done0) return json({ ok: true, already: true, refund_amount: rfNum(done0.actual_refund_amount) });
        return json({ error: "카페24 환불전 목록에 이 환불이 없어요(그 사이 처리됐거나 바뀜) — 새로고침해 주세요", stale: true }, 409);
      }
      const row = rfRow(rf, order);
      const logRow = (ok: boolean, result: string, extra: Record<string, unknown> = {}) => sbRest("cancel_accept_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
        kind: "refund", order_id: orderId, claim_code: code, items: row.items.map((x) => ({ code: x.code, product_name: x.product_name, option: x.option, qty: x.qty })),
        reason_type: null, reason_label: row.kind === "return" ? "반품 환불" : row.kind === "cancel" ? "취소 환불" : "환불", reason: null, ok, result: String(result).slice(0, 500),
        expected_amount: expectAmount, points: row.points, by_id: authed.id, by_name: authed.name, ...extra }) }).catch(() => null);
      if (row.group !== "auto") return json({ error: row.group === "cash" ? "무통장(현금 환불)은 직접 입금한 뒤 카페24에서 완료해 주세요" : "직접 확인이 필요한 환불이에요 — " + row.why.join(" / "), blocked: true }, 400);
      if (row.amount !== expectAmount) return json({ error: `화면의 환불 금액(${expectAmount.toLocaleString("ko-KR")}원)과 카페24의 지금 금액(${row.amount.toLocaleString("ko-KR")}원)이 달라요 — 새로고침한 뒤 다시 확인해주세요`, stale: true }, 409);
      if (b.expect_points !== undefined && Number(b.expect_points) !== row.points) return json({ error: `화면의 적립금 반환(${Number(b.expect_points).toLocaleString("ko-KR")}원)과 카페24의 지금 값(${row.points.toLocaleString("ko-KR")}원)이 달라요 — 새로고침해 주세요`, stale: true }, 409);
      // ── 안전장치(2026-10-15 사용자 요청): 보내기 직전, 카페24에서 새로 읽은 값으로 ──
      //  ① 결제액 한도(절대 금지 — 넘길 방법 없음) ② 상품 값보다 많은 환불·규칙과 다름·규칙 계산 불가 → 화면이 사람에게 따로 확인받고 ack:true를 보낸 경우만
      let guard: ReturnType<typeof rfGuardOf>, rule: Record<string, any> | null = null, oref: Record<string, any>[] = [];
      try {
        oref = (await rfOrderRefunds([orderId])).get(orderId) ?? [];
        if (!oref.some((x) => String(x.refund_code) === code)) oref.push(rf);
        guard = rfGuardOf(rf, order, oref);
      } catch (e) { return json({ error: "이 주문의 환불 내역을 읽지 못해 금액 한도를 확인할 수 없어요 — 보내지 않았어요 (" + String(e).slice(0, 150) + ")" }, 502); }
      if (guard.block.length) return json({ error: "안전장치가 막았어요(보내지 않음) — " + guard.block.join(" / "), blocked: true }, 400);
      try {
        const nrSets = await rscanNrSets(token);
        const cp = await retCouponInfo([order as Record<string, any>], token);
        rule = rfRuleOf(rf, order, nrSets, cp, oref);
      } catch { rule = null; }
      const ackWhy = [...guard.ack, ...(!rule ? ["규칙 점검을 하지 못했어요"] : rule.level === "warn" || rule.level === "note" ? (rule.issues as { text: string }[]).map((x) => x.text) : [])];
      // 검사만(dry): 안전장치 결과만 돌려주고 끝 — 카페24에 아무것도 보내지 않는다(점검·시험용)
      if (b.dry === true) return json({ ok: true, dry: true, would_send: !ackWhy.length || b.ack === true, need_ack: ackWhy.length > 0, reasons: ackWhy, paid: guard.paid, prior: guard.prior, me: guard.me, items_net: guard.items_net, rule_level: rule ? rule.level : null });
      if (ackWhy.length && b.ack !== true) return json({ error: "한 번 더 확인이 필요한 환불이에요(보내지 않음) — " + ackWhy.join(" / "), need_ack: true, reasons: ackWhy }, 409);
      // 안전장치: 사람별 1시간 300건 · 전체 하루 1,000건 (취소·반품 접수 기록과 합산)
      const sinceIso = (ms: number) => new Date(Date.now() - ms).toISOString();
      const mine = ((await sbRest(`cancel_accept_log?select=id&by_id=eq.${encodeURIComponent(authed.id)}&created_at=gte.${sinceIso(3600e3)}&limit=500`)) ?? []) as unknown[];
      const allDay = ((await sbRest(`cancel_accept_log?select=id&created_at=gte.${sinceIso(24 * 3600e3)}&limit=1500`)) ?? []) as unknown[];
      if (mine.length >= 300 || allDay.length >= 1000) return json({ error: "처리 한도를 넘었어요 — 잠시 뒤 다시 시도해주세요" }, 429);
      const won = (v: number) => v.toLocaleString("ko-KR") + "원";
      const detail: Record<string, unknown> = { stage: "refund_done", refund_code: code, methods: row.methods, kind: row.kind, paid: guard.paid, prior: guard.prior, items_net: guard.items_net, acked: ackWhy.length ? ackWhy : undefined };
      try { await cafe24CompleteRefund(orderId, code, token); }
      catch (e) {
        const st = (e as { status?: number }).status ?? 0, raw = String((e as Error).message ?? e);
        await logRow(false, "환불완료 처리 실패 — " + raw, { detail });
        return json({ error: "카페24가 환불완료 처리를 받지 않았어요(환불전 그대로) — " + (st === 403 || /scope|permission|insufficient/i.test(raw) ? "카페24 앱에 '주문 쓰기' 권한이 없어요" : raw.slice(0, 300)) }, 502);
      }
      let done: Record<string, any> | null = null;
      for (let i = 0; i < 4 && !done; i++) { await sleep(i ? 1500 : 800); try { done = await findRefund("T"); } catch { done = null; } }
      const pgList = ((done?.payment_gateway_cancel_statuses ?? []) as Record<string, any>[]);
      const pg = pgList.map((x) => `${x.payment_method}:${x.cancel_status}`);
      // PG 취소 상태: T = 전체 취소 완료, M = 부분 취소 완료(환불액이 결제액보다 적을 때 — 반품 배송비 차감·부분 반품 등). 둘 다 정상.
      // (2026-10-15 첫 실사용: 반품 2건이 M으로 정상 환불됐는데 T만 보고 '확인 실패'로 멈췄음. 지난 60일 환불완료 3,235건 중 M 1,959건 — 전부 환불액 < 결제액)
      const pgOk = !!done && pgList.length > 0 && pgList.every((x) => x.cancel_status === "T" || x.cancel_status === "M");
      const finalAmt = done ? rfNum(done.actual_refund_amount) : NaN;
      Object.assign(detail, { pg });
      if (!done || !pgOk || finalAmt !== expectAmount) {
        const why = !done ? "환불완료로 바뀐 것을 확인하지 못했어요" : !pgOk ? `PG 결제취소가 확인되지 않아요(${pg.join(", ") || "상태 없음"})` : `환불완료 금액이 달라요(${won(finalAmt)})`;
        await logRow(false, "환불완료를 보냈지만 확인 실패 — " + why, { refund_amount: isFinite(finalAmt) ? finalAmt : null, detail });
        return json({ error: `환불완료 처리를 보냈지만 ${why} — 카페24 환불 관리와 PG사에서 이 주문을 꼭 확인해주세요`, critical: true }, 502);
      }
      const pgPart = pgList.some((x) => x.cancel_status === "M");
      await logRow(true, `환불완료 · ${won(finalAmt)}${row.points ? ` · 적립금 반환 ${won(row.points)}` : ""} · PG ${pgPart ? "부분 취소" : "취소"} 확인`, { refund_amount: finalAmt, detail });
      return json({ ok: true, refund_amount: finalAmt, points: row.points, pg });
    }

    if (action === "selfcancel_list" || action === "selfcancel_run") {
      if (!(await cxlRoleOk(authed))) return json({ error: "접근 권한이 없습니다" }, 403);   // 관리자 + 허용 목록(cxl_users) — 단 최종 환불은 아래에서 관리자만
      const nrSets = await rscanNrSets(token).catch(() => null);
      if (!nrSets) return json({ error: "상품 카테고리(1+1 여부)를 읽지 못했어요 — 잠시 뒤 다시 시도해주세요" }, 502);
      if (action === "selfcancel_list") {
        const end = rscanYesterday(); end.setUTCDate(end.getUTCDate() + 1);   // 한국 날짜 오늘
        const start = new Date(end); start.setUTCDate(start.getUTCDate() - 89);
        const fmtD = (d: Date) => d.toISOString().slice(0, 10);
        const groups: Record<string, any>[] = [];
        for (let offset = 0; offset < 5000; offset += 200) {
          const body = await apiGet(`${API_BASE}/admin/orders?start_date=${fmtD(start)}&end_date=${fmtD(end)}&date_type=order_date&order_status=C10&embed=items,cancellation&limit=200&offset=${offset}`, token);
          const orders = (body.orders ?? []) as Record<string, any>[];
          for (const o of orders) groups.push(...selfGroupsOf(o, nrSets));
          if (orders.length < 200) break;
        }
        groups.sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)));
        return json({ today: fmtD(end), fetched_at: new Date().toISOString(), groups });
      }
      if (req.method !== "POST") return json({ error: "POST로 호출해주세요" }, 405);
      if (viaAgent || viaCron || viaSecret) return json({ error: "이 기능은 로그인한 사람만 쓸 수 있습니다" }, 403);
      const orderId = String(url.searchParams.get("order_id") ?? ""), claimCode = String(url.searchParams.get("claim_code") ?? "");
      if (!/^\d{8}-\d{7}$/.test(orderId) || !/^C\d{8}-\d{7}$/.test(claimCode)) return json({ error: "주문번호·접수번호가 올바르지 않습니다" }, 400);
      const b = await req.json().catch(() => ({})) as Record<string, any>;
      // 최종 환불(환불완료·PG 결제취소)은 관리자만 (2026-10-08 사용자 지정) — 허용 목록의 직원은 '환불전으로 넘기기'까지. 카페24에 아무것도 보내기 전에 거절한다.
      if (b.refund === true && authed.role !== "admin") return json({ error: "최종 환불까지 진행은 관리자만 할 수 있어요 — '환불전으로 넘기기'까지만 할 수 있어요", blocked: true }, 403);
      const readOrder = async () => ((await apiGet(`${API_BASE}/admin/orders/${orderId}?embed=items,cancellation`, token)).order ?? {}) as Record<string, any>;
      const claimItems = (o: Record<string, any>) => ((o.items ?? []) as Record<string, any>[]).filter((it) => String(it.claim_code ?? "") === claimCode);
      const stateOf = (o: Record<string, any>) => [...new Set(claimItems(o).map((it) => String(it.status_text ?? it.order_status ?? "")))].join(", ");
      let order: Record<string, any>;
      try { order = await readOrder(); } catch (e) { return json({ error: "카페24에서 주문을 읽지 못했어요 — " + String(e).slice(0, 200) }, 502); }
      const g = selfGroupsOf(order, nrSets).find((x) => x.claim_code === claimCode);
      if (!g) {
        const its = claimItems(order);
        if (its.length && its.every((it) => String(it.order_status ?? "") === "C40")) return json({ ok: true, already: true, status: stateOf(order) });
        return json({ error: `그 사이 주문 상태가 바뀌었어요(${stateOf(order) || "접수 없음"}) — 새로고침한 뒤 다시 확인해주세요`, stale: true }, 409);
      }
      if ((g.manual as { text: string }[]).length) return json({ error: "직접 확인이 필요한 주문이에요 — " + (g.manual as { text: string }[]).map((m) => m.text).join(" / "), blocked: true }, 400);
      const expect = g.expect as { amount: number; points: number };
      // 화면에 보여 준 환불 예정액과 지금 다시 계산한 값이 같아야 한다(사람이 본 금액 = 처리하는 금액)
      if (Number(b.expect_amount) !== expect.amount || Number(b.expect_points) !== expect.points) return json({ error: "화면의 환불 예정액과 지금 계산한 금액이 달라요 — 새로고침한 뒤 다시 확인해주세요", stale: true }, 409);
      const won = (v: number) => v.toLocaleString("ko-KR") + "원";
      const logRow = (ok: boolean, result: string, extra: Record<string, unknown> = {}) => sbRest("cancel_accept_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
        kind: "self", order_id: orderId, claim_code: claimCode, items: (g.items as Record<string, any>[]).map((x) => ({ code: x.code, product_name: x.product_name, option: x.option, qty: x.qty })),
        reason_type: g.reason_type || null, reason_label: null, reason: g.reason || null, ok, result: String(result).slice(0, 500), expected_amount: expect.amount, points: expect.points,
        by_id: authed.id, by_name: authed.name, ...extra }) }).catch(() => null);
      // 안전장치: 사람별 1시간 300건 · 전체 하루 1,000건 (성공·실패 모두 셈)
      const sinceIso = (ms: number) => new Date(Date.now() - ms).toISOString();
      const mine = ((await sbRest(`cancel_accept_log?select=id&by_id=eq.${encodeURIComponent(authed.id)}&created_at=gte.${sinceIso(3600e3)}&limit=500`)) ?? []) as unknown[];
      const allDay = ((await sbRest(`cancel_accept_log?select=id&created_at=gte.${sinceIso(24 * 3600e3)}&limit=1500`)) ?? []) as unknown[];
      if (mine.length >= 300 || allDay.length >= 1000) return json({ error: "취소 처리 한도를 넘었어요 — 잠시 뒤 다시 시도해주세요" }, 429);
      const errText = (e: unknown) => { const st = (e as { status?: number }).status ?? 0, raw = String((e as Error).message ?? e); return { st, raw, msg: st === 403 || /scope|permission|insufficient/i.test(raw) ? "카페24 앱에 '주문 쓰기' 권한이 없어요 — '카페24 연동'으로 다시 연동해주세요" : raw.slice(0, 300) }; };
      // ② 취소처리중(환불전)으로 — 카페24가 환불액을 계산한다
      const refundCode = SELF_REFUND_CODE[String(g.main)];
      if (!refundCode) return json({ error: "이 결제 수단은 아직 자동 환불 대상이 아니에요", blocked: true }, 400);
      try { await cafe24CancelToRefunding(orderId, claimCode, g.recover as "T" | "F", refundCode, token); }
      catch (e) { const x = errText(e); await logRow(false, "취소처리중으로 넘기지 못함 — " + x.raw); return json({ error: "카페24가 '취소처리중'으로 넘기지 않았어요(주문은 취소접수 그대로) — " + x.msg, step: "A" }, 502); }
      // 카페24가 계산한 환불 내역 읽기 (반영이 조금 늦을 수 있어 5번까지)
      const want = (g.items as Record<string, any>[]).map((x) => String(x.code)).sort().join(",");
      const dayStr = (off: number) => { const d = rscanYesterday(); d.setUTCDate(d.getUTCDate() + 1 + off); return d.toISOString().slice(0, 10); };
      const findRefund = async (status: "F" | "T") => {
        const body = await apiGet(`${API_BASE}/admin/refunds?start_date=${dayStr(-1)}&end_date=${dayStr(0)}&date_type=accepted_refund_date&order_id=${orderId}&refund_status=${status}&limit=100`, token);
        return (((body.refunds ?? []) as Record<string, any>[]).find((r) => [...((r.order_item_code ?? []) as unknown[])].map(String).sort().join(",") === want)) ?? null;
      };
      let rf: Record<string, any> | null = null;
      for (let i = 0; i < 5 && !rf; i++) { await sleep(i ? 1200 : 500); try { rf = await findRefund("F"); } catch { rf = null; } }
      const leftMsg = "주문은 '취소처리중(환불전)'에 남아 있어요 — 카페24 환불 관리에서 금액을 확인하고 직접 마무리해주세요";
      // 2026-10-05 사용자 지정: **기본은 '취소처리중(환불전)'으로 넘기기까지만.** 환불완료(PG 결제취소)는 화면에서 '최종 환불까지 한 번에 진행'을 켠 요청(refund:true)만.
      const fullRefund = b.refund === true;
      if (!rf) {
        if (!fullRefund) { await logRow(true, "취소처리중(환불전)으로 넘김 · 카페24 환불 내역은 아직 읽지 못함", { detail: { stage: "moved", pay: g.pay, recover_inventory: g.recover } }); return json({ ok: true, moved: true, warn: "넘기긴 했지만 카페24가 계산한 환불액을 아직 읽지 못했어요 — 카페24 환불 관리에서 금액을 확인해주세요" }); }
        await logRow(false, "취소처리중으로 넘겼지만 환불 내역을 읽지 못함 — 환불은 보내지 않음"); return json({ error: "취소처리중으로 넘겼지만 카페24의 환불 내역을 읽지 못했어요. 환불은 보내지 않았어요. " + leftMsg, step: "check", left: true }, 502);
      }
      const got = { amount: Math.round(Number(rf.actual_refund_amount ?? NaN)), points: Math.round(Number(rf.used_points ?? 0) || 0), credits: Math.round(Number(rf.used_credits ?? 0) || 0),
        methods: ((rf.refund_payment_methods ?? []) as unknown[]).map(String), code: String(rf.refund_code ?? "") };
      const detail: Record<string, unknown> = { pay: g.pay, refund_methods: got.methods, refund_code: got.code, cafe24_points: got.points, recover_inventory: g.recover };
      // ── 금액 확인: 원 단위까지 같고, 환불 수단이 결제 수단과 같아야만 환불을 끝낸다 ──
      const diffs: string[] = [];
      if (got.amount !== expect.amount) diffs.push(`환불액이 달라요(카페24 ${isFinite(got.amount) ? won(got.amount) : "읽지 못함"} · 예정 ${won(expect.amount)})`);
      if (got.points !== expect.points) diffs.push(`적립금 반환이 달라요(카페24 ${won(got.points)} · 예정 ${won(expect.points)})`);
      if (got.credits !== 0) diffs.push(`예치금 반환 ${won(got.credits)}이 있어요`);
      if (got.methods.length !== 1 || got.methods[0] !== g.main) diffs.push(`환불 수단이 결제 수단과 달라요(${got.methods.join("+") || "없음"} · 결제 ${g.main})`);
      if (!/^[A-Z]\d{8}-\d{7}$/.test(got.code)) diffs.push("환불 번호를 읽지 못했어요");
      if (!fullRefund) {
        // 넘기기까지만: 환불은 보내지 않는다. 카페24가 계산한 환불액이 예정과 같은지는 알려 준다(다르면 경고 — 환불 관리에서 금액 확인)
        Object.assign(detail, { stage: "moved" });
        if (diffs.length) {
          await logRow(true, "취소처리중(환불전)으로 넘김 · ⚠ 카페24 계산이 예정과 다름 — " + diffs.join(" / "), { refund_amount: isFinite(got.amount) ? got.amount : null, detail });
          return json({ ok: true, moved: true, warn: "넘기긴 했지만 카페24가 계산한 환불 내역이 예정과 달라요 — " + diffs.join(" / ") + ". 카페24 환불 관리에서 금액을 꼭 확인해주세요", cafe24_amount: isFinite(got.amount) ? got.amount : null });
        }
        await logRow(true, `취소처리중(환불전)으로 넘김 · 환불 예정 ${won(got.amount)}${expect.points ? ` · 적립금 반환 ${won(expect.points)}` : ""} (카페24 계산과 같음)`, { refund_amount: got.amount, detail });
        return json({ ok: true, moved: true, refund_amount: got.amount, points: expect.points });
      }
      Object.assign(detail, { stage: "refunded" });
      if (diffs.length) {
        await logRow(false, "금액 확인에서 멈춤 — " + diffs.join(" / ") + " · 환불은 보내지 않음", { refund_amount: isFinite(got.amount) ? got.amount : null, detail });
        return json({ error: "카페24가 계산한 환불 내역이 예정과 달라 환불을 보내지 않았어요 — " + diffs.join(" / ") + ". " + leftMsg, step: "check", left: true, mismatch: true }, 409);
      }
      // ③ 환불완료(PG 결제취소)
      try { await cafe24CompleteRefund(orderId, got.code, token); }
      catch (e) { const x = errText(e); await logRow(false, "환불완료 처리 실패 — " + x.raw, { refund_amount: got.amount, detail }); return json({ error: "카페24가 환불완료 처리를 받지 않았어요 — " + x.msg + ". " + leftMsg, step: "B", left: true }, 502); }
      // 재확인: 환불 상태·PG 취소 상태·주문 상태
      let done: Record<string, any> | null = null, after = "";
      for (let i = 0; i < 4 && !done; i++) { await sleep(i ? 1500 : 800); try { done = await findRefund("T"); } catch { done = null; } }
      try { after = stateOf(await readOrder()); } catch { /* 읽기 실패해도 아래에서 판단 */ }
      const pg = ((done?.payment_gateway_cancel_statuses ?? []) as Record<string, any>[]).map((x) => `${x.payment_method}:${x.cancel_status}`);
      const pgOk = !!done && pg.length > 0 && ((done.payment_gateway_cancel_statuses ?? []) as Record<string, any>[]).every((x) => x.cancel_status === "T");
      const finalAmt = done ? Math.round(Number(done.actual_refund_amount ?? NaN)) : NaN;
      Object.assign(detail, { pg, status_after: after });
      if (!done || !pgOk || finalAmt !== expect.amount) {
        const why = !done ? "환불완료로 바뀐 것을 확인하지 못했어요" : !pgOk ? `PG 결제취소가 확인되지 않아요(${pg.join(", ") || "상태 없음"})` : `환불완료 금액이 달라요(${won(finalAmt)})`;
        await logRow(false, "환불완료를 보냈지만 확인 실패 — " + why, { refund_amount: isFinite(finalAmt) ? finalAmt : got.amount, detail });
        return json({ error: `환불완료 처리를 보냈지만 ${why} — 카페24 환불 관리와 PG사에서 이 주문을 꼭 확인해주세요`, step: "verify", critical: true, status: after }, 502);
      }
      await logRow(true, `${after || "취소완료"} · 환불 ${won(finalAmt)}${expect.points ? ` · 적립금 반환 ${won(expect.points)}` : ""} · PG 취소 확인`, { refund_amount: finalAmt, detail });
      return json({ ok: true, status: after, refund_amount: finalAmt, points: expect.points, pg });
    }

    // ── 취소·반품 접수 3단계 — 자사몰 반품접수(R10) → 반품처리중(수거전) (2026-10-06 사용자 요청): 관리자 + 허용 목록(cxl_users). **서버는 카페24에 아무것도 쓰지 않는다.**
    //    retacc_list: 목록·분류·환불 예정액 계산(캐시 없음) / retacc_prepare(POST): 넘기기 직전 최신 주문으로 다시 계산해 연결 스크립트에 줄 작업(job)을 만든다
    //    (화면이 본 예정액과 다르면 409) / retacc_record(POST): 연결 스크립트가 끝난 뒤 주문을 다시 읽어 상태·금액을 확인하고 cancel_accept_log(kind 'ret')에 기록.
    if (action === "retacc_list" || action === "retacc_prepare" || action === "retacc_record") {
      if (!(await cxlRoleOk(authed))) return json({ error: "접근 권한이 없습니다" }, 403);   // 관리자 + 허용 목록(cxl_users)
      const nrSets = await rscanNrSets(token).catch(() => null);
      if (!nrSets) return json({ error: "상품 카테고리(1+1·ACC 여부)를 읽지 못했어요 — 잠시 뒤 다시 시도해주세요" }, 502);
      if (action === "retacc_list") {
        const end = rscanYesterday(); end.setUTCDate(end.getUTCDate() + 1);   // 한국 날짜 오늘
        const start = new Date(end); start.setUTCDate(start.getUTCDate() - 89);
        const fmtD = (d: Date) => d.toISOString().slice(0, 10);
        const orders: Record<string, any>[] = [];
        for (let offset = 0; offset < 5000; offset += 200) {
          const body = await apiGet(`${API_BASE}/admin/orders?start_date=${fmtD(start)}&end_date=${fmtD(end)}&date_type=order_date&order_status=R10&embed=items,return&limit=200&offset=${offset}`, token);
          const page = (body.orders ?? []) as Record<string, any>[];
          orders.push(...page);
          if (page.length < 200) break;
        }
        const cp = await retCouponInfo(orders, token);
        const groups: Record<string, any>[] = [];
        for (const o of orders) groups.push(...retGroupsOf(o, nrSets, cp));
        // 방금(30분 안) 넘긴 접수는 카페24 조회에 늦게 반영될 수 있어 '방금 처리함'으로 표시
        const recent = ((await sbRest(`cancel_accept_log?select=claim_code,created_at,by_name&kind=eq.ret&ok=is.true&created_at=gte.${new Date(Date.now() - 30 * 60 * 1000).toISOString()}&limit=1000`).catch(() => [])) ?? []) as Record<string, any>[];
        const recentMap = new Map(recent.map((r) => [String(r.claim_code ?? ""), { at: String(r.created_at ?? ""), by: String(r.by_name ?? "") }]));
        for (const g of groups) { const hit = recentMap.get(String(g.claim_code)); if (hit) g.just_done = hit; }
        groups.sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)));
        return json({ today: fmtD(end), fetched_at: new Date().toISOString(), groups });
      }
      if (req.method !== "POST") return json({ error: "POST로 호출해주세요" }, 405);
      if (viaAgent || viaCron || viaSecret) return json({ error: "이 기능은 로그인한 사람만 쓸 수 있습니다" }, 403);
      const orderId = String(url.searchParams.get("order_id") ?? ""), claimCode = String(url.searchParams.get("claim_code") ?? "");
      if (!/^\d{8}-\d{7}$/.test(orderId) || !/^C\d{8}-\d{7}$/.test(claimCode)) return json({ error: "주문번호·접수번호가 올바르지 않습니다" }, 400);
      const b = await req.json().catch(() => ({})) as Record<string, any>;
      // ⚠ 카페24는 **같은 조회 주소를 60초 동안 옛 결과로 돌려준다**(2026-10-07 실측: 두 번째 호출부터 cache-control max-age=60, 모르는 값(&_=1)은 구분에 안 쓰임).
      //   넘기기 직전(prepare)과 직후(record)에 같은 주소로 읽으면 직후 조회가 '반품접수' 그대로 나와 '반영 대기'로 잘못 멈춘다(첫 실사용에서 발생).
      //   → 주문 목록 조회에 limit 값을 매번 바꿔 붙여 늘 새로 읽는다(limit은 진짜 조건이라 구분에 쓰임). 주문일 = 주문번호 앞 8자리(앞뒤 하루 여유).
      const readOrder = async () => {
        const base = new Date(Date.UTC(Number(orderId.slice(0, 4)), Number(orderId.slice(4, 6)) - 1, Number(orderId.slice(6, 8))));
        const day = (off: number) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + off); return d.toISOString().slice(0, 10); };
        const lim = 10 + (Math.floor(Date.now() / 700) % 90);
        const list = ((await apiGet(`${API_BASE}/admin/orders?shop_no=1&order_id=${orderId}&start_date=${day(-1)}&end_date=${day(1)}&date_type=order_date&embed=items,return&limit=${lim}`, token)).orders ?? []) as Record<string, any>[];
        const hit = list.find((o) => String(o.order_id ?? "") === orderId);
        if (!hit) throw new Error("주문을 찾지 못했어요");
        return hit;
      };
      const claimItems = (o: Record<string, any>) => ((o.items ?? []) as Record<string, any>[]).filter((it) => String(it.claim_code ?? "") === claimCode);
      const stateOf = (o: Record<string, any>) => [...new Set(claimItems(o).map((it) => [String(it.status_text ?? it.order_status ?? ""), String(it.order_status_additional_info ?? "")].filter(Boolean).join(" · ")))].join(", ");
      const movedAll = (o: Record<string, any>) => { const its = claimItems(o); return its.length > 0 && its.every((it) => RET_MOVED.has(String(it.order_status ?? ""))); };
      const num = (v: unknown) => Math.round(Number(v ?? 0) || 0);
      const won = (v: number) => v.toLocaleString("ko-KR") + "원";
      let order: Record<string, any>;
      try { order = await readOrder(); } catch (e) { return json({ error: "카페24에서 주문을 읽지 못했어요 — " + String(e).slice(0, 200) }, 502); }
      if (action === "retacc_prepare") {
        const g = retGroupsOf(order, nrSets, await retCouponInfo([order], token)).find((x) => x.claim_code === claimCode);
        if (!g) {
          if (movedAll(order)) return json({ ok: true, already: true, status: stateOf(order) });
          return json({ error: `그 사이 주문 상태가 바뀌었어요(${stateOf(order) || "접수 없음"}) — 새로고침한 뒤 다시 확인해주세요`, stale: true }, 409);
        }
        const manual = g.manual as { tag: string; text: string }[];
        if (manual.length) return json({ error: "직접 확인이 필요한 접수예요 — " + manual.map((m) => m.text).join(" / "), blocked: true }, 400);
        const expect = g.expect as { total: number; amount: number; points: number }, plan = g.plan as Record<string, any>;
        // 화면에 보여 준 환불 예정액과 지금 다시 계산한 값이 같아야 한다(사람이 본 금액 = 처리하는 금액)
        if (Number(b.expect_amount) !== expect.amount || Number(b.expect_points) !== expect.points || Number(b.expect_total) !== expect.total) return json({ error: "화면의 환불 예정액과 지금 계산한 금액이 달라요 — 새로고침한 뒤 다시 확인해주세요", stale: true }, 409);
        if (!plan.refund_type) return json({ error: "이 결제 수단은 여기서 처리하지 않아요", blocked: true }, 400);
        const itemNos = (g.items as Record<string, any>[]).map((x) => Number(x.no));
        if (itemNos.some((x) => !Number.isInteger(x) || x < 1)) return json({ error: "품목 번호를 읽지 못했어요 — 카페24에서 직접 처리해주세요", blocked: true }, 400);
        if (b.dry !== true) {
          // 안전장치: 사람별 1시간 300건 · 전체 하루 1,000건 (취소 접수 기록과 합산, 성공·실패 모두 셈)
          const sinceIso = (ms: number) => new Date(Date.now() - ms).toISOString();
          const mine = ((await sbRest(`cancel_accept_log?select=id&by_id=eq.${encodeURIComponent(authed.id)}&created_at=gte.${sinceIso(3600e3)}&limit=500`)) ?? []) as unknown[];
          const allDay = ((await sbRest(`cancel_accept_log?select=id&created_at=gte.${sinceIso(24 * 3600e3)}&limit=1500`)) ?? []) as unknown[];
          if (mine.length >= 300 || allDay.length >= 1000) return json({ error: "처리 한도를 넘었어요 — 잠시 뒤 다시 시도해주세요" }, 429);
        }
        return json({ ok: true, job: { order_id: orderId, claim_code: claimCode, item_nos: itemNos, label: String(g.reason_label ?? ""), fee: plan.fee, coupon: plan.coupon, coupon_amount: plan.coupon_amount,
          points_return: plan.points_return, add_sale: plan.add_sale, add_sale_amount: plan.add_sale_amount, refund_type: plan.refund_type, expect: { total: expect.total, cash: expect.amount, points: expect.points } } });
      }
      // record — 연결 스크립트가 끝난 뒤. 화면이 보낸 결과는 참고이고, 서버가 주문을 다시 읽어 상태·금액을 확인한다(반영이 조금 늦을 수 있어 4번까지).
      const job = (b.job ?? {}) as Record<string, any>, jx = (job.expect ?? {}) as Record<string, any>;
      const expect = { total: num(jx.total), amount: num(jx.cash), points: num(jx.points) };
      const fee = num(job.fee), couponCancel = job.coupon === "cancel" ? num(job.coupon_amount) : 0;
      let moved = movedAll(order);
      for (let i = 0; i < 5 && !moved && b.ok === true; i++) { await sleep(1300); try { order = await readOrder(); moved = movedAll(order); } catch { /* 다음 시도 */ } }
      const ret = (((order.return ?? []) as Record<string, any>[]).find((r) => r.claim_code === claimCode)) ?? {};
      const got = { amount: ((ret.refund_amounts ?? []) as Record<string, any>[]).reduce((t, a) => t + num(a.amount), 0), points: -num(ret.point_used), fee: -num(ret.return_shipping_fee), coupon: -num(ret.coupon_discount_amount), has: Array.isArray(ret.refund_amounts) };
      const diffs: string[] = [];
      if (moved && got.has) {
        if (got.amount !== expect.amount) diffs.push(`환불 예정액이 달라요(카페24 ${won(got.amount)} · 예정 ${won(expect.amount)})`);
        if (got.points !== expect.points) diffs.push(`적립금 반환이 달라요(카페24 ${won(got.points)} · 예정 ${won(expect.points)})`);
        if (got.fee !== fee) diffs.push(`반품 배송비가 달라요(카페24 ${won(got.fee)} · 예정 ${won(fee)})`);
        if (got.coupon !== couponCancel) diffs.push(`쿠폰할인 취소가 달라요(카페24 ${won(got.coupon)} · 예정 ${won(couponCancel)})`);
      }
      const ok = moved || b.ok === true;
      const txt = (v: unknown, k: number) => String(v ?? "").slice(0, k);
      const result = !ok ? (txt(b.message, 450) || "넘어가지 않음")
        : !moved ? "반품처리중으로 넘김(카페24 반영 대기)"
        : diffs.length ? "반품처리중으로 넘김 · ⚠ 카페24 금액이 예정과 다름 — " + diffs.join(" / ")
        : `${stateOf(order) || "반품처리중"} · 환불 예정 ${won(expect.amount)}${expect.points ? ` · 적립금 반환 ${won(expect.points)}` : ""} · 반품 배송비 ${won(fee)}${couponCancel ? ` · 쿠폰 취소 ${won(couponCancel)}` : ""}${got.has ? " (카페24와 같음)" : ""}`;
      await sbRest("cancel_accept_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
        kind: "ret", order_id: orderId, claim_code: claimCode,
        items: (Array.isArray(b.items) ? b.items : []).slice(0, 50).map((x: any) => ({ code: txt(x?.code, 30), product_name: txt(x?.product_name, 200), option: txt(x?.option, 200), qty: Number(x?.qty) || 0 })),
        reason_type: txt(b.reason_type, 2) || null, reason_label: txt(job.label, 40) || null, reason: txt(b.reason, 2000) || null, ok, result: result.slice(0, 500),
        expected_amount: expect.amount, refund_amount: moved && got.has ? got.amount : null, points: expect.points,
        detail: { stage: "ret_moved", fee, coupon: txt(job.coupon, 10), coupon_cancel: couponCancel, add_sale: txt(job.add_sale, 5), add_sale_amount: num(job.add_sale_amount), refund_type: txt(job.refund_type, 2), total: expect.total,
          sent: b.sent === true, script: txt(b.script_version, 12), alerts: (Array.isArray(b.alerts) ? b.alerts : []).slice(0, 3).map((a: unknown) => txt(a, 200)), cafe24: moved && got.has ? got : null },
        by_id: authed.id, by_name: authed.name }) }).catch(() => null);
      return json({ ok, moved, status: stateOf(order), warn: diffs.length ? "카페24에 반영된 금액이 예정과 달라요 — " + diffs.join(" / ") + ". 카페24에서 이 접수를 꼭 확인해주세요" : "", refund_amount: moved && got.has ? got.amount : expect.amount, points: expect.points });
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
    //   cn_thumbs POST {get:[사입상품명…]} — 그 상품들의 작은 사진(전원, 한 번에 200개 — 화면에 보이는 것만 받게)
    //             POST {thumbs:{사입상품명:dataURL}} — 사진 저장(관리자·MD, 상품당 1장 — 같은 이름은 덮어씀). 목록과 따로 불러 표를 늦추지 않는다 (2026-10-02)
    if (action === "cn_list" || action === "cn_upload" || action === "cn_check" || action === "cn_ship" || action === "cn_vendor" || action === "cn_line" || action === "cn_fabric" || action === "cn_label" || action === "cn_c24find" || action === "cn_c24set" || action === "cn_export" || action === "cn_thumbs" || action === "cn_order_upload" || action === "cn_order" || action === "cn_inactive" || action === "cn_manual_ship" || action === "cn_fx_buy_add" || action === "cn_fx_buy_del" || action === "cn_remit_save" || action === "cn_remit_del" || action === "cn_doc_save" || action === "cn_discard" || action === "cn_discard_del" || action === "cn_gap" || action === "cn_cellmap" || action === "cn_misong_list" || action === "cn_misong_upload") {
      // 관리자 + MD + 물류팀. **CS팀은 볼 필요 없음(2026-10-02 사용자 지정)** — 서버 역할은 logistics→cs로 합쳐져 있어 원래 역할을 다시 본다(soldoutRoleOk와 같은 방식)
      // 미송 확인 목록만 CS팀에도 열림(2026-10-26 사용자 요청 — "미송 확인은 물류팀과 CS팀도") — 그 밖의 중국 사입 자료는 그대로 CS 제외
      const misongOnly = action === "cn_misong_list" && authed.role === "cs";
      if (!misongOnly && !(authed.role === "staff" || await soldoutRoleOk(authed))) return json({ error: "접근 권한이 없습니다" }, 403);
      const canPrice = authed.role === "admin";   // 단가·비용 = **관리자만** (2026-10-02 사용자 지정 — MD도 안 보이게. 물류팀은 원래 수량만)
      const canEdit = authed.role !== "cs";       // 엑셀 올리기·입고 건 수정·삭제·사진 넣기 = 관리자 + MD (MD는 올릴 수는 있지만 단가·비용은 응답에서 빠진다)
      const hideCosts = <T extends Record<string, any>>(x: T): T => { if (canPrice) return x; const { costs: _c, doc: _d, ...rest } = x; return rest as T; };   // 출고 서류 합계(doc, 위안)도 관리자만(2026-10-22)
      const txt = (v: unknown, n: number) => v == null ? null : String(v).trim().slice(0, n) || null;
      const intOrNull = (v: unknown, max: number) => {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 && n <= max ? n : NaN;
      };
      // 카페24 전 상품의 공급사 상품명(30분 캐시) — 등록 여부 맞추기(cn_list)·직접 연결할 상품 찾기(cn_c24find)·직접 연결 저장(cn_c24set)이 같이 쓴다
      const cnC24Load = () => cnC24LoadShared(token, noCache);   // 공용(최상위) — 종합 판매 데이터의 실질 단가도 같은 목록을 쓴다
      const cnC24Pub = (x: Record<string, any>, how: string) => ({ product_no: x.product_no, product_name: x.product_name, supply_product_name: x.supply_product_name ?? "", display: x.display, selling: x.selling, how });
      // ── 상품 관리 시스템(newproduct-manager)으로 내보내기 (2026-10-13 사용자 요청 — 중국 사입 상품을 그쪽에 자동 등록) ──
      //   서버 간 전용: 상품관리 서버가 x-sync-secret(NPM_SYNC_SECRET)으로만 부른다(사람 로그인으로는 403 — 원가가 들어 있음).
      //   상품(사입상품명)마다: 혼용률 · 색상(옵션의 색상에서 한자를 뺀 한글 약칭, 나온 순서) · 사이즈(옵션에 있을 때만) ·
      //   **실질 단가**(화면 cnRealWon/cnRealAvg와 같은 계산: 줄마다 위안 × 환율 200 × (1 + 그 입고의 들여오는 비용 비율)을 원 단위로 반올림 → 입고(전달) 수량으로 가중 평균,
      //   비용 시트가 있는 입고가 하나라도 있으면 그 줄들만으로). 품번이 묶이는 경우(6800·6800短款)를 그쪽에서 다시 합칠 수 있게 합계(sum)·수량(qty)도 같이 준다.
      if (action === "cn_export") {
        if (!viaSecret) return json({ error: "접근 권한이 없습니다" }, 403);
        const [ships, lines, prodRows, buys, remits] = await Promise.all([
          sbRest("cn_shipments?select=id,costs,ship_date,doc&limit=500"),
          sbRest("cn_lines?select=shipment_id,seq,sname,color,size,qty_sent,unit_price&order=shipment_id.asc,seq.asc&limit=20000"),
          sbRest("cn_products?select=sname,fabric,line,label&limit=5000"),
          sbRest("cn_fx_buys?select=*&limit=5000"),
          sbRest("cn_remits?select=*&limit=5000"),
        ]) as [Record<string, any>[], Record<string, any>[], Record<string, any>[], Record<string, any>[], Record<string, any>[]];
        const fx = cnFxModel(ships, lines, buys, remits);   // 2026-10-22: 화면 cnRealWon과 같은 계산(환전 내역 선입선출 + 출고 서류 총 합계)
        const meta = new Map(prodRows.map((r) => [String(r.sname), r]));
        const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL", "FREE", "F"];
        const koOnly = (v: unknown) => { const raw = String(v ?? "").trim(); const ko = raw.replace(/\p{Script=Han}/gu, "").replace(/\s+/g, " ").trim(); return ko || raw; };   // "黑灰검회" → "검회" (한글이 없으면 원래 글자 그대로)
        const by = new Map<string, { colors: string[]; sizes: string[]; cost: { sum: number; qty: number }; all: { sum: number; qty: number }; qty: number }>();
        for (const l of lines) {
          const name = String(l.sname ?? ""); if (!name) continue;
          const g = by.get(name) ?? { colors: [], sizes: [], cost: { sum: 0, qty: 0 }, all: { sum: 0, qty: 0 }, qty: 0 };
          const col = koOnly(l.color); if (col && !g.colors.includes(col)) g.colors.push(col);
          const sz = String(l.size ?? "").trim(); if (sz && !g.sizes.includes(sz)) g.sizes.push(sz);
          const q = Number(l.qty_sent) || 0; g.qty += q;
          if (l.unit_price != null && q > 0) {
            const { won, ratio: r } = cnLineWon(fx, l.shipment_id, l.unit_price);
            g.all.sum += q * won; g.all.qty += q;
            if (r != null) { g.cost.sum += q * won; g.cost.qty += q; }
          }
          by.set(name, g);
        }
        const products = [...by.entries()].map(([sname, g]) => {
          const use = g.cost.qty > 0 ? g.cost : g.all;
          const order = (x: string) => { const i = SIZE_ORDER.indexOf(x.toUpperCase()); return i < 0 ? 99 : i; };
          return { sname, fabric: txt(meta.get(sname)?.fabric, 200), line: meta.get(sname)?.line ?? null, label: meta.get(sname)?.label === true,
            colors: g.colors, sizes: [...g.sizes].sort((a, b) => order(a) - order(b)), qty: g.qty,
            cost: use.qty > 0 ? Math.round(use.sum / use.qty) : null, cost_with: g.cost, cost_all: g.all };
        });
        return json({ products, generated_at: new Date().toISOString() });
      }
      if (action === "cn_list") {
        const [ships, lines, orders, orderLines, prodRows, discards] = await Promise.all([
          sbRest("cn_shipments?select=*&order=id.desc&limit=500"),
          sbRest("cn_lines?select=*&order=shipment_id.desc,seq.asc&limit=20000"),
          sbRest("cn_orders?select=*&order=id.desc&limit=300"),                                   // 주문서(2026-10-19 다시) — 단가가 없어 역할과 관계없이 그대로
          sbRest("cn_order_lines?select=*&order=order_id.desc,seq.asc&limit=30000"),
          sbRest("cn_products?select=sname,vendor,updated_by_name,updated_at,line,line_by_name,line_at,fabric,fabric_by_name,fabric_at,label,label_by_name,label_at,c24_nos,c24_by_name,c24_at,inactive,inactive_by_name,inactive_at,cell_map&limit=5000"),
          sbRest("cn_discards?select=id,sname,color,size,qty,note,created_by_name,created_at&order=created_at.asc&limit=20000"),   // 폐기(2026-10-23) — 잔여 = 주문 − 중국출고 − 폐기
        ]) as [Record<string, any>[], Record<string, any>[], Record<string, any>[], Record<string, any>[], Record<string, any>[], Record<string, any>[]];
        const prods: Record<string, unknown> = {};
        for (const r of prodRows) prods[String(r.sname)] = { vendor: r.vendor ?? null, by: r.updated_by_name ?? null, at: r.updated_at ?? null, line: r.line ?? null, line_by: r.line_by_name ?? null, line_at: r.line_at ?? null, fabric: r.fabric ?? null, fabric_by: r.fabric_by_name ?? null, fabric_at: r.fabric_at ?? null, label: r.label === true, label_by: r.label_by_name ?? null, label_at: r.label_at ?? null, c24_nos: Array.isArray(r.c24_nos) ? r.c24_nos : null, c24_by: r.c24_by_name ?? null, c24_at: r.c24_at ?? null, inactive: r.inactive === true, inactive_by: r.inactive_by_name ?? null, inactive_at: r.inactive_at ?? null, cell_map: r.cell_map && typeof r.cell_map === "object" ? r.cell_map : null };
        const outLines = canPrice ? lines : lines.map((l) => { const { unit_price: _u, ...rest } = l; return rest; });
        const outShips = ships.map(hideCosts);   // 비용(2번째 시트)도 관리자만
        // 카페24 등록 여부 (2026-10-12 규칙 — 사용자 지정 반영): 카페24 상품의 '공급사 상품명'(공백·대소문자 무시)과 사입상품명(품번)을 맞춘다.
        //   ① 직접 연결(cn_products.c24_nos 배열)이 있으면 그것만 쓴다([] = '해당 없음'으로 확정).
        //   ② 확실(exact): 같은 이름이거나, 공급사 상품명이 품번으로 시작하고 바로 뒤가 영문·숫자가 아님 ("26K07가디건(네이비) 79위안" ↔ 26K07).
        //   ③ 몸통 일치(base): 품번에 꼬리가 붙은 것('6800短款'·'26833-1短'·'801#')은, 공급사 상품명의 앞머리 영문·숫자가 품번 몸통('6800'·'26833'·'801')과 같으면 같은 상품
        //      — 사용자 지정: "6800과 6800短款은 카페24에 상품 1개로 등록하고 옵션으로 나눈다, 공급사 상품명은 6800". 그래서 한 카페24 상품이 여러 사입상품명에 붙을 수 있다.
        //   ④ 헷갈림(maybe → c24_warn): 위에 안 걸렸는데 앞머리가 서로 앞부분만 같은 상품이 있으면('6800' ↔ '68001…', 짧은 쪽 4자 이상) 등록으로 치지 않고 **주의 후보**로만 내려 준다 — 화면에서 직접 연결.
        let c24: Record<string, unknown[]> = {};
        let c24_warn: Record<string, unknown[]> = {};
        let c24_error: string | null = null;
        try {
          const names = [...new Set([...lines, ...(orderLines ?? [])].map((l) => String(l.sname ?? "")).filter(Boolean))];   // 주문서에만 있는 품번(아직 입고 없음)도 같이
          ({ c24, c24_warn } = cnMatchC24(names, (name) => (prods[name] as Record<string, any> | undefined)?.c24_nos, await cnC24Load()));
        } catch (e) { c24_error = "카페24 상품 목록을 읽지 못했어요 — " + String(e).slice(0, 150); }
        // 환전 모델(관리자만 — 2026-10-22): 환전·송금 내역 + 입고마다 1위안 원가·물건값 1위안당 원화(base)·들여오는 비용 비율(ratio). 화면 실질 단가가 이 값을 쓴다.
        let fx = null;
        if (canPrice) {
          const [buys, remits] = await Promise.all([sbRest("cn_fx_buys?select=*&limit=5000"), sbRest("cn_remits?select=*&limit=5000")]) as [Record<string, any>[], Record<string, any>[]];
          fx = cnFxModel(ships, lines, buys, remits);
        }
        return json({ ships: outShips, lines: outLines, orders: orders ?? [], order_lines: orderLines ?? [], discards: discards ?? [], prods, c24, c24_warn, c24_error, can_price: canPrice, can_edit: canEdit, fx });
      }
      // ── 미송 확인(2026-10-26 사용자 요청) — 중국에서 받은 미송 엑셀(화면이 읽어 단가·합계를 뺀 묶음만 보냄). 최근 2개(지금 + 직전)만 보관
      if (action === "cn_misong_list") {
        const y = new Date().getUTCFullYear();
        const [rows, hol] = await Promise.all([
          sbRest("cn_misong?select=id,file_name,base_date,base_label,items,thumbs,uploaded_by_name,uploaded_at&order=id.desc&limit=2"),
          sbRest(`wm_holidays?select=date,name&date=gte.${y - 1}-01-01&date=lte.${y + 1}-12-31&order=date.asc`).catch(() => []),   // 한국 도착 예상일(주말·공휴일이면 다음 날)용 — 근무 관리 공휴일 표
        ]) as [Record<string, any>[], Record<string, any>[]];
        return json({ files: rows ?? [], holidays: (hol ?? []).map((h) => ({ date: String(h.date).slice(0, 10), name: h.name ?? "" })), can_edit: canEdit });
      }
      if (req.method !== "POST") return json({ error: "POST로 호출해주세요" }, 405);
      const b = await req.json().catch(() => ({})) as Record<string, any>;
      const now = new Date().toISOString();
      const dateOrNull = (v: unknown) => { const d = txt(v, 10); return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null; };
      // 출고 서류 합계 블록(위안) 검사 — {goods, agency, items[{name,cny}], total, src}. 값이 이상하면 null(저장 안 함)
      const cleanDoc = (v: unknown): Record<string, unknown> | null => {
        if (!v || typeof v !== "object" || Array.isArray(v)) return null;
        const o = v as Record<string, any>, num = (x: unknown) => x === null || x === undefined || x === "" ? null : Number(x);
        const total = num(o.total), goods = num(o.goods), agency = num(o.agency);
        if (total == null || !(total > 0 && total < 1e9) || (goods != null && !(goods >= 0 && goods < 1e9)) || (agency != null && !(agency >= 0 && agency < 1e9))) return null;
        const items = (Array.isArray(o.items) ? o.items : []).slice(0, 20).map((x: any) => ({ name: String(x?.name ?? "").trim().slice(0, 40), cny: Number(x?.cny) })).filter((x: any) => x.name && Number.isFinite(x.cny) && Math.abs(x.cny) < 1e9);
        return { goods, agency, items, total, src: txt(o.src, 200) };
      };
      // ── 원>달러>위안 환전 (2026-10-22 사용자 요청) — 관리자만 ──
      //   cn_fx_buy_add {rows:[{order_no, traded_at, usd, krw, rate}]} 붙여넣은 은행 환전 내역(같은 주문번호는 덮어씀) · cn_fx_buy_del {id}
      //   cn_remit_save {id?, remit_date, usd, cny, memo} 달러→위안 송금(에이전시 실수령 위안 직접 입력) · cn_remit_del {id}
      //   cn_doc_save {id, doc|null} 입고의 출고 서류 합계(위안) 직접 고치기
      if (action === "cn_fx_buy_add" || action === "cn_fx_buy_del" || action === "cn_remit_save" || action === "cn_remit_del" || action === "cn_doc_save") {
        if (!canPrice) return json({ error: "환전 내역은 관리자만 다룰 수 있어요" }, 403);
        const posId = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
        if (action === "cn_fx_buy_add") {
          const src = Array.isArray(b.rows) ? b.rows as Record<string, any>[] : [];
          if (!src.length || src.length > 500) return json({ error: "추가할 환전 내역이 없어요 (한 번에 500줄까지)" }, 400);
          const rows: Record<string, unknown>[] = [];
          for (let i = 0; i < src.length; i++) {
            const r = src[i], order_no = String(r.order_no ?? "").trim(), at = String(r.traded_at ?? "");
            const usd = Number(r.usd), krw = Number(r.krw), rate = Number(r.rate);
            if (!/^[0-9A-Za-z_-]{1,40}$/.test(order_no) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?\+09:00$/.test(at) || !(usd > 0 && usd < 1e8) || !(Number.isInteger(krw) && krw > 0 && krw < 1e12) || !(rate > 100 && rate < 5000)) {
              return json({ error: `${i + 1}번째 줄 값이 올바르지 않아요 (주문번호·체결일시·달러·원화·환율 확인)` }, 400);
            }
            if (Math.abs(usd * rate - krw) > Math.max(1000, krw * 0.002)) return json({ error: `${i + 1}번째 줄: 달러 × 환율이 원화와 맞지 않아요 (주문번호 ${order_no})` }, 400);
            rows.push({ order_no, traded_at: at, usd, krw, rate, created_by_name: authed.name });
          }
          await sbRest("cn_fx_buys?on_conflict=order_no", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
          return json({ ok: true, saved: rows.length });
        }
        if (action === "cn_fx_buy_del" || action === "cn_remit_del") {
          const id = posId(b.id); if (!id) return json({ error: "id 오류" }, 400);
          await sbRest(`${action === "cn_fx_buy_del" ? "cn_fx_buys" : "cn_remits"}?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
          return json({ ok: true });
        }
        if (action === "cn_remit_save") {
          const remit_date = dateOrNull(b.remit_date), usd = Number(b.usd), cny = Number(b.cny);
          if (!remit_date || !(usd > 0 && usd < 1e8) || !(cny > 0 && cny < 1e9)) return json({ error: "송금일·보낸 달러·받은 위안을 확인해 주세요" }, 400);
          if (cny / usd < 4 || cny / usd > 10) return json({ error: `달러당 ${(cny / usd).toFixed(2)}위안이에요 — 달러·위안 칸이 바뀌지 않았는지 확인해 주세요` }, 400);
          const row = { remit_date, usd: Math.round(usd * 100) / 100, cny: Math.round(cny * 100) / 100, memo: txt(b.memo, 200), updated_at: now };
          const id = b.id == null ? null : posId(b.id);
          if (b.id != null && !id) return json({ error: "id 오류" }, 400);
          const out = id ? await sbRest(`cn_remits?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(row) })
            : await sbRest("cn_remits", { method: "POST", body: JSON.stringify({ ...row, created_by_name: authed.name }) });
          return json({ ok: true, remit: (out as Record<string, any>[])[0] ?? null });
        }
        if (action === "cn_doc_save") {
          const id = posId(b.id); if (!id) return json({ error: "id 오류" }, 400);
          const doc = b.doc === null ? null : cleanDoc(b.doc);
          if (b.doc !== null && !doc) return json({ error: "총 합계(위안)를 확인해 주세요" }, 400);
          await sbRest(`cn_shipments?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ doc }) });
          return json({ ok: true });
        }
      }
      // 사진 저장 — 브라우저가 줄여 보낸 JPEG data URL만(한 장 30KB 이하, 한 번에 400장). 형식이 다르면 그 장은 버린다.
      // 품번이 입고 내역이나 주문서에 있는지 — 혼용률·라벨·라인·카페24 연결 저장의 검사(주문서에만 있는 품번도 저장할 수 있게)
      const snameKnown = async (sname: string): Promise<unknown[]> => {
        const a = ((await sbRest(`cn_lines?sname=eq.${encodeURIComponent(sname)}&select=id&limit=1`)) ?? []) as unknown[];
        return a.length ? a : (((await sbRest(`cn_order_lines?sname=eq.${encodeURIComponent(sname)}&select=id&limit=1`)) ?? []) as unknown[]);
      };
      const orderIdOrNull = async (v: unknown): Promise<number | null> => {
        const n = Number(v);
        if (v === null || v === undefined || v === "" || !Number.isInteger(n) || n < 1) return null;
        const [o] = ((await sbRest(`cn_orders?id=eq.${n}&select=id`)) ?? []) as Record<string, any>[];
        return o ? n : null;
      };
      const shipIds = (v: unknown): number[] | null => {
        if (!Array.isArray(v) || v.length > 300) return null;
        const ids = v.map((x) => Number(x));
        return ids.every((n) => Number.isInteger(n) && n >= 1) ? [...new Set(ids)] : null;
      };
      const saveThumbs = async (v: unknown, keep = false): Promise<number> => {   // keep = 이미 사진이 있는 품번은 그대로(주문서에서 올 때)
        if (!v || typeof v !== "object" || Array.isArray(v)) return 0;
        const rows = Object.entries(v as Record<string, unknown>).slice(0, 400)
          .map(([k, img]) => ({ sname: txt(k, 100), img: String(img ?? "") }))
          .filter((r) => r.sname && r.img.length <= 30000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(r.img))
          .map((r) => ({ ...r, updated_by_name: authed.name, updated_at: now }));
        if (!rows.length) return 0;
        await sbRest("cn_thumbs?on_conflict=sname", { method: "POST", headers: { Prefer: `resolution=${keep ? "ignore" : "merge"}-duplicates,return=minimal` }, body: JSON.stringify(rows) });
        return rows.length;
      };
      // ── 주문서 (2026-10-19 다시 — 사용자 요청 "언제 얼마나 주문했는지 보이게"). 품번·색상·사이즈·수량만 저장(단가 없음) ──
      // 올리기: { title, order_date?, note?, file_name?, lines:[{sname,color?,size?,qty,sheet?}], ship_ids:[이 주문서의 입고 건], thumbs? } — 관리자·MD
      if (action === "cn_order_upload") {
        if (!canEdit) return json({ error: "주문서 올리기는 관리자·MD만 할 수 있어요" }, 403);
        const title = txt(b.title, 100);
        if (!title) return json({ error: "주문서 이름을 입력해주세요" }, 400);
        const src = Array.isArray(b.lines) ? b.lines as Record<string, any>[] : [];
        if (!src.length || src.length > 5000) return json({ error: "옵션 줄은 1~5,000개여야 해요" }, 400);
        const ids = shipIds(b.ship_ids ?? []);
        if (!ids) return json({ error: "연결할 입고 건이 올바르지 않아요" }, 400);
        const rows: Record<string, unknown>[] = [];
        for (let i = 0; i < src.length; i++) {
          // 수량은 마이너스도 받는다(2026-10-19 사용자 지정 — 주문서의 '-1' = 앞선 주문에서 취소, 주문 합계에서 뺌)
          const r = src[i], sname = txt(r.sname, 100), qn = Number(r.qty), qty = Number.isInteger(qn) && Math.abs(qn) <= 1_000_000 ? qn : NaN;
          if (!sname || Number.isNaN(qty)) return json({ error: `${i + 1}번째 줄 값이 올바르지 않아요 (품번·수량 확인)` }, 400);
          rows.push({ seq: i, sheet: txt(r.sheet, 60), sname, color: txt(r.color, 60), size: txt(r.size, 40), qty });
        }
        const [order] = await sbRest("cn_orders", { method: "POST", body: JSON.stringify({
          title, order_date: dateOrNull(b.order_date), file_name: txt(b.file_name, 200), note: txt(b.note, 300), created_by: authed.id, created_by_name: authed.name,
        }) }) as Record<string, any>[];
        try {
          await sbRest("cn_order_lines", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows.map((r) => ({ ...r, order_id: order.id }))) });
        } catch (e) {
          await sbRest(`cn_orders?id=eq.${order.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => null);   // 줄 저장 실패 → 빈 주문서를 남기지 않는다
          return json({ error: "저장하지 못했어요 — " + String(e).slice(0, 150) }, 500);
        }
        let linked = 0;
        if (ids.length) linked = (((await sbRest(`cn_shipments?id=in.(${ids.join(",")})`, { method: "PATCH", body: JSON.stringify({ order_id: order.id }) })) ?? []) as unknown[]).length;
        let thumbs_saved = 0;
        try { thumbs_saved = await saveThumbs(b.thumbs, true); } catch { /* 사진 저장 실패는 주문서 저장을 막지 않는다 */ }
        return json({ ok: true, order, line_count: rows.length, linked, thumbs_saved });
      }
      // 수정·삭제: { id, delete:true } | { id, title?, order_date?, note?, ship_ids?: [이 주문서의 입고 건 전체 — 빠진 입고는 연결이 끊긴다] } — 관리자·MD
      if (action === "cn_order") {
        if (!canEdit) return json({ error: "주문서 수정·삭제는 관리자·MD만 할 수 있어요" }, 403);
        const oid = await orderIdOrNull(b.id);
        if (oid === null) return json({ error: "주문서를 찾지 못했어요 — 새로고침해 주세요" }, 404);
        if (b.delete === true) {
          await sbRest(`cn_orders?id=eq.${oid}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });   // 줄은 같이 지워지고 입고 건의 연결은 비워진다(입고·수량은 그대로)
          return json({ ok: true, deleted: 1 });
        }
        const patch: Record<string, unknown> = {};
        if ("title" in b) { const t = txt(b.title, 100); if (!t) return json({ error: "주문서 이름을 입력해주세요" }, 400); patch.title = t; }
        if ("order_date" in b) patch.order_date = dateOrNull(b.order_date);
        if ("note" in b) patch.note = txt(b.note, 300);
        let order: Record<string, any> | null = null;
        if (Object.keys(patch).length) [order] = await sbRest(`cn_orders?id=eq.${oid}`, { method: "PATCH", body: JSON.stringify(patch) }) as Record<string, any>[];
        let linked: number | null = null;
        if ("ship_ids" in b) {
          const ids = shipIds(b.ship_ids);
          if (!ids) return json({ error: "연결할 입고 건이 올바르지 않아요" }, 400);
          await sbRest(`cn_shipments?order_id=eq.${oid}${ids.length ? `&id=not.in.(${ids.join(",")})` : ""}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ order_id: null }) });
          linked = ids.length ? (((await sbRest(`cn_shipments?id=in.(${ids.join(",")})`, { method: "PATCH", body: JSON.stringify({ order_id: oid }) })) ?? []) as unknown[]).length : 0;
        } else if (!Object.keys(patch).length) return json({ error: "바꿀 내용이 없어요" }, 400);
        return json({ ok: true, order, linked });
      }
      if (action === "cn_thumbs" && Array.isArray(b.get)) {
        // 읽기: 요청한 이름만(화면에 보이는 상품) — 상품이 늘어도 한 번에 받는 양이 커지지 않는다
        const names = [...new Set((b.get as unknown[]).map((x) => String(x ?? "").trim()).filter((x) => x && x.length <= 100))].slice(0, 200);
        const thumbs: Record<string, string> = {};
        if (names.length) {
          const list = names.map((n) => '"' + n.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(",");
          const rows = ((await sbRest(`cn_thumbs?select=sname,img&sname=in.(${encodeURIComponent(list)})&limit=200`)) ?? []) as Record<string, any>[];
          for (const r of rows) thumbs[String(r.sname)] = String(r.img);
        }
        return json({ thumbs, asked: names.length });
      }
      if (action === "cn_misong_upload") {
        if (!canEdit) return json({ error: "미송 엑셀 올리기는 관리자·MD만 할 수 있어요" }, 403);
        const rawItems = Array.isArray(b.items) ? b.items : null;
        if (!rawItems || !rawItems.length || rawItems.length > 300) return json({ error: "미송 항목이 없거나 너무 많아요(300묶음까지)" }, 400);
        const qtyOk = (v: unknown) => Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= 1000000;
        const items: Record<string, unknown>[] = [];
        for (const it of rawItems as Record<string, any>[]) {
          const sname = txt(it?.sname, 100);
          if (!sname) return json({ error: "품번이 빈 묶음이 있어요" }, 400);
          const rows = (Array.isArray(it.rows) ? it.rows : []).slice(0, 60) as Record<string, any>[];
          if (rows.some((r) => !qtyOk(r?.qty))) return json({ error: `${sname}: 수량은 1 이상 정수여야 해요` }, 400);
          // 쇼핑몰 판매 상품명은 올릴 때 화면이 카페24 연결에서 찾아 같이 보냄(CS팀은 중국 사입 자료를 못 읽어서) — null = 중국 사입에 없는 품번, [] = 카페24 미등록
          const mall = it.mall === null || it.mall === undefined ? null : (Array.isArray(it.mall) ? it.mall.slice(0, 5).map((m: unknown) => txt(m, 200)).filter(Boolean) : null);
          items.push({
            sname, store: txt(it.store, 60), mall,
            rows: rows.map((r) => ({ color: txt(r.color, 60), size: txt(r.size, 30), qty: Number(r.qty) })),
            notes: (Array.isArray(it.notes) ? it.notes : []).slice(0, 10).map((n: any) => ({ text: txt(n?.text, 200) })).filter((n: any) => n.text),
            checks: (Array.isArray(it.checks) ? it.checks : []).slice(0, 5).map((c: unknown) => txt(c, 200)).filter(Boolean),
          });
        }
        const thumbs: Record<string, string> = {};
        if (b.thumbs && typeof b.thumbs === "object" && !Array.isArray(b.thumbs)) {
          for (const [k, v] of Object.entries(b.thumbs as Record<string, unknown>).slice(0, 300)) {
            const key = txt(k, 100);
            if (key && typeof v === "string" && v.length <= 30000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v)) thumbs[key] = v;
          }
        }
        const row = { file_name: txt(b.file_name, 200), base_date: dateOrNull(b.base_date), base_label: txt(b.base_label, 30), items, thumbs: Object.keys(thumbs).length ? thumbs : null, uploaded_by: authed.id, uploaded_by_name: authed.name };
        if (JSON.stringify(row).length > 3_000_000) return json({ error: "파일이 너무 커요" }, 400);
        const [saved] = ((await sbRest("cn_misong", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) })) ?? []) as Record<string, any>[];
        // 최근 2개(지금 + 직전)만 남기고 그 전 파일은 지운다(사용자 지정)
        const keep = ((await sbRest("cn_misong?select=id&order=id.desc&limit=2")) ?? []) as Record<string, any>[];
        if (keep.length === 2) await sbRest(`cn_misong?id=lt.${Number(keep[1].id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
        if (Object.keys(thumbs).length) { try { await saveThumbs(thumbs, true); } catch { /* 다른 탭 사진은 없어도 됨 */ } }
        return json({ ok: true, id: saved?.id ?? null, items: items.length });
      }
      if (action === "cn_thumbs") {
        if (!canEdit) return json({ error: "사진 넣기는 관리자·MD만 할 수 있어요" }, 403);
        return json({ ok: true, saved: await saveThumbs(b.thumbs) });
      }
      // 입고 비용(엑셀 2번째 시트) 정리 — 화면이 읽어 보낸 값을 모양·크기만 확인해 저장한다 (2026-10-01)
      const cleanCosts = (v: unknown): Record<string, unknown> | null | undefined => {
        if (v === null) return null;
        if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
        const c = v as Record<string, any>;
        const numOrNull = (x: unknown) => { const n = Number(x); return x === null || x === undefined || x === "" || !Number.isFinite(n) ? null : n; };
        const arr = (x: unknown, max: number) => (Array.isArray(x) ? x.slice(0, max) : []) as Record<string, any>[];
        const out = {
          sheet: txt(c.sheet, 60), title: txt(c.title, 120),
          items: arr(c.items, 100).map((r) => ({ name: txt(r.name, 60), amount: numOrNull(r.amount), note: txt(r.note, 200), calc: txt(r.calc, 80) })).filter((r) => r.name),
          totals: arr(c.totals, 20).map((r) => ({ name: txt(r.name, 60), amount: numOrNull(r.amount) })).filter((r) => r.name),
          payments: arr(c.payments, 50).map((r) => ({ name: txt(r.name, 60), usd: numOrNull(r.usd), krw: numOrNull(r.krw) })).filter((r) => r.name),
          pay_total: c.pay_total && typeof c.pay_total === "object" ? { usd: numOrNull(c.pay_total.usd), krw: numOrNull(c.pay_total.krw) } : null,
          saved_by: authed.name, saved_at: now,
        };
        return JSON.stringify(out).length > 40000 ? undefined : out;
      };
      if (action === "cn_vendor") {
        if (!canEdit) return json({ error: "거래처명 입력은 관리자·MD만 할 수 있어요" }, 403);
        const sname = txt(b.sname, 100);
        if (!sname) return json({ error: "사입상품명이 없어요" }, 400);
        const row = { sname, vendor: txt(b.vendor, 80), updated_by: authed.id, updated_by_name: authed.name, updated_at: now };
        await sbRest("cn_products?on_conflict=sname", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
        return json({ ok: true, sname, vendor: row.vendor, by: authed.name, at: now });
      }
      // 상품(사입상품명)별 혼용률 (2026-10-12 사용자 요청) — 직접 입력(cn_fabric)과 엑셀의 혼용률 열(cn_upload의 fabrics)이 같은 칸에 저장된다.
      //   { 사입상품명: 혼용률 글 } 을 받아 빈 값이 아닌 것만 저장(엑셀의 빈칸이 이미 적어 둔 값을 지우지 않게). 다른 칸(라인·거래처명)은 건드리지 않는다.
      const saveFabrics = async (obj: unknown): Promise<number> => {
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return 0;
        const rows = Object.entries(obj as Record<string, unknown>).slice(0, 2000)
          .map(([k, v]) => ({ sname: txt(k, 100), fabric: txt(v, 200) }))
          .filter((r) => r.sname && r.fabric)
          .map((r) => ({ ...r, fabric_by_name: authed.name, fabric_at: now }));
        if (!rows.length) return 0;
        await sbRest("cn_products?on_conflict=sname", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
        return rows.length;
      };
      if (action === "cn_fabric") {   // 한 상품의 혼용률을 직접 적거나(빈 값 = 지움) 고친다 — 관리자·MD만, 물류팀은 보기만
        if (!canEdit) return json({ error: "혼용률은 관리자·MD만 적을 수 있어요" }, 403);
        const sname = txt(b.sname, 100);
        if (!sname) return json({ error: "사입상품명이 없어요" }, 400);
        if (b.fabric != null && String(b.fabric).trim().length > 200) return json({ error: "혼용률은 200자까지 적을 수 있어요" }, 400);
        const known = await snameKnown(sname);
        if (!known.length) return json({ error: "입고 내역에 없는 사입상품명이에요 — 새로고침한 뒤 다시 시도해주세요" }, 404);
        const fabric = txt(b.fabric, 200);
        await sbRest("cn_products?on_conflict=sname", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ sname, fabric, fabric_by_name: authed.name, fabric_at: now }) });
        return json({ ok: true, sname, fabric, fabric_by: authed.name, fabric_at: now });
      }
      // 카페24 상품 직접 연결 (2026-10-12 사용자 요청 — 자동으로 맞추기 힘든 상품은 직접 고른다)
      //   cn_c24find { q }: 카페24 상품을 판매 상품명·공급사 상품명으로 찾는다(읽기, 30개까지). cn_c24set { sname, product_nos: [번호…] | [] | null }: 직접 연결 / 해당 없음 / 자동으로 되돌림.
      if (action === "cn_c24find") {
        const q = cnNorm(txt(b.q, 60) ?? "");
        if (q.length < 2) return json({ error: "두 글자 이상으로 찾아 주세요" }, 400);
        const cps = await cnC24Load();
        const out = cps.filter((x) => cnNorm(x.product_name).includes(q) || cnNorm(x.supply_product_name).includes(q) || String(x.product_no) === q).slice(0, 30).map((x) => cnC24Pub(x, "find"));
        return json({ products: out });
      }
      if (action === "cn_c24set") {
        if (!canEdit) return json({ error: "카페24 상품 연결은 관리자·MD만 바꿀 수 있어요" }, 403);
        const sname = txt(b.sname, 100);
        if (!sname) return json({ error: "사입상품명이 없어요" }, 400);
        const known = await snameKnown(sname);
        if (!known.length) return json({ error: "입고 내역에 없는 사입상품명이에요 — 새로고침한 뒤 다시 시도해주세요" }, 404);
        let nos: number[] | null = null;
        if (b.product_nos !== null && b.product_nos !== undefined) {
          if (!Array.isArray(b.product_nos) || b.product_nos.length > 5) return json({ error: "카페24 상품은 5개까지 연결할 수 있어요" }, 400);
          nos = [...new Set((b.product_nos as unknown[]).map(Number))];
          if (nos.some((n) => !Number.isInteger(n) || n <= 0)) return json({ error: "상품 번호가 올바르지 않아요" }, 400);
          const have = new Set((await cnC24Load()).map((x) => Number(x.product_no)));
          if (nos.some((n) => !have.has(n))) return json({ error: "카페24에 없는 상품 번호가 있어요 — 새로고침한 뒤 다시 골라 주세요" }, 400);
        }
        await sbRest("cn_products?on_conflict=sname", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ sname, c24_nos: nos, c24_by_name: authed.name, c24_at: now }) });
        return json({ ok: true, sname, c24_nos: nos, c24_by: authed.name, c24_at: now });
      }
      // 혼용률 라벨 제작 대상 표시 (2026-10-12 사용자 요청 — 아우터는 혼용률이 라벨에 들어가야 해서 라벨을 만들어야 하는 상품을 따로 파악). 관리자·MD만, 물류팀은 보기만.
      // 미진행 표시 (2026-10-20 사용자 요청 — 진행하지 않는 상품은 체크하면 안 보이게). 관리자·MD.
      // ── 폐기(2026-10-23 사용자 요청 — "주문 수량과 실제 출고 수량이 차이 나는 품목(원단 사정 등)은 나머지를 폐기로 없애, 덜 들어온 것처럼 보이지 않게") ──
      //   cn_discard {sname, color, size, qty, note} — 그 옵션(품번·색상·사이즈 글자 그대로)의 잔여 중 qty장을 더 받지 않기로. 관리자·MD만(물류팀은 보기만).
      //   cn_discard_del {id} — 되돌리기(기록을 지우면 잔여로 돌아온다). 잔여 = 주문(모든 주문서 합) − 중국출고(모든 입고 합) − 폐기 합.
      if (action === "cn_discard" || action === "cn_discard_del") {
        if (!canEdit) return json({ error: "폐기는 관리자·MD만 할 수 있어요" }, 403);
        if (action === "cn_discard_del") {
          const id = Number(b.id); if (!Number.isInteger(id) || id < 1) return json({ error: "id가 올바르지 않아요" }, 400);
          const gone = ((await sbRest(`cn_discards?id=eq.${id}`, { method: "DELETE" })) ?? []) as unknown[];
          if (!gone.length) return json({ error: "이미 지워진 폐기 기록이에요 — 새로고침해 주세요" }, 404);
          return json({ ok: true, id });
        }
        // 수량: 양수 = 폐기(더 받지 않음), 음수 = 초과 인정(주문보다 더 나온 수량을 받아들임 — 2026-10-23 '색이 바뀌어 나간' 경우 등)
        const sname = txt(b.sname, 100), qn = Number(b.qty), qty = Number.isInteger(qn) && qn !== 0 && Math.abs(qn) <= 1_000_000 ? qn : NaN;
        if (!sname) return json({ error: "사입상품명이 없어요" }, 400);
        if (Number.isNaN(qty)) return json({ error: "수량은 0이 아닌 정수로 적어 주세요(폐기 = 양수, 초과 인정 = 음수)" }, 400);
        if (!(await snameKnown(sname)).length) return json({ error: "입고 내역·주문서에 없는 사입상품명이에요 — 새로고침한 뒤 다시 시도해주세요" }, 404);
        const [row] = await sbRest("cn_discards", { method: "POST", body: JSON.stringify({ sname, color: txt(b.color, 60), size: txt(b.size, 40), qty, note: txt(b.note, 200), created_by: authed.id, created_by_name: authed.name }) }) as Record<string, any>[];
        return json({ ok: true, discard: { id: row.id, sname: row.sname, color: row.color, size: row.size, qty: row.qty, note: row.note, created_by_name: row.created_by_name, created_at: row.created_at } });
      }
      // ── 차이 정리(2026-10-23 사용자 요청 — "1차 입고의 부족분은 모두 없애줘, 기록에 (첫 입고여서 차이가 있었음. 감안)") ──
      //   cn_gap {line_id, close: true, note} — 그 입고 줄의 차이(중국출고 − 실입고)를 '정리'로 표시(실입고 숫자는 그대로). 검수 완료한 차수도 된다(검수 뒤 정리).
      //   cn_gap {line_id, close: false} — 정리 취소. 관리자·MD만.
      if (action === "cn_gap") {
        if (!canEdit) return json({ error: "차이 정리는 관리자·MD만 할 수 있어요" }, 403);
        const id = Number(b.line_id); if (!Number.isInteger(id) || id < 1) return json({ error: "line_id가 올바르지 않아요" }, 400);
        if (typeof b.close !== "boolean") return json({ error: "close 값이 올바르지 않아요" }, 400);
        const [l] = ((await sbRest(`cn_lines?id=eq.${id}&select=id,qty_sent,qty_actual`)) ?? []) as Record<string, any>[];
        if (!l) return json({ error: "입고 줄을 찾지 못했어요 — 새로고침해 주세요" }, 404);
        let patch: Record<string, unknown>;
        if (b.close) {
          if (l.qty_actual == null) return json({ error: "실입고를 적지 않은 줄이에요" }, 400);
          const gap = Number(l.qty_sent) - Number(l.qty_actual);
          if (gap === 0) return json({ error: "차이가 없는 줄이에요" }, 400);
          patch = { gap_closed: gap, gap_note: txt(b.note, 200), gap_by_name: authed.name, gap_at: now };
        } else patch = { gap_closed: null, gap_note: null, gap_by_name: null, gap_at: null };
        const [row] = await sbRest(`cn_lines?id=eq.${id}&select=id,gap_closed,gap_note,gap_by_name,gap_at`, { method: "PATCH", body: JSON.stringify(patch) }) as Record<string, any>[];
        return json({ ok: true, line: row });
      }
      // ── 옵션 짝(2026-10-23 — 중국 사입 / 제작 주문 점검의 '중국 상품'): cn_cellmap {sname, key: "색상\u0001사이즈", opt: "셀메이트 옵션명" | "__none" | null(자동으로 되돌림)} — 관리자·MD
      if (action === "cn_cellmap") {
        if (!canEdit) return json({ error: "옵션 짝은 관리자·MD만 바꿀 수 있어요" }, 403);
        const sname = txt(b.sname, 100), key = typeof b.key === "string" ? b.key.slice(0, 200) : "";
        if (!sname || !key) return json({ error: "sname·key가 필요해요" }, 400);
        const opt = b.opt == null ? null : txt(b.opt, 200);
        if (!(await snameKnown(sname)).length) return json({ error: "입고 내역·주문서에 없는 사입상품명이에요 — 새로고침한 뒤 다시 시도해주세요" }, 404);
        const [cur] = ((await sbRest(`cn_products?sname=eq.${encodeURIComponent(sname)}&select=cell_map`)) ?? []) as Record<string, any>[];
        const map: Record<string, string> = cur && cur.cell_map && typeof cur.cell_map === "object" ? { ...cur.cell_map } : {};
        if (opt) map[key] = opt; else delete map[key];
        if (Object.keys(map).length > 200) return json({ error: "옵션 짝이 너무 많아요" }, 400);
        await sbRest("cn_products?on_conflict=sname", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ sname, cell_map: Object.keys(map).length ? map : null }) });
        return json({ ok: true, sname, cell_map: Object.keys(map).length ? map : null });
      }
      if (action === "cn_inactive") {
        if (!canEdit) return json({ error: "미진행 표시는 관리자·MD만 바꿀 수 있어요" }, 403);
        const sname = txt(b.sname, 100);
        if (!sname) return json({ error: "사입상품명이 없어요" }, 400);
        if (typeof b.inactive !== "boolean") return json({ error: "미진행 값이 올바르지 않아요" }, 400);
        if (!(await snameKnown(sname)).length) return json({ error: "입고 내역·주문서에 없는 사입상품명이에요 — 새로고침한 뒤 다시 시도해주세요" }, 404);
        await sbRest("cn_products?on_conflict=sname", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ sname, inactive: b.inactive, inactive_by_name: authed.name, inactive_at: now }) });
        return json({ ok: true, sname, inactive: b.inactive, inactive_by: authed.name, inactive_at: now });
      }
      // 입고 엑셀 없이 들어온 상품을 직접 입고로 등록 (2026-10-20 — 26902처럼 주문서에만 있는 상품): 그 품번의 주문서 수량(모든 주문서 합)으로 입고 건 하나를 만든다.
      //   중국출고 = 주문 수량으로 본다(엑셀이 없으니). 만든 뒤에는 보통 입고처럼 실입고·불량을 적고 검수 완료. 이미 입고 줄이 있는 품번은 409(엑셀로 들어온 것과 겹치지 않게).
      if (action === "cn_manual_ship") {
        if (!canEdit) return json({ error: "직접 입고 등록은 관리자·MD만 할 수 있어요" }, 403);
        const sname = txt(b.sname, 100);
        if (!sname) return json({ error: "사입상품명이 없어요" }, 400);
        const have = ((await sbRest(`cn_lines?sname=eq.${encodeURIComponent(sname)}&select=id&limit=1`)) ?? []) as unknown[];
        if (have.length) return json({ error: "이미 입고 내역이 있는 상품이에요 — 그 입고에서 수량을 적어 주세요" }, 409);
        const ols = ((await sbRest(`cn_order_lines?sname=eq.${encodeURIComponent(sname)}&select=color,size,qty,seq,order_id&order=order_id.asc,seq.asc`)) ?? []) as Record<string, any>[];
        const by = new Map<string, { color: string | null; size: string | null; qty: number }>();
        for (const l of ols) { const k = String(l.color ?? "") + "\u0001" + String(l.size ?? ""); const e = by.get(k) ?? { color: l.color ?? null, size: l.size ?? null, qty: 0 }; e.qty += Number(l.qty) || 0; by.set(k, e); }
        const rows = [...by.values()].filter((e) => e.qty > 0);
        if (!rows.length) return json({ error: "주문서에 이 품번의 주문 수량이 없어요" }, 400);
        const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
        const [ship] = await sbRest("cn_shipments", { method: "POST", body: JSON.stringify({
          title: `직접 입고 · ${sname}`, order_round: "직접 입고", ship_date: today, note: "입고 엑셀 없이 직접 등록 — 중국출고 = 주문서 수량", created_by: authed.id, created_by_name: authed.name, costs: null,
        }) }) as Record<string, any>[];
        try {
          await sbRest("cn_lines", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows.map((e, i) => ({ shipment_id: ship.id, seq: i, sname, color: e.color, size: e.size, qty_sent: e.qty, qty_left: null, unit_price: null }))) });
        } catch (e) {
          await sbRest(`cn_shipments?id=eq.${ship.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => null);
          return json({ error: "저장하지 못했어요 — " + String(e).slice(0, 150) }, 500);
        }
        return json({ ok: true, shipment: hideCosts(ship), line_count: rows.length });
      }
      if (action === "cn_label") {
        if (!canEdit) return json({ error: "라벨 표시는 관리자·MD만 바꿀 수 있어요" }, 403);
        const sname = txt(b.sname, 100);
        if (!sname) return json({ error: "사입상품명이 없어요" }, 400);
        if (typeof b.label !== "boolean") return json({ error: "라벨 값이 올바르지 않아요" }, 400);
        const known = await snameKnown(sname);
        if (!known.length) return json({ error: "입고 내역에 없는 사입상품명이에요 — 새로고침한 뒤 다시 시도해주세요" }, 404);
        await sbRest("cn_products?on_conflict=sname", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ sname, label: b.label, label_by_name: authed.name, label_at: now }) });
        return json({ ok: true, sname, label: b.label, label_by: authed.name, label_at: now });
      }
      // 상품(사입상품명)별 라인 구분 — made 라인 / 일반 상품 (2026-10-12 사용자 요청). null = 구분 지움. 관리자·MD만, 물류팀은 보기만.
      if (action === "cn_line") {
        if (!canEdit) return json({ error: "라인 구분은 관리자·MD만 바꿀 수 있어요" }, 403);
        const sname = txt(b.sname, 100);
        if (!sname) return json({ error: "사입상품명이 없어요" }, 400);
        const line = b.line === null || b.line === "" || b.line === undefined ? null : String(b.line);
        if (line !== null && line !== "made" && line !== "normal") return json({ error: "라인은 made 또는 일반만 고를 수 있어요" }, 400);
        const known = await snameKnown(sname);
        if (!known.length) return json({ error: "입고 내역에 없는 사입상품명이에요 — 새로고침한 뒤 다시 시도해주세요" }, 404);
        // 이 표의 다른 칸(거래처명 등)은 건드리지 않는다 — 보낸 칸만 합쳐진다
        await sbRest("cn_products?on_conflict=sname", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ sname, line, line_by_name: authed.name, line_at: now }) });
        return json({ ok: true, sname, line, line_by: authed.name, line_at: now });
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
          rows.push({ seq: i, sname, color: txt(r.color, 60), size: txt(r.size, 40), qty_sent: sent, qty_left: left, unit_price: price, line_note: txt(r.line_note, 200) });   // 미출고(F열) 다시 저장(2026-10-23 사용자 요청 — '출완' = 0, 빈칸 = null). 10-14~10-22에는 null로 저장했었다
        }
        // 출고(E)는 비었는데 미출고(F)만 적힌 줄 — 입고 줄로 만들지 않고 입고 건에 따로 담는다(2026-10-23)
        const extraSrc = Array.isArray(b.left_extra) ? b.left_extra as Record<string, any>[] : [];
        if (extraSrc.length > 3000) return json({ error: "미출고만 적힌 줄이 너무 많아요" }, 400);
        const leftExtra: Record<string, unknown>[] = [];
        for (const r of extraSrc) {
          const sname = txt(r.sname, 100), left = intOrNull(r.left, 1_000_000);
          if (!sname || left === null || Number.isNaN(left)) return json({ error: "미출고만 적힌 줄의 값이 올바르지 않아요" }, 400);
          leftExtra.push({ sname, color: txt(r.color, 60), size: txt(r.size, 40), left });
        }
        const [ship] = await sbRest("cn_shipments", { method: "POST", body: JSON.stringify({
          title, vendor: txt(b.vendor, 80), order_round: txt(b.order_round, 40), ship_date: dateOrNull(b.ship_date),
          arrival_date: dateOrNull(b.arrival_date), box_count: Number.isNaN(intOrNull(b.box_count, 100000)) ? null : intOrNull(b.box_count, 100000),   // 입고 예정일·박스 수량(2026-10-22 — 발주 차수 대신)
          file_name: txt(b.file_name, 200), note: txt(b.note, 300), created_by: authed.id, created_by_name: authed.name,
          costs: "costs" in b ? (cleanCosts(b.costs) ?? null) : null,
          doc: cleanDoc(b.doc),   // 출고 서류 합계 블록(물건값·에이전시 10%·경비·총 합계 위안 — 2026-10-22)
          left_extra: leftExtra.length ? leftExtra : null,   // 출고 없이 미출고만 적힌 줄(2026-10-23)
        }) }) as Record<string, any>[];
        try {
          await sbRest("cn_lines", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows.map((r) => ({ ...r, shipment_id: ship.id }))) });
        } catch (e) {
          await sbRest(`cn_shipments?id=eq.${ship.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => null);   // 줄 저장 실패 → 빈 입고 건을 남기지 않는다
          return json({ error: "저장하지 못했어요 — " + String(e).slice(0, 150) }, 500);
        }
        let thumbs_saved = 0;
        try { thumbs_saved = await saveThumbs(b.thumbs); } catch { /* 사진 저장 실패는 입고 건 저장을 막지 않는다 */ }
        // 물류팀 알림(2026-10-22 사용자 요청 "신규 입고 엑셀이 등록되면 물류팀 직원에게 알림"): 로그인 막히지 않은 logistics 계정 전원(올린 사람 제외)에게
        //   앱 종 알림 + 휴대폰 푸시 — notify 함수를 올린 사람의 토큰 그대로 부른다(발신자 = 올린 사람, notify의 시간당 60건 제한도 그대로). 실패해도 입고 저장은 그대로.
        let notified = 0;
        try {
          const users = ((await sbRest("app_users?role=eq.logistics&select=id,login_blocked&limit=50")) ?? []) as Record<string, any>[];
          const targets = users.filter((u) => !u.login_blocked && String(u.id) !== authed.id).map((u) => String(u.id));
          if (targets.length) {
            const md = (d: unknown) => { const v = String(d ?? ""); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${Number(v.slice(5, 7))}/${Number(v.slice(8, 10))}` : ""; };
            const msg = `새 입고 등록: ${title}${ship.box_count != null ? ` · ${ship.box_count}박스` : ""}${md(ship.arrival_date) ? ` · 입고 예정 ${md(ship.arrival_date)}` : ""} — 도착하면 [입고 완료]를 눌러 주세요`;
            const key = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
            const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/notify`, { method: "POST",
              headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}`, "x-auth-token": req.headers.get("x-auth-token") ?? "" },
              body: JSON.stringify({ targets, message: msg.slice(0, 200), link_menu: "cnbuy", title: "중국 사입 새 입고" }) });
            if (r.ok) notified = targets.length;
          }
        } catch { /* 알림 실패는 입고 건 저장을 막지 않는다 */ }
        // 엑셀에 혼용률 열이 있으면 같이 저장 — 이번에 올린 줄에 있는 사입상품명만(2026-10-12)
        let fabrics_saved = 0;
        try {
          const inFile = new Set(rows.map((r) => String(r.sname)));
          const src2 = b.fabrics && typeof b.fabrics === "object" && !Array.isArray(b.fabrics) ? b.fabrics as Record<string, unknown> : {};
          // 2026-10-13 사용자 지정: **이미 혼용률이 적힌 상품은 엑셀 값으로 바꾸지 않는다**(직접 적은 값 보호 — 겹쳐 적히거나 수정되지 않게). 비어 있는 상품만 엑셀 값으로 채운다.
          const have = new Set((((await sbRest("cn_products?select=sname,fabric&fabric=not.is.null&limit=5000")) ?? []) as Record<string, any>[]).filter((r) => String(r.fabric ?? "").trim()).map((r) => String(r.sname)));
          fabrics_saved = await saveFabrics(Object.fromEntries(Object.entries(src2).filter(([k]) => { const n = String(txt(k, 100)); return inFile.has(n) && !have.has(n); })));
        } catch { /* 혼용률 저장 실패는 입고 건 저장을 막지 않는다 */ }
        return json({ ok: true, shipment: hideCosts(ship), line_count: rows.length, thumbs_saved, fabrics_saved, notified });
      }
      if (action === "cn_check") {
        // items: [{ line_id, qty_actual?(0 이상 정수 | null = 확인 취소), qty_defect?(0 이상 정수 | null), memo? }] — 한 번에 500줄까지('전달 수량과 같음' 일괄 기입)
        const items = (Array.isArray(b.items) ? b.items : [b]) as Record<string, any>[];
        if (!items.length || items.length > 500) return json({ error: "한 번에 500줄까지 바꿀 수 있어요" }, 400);
        // 검수 완료한 차수의 줄은 고치지 않는다 (2026-10-14 사용자 요청 — 끝낸 차수를 다시 체크해 꼬이지 않게. 고치려면 관리자·MD가 완료를 취소)
        const ids0 = [...new Set(items.map((it) => Number(it.line_id)).filter((n) => Number.isInteger(n) && n >= 1))];
        if (ids0.length) {
          const shipOf = ((await sbRest(`cn_lines?id=in.(${ids0.join(",")})&select=shipment_id`)) ?? []) as Record<string, any>[];
          const sids = [...new Set(shipOf.map((r) => Number(r.shipment_id)))];
          const locked = sids.length ? ((await sbRest(`cn_shipments?id=in.(${sids.join(",")})&checked_done=is.true&select=id,title`)) ?? []) as Record<string, any>[] : [];
          if (locked.length) return json({ error: `검수 완료된 차수예요(${locked.map((x) => x.title).join(", ")}) — 고치려면 관리자·MD가 완료를 취소해 주세요`, locked: true }, 409);
        }
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
          // 불량 수량(2026-10-19 사용자 요청) — 실제로 받은 것 중 불량 개수, null = 아직 안 적음
          if ("qty_defect" in it) {
            const q = intOrNull(it.qty_defect, 1_000_000);
            if (Number.isNaN(q)) return json({ error: "불량 수량은 0 이상의 정수로 적어 주세요" }, 400);
            patch.qty_defect = q;
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
      // 차수별 검수 완료 (2026-10-14 사용자 요청) — { id, done: true | false }. 완료 = 관리자·MD·물류팀, 완료 취소 = 관리자·MD.
      //   완료는 그 입고의 모든 옵션에 실제 수량이 적혀 있을 때만(빠짐없이 센 차수만 '끝'으로). 완료한 차수의 줄은 cn_check가 거절한다.
      // 입고 완료(2026-10-22 사용자 요청 — "입고 완료 버튼 추가, 입고 완료 후 검수 완료"): 표시 = 메뉴를 보는 사람 모두(물류팀 포함), 취소 = 관리자·MD이고 검수 완료 전만
      if (action === "cn_ship" && "arrived" in b) {
        if (typeof b.arrived !== "boolean") return json({ error: "입고 완료 값이 올바르지 않아요" }, 400);
        const sidA = Number(b.id);
        if (!Number.isInteger(sidA) || sidA < 1) return json({ error: "입고 건 번호가 올바르지 않아요" }, 400);
        const [cur] = ((await sbRest(`cn_shipments?id=eq.${sidA}&select=id,checked_done`)) ?? []) as Record<string, any>[];
        if (!cur) return json({ error: "입고 건을 찾지 못했어요" }, 404);
        if (!b.arrived) {
          if (!canEdit) return json({ error: "입고 완료 취소는 관리자·MD만 할 수 있어요" }, 403);
          if (cur.checked_done) return json({ error: "검수 완료한 입고는 입고 완료를 취소할 수 없어요 — 먼저 검수 완료를 취소해 주세요" }, 400);
        }
        const [rowA] = ((await sbRest(`cn_shipments?id=eq.${sidA}`, { method: "PATCH", body: JSON.stringify(b.arrived ? { arrived: true, arrived_by_name: authed.name, arrived_at: now } : { arrived: false, arrived_by_name: null, arrived_at: null }) })) ?? []) as Record<string, any>[];
        return json({ ok: true, shipment: hideCosts(rowA) });
      }
      if (action === "cn_ship" && "done" in b) {
        if (typeof b.done !== "boolean") return json({ error: "완료 값이 올바르지 않아요" }, 400);
        const sid0 = Number(b.id);
        if (!Number.isInteger(sid0) || sid0 < 1) return json({ error: "입고 건 번호가 올바르지 않아요" }, 400);
        if (!b.done && !canEdit) return json({ error: "검수 완료 취소는 관리자·MD만 할 수 있어요" }, 403);
        if (b.done) {
          const [sh0] = ((await sbRest(`cn_shipments?id=eq.${sid0}&select=arrived`)) ?? []) as Record<string, any>[];
          if (sh0 && !sh0.arrived) return json({ error: "먼저 [입고 완료]를 눌러 주세요 — 입고된 뒤에 검수 완료할 수 있어요" }, 400);
          const all = ((await sbRest(`cn_lines?shipment_id=eq.${sid0}&select=id,qty_actual`)) ?? []) as Record<string, any>[];
          if (!all.length) return json({ error: "옵션 줄이 없는 입고 건이에요" }, 400);
          const open = all.filter((r) => r.qty_actual === null || r.qty_actual === undefined).length;
          if (open) return json({ error: `아직 실제 수량을 안 적은 옵션이 ${open}개 있어요 — 다 적은 뒤 완료할 수 있어요` }, 400);
        }
        const [row] = ((await sbRest(`cn_shipments?id=eq.${sid0}`, { method: "PATCH", body: JSON.stringify(b.done ? { checked_done: true, checked_done_by_name: authed.name, checked_done_at: now } : { checked_done: false, checked_done_by_name: null, checked_done_at: null }) })) ?? []) as Record<string, any>[];
        if (!row) return json({ error: "입고 건을 찾지 못했어요" }, 404);
        return json({ ok: true, shipment: hideCosts(row) });
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
      if ("order_id" in b) {   // 이 입고가 어느 주문서의 것인지(null = 연결 끊기, 2026-10-19)
        if (b.order_id !== null && (await orderIdOrNull(b.order_id)) === null) return json({ error: "없는 주문서예요 — 새로고침해 주세요" }, 404);
        patch.order_id = b.order_id === null ? null : Number(b.order_id);
      }
      if ("ship_date" in b) patch.ship_date = dateOrNull(b.ship_date);
      if ("arrival_date" in b) patch.arrival_date = dateOrNull(b.arrival_date);
      if ("box_count" in b) { const bc = intOrNull(b.box_count, 100000); if (Number.isNaN(bc)) return json({ error: "박스 수량은 0 이상의 숫자예요" }, 400); patch.box_count = bc; }
      if ("note" in b) patch.note = txt(b.note, 300);
      if ("costs" in b) {
        if (!canPrice) return json({ error: "비용 내용은 관리자만 바꿀 수 있어요" }, 403);
        const c = cleanCosts(b.costs); if (c === undefined) return json({ error: "비용 내용이 올바르지 않아요" }, 400); patch.costs = c;
      }
      if (!Object.keys(patch).length) return json({ error: "바꿀 내용이 없어요" }, 400);
      const [row] = await sbRest(`cn_shipments?id=eq.${sid}`, { method: "PATCH", body: JSON.stringify(patch) }) as Record<string, any>[];
      if (!row) return json({ error: "입고 건을 찾지 못했어요" }, 404);
      return json({ ok: true, shipment: hideCosts(row) });
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
            ret_fee: e.ret_fee ?? null, fee_hold: rscanFeeHold(e),
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
        if (kind === "return") {   // 변심인데 반품 배송비 차감 없음 → 처리하지 않음(2026-10-23 사용자 요청) — 카페24에서 확인·수정 후 다시
          const cl = (((order.return ?? []) as Record<string, any>[]).find((c) => c.claim_code === claimCode)) ?? {};
          const rt = cl.claim_reason_type ?? its[0]?.claim_reason_type ?? null;
          if (rscanFeeHold({ kind, naver: false, reason_type: rt, ret_fee: rscanRetFee(cl), ...stateOf(its) })) return json({ error: rscanFeeHoldMsg(rt), fee_hold: true, reason_type: rt }, 409);
        }
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
        const hitsF = (await rscanFeeRefresh(hits, token)).map((e) => ({ ...e, fee_hold: rscanFeeHold(e) }));
        return json({ q: url.searchParams.get("q"), hits: hitsF, index: { built_at: fresh ? row!.built_at : new Date().toISOString(), row_count: payload.length, days, start_date: startDate } });
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
      hits = (await rscanFeeRefresh(hits, token)).map((e) => ({ ...e, fee_hold: rscanFeeHold(e) }));
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

    // ── 매출 구성 (2026-10-21 사용자 요청 "쿠폰할인·적립금 등 매출에서 차감된 비용도 수식에 반영") — 순익 시나리오용, 관리자, 30분 캐시 ──
    //   결제일 기준 주문의 **주문 시점 금액(initial_order_amount)** 으로 판매가 매출 → 상품 할인(추가할인·할인코드) → 쿠폰·적립금·예치금·회원등급·세트·앱·배송비 쿠폰 → 배송비 수입 → 결제 매출을 쌓는다.
    //   실주문금액(actual_order_amount)을 쓰지 않는 이유(2026-09 실측 13,032건): 취소·반품 반영 시점이 주문마다 달라(전체 반품인데 결제액은 그대로 등) 취소·반품 환불액을 따로 빼는 손익과 이중 차감된다.
    //   네이버 포인트(naver_point)는 네이버가 정산 때 보전하므로 매출에 포함(결제액 + 네이버 포인트 = 고객이 치른 돈). 상품 할인은 items(판매가×수량 − order_price)로 잡는다.
    if (action === "profit_sales") {
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);
      // 취소·반품(2026-10-21 밤 사용자 지적 "9월 순이익 1.1억 이상함" → 원인: cafe24-claims가 네이버페이 주문을 빼고 집계(네이버 CSV 별도) — 9월 실측 취소·반품의 32%가 네이버페이):
      //   같은 주문들의 품목 상태(C40 취소완료 / R00·R10·R30·R34·R40 반품)를 판매가×수량으로 모아 네이버페이까지 포함하고, 결제 매출÷판매가 매출 비율로 환불액을 추정한다.
      const RET = new Set(["R00", "R10", "R30", "R34", "R40"]);
      const sum = { orders: 0, list: 0, item_disc: 0, item_code_disc: 0, gross: 0, coupon: 0, points: 0, credits: 0, member: 0, set: 0, app: 0, coupon_ship: 0, naver: 0, ship_fee: 0, ship_disc: 0, paid: 0, naver_point: 0, qty: 0,
        cancel_list: 0, return_list: 0, naver_cancel_list: 0, naver_return_list: 0, cancel_orders: 0, return_orders: 0, naver_orders: 0, naver_list: 0 };
      await eachOrder(token, "date_type=pay_date&fields=order_id,order_place_id,market_id,initial_order_amount,naver_point,items&embed=items", s, e, (orders) => {
        for (const o of orders as Record<string, any>[]) {
          const i = (o.initial_order_amount ?? {}) as Record<string, unknown>;
          const gross = num(i.order_price_amount);
          if (gross <= 0 && num(i.payment_amount) <= 0) continue;
          sum.orders++;
          const nv = o.order_place_id === "NCHECKOUT" || o.market_id === "NCHECKOUT";
          if (nv) sum.naver_orders++;
          let anyC = false, anyR = false;
          sum.gross += gross;
          sum.coupon += num(i.coupon_discount_price); sum.points += num(i.points_spent_amount); sum.credits += num(i.credits_spent_amount);
          sum.member += num(i.membership_discount_amount); sum.set += num(i.set_product_discount_amount); sum.app += num(i.app_discount_amount);
          sum.coupon_ship += num(i.coupon_shipping_fee_amount); sum.naver += num(i.market_other_discount_amount);
          sum.ship_fee += num(i.shipping_fee); sum.ship_disc += num(i.shipping_fee_discount_amount);
          sum.paid += num(i.payment_amount); sum.naver_point += num(o.naver_point);
          for (const it of (o.items ?? []) as Record<string, any>[]) {
            const q = Number(it.quantity ?? 0) || 0, lp = (num(it.product_price) + num(it.option_price)) * q, st = String(it.order_status ?? "");
            sum.list += lp; sum.qty += q; if (nv) sum.naver_list += lp;
            sum.item_disc += num(it.additional_discount_price); sum.item_code_disc += num(it.app_item_discount_amount);
            if (st === "C40") { sum.cancel_list += lp; anyC = true; if (nv) sum.naver_cancel_list += lp; }
            else if (RET.has(st)) { sum.return_list += lp; anyR = true; if (nv) sum.naver_return_list += lp; }
          }
          if (anyC) sum.cancel_orders++;
          if (anyR) sum.return_orders++;
        }
      });
      const own = sum.coupon + sum.points + sum.credits + sum.member + sum.set + sum.app;
      const shipIncome = Math.max(0, sum.ship_fee - sum.ship_disc - sum.coupon_ship);
      const revenue = sum.gross - own + shipIncome;
      const ratio = sum.list > 0 ? revenue / sum.list : 1;   // 판매가 → 결제 매출 비율(할인·배송비 수입 반영)
      return respond({
        period: { start: s, end: e }, basis: "pay_date·initial",
        ...Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.round(v)])),
        own_discount: Math.round(own), ship_income: Math.round(shipIncome),
        // 결제 매출(고객이 치른 돈) = 정가 − 자사 할인 + 배송비 수입. 참고로 카페24 payment_amount + 네이버 포인트도 같이 준다(네이버 즉시할인 등 차이 확인용)
        revenue: Math.round(revenue), paid_plus_naver: Math.round(sum.paid + sum.naver_point),
        // 취소·반품 환불 추정 = (취소 + 반품 판매가) × 비율 — 네이버페이 포함
        claims_amount: Math.round((sum.cancel_list + sum.return_list) * ratio), cancel_amount: Math.round(sum.cancel_list * ratio), return_amount: Math.round(sum.return_list * ratio),
        naver_claims_amount: Math.round((sum.naver_cancel_list + sum.naver_return_list) * ratio), claims_ratio: ratio,
      });
    }

    // ── 결제 수단 비중 (2026-10-21 사용자 요청 "PG·네이버페이 수수료 알아서 반영") — 순익 시나리오 결제 수수료용, 관리자, 30분 캐시 ──
    //   결제일 기준 주문의 실결제액(actual_order_amount.payment_amount — 부분취소 반영)을 자사몰/네이버페이(NCHECKOUT) × 결제 수단으로 나눈다.
    //   쿠폰·적립금·마일리지는 보조 수단이라 빼고 첫 번째 주 결제 수단으로 분류. 화면이 profit_fee_rates의 수단별 수수료율을 곱해 수수료를 낸다.
    if (action === "paymix") {
      if (authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
      const s = url.searchParams.get("start_date");
      const e = url.searchParams.get("end_date");
      if (!s || !e) return json({ error: "start_date, end_date 필수 (YYYY-MM-DD)" }, 400);
      const hit = await fromCache(); if (hit) return json(hit);
      const AUX = new Set(["coupon", "point", "mileage"]);
      // 실측(2026-09, 11,080건): 자사몰 card 51%·prepaid(간편결제 선불금 — 카카오페이·네이버페이머니 등) 8.4%·tcash 5.4%·cash+icash(무통장·가상계좌) 2.7% / 네이버페이 card 30%·tcash 1.2%·cell 0.4%
      const buckets: Record<string, number> = { card: 0, tcash: 0, cash: 0, prepaid: 0, cell: 0, other: 0, naver_card: 0, naver_tcash: 0, naver_prepaid: 0, naver_other: 0 };
      let orders = 0, total = 0;
      await eachOrder(token, "date_type=pay_date&fields=order_id,payment_method,order_place_id,market_id,actual_order_amount", s, e, (list) => {
        for (const o of list as Record<string, any>[]) {
          const amt = num((o.actual_order_amount ?? {}).payment_amount);
          if (amt <= 0) continue;
          const pay = ((o.payment_method ?? []) as unknown[]).map(String).filter((m) => !AUX.has(m));
          const m = pay[0] ?? "other";
          const naver = o.order_place_id === "NCHECKOUT" || o.market_id === "NCHECKOUT";
          const key = naver ? (m === "card" ? "naver_card" : m === "tcash" ? "naver_tcash" : m === "prepaid" ? "naver_prepaid" : "naver_other")
            : (m === "card" ? "card" : m === "tcash" ? "tcash" : (m === "cash" || m === "icash") ? "cash" : m === "prepaid" ? "prepaid" : m === "cell" ? "cell" : "other");
          buckets[key] += amt; total += amt; orders++;
        }
      });
      return respond({ period: { start: s, end: e }, basis: "pay_date", orders, total: Math.round(total), buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, Math.round(v)])) });
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
      // 중국 사입 마진 원가(2026-10-22 사용자 요청 "에이전트 마진율에도 똑같이"): supply_price(카페24 공급가)는 그대로 두고(카테고리별 진열이 직접 씀)
      //   cost_src·cn_real_cost(실질 단가)·cn_vat(실제 수입 부가세 몫)·cost_vat(= 마진율 원가)를 덧붙인다 — 에이전트 marginRate가 cost_vat를 쓴다.
      try {
        const cn = await cnRealCostByProduct(token, noCache);
        for (const p of out) {
          const c = cn.get(Number(p.product_no)); if (!c) continue;
          Object.assign(p, { cost_src: "cn", cn_real_cost: c.won, cn_vat: c.vat, cost_vat: c.won + c.vat, cn_snames: c.snames, cn_with_cost: c.with_cost });
        }
      } catch { /* 실질 단가를 못 읽으면 공급가 × 1.1 그대로 */ }
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
        supply_c24?: number; cost_src?: string; cn_snames?: string[]; cn_with_cost?: boolean;
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

      // ④ 중국 사입 상품은 공급가 대신 '실질 단가'(중국 사입 관리 — 위안 × 200 × (1 + 들여오는 비용 비율), 부가세 제외) — 2026-10-16 사용자 요청
      //    "일반 상품은 공급가×1.1, 중국 사입 상품은 실질 단가×1.1로 마진율". 화면들은 supply_price × 1.1로 마진을 계산하므로 그 자리에 넣고, 원래 공급가는 supply_c24로.
      //    관리자 + MD(staff — 2026-10-16 사용자 요청 "MD도 그렇게 보이게"). 물류·CS는 공급가 그대로. 못 읽으면 공급가 그대로(cn_cost_error).
      let cnCostError: string | null = null;
      const cnCostOn = authed.role === "admin" || authed.role === "staff";
      if (cnCostOn) {
        try {
          const cn = await cnRealCostByProduct(token, noCache);
          for (const row of map.values()) {
            const c = cn.get(row.product_no); if (!c) continue;
            row.supply_c24 = row.supply_price; row.supply_price = c.won; row.cost_src = "cn"; row.cn_snames = c.snames; row.cn_with_cost = c.with_cost;
            row.cn_vat = c.vat; row.cost_vat = c.won + c.vat;   // 마진율 원가 = 실질 단가 + 실제 수입 부가세 몫(2026-10-22 — 실질 단가 × 1.1 아님)
          }
        } catch (e) { cnCostError = "중국 사입 실질 단가를 읽지 못해 공급가로 계산했어요 — " + String(e).slice(0, 120); }
      }
      const rows = [...map.values()].sort((a, b) => b.paid_qty - a.paid_qty);
      // 주문금액(판매합계)은 관리자만 — 직원·CS는 UI에서도 숨김/블러 처리되는 값이라 서버에서 0으로 제거
      if (authed.role !== "admin") for (const r of rows) r.order_amount = 0;
      return respond({ period: { start: s, end: e }, product_count: rows.length, rows, cn_cost: cnCostOn, cn_cost_error: cnCostError });
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
      price?: number; supply_price?: number; supply_c24?: number; cost_src?: string; cn_snames?: string[]; cn_with_cost?: boolean;
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

    // 마진율용 판매가·공급가 (2026-10-18 사용자 요청 — "상품 분석에도 마진율, 종합 판매 데이터와 똑같이"): performance ③④와 같은 값.
    //   판매가·공급가 = 카페24 상품 정보, 중국 사입 상품은 관리자·MD에게 공급가 자리에 실질 단가(supply_c24 = 원래 공급가). 못 읽으면 마진율만 빈칸(조회는 그대로).
    let costError: string | null = null;
    try {
      const byNo = new Map(rows.map((r) => [r.product_no, r]));
      const nos = [...byNo.keys()].filter((n) => n > 0);
      for (let i = 0; i < nos.length; i += 100) {
        const body = await apiGet(`${API_BASE}/admin/products?product_no=${nos.slice(i, i + 100).join(",")}&fields=product_no,price,supply_price&limit=100`, token);
        for (const p of (body.products ?? []) as Record<string, unknown>[]) {
          const r = byNo.get(Number(p.product_no)); if (!r) continue;
          r.price = num(p.price); r.supply_price = num(p.supply_price);
        }
      }
      if (authed.role === "admin" || authed.role === "staff") {
        const cn = await cnRealCostByProduct(token, noCache);
        for (const r of rows) {
          const c = cn.get(r.product_no); if (!c || r.supply_price === undefined) continue;
          r.supply_c24 = r.supply_price; r.supply_price = c.won; r.cost_src = "cn"; r.cn_snames = c.snames; r.cn_with_cost = c.with_cost;
          r.cn_vat = c.vat; r.cost_vat = c.won + c.vat;   // 마진율 원가 = 실질 단가 + 실제 수입 부가세 몫(2026-10-22 — 실질 단가 × 1.1 아님)
        }
      }
    } catch (e) { costError = "마진율 계산용 상품 정보를 읽지 못했어요 — " + String(e).slice(0, 120); }

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
      rows, cost_error: costError,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
