// 프로젝트 저장소 — 워크스페이스 서버에 저장한다. 사진·GIF 파일은 비공개 보관함에 올라간다.
// 새로 만든 프로젝트는 '내 프로젝트'(만든 사람만 봄) → [공유하기]로 '공유 프로젝트'(관리자가 프로젝트 권한(읽기/쓰기)을 준 계정이 같이 봄).
// GIF 만들기 화면과 프로젝트 화면이 함께 쓴다. ('/api/…' 호출은 gm-ws.js 가 워크스페이스 서버로 보낸다)
(function () {
  'use strict';

  // ── 서버 호출 ──
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      keepalive: method === 'PATCH',   // 창을 닫는 순간의 마지막 저장도 끝까지 보낸다
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error((json && json.error) || ('http_' + res.status));
      err.status = res.status;
      err.code = (json && json.error) || '';
      throw err;
    }
    return json;
  }

  // ── 내려받은 사진 보관 (같은 사진을 열 때마다 다시 받지 않도록, 이 브라우저에만) ──
  const CACHE_DB = 'gm_cache', CACHE_STORE = 'blobs', CACHE_MAX = 400;
  let cachep = null;
  function cacheOpen() {
    if (!cachep) cachep = new Promise((res, rej) => {
      const r = indexedDB.open(CACHE_DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(CACHE_STORE, { keyPath: 'path' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return cachep;
  }
  function cacheTx(mode, fn) {
    return cacheOpen().then(db => new Promise((res, rej) => {
      const t = db.transaction(CACHE_STORE, mode);
      const rq = fn(t.objectStore(CACHE_STORE));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }));
  }
  const cacheGet = path => cacheTx('readonly', s => s.get(path)).then(r => (r ? r.blob : null)).catch(() => null);
  const cachePut = (path, blob) => cacheTx('readwrite', s => s.put({ path, blob, t: Date.now() })).catch(() => {});
  async function cacheDropProject(prefix) {
    try {
      const keys = await cacheTx('readonly', s => s.getAllKeys());
      const mine = keys.filter(k => String(k).startsWith(prefix));
      if (mine.length) await cacheTx('readwrite', s => { mine.forEach(k => s.delete(k)); });
    } catch {}
  }
  async function cacheTrim() {
    try {
      const all = await cacheTx('readonly', s => s.getAll());
      if (all.length <= CACHE_MAX) return;
      all.sort((a, b) => a.t - b.t);
      const drop = all.slice(0, all.length - CACHE_MAX).map(r => r.path);
      await cacheTx('readwrite', s => { drop.forEach(k => s.delete(k)); });
    } catch {}
  }

  async function fetchBlob(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('download_' + r.status);
    return r.blob();
  }

  // ── 사진을 보관함에 올리기 ──
  async function putFile(url, blob, type) {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': type, 'cache-control': 'max-age=31536000', 'x-upsert': 'false' },
      body: blob,
    });
    if (r.ok) return;
    // 같은 파일이 이미 올라가 있으면(중간에 끊겼다가 다시 시도) 성공으로 본다 — 사진 파일은 바뀌지 않는다
    let msg = '';
    try { msg = await r.text(); } catch {}
    if (r.status === 409 || /Duplicate|already exists/i.test(msg)) return;
    throw new Error('upload_' + r.status);
  }

  // 서버에 보낼 내용 (사진 파일은 빼고 글자·배치 설정만)
  function toData(p) {
    return {
      titleEn: p.titleEn || '', caption: p.caption || '',
      reels: p.reels || '',            // 릴스 멘트: 메모로만 적어 두는 글 (사진에는 안 들어간다)
      split: p.split || 'auto2', format: p.format || 'story',
      filter: p.filter || null, outFmt: p.outFmt === 'jpg' ? 'jpg' : 'png',
      gifInfo: p.gifInfo || null, thumb: p.thumb || '', created: p.created || Date.now(),
      hasGif: !!p.gif,
      photos: (p.photos || []).map(ph => ({ id: ph.id, w: ph.w, h: ph.h, name: ph.name || '', lay: ph.lay || null })),
    };
  }

  // 사람이 고칠 수 있는 내용만 글자로 — 바뀐 게 있는지 비교하는 데 쓴다
  function editState(p) {
    const d = toData(p);
    return JSON.stringify([p.name || '', d.titleEn, d.caption, d.reels, d.split, d.format, d.filter, d.outFmt, d.photos.map(ph => [ph.id, ph.lay])]);
  }

  // 새 프로젝트: 사진·GIF를 올린 다음 프로젝트를 만든다. onProgress(끝난 수, 전체 수)
  async function create(p, onProgress) {
    const jobs = p.photos.map(ph => ({ file: ph.id + '.jpg', blob: ph.blob, type: 'image/jpeg' }));
    if (p.gif) jobs.push({ file: 'gif.gif', blob: p.gif, type: 'image/gif' });
    const { uploads } = await api('POST', '/api/projects/upload-urls', { id: p.id, files: jobs.map(j => j.file) });
    const urlOf = Object.fromEntries(uploads.map(u => [u.file, u.url]));
    let done = 0;
    if (onProgress) onProgress(0, jobs.length);
    // 한 번에 3개씩
    const queue = jobs.slice();
    await Promise.all([0, 1, 2].map(async () => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        await putFile(urlOf[j.file], j.blob, j.type);
        done++;
        if (onProgress) onProgress(done, jobs.length);
      }
    }));
    const out = await api('POST', '/api/projects', { id: p.id, name: p.name || '', data: toData(p) });
    // 방금 올린 사진은 다시 내려받지 않도록 보관해 둔다
    if (out.ownerId) jobs.forEach(j => cachePut(out.ownerId + '/' + p.id + '/' + j.file, j.blob));
    return out;
  }

  // 프로젝트 하나를 사진까지 받아서 돌려준다
  async function get(id) {
    const { project, urls } = await api('GET', '/api/projects/' + encodeURIComponent(id));
    await Promise.all((project.photos || []).map(async ph => {
      let blob = await cacheGet(ph.path);
      if (!blob) {
        if (!urls[ph.path]) throw new Error('missing_file');
        blob = await fetchBlob(urls[ph.path]);
        cachePut(ph.path, blob);
      }
      ph.blob = blob;
    }));
    cacheTrim();
    return project;
  }

  // 원본 GIF (필요할 때만 받는다)
  async function loadGif(p) {
    if (!p.gifPath) return null;
    const cached = await cacheGet(p.gifPath);
    if (cached) return cached;
    const { urls } = await api('GET', '/api/projects/' + encodeURIComponent(p.id));
    if (!urls[p.gifPath]) throw new Error('missing_file');
    const blob = await fetchBlob(urls[p.gifPath]);
    cachePut(p.gifPath, blob);
    return blob;
  }

  // 수정 저장. 그 사이 다른 사람이 고쳤으면 err.status === 409
  async function save(p) {
    const out = await api('PATCH', '/api/projects/' + encodeURIComponent(p.id), { rev: p.rev, name: p.name || '', data: toData(p) });
    p.rev = out.rev; p.updated = out.updated;
    return out;
  }

  async function del(id, ownerId) {
    await api('DELETE', '/api/projects/' + encodeURIComponent(id));
    if (ownerId) cacheDropProject(ownerId + '/' + id + '/');
  }


  window.GMDB = {
    uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    list: () => api('GET', '/api/projects').then(r => r.projects),
    listAll: () => api('GET', '/api/projects'),   // { level, projects }
    share: id => api('POST', '/api/projects/' + encodeURIComponent(id) + '/share'),   // 내 프로젝트 → 공유 프로젝트
    unshare: id => api('POST', '/api/projects/' + encodeURIComponent(id) + '/unshare'),   // 공유 프로젝트 → 만든 사람의 내 프로젝트
    get, create, save, del, loadGif, editState,
    // 프로젝트 권한 (관리자만): 계정마다 'none' | 'read' | 'write'
    perms: {
      get: () => api('GET', '/api/perms'),
      set: (userId, level) => api('POST', '/api/perms', { user_id: userId, level }),
    },
  };
})();
