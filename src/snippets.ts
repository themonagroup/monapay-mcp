/** Code mẫu verify webhook đúng chuẩn MONA Pay cho từng ngôn ngữ (dùng bởi tool monapay_generate_webhook_snippet). */
export const SNIPPETS: Record<string, string> = {
  php: `<?php
// webhook-monapay.php — nhận webhook MONA Pay, verify HMAC-SHA256, trả 200 ngay
$secret    = getenv('MONA_WEBHOOK_SECRET');
$raw       = file_get_contents('php://input');
$timestamp = $_SERVER['HTTP_X_MONA_TIMESTAMP'] ?? '';
$signature = $_SERVER['HTTP_X_MONA_SIGNATURE'] ?? '';
if (abs(time() - (int) $timestamp) > 300) { http_response_code(400); exit('timestamp qua han'); }
$expected = 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $raw, $secret);
if (!hash_equals($expected, $signature)) { http_response_code(401); exit('sai chu ky'); }
http_response_code(200); echo 'OK';
if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
$data = json_decode($raw, true);
// $data['amount'], $data['description'], $data['transaction_code'] (khoá chống trùng), $data['account_number'], $data['bank_name'], $data['transfer_date']
// TODO: ghi nhận giao dịch + cập nhật đơn hàng`,
  node: `// webhook-monapay.js — Express: đọc raw body để chữ ký khớp
const express = require('express');
const crypto = require('crypto');
const app = express();
const SECRET = process.env.MONA_WEBHOOK_SECRET;
app.post('/webhook/monapay', express.raw({ type: 'application/json' }), (req, res) => {
  const timestamp = req.header('X-Mona-Timestamp') || '';
  const signature = req.header('X-Mona-Signature') || '';
  const rawBody = req.body.toString('utf8');
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return res.status(400).send('timestamp qua han');
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(timestamp + '.' + rawBody).digest('hex');
  const ok = signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!ok) return res.status(401).send('sai chu ky');
  res.status(200).send('OK');
  const data = JSON.parse(rawBody);
  // data.amount, data.description, data.transaction_code (khoá chống trùng), data.account_number, data.bank_name
  // TODO: ghi nhận giao dịch + cập nhật đơn hàng
});
app.listen(3000);`,
  python: `# webhook_monapay.py — FastAPI: verify HMAC-SHA256 rồi trả 200 ngay
import hmac, hashlib, time, os, json
from fastapi import FastAPI, Request, HTTPException
app = FastAPI(); SECRET = os.environ["MONA_WEBHOOK_SECRET"]
@app.post("/webhook/monapay")
async def monapay_webhook(req: Request):
    raw = await req.body(); ts = req.headers.get("x-mona-timestamp", ""); sig = req.headers.get("x-mona-signature", "")
    if abs(time.time() - float(ts or 0)) > 300: raise HTTPException(400, "timestamp qua han")
    expected = "sha256=" + hmac.new(SECRET.encode(), f"{ts}.".encode() + raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig): raise HTTPException(401, "sai chu ky")
    data = json.loads(raw)
    # data["amount"], data["description"], data["transaction_code"] (khoá chống trùng), data["account_number"], data["bank_name"]
    # TODO: ghi nhận giao dịch + cập nhật đơn hàng (đẩy sang background task)
    return {"ok": True}`,
};
export const SAMPLE_PAYLOAD = { amount: 2500000, description: 'DH10234 NGUYEN VAN A', transfer_date: '10:30:00 28/08/2026', transaction_code: 'FT26240001234', account_number: '1234567890', bank_name: 'ACB', type: 'income' };
