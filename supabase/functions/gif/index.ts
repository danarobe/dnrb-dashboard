// ═══════════════════════════════════════════════════════════════
// GIF 메이커 (워크스페이스 내장, 2026-11-26 사용자 요청)
//   기존 GIF 메이커(카카오 로그인·별도 서버)와 연동하지 않는 별개 프로그램 — 계정은 워크스페이스 계정.
//   쓸 수 있는 사람 = 관리자(대표 포함) + MD/컨텐츠(staff·marketer). CS팀·물류팀 403.
//   주소: /functions/v1/gif/api/…  (화면 gif/gm-ws.js 가 도구 화면의 '/api/…' 호출을 여기로 돌린다)
//     GET  /api/me                                   내 권한
//     GET·POST /api/projects · GET·PATCH·DELETE /api/projects/{id} · POST /api/projects/{id}/share|unshare · POST /api/projects/upload-urls
//     GET·POST /api/perms                            프로젝트 권한(관리자만) — 계정별 읽기/쓰기
//     GET·POST /api/templates · PATCH·DELETE /api/templates/{id} · POST /api/template-names
//     GET  /api/detail?url= · /api/detail-img?u=     다나로브 상세 사진 대신 받기
//     GET  /api/drive/list · /api/drive/thumb · /api/drive/file   구글 드라이브 지정 폴더
//   내 프로젝트 / 공유 프로젝트 (2026-11-26 사용자 요청, migrations/0093 gif_projects.shared):
//     내 프로젝트(shared=false) = 만든 사람만 보기·고치기·지우기(권한과 상관없음 — 관리자도 남의 것은 안 보임). 새로 만들면 여기.
//     [공유하기](POST /api/projects/{id}/share) = 만든 사람이 공유 프로젝트로 옮김 — 공유 프로젝트 쓰기 권한(관리자 포함)이 있을 때만.
//     [내 프로젝트로 되돌리기](POST /api/projects/{id}/unshare) = 관리자, 또는 공유 프로젝트 쓰기 권한이 있는 만든 사람 → 만든 사람의 내 프로젝트로
//       (같은 날 사용자 요청. 보안 점검: 권한이 빠진 만든 사람이 팀이 고친 프로젝트를 빼 가지 못하게 공유하기와 같은 조건, 누가·언제는 unshared_* 칸에)
//     공유 프로젝트(shared=true) = 프로젝트 권한: 관리자 = 항상 쓰기. MD/컨텐츠 = gif_perms 에 준 만큼(read 읽기 / write 쓰기), 없으면 못 봄.
//       읽기 = 목록·열기 / 쓰기 = 고치기 / 지우기 = 만든 사람(쓰기 권한이 있을 때) 또는 관리자.
// ═══════════════════════════════════════════════════════════════
import { verifyAuthToken } from "../_shared/util.ts";
import { BUCKET, BUILTIN_IDS, FILE_RE, ID_RE, MAX_PHOTOS, MAX_PROJECTS, ROOT, cleanNewData, cleanTemplateData, cleanTemplateName, mergeEdit, type ProjectData } from "./projects.ts";
import { IMG_HOSTS, MAX_IMG_TOTAL, PAGE_HOSTS, allowedUrl, fetchAllowed, parseDetail } from "./detail.ts";
import { DriveError, checkId, driveConfigured, driveShareEmail, fetchFile, fetchThumb, listFolder, listRoots, ROOT_NAMES } from "./drive.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-auth-token",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Max-Age": "600",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const err = (error: string, status: number, more: Record<string, unknown> = {}) => json({ error, ...more }, status);

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = (Deno.env.get("SB_SERVICE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))!;
const sbHeaders = (more: Record<string, string> = {}) => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...more });
const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: sbHeaders((init.headers ?? {}) as Record<string, string>) });
const storage = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/storage/v1/${path}`, { ...init, headers: sbHeaders((init.headers ?? {}) as Record<string, string>) });
const enc = encodeURIComponent;
const ms = (t: string) => new Date(t).getTime();

type Me = { id: string; name: string; admin: boolean };
type Level = "write" | "read" | "none";

async function projLevel(me: Me): Promise<Level> {
  if (me.admin) return "write";
  const r = await rest(`gif_perms?user_id=eq.${enc(me.id)}&select=level`);
  if (!r.ok) throw new Error("db");
  const lv = (await r.json())[0]?.level;
  return lv === "write" ? "write" : lv === "read" ? "read" : "none";
}

// ── 프로젝트 ──
const P_COLS = "id,name,rev,updated_at,data,created_by,created_by_name,shared,shared_at,shared_by_name";
type PRow = { id: string; name: string; rev: number; updated_at: string; data: ProjectData; created_by: string | null; created_by_name: string; shared: boolean; shared_at: string | null; shared_by_name: string };
const ownerName = (r: PRow) => r.created_by_name || "기존 GIF 메이커";
const isMine = (r: PRow, me: Me) => !!r.created_by && r.created_by === me.id;
// 이 프로젝트에 내가 할 수 있는 것. 남의 내 프로젝트는 아예 없는 것처럼(404) 다룬다.
function rights(r: PRow, me: Me, lv: Level) {
  const mine = isMine(r, me);
  if (!r.shared) return { see: mine, edit: mine, del: mine, share: mine && lv === "write", unshare: false };
  return { see: lv !== "none", edit: lv === "write", del: me.admin || (lv === "write" && mine), share: false, unshare: !!r.created_by && (me.admin || (mine && lv === "write")) };
}

async function projectsList(me: Me, lv: Level) {
  // 공유 프로젝트(권한이 있을 때) + 내가 만든 내 프로젝트
  const meQ = `created_by.eq.${JSON.stringify(me.id)}`;
  const where = lv === "none" ? `shared=is.false&created_by=eq.${enc(me.id)}` : `or=${enc(`(shared.is.true,and(shared.is.false,${meQ}))`)}`;
  const r = await rest(`gif_projects?select=${P_COLS}&${where}&order=updated_at.desc&limit=1000`);
  if (!r.ok) return err("db", 500);
  const rows = (await r.json() as PRow[]).filter((p) => rights(p, me, lv).see);
  return json({
    level: lv,
    projects: rows.map((p) => {
      const d = (p.data ?? {}) as Partial<ProjectData>;
      const mine = isMine(p, me), rt = rights(p, me, lv);
      return {
        id: p.id, name: p.name, rev: p.rev, updated: ms(p.updated_at),
        mine, shared: !!p.shared, sharedAt: p.shared_at ? ms(p.shared_at) : null, sharedBy: p.shared ? (p.shared_by_name || "") : "",
        ownerId: ROOT, ownerName: mine ? "" : ownerName(p), canEdit: rt.edit, canDelete: rt.del, canShare: rt.share, canUnshare: rt.unshare,
        thumb: d.thumb ?? "", photoCount: Array.isArray(d.photos) ? d.photos.length : 0,
      };
    }),
  });
}

async function projectCreate(me: Me, body: any) {
  const id = typeof body?.id === "string" ? body.id : "";
  if (!ID_RE.test(id)) return err("bad_id", 400);
  const data = cleanNewData(body?.data, id);
  if (!data) return err("bad_data", 400);
  const name = (typeof body?.name === "string" ? body.name : "").trim().slice(0, 100) || "상품";
  if (await projectCount() >= MAX_PROJECTS) return err("too_many", 400);
  const r = await rest("gif_projects", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ id, name, data, shared: false, created_by: me.id, created_by_name: me.name, updated_by: me.id, updated_by_name: me.name }),
  });
  if (r.status === 409) return err("exists", 409);   // 같은 id가 이미 있음
  if (!r.ok) return err("db", 500);
  const row = (await r.json())[0];
  return json({ id: row.id, ownerId: ROOT, rev: row.rev, updated: ms(row.updated_at), shared: false });
}

async function projectCount(): Promise<number> {
  const r = await rest("gif_projects?select=id", { method: "HEAD", headers: { Prefer: "count=exact" } });
  return Number((r.headers.get("content-range") ?? "").split("/")[1] ?? 0) || 0;
}

async function projectRow(id: string): Promise<PRow | null> {
  const r = await rest(`gif_projects?id=eq.${enc(id)}&select=${P_COLS}`);
  if (!r.ok) throw new Error("db");
  return (await r.json())[0] ?? null;
}

async function projectGet(me: Me, lv: Level, id: string) {
  const row = await projectRow(id);
  if (!row || !rights(row, me, lv).see) return row && row.shared ? err("no_permission", 403) : err("not_found", 404);
  const data = row.data;
  const paths = [...(data.photos ?? []).map((p) => p.path), ...(data.gifPath ? [data.gifPath] : [])];
  const urls: Record<string, string> = {};
  if (paths.length) {
    const s = await storage(`object/sign/${BUCKET}`, { method: "POST", body: JSON.stringify({ expiresIn: 3600, paths }) });
    if (!s.ok) return err("storage", 500);
    for (const x of await s.json() as { path?: string; signedURL?: string }[]) {
      if (x.path && x.signedURL) urls[x.path] = `${SB_URL}/storage/v1${x.signedURL}`;
    }
  }
  const mine = isMine(row, me), rt = rights(row, me, lv);
  return json({
    project: {
      id: row.id, name: row.name, rev: row.rev, updated: ms(row.updated_at),
      mine, shared: !!row.shared, sharedAt: row.shared_at ? ms(row.shared_at) : null, sharedBy: row.shared ? (row.shared_by_name || "") : "",
      ownerId: ROOT, ownerName: mine ? "" : ownerName(row), canEdit: rt.edit, canDelete: rt.del, canShare: rt.share, canUnshare: rt.unshare,
      ...data,
    },
    urls,
  });
}

// 수정. rev 가 서버와 다르면 그 사이 다른 사람이 고친 것 → 409
async function projectPatch(me: Me, lv: Level, id: string, body: any) {
  const rev = Number(body?.rev);
  if (!Number.isInteger(rev) || rev < 1) return err("bad_rev", 400);
  const cur = await projectRow(id);
  if (!cur || !rights(cur, me, lv).see) return cur && cur.shared ? err("no_permission", 403) : err("not_found", 404);
  if (!rights(cur, me, lv).edit) return err("read_only", 403);
  if (cur.rev !== rev) return err("conflict", 409, { rev: cur.rev });
  const name = (typeof body?.name === "string" ? body.name : "").trim().slice(0, 100) || "상품";
  const data = mergeEdit(cur.data, body?.data);
  // rev 가 그대로일 때만 저장된다 (동시에 두 사람이 저장하면 한쪽만 성공)
  const r = await rest(`gif_projects?id=eq.${enc(id)}&rev=eq.${rev}`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ name, data, rev: rev + 1, updated_by: me.id, updated_by_name: me.name, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) return err("db", 500);
  const saved = await r.json();
  if (!saved.length) return err("conflict", 409);
  return json({ rev: saved[0].rev, updated: ms(saved[0].updated_at) });
}

async function projectDelete(me: Me, lv: Level, id: string) {
  const row = await projectRow(id);
  if (!row || !rights(row, me, lv).see) return row && row.shared ? err("no_permission", 403) : err("not_found", 404);
  if (!rights(row, me, lv).del) return err("forbidden", 403);
  const r = await rest(`gif_projects?id=eq.${enc(id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  if (!r.ok) return err("db", 500);
  // 보관함의 사진 파일도 지운다 (실패해도 프로젝트는 이미 지워졌으므로 그대로 진행)
  try {
    const folder = `${ROOT}/${id}`;
    const l = await storage(`object/list/${BUCKET}`, { method: "POST", body: JSON.stringify({ prefix: folder, limit: 200, offset: 0 }) });
    const files = l.ok ? await l.json() as { name: string }[] : [];
    if (files.length) await storage(`object/${BUCKET}`, { method: "DELETE", body: JSON.stringify({ prefixes: files.map((f) => `${folder}/${f.name}`) }) });
  } catch { /* 남은 파일은 무해 */ }
  return json({ ok: true });
}

// [공유하기] 내 프로젝트 → 공유 프로젝트. 만든 사람이, 공유 프로젝트 쓰기 권한이 있을 때만(되돌리기 없음).
async function projectShare(me: Me, lv: Level, id: string) {
  const row = await projectRow(id);
  if (!row || !rights(row, me, lv).see) return row && row.shared ? err("no_permission", 403) : err("not_found", 404);
  if (row.shared) return err("already_shared", 409);
  if (!rights(row, me, lv).share) return err("need_write", 403);
  const at = new Date().toISOString();
  // 아직 내 프로젝트일 때만 바꾼다(두 번 눌러도 한 번만)
  const r = await rest(`gif_projects?id=eq.${enc(id)}&shared=is.false&created_by=eq.${enc(me.id)}`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ shared: true, shared_at: at, shared_by_name: me.name }),
  });
  if (!r.ok) return err("db", 500);
  if (!(await r.json()).length) return err("already_shared", 409);
  return json({ id, shared: true, sharedAt: ms(at), sharedBy: me.name, canEdit: true, canDelete: true, canShare: false, canUnshare: true });
}

