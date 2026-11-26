// GIF 인코딩 워커: Wu 색상 양자화 + 오차 제한 Floyd–Steinberg 디더링 + gifenc(LZW)
// 기존 gif.js(NeuQuant)는 작은 면적의 색(입술 등)을 팔레트에서 빠뜨리고, 그 오차가 디더링으로
// 매끈한 피부 영역까지 번져 얼룩/튀는 픽셀을 만들었음. 여기서는 팔레트를 더 정확히 뽑고
// 픽셀당 오차를 제한해 번짐을 막는다.
'use strict';
self.exports = {}; self.module = { exports: self.exports };
importScripts('vendor/gifenc.js');
const GifEnc = self.exports;

// ── Wu 양자화 (Xiaolin Wu, 1991) ──
const SIDE = 33;
const IDX = (r, g, b) => (r << 10) + (r << 6) + r + (g << 5) + g + b;

// 히스토그램(5비트/채널) → 가중치 변환 → 누적 모멘트
// 가중치: sqrt(픽셀 수) × (1 + SAT_BOOST × 채도) — 면적은 작지만 눈에 띄는 색(입술·피부 홍조)이
// 넓은 배경색에 밀려 팔레트에서 빠지는 것을 막는다.
function buildMoments(rgba, n, q) {
  const size = SIDE * SIDE * SIDE;
  const cnt = new Float64Array(size), sr = new Float64Array(size), sg = new Float64Array(size), sb = new Float64Array(size), s2 = new Float64Array(size);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    const ind = IDX((r >> 3) + 1, (g >> 3) + 1, (b >> 3) + 1);
    cnt[ind]++; sr[ind] += r; sg[ind] += g; sb[ind] += b; s2[ind] += r * r + g * g + b * b;
  }
  const wt = new Float64Array(size), mr = new Float64Array(size), mg = new Float64Array(size), mb = new Float64Array(size), m2 = new Float64Array(size);
  const bins = []; // k-means 보정용 (평균색, 가중치)
  for (let i = 0; i < size; i++) {
    const c = cnt[i]; if (!c) continue;
    const r = sr[i] / c, g = sg[i] / c, b = sb[i] / c;
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const w = (q.sqrtWeight ? Math.sqrt(c) : c) * (1 + q.satBoost * chroma);
    wt[i] = w; mr[i] = w * r; mg[i] = w * g; mb[i] = w * b; m2[i] = w * (s2[i] / c);
    bins.push(r, g, b, w);
  }
  const area = new Float64Array(SIDE), areaR = new Float64Array(SIDE), areaG = new Float64Array(SIDE), areaB = new Float64Array(SIDE), area2 = new Float64Array(SIDE);
  for (let r = 1; r < SIDE; r++) {
    area.fill(0); areaR.fill(0); areaG.fill(0); areaB.fill(0); area2.fill(0);
    for (let g = 1; g < SIDE; g++) {
      let line = 0, lineR = 0, lineG = 0, lineB = 0, line2 = 0;
      for (let b = 1; b < SIDE; b++) {
        const i1 = IDX(r, g, b);
        line += wt[i1]; lineR += mr[i1]; lineG += mg[i1]; lineB += mb[i1]; line2 += m2[i1];
        area[b] += line; areaR[b] += lineR; areaG[b] += lineG; areaB[b] += lineB; area2[b] += line2;
        const i2 = IDX(r - 1, g, b);
        wt[i1] = wt[i2] + area[b]; mr[i1] = mr[i2] + areaR[b]; mg[i1] = mg[i2] + areaG[b]; mb[i1] = mb[i2] + areaB[b]; m2[i1] = m2[i2] + area2[b];
      }
    }
  }
  return { wt, mr, mg, mb, m2, bins: Float64Array.from(bins) };
}

