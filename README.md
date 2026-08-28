# monapay-mcp — MCP server cho MONA Pay

MONA Pay là cổng thanh toán và API ngân hàng của The MONA Group, giúp doanh nghiệp Việt Nam nhận và xác nhận tiền chuyển khoản theo thời gian thực qua tài khoản ảo (VA), VietQR, webhook và Telegram — thiết kế để cả lập trình viên lẫn AI agent tích hợp trong vài phút. Miễn phí hoàn toàn, tiền không đi qua MONA Pay.

`monapay-mcp` cho **Claude Code, Cursor, Codex** (hoặc bất kỳ client MCP nào) gọi thẳng MONA Pay ngay trong lúc code: tạo VietQR cho đơn, tra giao dịch, cấu hình và bắn thử webhook, kiểm chữ ký HMAC, lấy code mẫu nhận webhook. Không cần rời IDE.

## Cài đặt

Cần Node ≥ 18 và một tài khoản MONA Pay (đăng ký xong dùng ngay, không cần duyệt): https://my.monapay.vn/auth?mode=register

```bash
npx monapay-mcp   # chạy server qua stdio
```

Biến môi trường:

| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `MONAPAY_USERNAME` | có | tên đăng nhập MONA Pay |
| `MONAPAY_PASSWORD` | có | mật khẩu |
| `MONAPAY_CLIENT_SECRET` | nên có | client_secret (API key) sinh trong dashboard hoặc tool `monapay_generate_key`, dùng cho lệnh ghi |
| `MONAPAY_BASE_URL` | không | mặc định `https://api.monapay.vn` |

### Claude Code

```bash
claude mcp add monapay \
  -e MONAPAY_USERNAME=ten_dang_nhap \
  -e MONAPAY_PASSWORD=mat_khau \
  -e MONAPAY_CLIENT_SECRET=client_secret_cua_anh_chi \
  -- npx -y monapay-mcp
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "monapay": {
      "command": "npx",
      "args": ["-y", "monapay-mcp"],
      "env": { "MONAPAY_USERNAME": "ten_dang_nhap", "MONAPAY_PASSWORD": "mat_khau", "MONAPAY_CLIENT_SECRET": "client_secret" }
    }
  }
}
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.monapay]
command = "npx"
args = ["-y", "monapay-mcp"]
env = { MONAPAY_USERNAME = "ten_dang_nhap", MONAPAY_PASSWORD = "mat_khau", MONAPAY_CLIENT_SECRET = "client_secret" }
```

## Tool

| Tool | Làm gì |
|---|---|
| `monapay_me` | hồ sơ tài khoản đang đăng nhập |
| `monapay_list_bank_accounts` · `monapay_list_virtual_accounts` | tài khoản ngân hàng đã nối, tài khoản ảo (VA) |
| `monapay_create_qr` · `monapay_cancel_qr` | tạo / huỷ VietQR động cho đơn hàng |
| `monapay_list_transactions` | tra giao dịch tiền vào theo VA (đối soát) |
| `monapay_list_webhooks` · `monapay_create_webhook` · `monapay_update_webhook` · `monapay_delete_webhook` | cấu hình webhook (HMAC-SHA256 khuyến nghị) |
| `monapay_test_webhook` · `monapay_webhook_logs` · `monapay_webhook_stats` | bắn thử, lịch sử từng lần gửi, tỷ lệ thành công / P95 |
| `monapay_retry_transaction` | gửi lại webhook hoặc Telegram cho một giao dịch |
| `monapay_generate_key` | sinh client_secret mới |
| `monapay_verify_signature` | kiểm chữ ký webhook ngay tại chỗ, không gọi mạng |
| `monapay_generate_webhook_snippet` | code mẫu endpoint nhận webhook PHP / Node / Python đúng chuẩn |

Resource: `monapay://docs/llms` (mục lục tài liệu máy đọc), `monapay://docs/{slug}` (một trang docs dạng markdown, ví dụ `monapay://docs/webhooks/tich-hop-webhook`). Prompt: `integrate-monapay` (6 bước để agent tự tích hợp).

## Ví dụ hội thoại

> "Tích hợp nhận tiền chuyển khoản cho web Laravel này bằng MONA Pay."

Agent sẽ: gọi `monapay_me` → lấy code mẫu bằng `monapay_generate_webhook_snippet(language="php")` → viết endpoint vào dự án → `monapay_create_webhook(auth_type="HMAC_SHA256", secret_key=...)` → `monapay_test_webhook` → đọc `monapay_webhook_logs` để chắc endpoint trả 200 → dùng `monapay_create_qr` cho từng đơn.

## Chữ ký webhook

`X-Mona-Signature: sha256=<hex>` với `hex = HMAC-SHA256(secret, "<X-Mona-Timestamp>.<raw_body>")`, từ chối nếu timestamp lệch quá 300 giây, so sánh constant-time. `transaction_code` không đổi qua mọi lần gửi lại, dùng làm khoá chống trùng. Chi tiết: https://monapay.vn/docs/webhooks/bao-mat

## Phát triển

```bash
npm install && npm test        # build + node --test
MONAPAY_USERNAME=... MONAPAY_PASSWORD=... npm run smoke   # gọi thật vài tool GET
```

Tài liệu: https://monapay.vn/docs · llms.txt: https://monapay.vn/llms.txt · OpenAPI: https://monapay.vn/openapi.json · Hotline 1900 636 648 · info@themona.global
