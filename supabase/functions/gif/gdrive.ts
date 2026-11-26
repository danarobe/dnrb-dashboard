// 구글 드라이브에 저장 (GIF 만들기 › [구글 드라이브에 저장], 2026-11-26 사용자 요청 — "구글 계정 연결, 대표(관리자)만")
//   읽기용 서비스 계정(drive.ts)은 저장 공간이 0이라 사용자 드라이브에 파일을 만들 수 없다(구글 정책)
//   → 드라이브 주인 구글 계정을 한 번 연결(OAuth 동의)해 두고, 그 계정 이름으로 파일을 만든다.
//   · 연결·끊기·저장·새 폴더 = 관리자만(index.ts 가 막는다).
//   · secrets: GOOGLE_OAUTH_CLIENT_ID · GOOGLE_OAUTH_CLIENT_SECRET (구글 클라우드의 OAuth 클라이언트 — 웹 애플리케이션)
//   · 동의 뒤 구글이 돌아오는 주소 = 정적 화면 gif/gauth.html (그 화면이 로그인한 관리자 이름으로 /api/gdrive/finish 를 부른다)
//   · 다시 쓸 수 있는 연결 증표(refresh token)는 암호화해서 표 gif_gdrive 에만 둔다(키 = AUTH_SECRET 에서 갈라 씀 — AUTH_SECRET 을 바꾸면 다시 연결).
//   · 저장할 폴더 번호는 drive.ts 가 서명해 내려 준 것만 받는다 → 지정 폴더(ROOT_NAMES) 아래에만 저장된다.
//   · 구글로 보내는 쓰기 = 폴더 만들기(mkdir) · GIF 파일 만들기/같은 이름 파일 내용 바꾸기(upload) 두 가지뿐. 지우기 없음.
import { DriveError, signId } from "./drive.ts";

const SCOPE = "https://www.googleapis.com/auth/drive";
const REDIRECT_DEFAULT = "https://danarobe.github.io/dnrb-dashboard/gif/gauth.html";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** GIF 한 개 최대 크기 */
export const MAX_GIF_BYTES = 40_000_000;

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = (Deno.env.get("SB_SERVICE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))!;
const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...((init.headers ?? {}) as Record<string, string>) } });

function client(): { id: string; secret: string } {
  const id = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "", secret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? "";
  if (!id || !secret) throw new DriveError("gdrive_not_configured", 503);
  return { id, secret };
}
export const gdriveConfigured = () => !!(Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") && Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET"));
export const redirectUri = () => Deno.env.get("GIF_GAUTH_REDIRECT") || REDIRECT_DEFAULT;

const te = new TextEncoder(), td = new TextDecoder();
const b64u = (bytes: Uint8Array) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
function sameStr(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
async function keyBytes(label: string): Promise<Uint8Array> {
  const secret = Deno.env.get("AUTH_SECRET") ?? "";
  if (!secret) throw new DriveError("server", 500);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(`${secret}|${label}`)));
}

// ── 동의 화면에 다녀오는 동안 쓰는 증표(state): 누른 관리자 본인 것만, 10분 ──
async function stateSig(payload: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", await keyBytes("gif-gdrive-state"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode(payload))));
}
async function makeState(uid: string): Promise<string> {
  const payload = `${b64u(te.encode(uid))}.${Date.now() + 600_000}.${b64u(crypto.getRandomValues(new Uint8Array(12)))}`;
  return `${payload}.${await stateSig(payload)}`;
}
async function checkState(state: unknown, uid: string): Promise<boolean> {
  if (typeof state !== "string" || state.length > 600) return false;
  const p = state.split(".");
  if (p.length !== 4) return false;
  const payload = p.slice(0, 3).join(".");
  if (!sameStr(await stateSig(payload), p[3])) return false;
  if (!(Number(p[1]) > Date.now())) return false;
  try { return td.decode(unb64u(p[0])) === uid; } catch { return false; }
}

// ── 연결 증표 암호화 (AES-GCM) ──
async function aesKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", await keyBytes("gif-gdrive-token"), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function enc(text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), te.encode(text)));
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}
async function dec(v: string): Promise<string> {
  const p = String(v).split(".");
  if (p.length !== 3 || p[0] !== "v1") throw new Error("bad");
  return td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(p[1]) }, await aesKey(), unb64u(p[2])));
}

type Row = { refresh_enc: string; email: string; by_name: string; at: string };
async function row(): Promise<Row | null> {
  const r = await rest("gif_gdrive?id=eq.main&select=refresh_enc,email,by_name,at");
  if (!r.ok) throw new DriveError("server", 500);
  return (await r.json())[0] ?? null;
}