// 팔레트 k-means 보정: 각 색을 '그 색에 배정된 픽셀들의 평균'으로 옮겨 오차를 줄인다 (히스토그램 단위라 빠름)
function refinePalette(pal, bins, iters) {
  const K = pal.length;
  for (let it = 0; it < iters; it++) {
    const acc = new Float64Array(K * 4);
    for (let i = 0; i < bins.length; i += 4) {
      const r = bins[i], g = bins[i + 1], b = bins[i + 2], w = bins[i + 3];
      let best = 0, bd = 1e18;
      for (let k = 0; k < K; k++) {
        const dr = r - pal[k][0], dg = g - pal[k][1], db = b - pal[k][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = k; }
      }
      const o = best * 4; acc[o] += w * r; acc[o + 1] += w * g; acc[o + 2] += w * b; acc[o + 3] += w;
    }
    for (let k = 0; k < K; k++) {
      const o = k * 4; if (acc[o + 3] > 0) pal[k] = [acc[o] / acc[o + 3], acc[o + 1] / acc[o + 3], acc[o + 2] / acc[o + 3]];
    }
  }
  return pal.map(p => p.map(Math.round));
}

function vol(c, m) {
  return m[IDX(c.r1, c.g1, c.b1)] - m[IDX(c.r1, c.g1, c.b0)] - m[IDX(c.r1, c.g0, c.b1)] + m[IDX(c.r1, c.g0, c.b0)]
       - m[IDX(c.r0, c.g1, c.b1)] + m[IDX(c.r0, c.g1, c.b0)] + m[IDX(c.r0, c.g0, c.b1)] - m[IDX(c.r0, c.g0, c.b0)];
}
function bottom(c, dir, m) {
  if (dir === 0) return -m[IDX(c.r0, c.g1, c.b1)] + m[IDX(c.r0, c.g1, c.b0)] + m[IDX(c.r0, c.g0, c.b1)] - m[IDX(c.r0, c.g0, c.b0)];
  if (dir === 1) return -m[IDX(c.r1, c.g0, c.b1)] + m[IDX(c.r1, c.g0, c.b0)] + m[IDX(c.r0, c.g0, c.b1)] - m[IDX(c.r0, c.g0, c.b0)];
  return -m[IDX(c.r1, c.g1, c.b0)] + m[IDX(c.r1, c.g0, c.b0)] + m[IDX(c.r0, c.g1, c.b0)] - m[IDX(c.r0, c.g0, c.b0)];
}
function top(c, dir, pos, m) {
  if (dir === 0) return m[IDX(pos, c.g1, c.b1)] - m[IDX(pos, c.g1, c.b0)] - m[IDX(pos, c.g0, c.b1)] + m[IDX(pos, c.g0, c.b0)];
  if (dir === 1) return m[IDX(c.r1, pos, c.b1)] - m[IDX(c.r1, pos, c.b0)] - m[IDX(c.r0, pos, c.b1)] + m[IDX(c.r0, pos, c.b0)];
  return m[IDX(c.r1, c.g1, pos)] - m[IDX(c.r1, c.g0, pos)] - m[IDX(c.r0, c.g1, pos)] + m[IDX(c.r0, c.g0, pos)];
}
function variance(c, M) {
  const dr = vol(c, M.mr), dg = vol(c, M.mg), db = vol(c, M.mb), w = vol(c, M.wt);
  return w ? vol(c, M.m2) - (dr * dr + dg * dg + db * db) / w : 0;
}
function maximize(c, dir, first, last, whole, M) {
  const baseR = bottom(c, dir, M.mr), baseG = bottom(c, dir, M.mg), baseB = bottom(c, dir, M.mb), baseW = bottom(c, dir, M.wt);
  let max = 0, cut = -1;
  for (let i = first; i < last; i++) {
    let hr = baseR + top(c, dir, i, M.mr), hg = baseG + top(c, dir, i, M.mg), hb = baseB + top(c, dir, i, M.mb), hw = baseW + top(c, dir, i, M.wt);
    if (hw === 0) continue;
    let t = (hr * hr + hg * hg + hb * hb) / hw;
    hr = whole.r - hr; hg = whole.g - hg; hb = whole.b - hb; hw = whole.w - hw;
    if (hw === 0) continue;
    t += (hr * hr + hg * hg + hb * hb) / hw;
    if (t > max) { max = t; cut = i; }
  }
  return { max, cut };
}
function cutBox(s1, s2, M) {
  const whole = { r: vol(s1, M.mr), g: vol(s1, M.mg), b: vol(s1, M.mb), w: vol(s1, M.wt) };
  const cr = maximize(s1, 0, s1.r0 + 1, s1.r1, whole, M);
  const cg = maximize(s1, 1, s1.g0 + 1, s1.g1, whole, M);
  const cb = maximize(s1, 2, s1.b0 + 1, s1.b1, whole, M);
  let dir;
  if (cr.max >= cg.max && cr.max >= cb.max) { dir = 0; if (cr.cut < 0) return false; }
  else if (cg.max >= cr.max && cg.max >= cb.max) dir = 1;
  else dir = 2;
  s2.r1 = s1.r1; s2.g1 = s1.g1; s2.b1 = s1.b1;
  if (dir === 0)      { s2.r0 = s1.r1 = cr.cut; s2.g0 = s1.g0; s2.b0 = s1.b0; }
  else if (dir === 1) { s2.g0 = s1.g1 = cg.cut; s2.r0 = s1.r0; s2.b0 = s1.b0; }
  else                { s2.b0 = s1.b1 = cb.cut; s2.r0 = s1.r0; s2.g0 = s1.g0; }
  s1.vol = (s1.r1 - s1.r0) * (s1.g1 - s1.g0) * (s1.b1 - s1.b0);
  s2.vol = (s2.r1 - s2.r0) * (s2.g1 - s2.g0) * (s2.b1 - s2.b0);
  return true;
}

