// Password key derivation and host identity helpers.
// The password never leaves the viewer: the host stores PBKDF2(password, salt) and both
// sides mix that key into the end-to-end handshake (see e2e.js).
// Runs unchanged in Node (>=20) and in browsers (WebCrypto, secure context only).

const enc = new TextEncoder();

export const PBKDF2_ITERATIONS = 200_000;
export const MIN_ITERATIONS = 100_000;
export const MAX_ITERATIONS = 1_000_000;

export function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomB64(byteLength) {
  return toB64(globalThis.crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** Derive the 32-byte password key from a password and a base64 salt. */
export async function deriveKey(password, saltB64, iterations = PBKDF2_ITERATIONS) {
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error('iterations out of range');
  }
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/** 9-digit public ID derived from a host secret (collisions are resolved by the server). */
export async function idFromSecret(secretB64) {
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', fromB64(secretB64)));
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(hash[i]);
  return String(n % 1_000_000_000n).padStart(9, '0');
}

export function formatId(id) {
  return id.replace(/(\d{3})(?=\d)/g, '$1 ');
}
