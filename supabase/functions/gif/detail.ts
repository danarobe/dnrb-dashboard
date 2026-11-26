// 상세페이지 사진 불러오기: 다나로브 상품 상세 사진을 대신 받아 준다
// 아무 주소나 받아 주는 통로가 되지 않게 다나로브 쇼핑몰과 그 사진 서버만 허용한다.
export const PAGE_HOSTS = new Set(["danarobe.com", "www.danarobe.com", "m.danarobe.com"]);
export const IMG_HOSTS = new Set([...PAGE_HOSTS, "cafe24img.poxo.com", "wnqka5000.cafe24.com", "ecimg.cafe24img.com"]);
export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
/** 사진 한 장은 여기까지만 */
export const MAX_IMG_TOTAL = 48_000_000;

export function allowedUrl(raw: unknown, hosts: Set<string>): URL | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !hosts.has(u.hostname) || u.username || u.password || (u.port && u.port !== "80" && u.port !== "443")) return null;
    u.protocol = "https:";
    return u;
  } catch { return null; }
}

/** 리다이렉트도 허용한 주소 안에서만 따라간다 */
export async function fetchAllowed(u: URL, hosts: Set<string>, init: RequestInit = {}): Promise<Response | null> {
  let cur = u;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(cur, { ...init, redirect: "manual", signal: AbortSignal.timeout(25000), headers: { "user-agent": UA, ...(init.headers || {}) } });
    if (r.status >= 300 && r.status < 400) {
      await r.body?.cancel().catch(() => {});
      const next = allowedUrl(new URL(r.headers.get("location") || "", cur).href, hosts);
      if (!next) return null;
      cur = next;
      continue;
    }
    return r;
  }
  return null;
}

/** 상품 페이지의 상세정보 칸(#prdDetail ~ #prdInfo) 안 사진 + 대표 사진 */
export function parseDetail(html: string, base: URL) {
  const title = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || "";
  const a = html.indexOf('id="prdDetail"');
  const b = a >= 0 ? html.indexOf('id="prdInfo"', a) : -1;
  const seg = a >= 0 ? html.slice(a, b > a ? b : a + 400000) : "";
  const images: string[] = [];
  for (const tag of seg.match(/<img\b[^>]*>/gi) || []) {
    const m = tag.match(/\b(?:ec-data-src|data-src|src)="([^"]+)"/i);
    if (!m || !m[1] || m[1].startsWith("data:")) continue;
    try {
      const abs = allowedUrl(new URL(m[1].replace(/&amp;/g, "&"), base).href, IMG_HOSTS);
      if (abs && !images.includes(abs.href)) images.push(abs.href);
    } catch { /* 건너뜀 */ }
    if (images.length >= 60) break;
  }
  const big = (html.match(/<img[^>]+src="([^"]+\/web\/product\/big\/[^"]+)"/) || [])[1];
  let main: string | null = null;
  if (big) { try { main = allowedUrl(new URL(big, base).href, IMG_HOSTS)?.href ?? null; } catch { /* 없음 */ } }
  return { title: decodeEntities(title), main, images };
}

function decodeEntities(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