// [내 프로젝트로 되돌리기] 공유 프로젝트 → 만든 사람의 내 프로젝트. 만든 사람 또는 관리자만.
async function projectUnshare(me: Me, lv: Level, id: string) {
  const row = await projectRow(id);
  if (!row || !rights(row, me, lv).see) return row && row.shared ? err("no_permission", 403) : err("not_found", 404);
  if (!row.shared) return err("not_shared", 409);
  if (!rights(row, me, lv).unshare) return err("forbidden", 403);
  const r = await rest(`gif_projects?id=eq.${enc(id)}&shared=is.true`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ shared: false, shared_at: null, shared_by_name: "", unshared_at: new Date().toISOString(), unshared_by: me.id, unshared_by_name: me.name }),
  });
  if (!r.ok) return err("db", 500);
  if (!(await r.json()).length) return err("not_shared", 409);
  const mine = isMine(row, me);
  return json({ id, shared: false, mine, ownerName: mine ? "" : ownerName(row), canEdit: mine, canDelete: mine, canShare: mine && lv === "write", canUnshare: false });
}

// 사진·GIF를 브라우저에서 보관함으로 곧장 올릴 수 있는 1회용 주소
async function uploadUrls(body: any) {
  const id = typeof body?.id === "string" ? body.id : "";
  const files: unknown[] = Array.isArray(body?.files) ? body.files : [];
  if (!ID_RE.test(id)) return err("bad_id", 400);
  if (!files.length || files.length > MAX_PHOTOS + 1 || !files.every((f) => typeof f === "string" && FILE_RE.test(f))) return err("bad_files", 400);
  // 이미 만들어진 프로젝트의 파일을 덮어쓰지 못하게 한다
  if (await projectRow(id)) return err("exists", 409);
  if (await projectCount() >= MAX_PROJECTS) return err("too_many", 400);
  const uploads: { file: string; url: string }[] = [];
  for (const file of files as string[]) {
    const s = await storage(`object/upload/sign/${BUCKET}/${ROOT}/${id}/${file}`, { method: "POST", body: "{}" });
    const d = s.ok ? await s.json().catch(() => null) : null;
    if (!d?.url) return err("storage", 500);
    uploads.push({ file, url: `${SB_URL}/storage/v1${d.url}` });
  }
  return json({ uploads });
}