/** 지금 상태(관리자 화면용). 연결 증표는 내보내지 않는다. */
export async function gdriveStatus() {
  const configured = gdriveConfigured();
  const r = await row();
  return { configured, connected: !!r, email: r?.email ?? "", by: r?.by_name ?? "", at: r ? new Date(r.at).getTime() : null, redirect: redirectUri() };
}

/** 구글 동의 화면 주소 */
export async function startUrl(uid: string): Promise<string> {
  const { id } = client();
  return "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: id, redirect_uri: redirectUri(), response_type: "code", scope: SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "false", state: await makeState(uid),
  });
}

async function tokenCall(params: Record<string, string>): Promise<{ ok: boolean; d: Record<string, unknown> }> {
  const { id, secret } = client();
  const res = await fetch(TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...params }), signal: AbortSignal.timeout(15000),
  });
  const d = await res.json().catch(() => ({}));
  return { ok: res.ok, d };
}
async function revoke(token: string) {
  try { await (await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10000) })).body?.cancel(); } catch { /* 구글 쪽 끊기는 실패해도 우리 쪽 연결은 지운다 */ }
}

let acc: { v: string; exp: number; of: string } | null = null;

/** 동의하고 돌아온 코드를 연결 증표로 바꿔 저장한다 */
export async function finish(me: { id: string; name: string }, code: unknown, state: unknown) {
  if (!(await checkState(state, me.id))) throw new DriveError("bad_state", 400);
  if (typeof code !== "string" || !code || code.length > 2000) throw new DriveError("bad_code", 400);
  const { ok, d } = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });
  if (!ok || typeof d.access_token !== "string") throw new DriveError("gdrive_exchange", 400);
  const access = d.access_token as string;
  if (typeof d.refresh_token !== "string" || !d.refresh_token) { await revoke(access); throw new DriveError("gdrive_no_refresh", 400); }
  if (!String(d.scope ?? "").split(" ").includes(SCOPE)) { await revoke(d.refresh_token as string); throw new DriveError("gdrive_scope", 400); }   // 동의 화면에서 드라이브 칸을 끔
  let email = "";
  try {
    const a = await fetch(`${API}/about?fields=user(emailAddress)`, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15000) });
    email = String((await a.json().catch(() => ({})))?.user?.emailAddress ?? "").slice(0, 200);
  } catch { /* 주소를 못 읽어도 연결은 된다 */ }
  const old = await row().catch(() => null);
  const refresh_enc = await enc(d.refresh_token as string);
  const r = await rest("gif_gdrive?on_conflict=id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id: "main", refresh_enc, email, by_id: me.id, by_name: me.name, at: new Date().toISOString() }),
  });
  if (!r.ok) { await revoke(d.refresh_token as string); throw new DriveError("server", 500); }
  if (old) { try { await revoke(await dec(old.refresh_enc)); } catch { /* 예전 연결 */ } }
  acc = { v: access, exp: Date.now() + Number(d.expires_in ?? 3600) * 1000, of: refresh_enc };
  return { connected: true, email };
}

/** 연결 끊기: 구글 쪽 동의도 거두고 우리 쪽 증표를 지운다 */
export async function disconnect() {
  const r = await row();
  if (r) { try { await revoke(await dec(r.refresh_enc)); } catch { /* 풀지 못한 예전 증표 */ } }
  const d = await rest("gif_gdrive?id=eq.main", { method: "DELETE", headers: { Prefer: "return=minimal" } });
  if (!d.ok) throw new DriveError("server", 500);
  acc = null;
  return { connected: false };
}

async function access(): Promise<string> {
  const r = await row();
  if (!r) throw new DriveError("gdrive_not_connected", 409);
  if (acc && acc.of === r.refresh_enc && acc.exp - Date.now() > 60_000) return acc.v;
  let refresh = "";
  try { refresh = await dec(r.refresh_enc); } catch { throw new DriveError("gdrive_expired", 409); }
  const { ok, d } = await tokenCall({ grant_type: "refresh_token", refresh_token: refresh });
  if (!ok || typeof d.access_token !== "string") throw new DriveError(d.error === "invalid_grant" ? "gdrive_expired" : "gdrive_auth", d.error === "invalid_grant" ? 409 : 502);
  acc = { v: d.access_token as string, exp: Date.now() + Number(d.expires_in ?? 3600) * 1000, of: r.refresh_enc };
  return acc.v;
}

