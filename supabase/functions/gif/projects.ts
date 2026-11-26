// 프로젝트·템플릿 저장 규칙 (식별자 모양, 저장할 내용 검증)
export const BUCKET = "gif-projects";
/** 사진 보관함의 맨 앞 폴더 — 경로는 항상 `ws/{프로젝트 id}/{파일}` */
export const ROOT = "ws";
export const ID_RE = /^[a-z0-9]{6,40}$/;
/** 프로젝트 폴더 안에 올릴 수 있는 파일 이름: 사진 `{사진 id}.jpg`, 원본 GIF `gif.gif` */
export const FILE_RE = /^(?:[a-z0-9]{6,40}\.jpg|gif\.gif)$/;
export const MAX_PHOTOS = 60;
/** 전체 프로젝트 수 (보관함을 끝없이 채우지 못하게) */
export const MAX_PROJECTS = 3000;
const REELS_MAX = 4000;

type Json = Record<string, unknown>;

export interface PhotoMeta { id: string; w: number; h: number; name: string; lay: Json | null; path: string }
export interface ProjectData {
  titleEn: string; caption: string; reels?: string; split: string; format: string;
  filter: Json | null; outFmt: string; gifInfo: Json | null; gifPath: string | null;
  thumb: string; created: number; photos: PhotoMeta[];
}

const str = (v: unknown, max: number, fallback = "") => typeof v === "string" ? v.slice(0, max) : fallback;

function smallObj(v: unknown, maxBytes: number): Json | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  try { return JSON.stringify(v).length <= maxBytes ? (v as Json) : null; } catch { return null; }
}

function editableFields(input: Json) {
  return {
    titleEn: str(input.titleEn, 300),
    caption: str(input.caption, 4000),
    split: str(input.split, 20, "auto2"),
    format: str(input.format, 20, "story"),
    filter: smallObj(input.filter, 500),
    outFmt: input.outFmt === "jpg" ? "jpg" : "png",
  };
}

/** 새 프로젝트의 내용. 사진 경로는 서버가 정한다(`ws/{프로젝트}/{사진 id}.jpg`). */
export function cleanNewData(input: unknown, projectId: string): ProjectData | null {
  if (!input || typeof input !== "object") return null;
  const src = input as Json;
  const prefix = `${ROOT}/${projectId}/`;
  if (!Array.isArray(src.photos) || src.photos.length < 1 || src.photos.length > MAX_PHOTOS) return null;
  const photos: PhotoMeta[] = [];
  for (const raw of src.photos as Json[]) {
    if (!raw || typeof raw !== "object") return null;
    const id = str(raw.id, 40);
    if (!ID_RE.test(id)) return null;
    const w = Number(raw.w), h = Number(raw.h);
    if (!(w > 0 && w <= 10000 && h > 0 && h <= 10000)) return null;
    photos.push({ id, w, h, name: str(raw.name, 200), lay: smallObj(raw.lay, 8000), path: `${prefix}${id}.jpg` });
  }
  if (new Set(photos.map((p) => p.id)).size !== photos.length) return null;
  const thumb = str(src.thumb, 30000);
  return {
    ...editableFields(src),
    reels: str(src.reels, REELS_MAX),
    gifInfo: smallObj(src.gifInfo, 500),
    gifPath: src.hasGif ? `${prefix}gif.gif` : null,
    thumb: thumb.startsWith("data:image/jpeg;base64,") ? thumb : "",
    created: Number(src.created) > 0 ? Number(src.created) : Date.now(),
    photos,
  };
}

/** 수정: 글자·출력 설정과 사진별 배치(lay)만 받는다. 사진 목록·파일 경로는 저장된 것을 그대로 둔다. */
export function mergeEdit(stored: ProjectData, input: unknown): ProjectData {
  const src = (input && typeof input === "object" ? input : {}) as Json;
  const lays = new Map<string, Json | null>();
  if (Array.isArray(src.photos)) {
    for (const raw of src.photos as Json[]) {
      if (raw && typeof raw === "object" && typeof raw.id === "string") lays.set(raw.id, smallObj(raw.lay, 8000));
    }
  }
  return {
    ...stored,
    ...editableFields(src),
    ...(typeof src.reels === "string" ? { reels: src.reels.slice(0, REELS_MAX) } : {}),
    photos: (stored.photos ?? []).map((ph) => (lays.has(ph.id) ? { ...ph, lay: lays.get(ph.id) ?? null } : ph)),
  };
}

// ── 카드뉴스 템플릿 ──
/** 기본 템플릿 id — gif/cardnews-standalone.html 의 BUILTINS 와 같아야 한다 */
export const BUILTIN_IDS = ["b:lookbook", "b:box", "b:bold", "b:plain", "b:magazine", "b:shade", "b:spo", "b:floor", "b:visual", "b:brand"];

export function cleanTemplateName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = v.replace(/\s+/g, " ").trim().slice(0, 40);
  return name || null;
}

export function cleanTemplateData(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  try {
    const s = JSON.stringify(v);
    if (s.length > 30000) return null;
    return JSON.parse(s);
  } catch { return null; }
}
