// 구글 드라이브 읽기 (GIF 메이커 — 지정 폴더의 사진을 바로 불러오기, 2026-11-26)
//   서비스 계정 키 = secret GOOGLE_SERVICE_ACCOUNT_KEY(JSON). 읽기 전용 권한만 쓴다.
//   그 서비스 계정에 '공유'해 준 폴더만 보인다. 지정 폴더 = 이름이 ROOT_NAMES 인 폴더와 그 아래.
//   화면에는 폴더·파일 번호와 함께 서버 서명(k)을 내려 주고, 서명이 맞는 번호만 다시 받아 준다
//   → 지정 폴더에서 눌러 들어간 것 말고 다른 파일 번호를 넣어 받아 갈 수 없다.

/** 지정 폴더 이름 (사용자 지정 2026-11-26 — 우선 '01_보정완료'). 늘리려면 여기에 이름을 추가. */
export const ROOT_NAMES = ["01_보정완료"];

const FOLDER_MIME = "application/vnd.google-apps.folder";
const IMG_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/avif"]);
const API = "https://www.googleapis.com/drive/v3";
const ID_RE = /^[A-Za-z0-9_-]{10,100}$/;
/** 사진 한 장 최대 크기 */
export const MAX_FILE_BYTES = 80_000_000;

export class DriveError extends Error {
  code: string; status: number;
  constructor(code: string, status: number, msg?: string) { super(msg ?? code); this.code = code; this.status = status; }
}

function serviceKey(): { email: string; pk: string } {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "";
  if (!raw) throw new DriveError("drive_not_configured", 503);
  // 키 내용이 오류 문구에 섞여 나가지 않게 고정 문구로
  let k: { client_email?: string; private_key?: string };
  try { k = JSON.parse(raw); } catch { throw new DriveError("drive_bad_key", 503); }
  if (!k.client_email || !k.private_key) throw new DriveError("drive_bad_key", 503);
  return { email: k.client_email, pk: k.private_key };
}

export const driveConfigured = () => !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
/** 폴더를 공유해 줄 서비스 계정 주소(비밀값 아님 — 화면 안내용) */
export function driveShareEmail(): string | null { try { return serviceKey().email; } catch { return null; } }

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uStr = (s: string) => b64u(new TextEncoder().encode(s));

