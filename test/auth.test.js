import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, formatId, fromB64, idFromSecret, randomB64, toB64, MIN_ITERATIONS } from '../shared/auth.js';

test('key derivation is deterministic per (password, salt) and differs otherwise', async () => {
  const salt = randomB64(16);
  const a = await deriveKey('correct horse', salt, MIN_ITERATIONS);
  const b = await deriveKey('correct horse', salt, MIN_ITERATIONS);
  const c = await deriveKey('wrong horse', salt, MIN_ITERATIONS);
  const d = await deriveKey('correct horse', randomB64(16), MIN_ITERATIONS);
  assert.equal(a.length, 32);
  assert.equal(toB64(a), toB64(b));
  assert.notEqual(toB64(a), toB64(c));
  assert.notEqual(toB64(a), toB64(d));
});

test('iteration count outside the accepted range is refused', async () => {
  await assert.rejects(deriveKey('x', randomB64(16), 10));
  await assert.rejects(deriveKey('x', randomB64(16), 50_000_000));
});

test('IDs are 9 digits and stable for a secret', async () => {
  const secret = randomB64(32);
  const id = await idFromSecret(secret);
  assert.match(id, /^\d{9}$/);
  assert.equal(await idFromSecret(secret), id);
  assert.equal(formatId('123456789'), '123 456 789');
});

test('base64 helpers round-trip', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
  assert.deepEqual([...fromB64(toB64(bytes))], [...bytes]);
});
