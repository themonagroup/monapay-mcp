/** Xác minh chữ ký webhook MONA Pay: X-Mona-Signature = "sha256=" + HMAC-SHA256(secret, `${X-Mona-Timestamp}.${raw_body}`), từ chối lệch > tolerance giây. */
import { createHmac, timingSafeEqual } from 'node:crypto';
export type VerifyInput = { rawBody: string; timestamp: string | number; signature: string; secret: string; toleranceSec?: number; now?: number };
export type VerifyResult = { ok: boolean; reason?: string; expected?: string };
export function computeSignature(secret: string, timestamp: string | number, rawBody: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}
export function verifyWebhookSignature(i: VerifyInput): VerifyResult {
  const tol = i.toleranceSec ?? 300; const now = i.now ?? Math.floor(Date.now() / 1000);
  const ts = Number(i.timestamp);
  if (!i.secret) return { ok: false, reason: 'thiếu secret' };
  if (!Number.isFinite(ts)) return { ok: false, reason: 'X-Mona-Timestamp không hợp lệ' };
  if (Math.abs(now - ts) > tol) return { ok: false, reason: `timestamp lệch ${Math.abs(now - ts)}s > ${tol}s (chống replay)` };
  const expected = computeSignature(i.secret, i.timestamp, i.rawBody);
  const a = Buffer.from(String(i.signature || '')); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'chữ ký không khớp', expected };
  return { ok: true };
}