// ── 프로젝트 권한 (관리자만) ──
async function permsList() {
  const [u, p] = await Promise.all([
    rest("app_users?select=id,name,role,login_blocked&role=in.(admin,staff,marketer)&order=name.asc"),
    rest("gif_perms?select=user_id,level,by_name,at"),
  ]);
  if (!u.ok || !p.ok) return err("db", 500);
  const perms = new Map((await p.json() as { user_id: string; level: string; by_name: string; at: string }[]).map((x) => [x.user_id, x]));
  const users = (await u.json() as { id: string; name: string; role: string; login_blocked: boolean | null }[])
    .filter((x) => x.role === "admin" || x.login_blocked !== true)   // 퇴사 처리된 계정은 뺀다
    .map((x) => {
      const admin = x.role === "admin";
      const row = perms.get(x.id);
      return { id: x.id, name: x.name, admin, level: admin ? "write" : (row?.level ?? "none"), by: admin ? "" : (row?.by_name ?? ""), at: admin || !row ? null : ms(row.at) };
    });
  return json({ users });
}

async function permsSet(me: Me, body: any) {
  const userId = typeof body?.user_id === "string" ? body.user_id.slice(0, 100) : "";
  const level = body?.level;
  if (!userId || !["none", "read", "write"].includes(level)) return err("bad_request", 400);
  const u = await rest(`app_users?id=eq.${enc(userId)}&select=id,role`);
  if (!u.ok) return err("db", 500);
  const target = (await u.json())[0];
  if (!target) return err("not_found", 404);
  if (target.role === "admin") return err("admin_fixed", 400);                          // 관리자는 항상 쓰기
  if (!["staff", "marketer"].includes(target.role)) return err("not_gif_user", 400);    // GIF 메이커를 못 쓰는 역할
  const r = level === "none"
    ? await rest(`gif_perms?user_id=eq.${enc(userId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } })
    : await rest("gif_perms?on_conflict=user_id", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: userId, level, by_name: me.name, at: new Date().toISOString() }),
    });
  if (!r.ok) return err("db", 500);
  return json({ user_id: userId, level });
}

// ── 카드뉴스 템플릿 (GIF 메이커를 쓰는 사람 모두 보고, 고치기·지우기는 만든 사람과 관리자) ──
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
type TRow = { id: string; owner_id: string; owner_name: string; name: string; data: unknown; updated_at: string };
const tOut = (r: TRow, me: Me) => ({ id: r.id, name: r.name, data: r.data, mine: r.owner_id === me.id || me.admin, ownerName: r.owner_id === me.id ? "" : r.owner_name, updated: ms(r.updated_at) });

async function templatesList(me: Me) {
  const [t, n] = await Promise.all([
    rest("gif_templates?select=id,owner_id,owner_name,name,data,updated_at&order=created_at.asc&limit=500"),
    rest("gif_template_names?select=id,name"),
  ]);
  if (!t.ok || !n.ok) return err("db", 500);
  const names = (await n.json() as { id: string; name: string }[]).filter((x) => BUILTIN_IDS.includes(x.id));
  return json({ isAdmin: me.admin, builtinNames: Object.fromEntries(names.map((x) => [x.id, x.name])), templates: (await t.json() as TRow[]).map((r) => tOut(r, me)) });
}

async function templateCreate(me: Me, body: any) {
  const name = cleanTemplateName(body?.name), data = cleanTemplateData(body?.data);
  if (!name) return err("bad_name", 400);
  if (!data) return err("bad_data", 400);
  const c = await rest(`gif_templates?owner_id=eq.${enc(me.id)}&select=id`, { method: "HEAD", headers: { Prefer: "count=exact" } });
  if ((Number((c.headers.get("content-range") ?? "").split("/")[1] ?? 0) || 0) >= 100) return err("too_many", 400);
  const r = await rest("gif_templates", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ id: newId(), owner_id: me.id, owner_name: me.name, name, data }) });
  if (!r.ok) return err("db", 500);
  return json({ template: tOut((await r.json())[0], me) });
}

const tFilter = (me: Me, id: string) => `gif_templates?id=eq.${enc(id)}${me.admin ? "" : `&owner_id=eq.${enc(me.id)}`}`;

async function templatePatch(me: Me, id: string, body: any) {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body?.name !== undefined) { const name = cleanTemplateName(body.name); if (!name) return err("bad_name", 400); patch.name = name; }
  if (body?.data !== undefined) { const data = cleanTemplateData(body.data); if (!data) return err("bad_data", 400); patch.data = data; }
  if (patch.name === undefined && patch.data === undefined) return err("empty", 400);
  const r = await rest(tFilter(me, id), { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
  if (!r.ok) return err("db", 500);
  const rows = await r.json();
  if (!rows.length) return err("not_found", 404);
  return json({ id: rows[0].id, name: rows[0].name, updated: ms(rows[0].updated_at) });
}

async function templateDelete(me: Me, id: string) {
  const r = await rest(tFilter(me, id), { method: "DELETE", headers: { Prefer: "return=representation" } });
  if (!r.ok) return err("db", 500);
  if (!(await r.json()).length) return err("not_found", 404);
  return json({ ok: true });
}

// 기본 템플릿 이름 바꾸기 — 관리자만. 이름을 비우면 원래 이름으로 돌아간다.
async function templateName(me: Me, body: any) {
  if (!me.admin) return err("forbidden", 403);
  const id = typeof body?.id === "string" ? body.id : "";
  if (!BUILTIN_IDS.includes(id)) return err("bad_id", 400);
  const raw = typeof body?.name === "string" ? body.name.trim() : "";
  if (!raw) {
    const r = await rest(`gif_template_names?id=eq.${enc(id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    return r.ok ? json({ id, name: null }) : err("db", 500);
  }
  const name = cleanTemplateName(raw);
  if (!name) return err("bad_name", 400);
  const r = await rest("gif_template_names?on_conflict=id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id, name, updated_by: me.id, updated_at: new Date().toISOString() }),
  });
  return r.ok ? json({ id, name }) : err("db", 500);
}

// ── 다나로브 상세 사진 ──
async function detail(q: URLSearchParams) {
  const u = allowedUrl(q.get("url"), PAGE_HOSTS);
  if (!u) return err("bad_url", 400);
  try {
    const r = await fetchAllowed(u, PAGE_HOSTS);
    if (!r || !r.ok) { await r?.body?.cancel().catch(() => {}); return err("fetch_failed", 502, { status: r?.status ?? 0 }); }
    return json(parseDetail((await r.text()).slice(0, 3_000_000), u));
  } catch { return err("fetch_failed", 502); }
}

const IMG_TYPE = /^image\/(jpeg|png|webp|gif|avif)/;
// 받은 내용을 그대로 흘려보내는 응답: 사진으로만 쓰이게(혹시 문서로 열려도 스크립트가 돌지 않게)
const passHeaders = (type: string, len: string | null) => ({
  ...CORS, "Content-Type": type, ...(len ? { "Content-Length": len } : {}),
  "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": 'inline; filename="image"',
});

async function detailImg(q: URLSearchParams) {
  const u = allowedUrl(q.get("u"), IMG_HOSTS);
  if (!u) return err("bad_url", 400);
  try {
    const r = await fetchAllowed(u, IMG_HOSTS, { headers: { referer: "https://www.danarobe.com/" } });
    if (!r || !r.ok) { await r?.body?.cancel().catch(() => {}); return err("fetch_failed", 502); }
    const type = r.headers.get("content-type") || "";
    const len = r.headers.get("content-length");
    if (!IMG_TYPE.test(type)) { await r.body?.cancel().catch(() => {}); return err("not_image", 415); }
    if (Number(len ?? 0) > MAX_IMG_TOTAL) { await r.body?.cancel().catch(() => {}); return err("too_big", 413, { size: Number(len) }); }
    return new Response(r.body, { headers: passHeaders(type.split(";")[0].trim(), len) });
  } catch { return err("fetch_failed", 502); }
}

// ── 구글 드라이브 지정 폴더 ──
async function drive(sub: string, q: URLSearchParams) {
  try {
    if (sub === "list") {
      const folder = q.get("folder");
      if (!folder) {
        const roots = await listRoots();
        return json({ roots, rootNames: ROOT_NAMES, shareEmail: roots.length ? null : driveShareEmail() });
      }
      return json(await listFolder(await checkId("d", folder, q.get("k"))));
    }
    if (sub === "thumb") {
      const r = await fetchThumb(q.get("u"), q.get("k"));
      const type = (r.headers.get("content-type") || "").split(";")[0].trim();
      if (!IMG_TYPE.test(type)) { await r.body?.cancel().catch(() => {}); return err("not_image", 415); }
      return new Response(r.body, { headers: passHeaders(type, r.headers.get("content-length")) });
    }
    if (sub === "file") {
      const r = await fetchFile(await checkId("f", q.get("id"), q.get("k")));
      const type = (r.headers.get("content-type") || "").split(";")[0].trim();
      if (!/^image\//.test(type)) { await r.body?.cancel().catch(() => {}); return err("not_image", 415); }
      return new Response(r.body, { headers: passHeaders(type, r.headers.get("content-length")) });
    }
    return err("not_found", 404);
  } catch (e) {
    if (e instanceof DriveError) return err(e.code, e.status, e.code === "drive_not_configured" ? {} : {});
    return err("drive_failed", 502);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/gif(?=\/|$)/, "").replace(/\/+$/, "");
  const m = req.method;

  const u = await verifyAuthToken(req);
  if (!u) return err("unauthorized", 401);
  if (u.role !== "admin" && u.role !== "staff") return err("forbidden", 403);   // 관리자 + MD/컨텐츠만 (verifyAuthToken이 marketer → staff로 합쳐 줌)
  const me: Me = { id: u.id, name: u.name, admin: u.role === "admin" };

  try {
    const body = m === "POST" || m === "PATCH" ? await req.json().catch(() => null) : null;
    let mt: RegExpMatchArray | null;

    if (path === "/api/me" && m === "GET") {
      return json({ id: me.id, name: me.name, admin: me.admin, proj: await projLevel(me), drive: driveConfigured() });
    }

    if (path === "/api/projects" || path === "/api/projects/upload-urls" || path.startsWith("/api/projects/")) {
      // 내 프로젝트는 권한과 상관없이 누구나(GIF 메이커를 쓰는 사람) 만들고 고친다. 공유 프로젝트는 rights()가 권한대로.
      const lv = await projLevel(me);
      if (path === "/api/projects") {
        if (m === "GET") return await projectsList(me, lv);
        if (m === "POST") return await projectCreate(me, body);
      } else if (path === "/api/projects/upload-urls") {
        if (m === "POST") return await uploadUrls(body);
      } else if ((mt = path.match(/^\/api\/projects\/([^/]+)\/(share|unshare)$/))) {
        const id = decodeURIComponent(mt[1]);
        if (!ID_RE.test(id)) return err("bad_id", 400);
        if (m === "POST") return mt[2] === "share" ? await projectShare(me, lv, id) : await projectUnshare(me, lv, id);
      } else if ((mt = path.match(/^\/api\/projects\/([^/]+)$/))) {
        const id = decodeURIComponent(mt[1]);
        if (!ID_RE.test(id)) return err("bad_id", 400);
        if (m === "GET") return await projectGet(me, lv, id);
        if (m === "PATCH") return await projectPatch(me, lv, id, body);
        if (m === "DELETE") return await projectDelete(me, lv, id);
      }
      return err("not_found", 404);
    }

    if (path === "/api/perms") {
      if (!me.admin) return err("forbidden", 403);
      if (m === "GET") return await permsList();
      if (m === "POST") return await permsSet(me, body);
    }

    if (path === "/api/templates") {
      if (m === "GET") return await templatesList(me);
      if (m === "POST") return await templateCreate(me, body);
    }
    if ((mt = path.match(/^\/api\/templates\/([^/]+)$/))) {
      const id = decodeURIComponent(mt[1]);
      if (!ID_RE.test(id)) return err("bad_id", 400);
      if (m === "PATCH") return await templatePatch(me, id, body);
      if (m === "DELETE") return await templateDelete(me, id);
    }
    if (path === "/api/template-names" && m === "POST") return await templateName(me, body);

    if (path === "/api/detail" && m === "GET") return await detail(url.searchParams);
    if (path === "/api/detail-img" && m === "GET") return await detailImg(url.searchParams);
    if ((mt = path.match(/^\/api\/drive\/(list|thumb|file)$/)) && m === "GET") return await drive(mt[1], url.searchParams);

    return err("not_found", 404);
  } catch {
    return err("server", 500);
  }
});
