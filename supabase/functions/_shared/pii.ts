// 개인정보(주민번호) 암호화 — wm-hire와 같은 키(HIRE_ENC_KEY)·같은 형식('v1.' + base64(iv12 + AES-256-GCM 암호문)).
// 2026-11-10 인사 명부에 근무자 주민번호를 저장하면서 wm-admin에서 쓰려고 분리. wm-hire의 enc/dec와 서로 풀 수 있다(키·형식이 같음).
// ⚠ HIRE_ENC_KEY를 바꾸면 기존 암호문(알바 채용·근무자 둘 다)을 못 푼다.
let aes: Promise<CryptoKey> | null = null;
function key() {
  return aes ??= (async () => {
    const raw = Uint8Array.from(atob(Deno.env.get('HIRE_ENC_KEY') ?? ''), c => c.charCodeAt(0));
    if (raw.length !== 32) throw new Error('HIRE_ENC_KEY 미설정 또는 32바이트 아님 — 주민번호 저장 불가');
    return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  })().catch(e => { aes = null; throw e; });
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
export async function piiEnc(text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(text)));
  return 'v1.' + b64(new Uint8Array([...iv, ...ct]));
}
export async function piiDec(s: string | null | undefined): Promise<string | null> {
  if (!s) return null;
  const all = Uint8Array.from(atob(s.slice(3)), c => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await key(), all.slice(12)));
}
export const maskRrn = (d: string | null) => d ? `${d.slice(0, 6)}-${d[6]}******` : null;
export const fmtRrn = (d: string | null) => d ? `${d.slice(0, 6)}-${d.slice(6)}` : '';
