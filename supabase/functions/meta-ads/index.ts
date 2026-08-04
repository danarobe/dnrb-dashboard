// ═══════════════════════════════════════════════
// Meta(페이스북·인스타그램) 광고관리자 연동 함수 — 관리자 전용
//   GET ?action=summary&start_date&end_date → 기간 광고비·구매전환값·구매수·meta ROAS
//   GET ?action=topads&start_date&end_date  → 지출 상위 10개 소재 (광고명/지출/구매당비용/구매수/전환값/ROAS/빈도)
//   GET ?action=preview&ad_id=...           → 소재 미리보기(iframe HTML) + 썸네일
//
// 필요 secrets: META_ACCESS_TOKEN (비즈니스 설정 > 시스템 사용자 토큰, ads_read 권한),
//               META_AD_ACCOUNT_ID (act_ 제외 숫자만 또는 act_숫자)
// ═══════════════════════════════════════════════
import { handleOptions, json, verifyAuthToken } from "../_shared/util.ts";

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

const num = (v: unknown) => {
  const n = parseFloat(String(v ?? "0"));
  return isFinite(n) ? n : 0;
};

// actions/action_values 배열에서 구매 항목 추출 (픽셀 설정에 따라 purchase 또는 omni_purchase)
function pickPurchase(arr: unknown): number {
  const list = (arr ?? []) as { action_type?: string; value?: unknown }[];
  for (const t of ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"]) {
    const hit = list.find((a) => a.action_type === t);
    if (hit) return num(hit.value);
  }
  return 0;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  // 광고비·ROAS는 매출 역산이 가능하므로 관리자 전용
  const authed = await verifyAuthToken(req);
  if (!authed || authed.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);

  const c = creds();
  if (!c) return json({ error: "not_connected", message: "Meta 연동이 설정되지 않았습니다 (META_ACCESS_TOKEN / META_AD_ACCOUNT_ID)" }, 200);

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "summary";

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

      // topads — 소재(광고) 단위, 지출 내림차순 상위 10
      const body = await graphGet(`${c.account}/insights`, {
        time_range: timeRange,
        level: "ad",
        fields: "ad_id,ad_name,spend,actions,action_values,purchase_roas,frequency,cost_per_action_type",
        sort: "spend_descending",
        limit: "10",
      }, c.token);
      const ads = ((body.data ?? []) as Record<string, unknown>[]).map((r) => {
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
      });
      return json({ period: { start: s, end: e }, ads });
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