async function gfetch(url: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(url, { ...init, headers: { Authorization: `Bearer ${await access()}`, ...((init.headers ?? {}) as Record<string, string>) }, signal: AbortSignal.timeout(120000) });
}
// 구글이 거절한 이유를 우리 말로 (구글 응답 글은 화면에 내보내지 않는다)
async function fail(res: Response): Promise<never> {
  const d = await res.json().catch(() => ({}));
  const reason = String(d?.error?.errors?.[0]?.reason ?? "");
  if (res.status === 401) { acc = null; throw new DriveError("gdrive_expired", 409); }
  if (res.status === 404) throw new DriveError("gdrive_no_folder", 409);          // 연결한 계정에 이 폴더가 안 보임
  if (res.status === 403 && /quota/i.test(reason)) throw new DriveError("gdrive_quota", 409);
  if (res.status === 403) throw new DriveError("gdrive_no_edit", 409);            // 연결한 계정에 편집 권한 없음
  throw new DriveError("gdrive_failed", 502);
}

// 파일·폴더 이름: 경로 글자·제어 글자를 빼고 길이를 줄인다
function cleanName(v: unknown, max: number): string {
  // deno-lint-ignore no-control-regex
  return (typeof v === "string" ? v : "").normalize("NFC").replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, max).trim();
}
const qName = (name: string) => [...new Set([name.normalize("NFC"), name.normalize("NFD")])]
  .map((n) => `name = '${n.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(" or ");

async function findIn(parentId: string, name: string, folder: boolean): Promise<{ id: string; name: string }[]> {
  const q = `'${parentId}' in parents and trashed = false and (${qName(name)}) and mimeType ${folder ? "=" : "!="} '${FOLDER_MIME}'`;
  const res = await gfetch(`${API}/files?${new URLSearchParams({ q, fields: "files(id, name)", pageSize: "20", supportsAllDrives: "true", includeItemsFromAllDrives: "true" })}`);
  if (!res.ok) return await fail(res);
  return ((await res.json().catch(() => ({}))).files ?? []) as { id: string; name: string }[];
}

/** 새 폴더 (같은 이름 폴더가 이미 있으면 그 폴더) */
export async function mkdir(parentId: string, rawName: unknown) {
  const name = cleanName(rawName, 60);
  if (!name) throw new DriveError("bad_name", 400);
  const had = await findIn(parentId, name, true);
  let id = had[0]?.id ?? "";
  if (!id) {
    const res = await gfetch(`${API}/files?supportsAllDrives=true&fields=id`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    if (!res.ok) return await fail(res);
    id = String((await res.json().catch(() => ({}))).id ?? "");
    if (!id) throw new DriveError("gdrive_failed", 502);
  }
  return { id, name, k: await signId("d", id), existed: !!had.length };
}

const isGif = (b: Uint8Array) => b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61;

/** GIF 한 개를 폴더에 저장. 같은 이름 파일이 있으면 replace 일 때만 그 파일의 내용을 바꾼다(구글이 예전 판을 보관). */
export async function upload(me: { id: string; name: string }, parentId: string, rawName: unknown, bytes: Uint8Array, replace: boolean) {
  if (!bytes.length || bytes.length > MAX_GIF_BYTES) throw new DriveError("too_big", 413);
  if (!isGif(bytes)) throw new DriveError("not_gif", 415);
  let name = cleanName(rawName, 100).replace(/\.gif$/i, "").trim() || "gif_text";
  name += ".gif";
  const had = await findIn(parentId, name, false);
  if (had.length && !replace) throw new DriveError("exists", 409);
  if (had.length > 1) throw new DriveError("many", 409);       // 같은 이름이 여러 개면 어느 것을 바꿀지 알 수 없다
  let res: Response;
  if (had.length) {
    res = await gfetch(`${UPLOAD}/files/${had[0].id}?uploadType=media&supportsAllDrives=true&fields=id,name,webViewLink`, { method: "PATCH", headers: { "Content-Type": "image/gif" }, body: bytes });
  } else {
    const bd = "gm" + b64u(crypto.getRandomValues(new Uint8Array(18)));
    const head = `--${bd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parentId], mimeType: "image/gif" })}\r\n--${bd}\r\nContent-Type: image/gif\r\n\r\n`;
    res = await gfetch(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`, {
      method: "POST", headers: { "Content-Type": `multipart/related; boundary=${bd}` },
      body: new Blob([te.encode(head), bytes, te.encode(`\r\n--${bd}--`)]),
    });
  }
  if (!res.ok) return await fail(res);
  const f = await res.json().catch(() => ({}));
  if (!f.id) throw new DriveError("gdrive_failed", 502);
  // 누가 무엇을 저장했는지 남긴다(실패해도 저장은 된 것)
  try {
    await (await rest("gif_gdrive_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ by_id: me.id, by_name: me.name, folder_id: parentId, file_id: String(f.id), name, bytes: bytes.length, replaced: !!had.length }) })).body?.cancel();
  } catch { /* 기록 실패 */ }
  const link = typeof f.webViewLink === "string" && /^https:\/\/(drive|docs)\.google\.com\//.test(f.webViewLink) ? f.webViewLink : "";
  return { id: String(f.id), name, link, replaced: !!had.length };
}
