import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebhookSignature, computeSignature } from '../dist/verify.js';
import { SNIPPETS } from '../dist/snippets.js';
const secret = 'secret_hmac_test'; const body = '{"amount":2500000,"transaction_code":"FT1"}'; const ts = '1756380000';
test('chữ ký đúng → ok', () => {
  const sig = computeSignature(secret, ts, body);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.deepEqual(verifyWebhookSignature({ rawBody: body, timestamp: ts, signature: sig, secret, now: Number(ts) + 10 }), { ok: true });
});
test('sai chữ ký → reject', () => {
  const r = verifyWebhookSignature({ rawBody: body, timestamp: ts, signature: 'sha256=' + 'a'.repeat(64), secret, now: Number(ts) });
  assert.equal(r.ok, false); assert.match(r.reason, /không khớp/);
});
test('lệch thời gian > 300s → reject (replay)', () => {
  const sig = computeSignature(secret, ts, body);
  const r = verifyWebhookSignature({ rawBody: body, timestamp: ts, signature: sig, secret, now: Number(ts) + 301 });
  assert.equal(r.ok, false); assert.match(r.reason, /lệch/);
});
test('body đổi 1 ký tự → chữ ký khác', () => {
  assert.notEqual(computeSignature(secret, ts, body), computeSignature(secret, ts, body + ' '));
});
test('snippet 3 ngôn ngữ đều có HMAC + timestamp + 300', () => {
  for (const l of ['php', 'node', 'python']) { assert.match(SNIPPETS[l], /sha256/); assert.match(SNIPPETS[l], /300/); assert.match(SNIPPETS[l], /X[-_]Mona[-_]Timestamp/i); }
});
