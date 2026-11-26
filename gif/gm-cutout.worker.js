'use strict';
// 누끼(배경 지우기) 작업자. 사진은 이 브라우저 안에서만 처리한다 (서버로 보내지 않는다).
//  받는 것: { id, type: 'cut', rgba: ArrayBuffer(1024×1024×4) }
//  보내는 것: { id, type: 'done', mask: ArrayBuffer(1024×1024, 0~255), ep } / { id, type: 'err', msg }
//            { type: 'progress', loaded, total } (도구를 처음 받을 때)
// 그래픽카드(WebGPU)를 쓸 수 있으면 사진 한 장에 0.1초쯤, 없으면 CPU로 5~10초쯤 걸린다. 결과는 같다.
const BASE = new URL('vendor/cutout-v1/', self.location.href).href;
const PARTS = ['isnet-w16.0.bin', 'isnet-w16.1.bin', 'isnet-w16.2.bin'];
const WASM = 'ort-wasm-simd-threaded.asyncify.wasm';
const TOTAL = 90650884 + 28747738;   // 진행률 표시용 (모델 + 실행 파일)
const SIZE = 1024, N = SIZE * SIZE;
const CACHE = 'gm-cutout-v1';

importScripts(BASE + 'ort.webgpu.min.js');
ort.env.wasm.numThreads = 1;                 // 여러 가닥(스레드)은 사이트 전체 설정이 필요해 쓰지 않는다
ort.env.wasm.wasmPaths = BASE;
ort.env.logLevel = 'error';

let loaded = 0;
const bump = n => { loaded += n; postMessage({ type: 'progress', loaded, total: TOTAL }); };

// 한 번 받은 파일은 브라우저 보관함에 넣어 두고 다음부터는 거기서 꺼낸다
async function getBytes(name) {
  const url = BASE + name;
  let cache = null;
  try { cache = await caches.open(CACHE); } catch {}
  let res = cache ? await cache.match(url).catch(() => null) : null;
  const fresh = !res;
  if (!res) res = await fetch(url);
  if (!res.ok) throw new Error('http_' + res.status);
  const copy = fresh && cache ? res.clone() : null;
  let buf;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader(), chunks = [];
    let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length; bump(value.length); }
    buf = new Uint8Array(size);
    let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  } else { buf = new Uint8Array(await res.arrayBuffer()); bump(buf.length); }
  if (copy) cache.put(url, copy).catch(() => {});
  return buf;
}

let sess = null, ep = '', loading = null, model = null;
async function makeSession(provider) {
  const s = await ort.InferenceSession.create(model, { executionProviders: [provider], graphOptimizationLevel: 'all' });
  sess = s; ep = provider;
}
async function hasGpu() {
  try { return !!(self.navigator && navigator.gpu && await navigator.gpu.requestAdapter()); } catch { return false; }
}
function load() {
  if (!loading) loading = (async () => {
    loaded = 0;
    const [wasm, ...parts] = await Promise.all([getBytes(WASM), ...PARTS.map(getBytes)]);
    ort.env.wasm.wasmBinary = wasm;
    model = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0; for (const p of parts) { model.set(p, o); o += p.length; }
    if (await hasGpu()) { try { await makeSession('webgpu'); return; } catch (e) { sess = null; } }
    await makeSession('wasm');
  })().catch(e => { loading = null; throw e; });
  return loading;
}

async function infer(rgba) {
  const d = new Uint8ClampedArray(rgba), f = new Float32Array(3 * N);
  for (let p = 0, q = 0; p < N; p++, q += 4) { f[p] = d[q] / 255 - 0.5; f[N + p] = d[q + 1] / 255 - 0.5; f[2 * N + p] = d[q + 2] / 255 - 0.5; }
  const out = await sess.run({ input_image: new ort.Tensor('float32', f, [1, 3, SIZE, SIZE]) });
  const m = out.output_image.data;
  let lo = Infinity, hi = -Infinity, bad = false;
  for (let p = 0; p < N; p++) { const v = m[p]; if (v !== v) { bad = true; break; } if (v < lo) lo = v; if (v > hi) hi = v; }
  if (bad || !(hi - lo > 0.05)) return null;      // 계산이 잘못됐거나 사진 전체가 한 덩어리로 나온 경우
  const mask = new Uint8Array(N), k = 255 / (hi - lo);
  for (let p = 0; p < N; p++) mask[p] = (m[p] - lo) * k + 0.5;
  return mask;
}

// 한 번에 한 장씩 차례로
let chain = Promise.resolve();
self.onmessage = e => {
  const { id, type, rgba } = e.data || {};
  if (type !== 'cut') return;
  chain = chain.then(async () => {
    try {
      await load();
      let mask = await infer(rgba).catch(err => { if (ep === 'wasm') throw err; return null; });
      // 그래픽카드 쪽 결과가 이상하면 CPU로 한 번 더 한다 (그 뒤로는 계속 CPU)
      if (!mask && ep === 'webgpu') { await makeSession('wasm'); mask = await infer(rgba); }
      if (!mask) throw new Error('empty');
      postMessage({ id, type: 'done', mask: mask.buffer, ep }, [mask.buffer]);
    } catch (err) {
      postMessage({ id, type: 'err', msg: String((err && err.message) || err) });
    }
  });
};