function wuQuantize(rgba, n, maxColors, q) {
  const M = buildMoments(rgba, n, q);
  const cubes = [{ r0: 0, g0: 0, b0: 0, r1: SIDE - 1, g1: SIDE - 1, b1: SIDE - 1, vol: 0 }];
  const vv = new Float64Array(maxColors);
  let next = 0, K = maxColors;
  for (let i = 1; i < maxColors; i++) {
    cubes[i] = { r0: 0, g0: 0, b0: 0, r1: 0, g1: 0, b1: 0, vol: 0 };
    if (cutBox(cubes[next], cubes[i], M)) {
      vv[next] = cubes[next].vol > 1 ? variance(cubes[next], M) : 0;
      vv[i]    = cubes[i].vol > 1 ? variance(cubes[i], M) : 0;
    } else {
      vv[next] = 0; i--;
    }
    next = 0; let t = vv[0];
    for (let k = 1; k <= i; k++) if (vv[k] > t) { t = vv[k]; next = k; }
    if (t <= 0) { K = i + 1; break; }
  }
  const pal = [];
  for (let k = 0; k < K; k++) {
    const w = vol(cubes[k], M.wt);
    if (w > 0) pal.push([vol(cubes[k], M.mr) / w, vol(cubes[k], M.mg) / w, vol(cubes[k], M.mb) / w]);
  }
  return refinePalette(pal, M.bins, q.kmeans);
}

// ── 최근접 팔레트 색 (정확한 유클리드 거리, 캐시) ──
function makeNearest(pal) {
  const cache = new Map();
  const pr = new Int32Array(pal.length), pg = new Int32Array(pal.length), pb = new Int32Array(pal.length);
  pal.forEach((p, i) => { pr[i] = p[0]; pg[i] = p[1]; pb[i] = p[2]; });
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let v = cache.get(key);
    if (v !== undefined) return v;
    let best = 0, bd = 1e9;
    for (let i = 0; i < pr.length; i++) {
      const dr = r - pr[i], dg = g - pg[i], db = b - pb[i];
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; if (d === 0) break; }
    }
    cache.set(key, best);
    return best;
  };
}