let tok: { v: string; exp: number } | null = null;
async function token(): Promise<string> {
  if (tok && tok.exp - Date.now() > 60_000) return tok.v;
  const { email, pk } = serviceKey();
  const der = Uint8Array.from(atob(pk.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch { throw new DriveError("drive_bad_key", 503); }
  const now = Math.floor(Date.now() / 1000);
  const head = b64uStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64uStr(JSON.stringify({ iss: email, scope: "https://www.googleapis.com/auth/drive.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = b64u(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claim}`))));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new DriveError("drive_auth", 502);
  tok = { v: d.access_token, exp: Date.now() + Number(d.expires_in ?? 3600) * 1000 };
  return tok.v;
}

async function gget(path: string, qs: Record<string, string>): Promise<Response> {
  return await fetch(`${API}/${path}?${new URLSearchParams(qs)}`, { headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(25000) });
}

// ── 서명 (AUTH_SECRET에서 갈라 쓴 키) ──
let hkey: CryptoKey | null = null;
async function hmac(data: string): Promise<string> {
  if (!hkey) {
    const secret = Deno.env.get("AUTH_SECRET") ?? "";
    if (!secret) throw new DriveError("server", 500);
    hkey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret + "|gif-drive"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", hkey, new TextEncoder().encode(data)))).slice(0, 32);
}
function sameStr(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
export const signId = (kind: "d" | "f", id: string) => hmac(`${kind}|${id}`);
export async function checkId(kind: "d" | "f", id: unknown, k: unknown): Promise<string> {
  if (typeof id !== "string" || !ID_RE.test(id) || typeof k !== "string" || !sameStr(await signId(kind, id), k)) throw new DriveError("bad_id", 400);
  return id;
}
const thumbHostOk = (u: URL) => u.protocol === "https:" && /(^|\.)googleusercontent\.com$/.test(u.hostname) && !u.username && !u.password && !u.port;

// 이름 순서: 사람이 세는 숫자 순서(2 < 10)
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "ko", { numeric: true, sensitivity: "base" });

/** 지정 폴더(이름이 ROOT_NAMES 인, 서비스 계정에 보이는 폴더) */
export async function listRoots() {
  // 맥에서 올린 폴더 이름은 자모가 풀린 꼴(NFD)로 저장되기도 해서 두 꼴 모두로 찾는다
  const names = [...new Set(ROOT_NAMES.flatMap((n) => [n.normalize("NFC"), n.normalize("NFD")]))];
  const q = `(${names.map((n) => `name = '${n.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(" or ")}) and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const res = await gget("files", { q, fields: "files(id, name)", pageSize: "50", corpora: "allDrives", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new DriveError("drive_list", 502);
  const roots = [];
  for (const f of d.files ?? []) {
    if (!ID_RE.test(f.id)) continue;
    roots.push({ id: f.id, name: String(f.name ?? "").normalize("NFC"), k: await signId("d", f.id) });
  }
  return roots.sort(byName);
}

/** 폴더 바로 아래의 폴더와 사진 */
export async function listFolder(folderId: string) {
  const folders: { id: string; name: string; k: string }[] = [];
  const images: { id: string; name: string; size: number; w: number; h: number; k: string; t: string; tk: string }[] = [];
  let other = 0, page = "";
  for (let i = 0; i < 10; i++) {
    const res = await gget("files", {
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, size, thumbnailLink, imageMediaMetadata(width, height, rotation))",
      pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
      ...(page ? { pageToken: page } : {}),
    });
    const d = await res.json().catch(() => ({}));
    if (res.status === 404) throw new DriveError("drive_not_found", 404);
    if (!res.ok) throw new DriveError("drive_list", 502);
    for (const f of d.files ?? []) {
      if (!ID_RE.test(f.id)) continue;
      const name = String(f.name ?? "").normalize("NFC");
      if (f.mimeType === FOLDER_MIME) folders.push({ id: f.id, name, k: await signId("d", f.id) });
      else if (IMG_MIME.has(f.mimeType)) {
        let t = "", tk = "";
        try {
          const u = new URL(String(f.thumbnailLink || ""));
          if (thumbHostOk(u)) { t = u.href.replace(/=s\d+$/, "=s400"); tk = await hmac(`t|${t}`); }
        } catch { /* 미리보기 없음 */ }
        const m = f.imageMediaMetadata ?? {};
        const rot = Number(m.rotation) === 1 || Number(m.rotation) === 3;   // 옆으로 누운 사진
        images.push({ id: f.id, name, size: Number(f.size ?? 0), w: Number((rot ? m.height : m.width) ?? 0), h: Number((rot ? m.width : m.height) ?? 0), k: await signId("f", f.id), t, tk });
      } else other++;
    }
    page = d.nextPageToken ?? "";
    if (!page) break;
  }
  return { folders: folders.sort(byName), images: images.sort(byName), other };
}

/** 미리보기(작은 사진). 주소는 목록에서 서버가 서명해 내려 준 것만 받는다. */
export async function fetchThumb(raw: unknown, k: unknown): Promise<Response> {
  if (typeof raw !== "string" || raw.length > 2000 || typeof k !== "string" || !sameStr(await hmac(`t|${raw}`), k)) throw new DriveError("bad_id", 400);
  const u = new URL(raw);
  if (!thumbHostOk(u)) throw new DriveError("bad_id", 400);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${await token()}` }, redirect: "manual", signal: AbortSignal.timeout(20000) });
  if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new DriveError("drive_thumb", r.status === 404 ? 404 : 502); }
  return r;
}

/** 원본 사진 */
export async function fetchFile(fileId: string): Promise<Response> {
  const r = await fetch(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(120000) });
  if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new DriveError(r.status === 404 ? "drive_not_found" : "drive_file", r.status === 404 ? 404 : 502); }
  if (Number(r.headers.get("content-length") ?? 0) > MAX_FILE_BYTES) { await r.body?.cancel().catch(() => {}); throw new DriveError("too_big", 413); }
  return r;
}