// ── 인덱스 변환 (디더링 on/off) ──
// 오차를 ±ERR_LIMIT로 제한: 팔레트에 가까운 색이 없는 경계(입술·강한 색)의 오차가
// 매끈한 영역으로 번져 튀는 픽셀을 만드는 것을 막는다. 그라데이션의 작은 오차는 그대로 확산.
function indexFrame(rgba, W, H, pal, dither, q) {
  const ERR_LIMIT = q.errLimit, DIFFUSE = q.diffuse;
  const nearest = makeNearest(pal);
  const out = new Uint8Array(W * H);
  if (!dither) {
    for (let p = 0, i = 0; p < W * H; p++, i += 4) out[p] = nearest(rgba[i], rgba[i + 1], rgba[i + 2]);
    return out;
  }
  const stride = (W + 2) * 3;
  let cur = new Float32Array(stride), nxt = new Float32Array(stride);
  for (let y = 0; y < H; y++) {
    nxt.fill(0);
    const ltr = (y & 1) === 0;
    for (let k = 0; k < W; k++) {
      const x = ltr ? k : W - 1 - k;
      const i = (y * W + x) * 4, e = (x + 1) * 3;
      let r = rgba[i] + cur[e], g = rgba[i + 1] + cur[e + 1], b = rgba[i + 2] + cur[e + 2];
      r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; b = b < 0 ? 0 : b > 255 ? 255 : b;
      const ri = Math.round(r), gi = Math.round(g), bi = Math.round(b);
      const idx = nearest(ri, gi, bi);
      out[y * W + x] = idx;
      const p = pal[idx];
      let er = r - p[0], eg = g - p[1], eb = b - p[2];
      er = (er > ERR_LIMIT ? ERR_LIMIT : er < -ERR_LIMIT ? -ERR_LIMIT : er) * DIFFUSE;
      eg = (eg > ERR_LIMIT ? ERR_LIMIT : eg < -ERR_LIMIT ? -ERR_LIMIT : eg) * DIFFUSE;
      eb = (eb > ERR_LIMIT ? ERR_LIMIT : eb < -ERR_LIMIT ? -ERR_LIMIT : eb) * DIFFUSE;
      const d = ltr ? 3 : -3;
      // Floyd–Steinberg: 7/16 → 옆, 3/16 → 아래 뒤, 5/16 → 아래, 1/16 → 아래 앞
      cur[e + d] += er * 0.4375;     cur[e + d + 1] += eg * 0.4375;     cur[e + d + 2] += eb * 0.4375;
      nxt[e - d] += er * 0.1875;     nxt[e - d + 1] += eg * 0.1875;     nxt[e - d + 2] += eb * 0.1875;
      nxt[e]     += er * 0.3125;     nxt[e + 1]     += eg * 0.3125;     nxt[e + 2]     += eb * 0.3125;
      nxt[e + d] += er * 0.0625;     nxt[e + d + 1] += eg * 0.0625;     nxt[e + d + 2] += eb * 0.0625;
    }
    const t = cur; cur = nxt; nxt = t;
  }
  return out;
}

// 프레임 묶음을 받아 프레임별 GIF 청크를 돌려준다. 첫 프레임(first)은 헤더·전역 팔레트 포함,
// 나머지는 로컬 팔레트가 붙은 독립 청크라 메인 스레드에서 순서대로 이어 붙이면 완성된 GIF가 된다.
self.onmessage = e => {
  const { jobs, W, H, delay, maxColors, dither } = e.data;
  const q = Object.assign({ sqrtWeight: true, satBoost: 2, kmeans: 3, errLimit: 24, diffuse: 0.85 }, e.data.q || {});
  try {
    const n = W * H;
    const results = [];
    for (const job of jobs) {
      const rgba = new Uint8Array(job.buffer);
      const pal = wuQuantize(rgba, n, maxColors, q);
      const index = indexFrame(rgba, W, H, pal, dither, q);
      const gif = GifEnc.GIFEncoder({ auto: false });
      if (job.first) gif.writeHeader();
      gif.writeFrame(index, W, H, { palette: pal, delay, repeat: 0, first: job.first });
      const bytes = gif.bytes();
      results.push({ i: job.i, bytes });
      self.postMessage({ type: 'progress' });
    }
    self.postMessage({ type: 'done', results }, results.map(r => r.bytes.buffer));
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
