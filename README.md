# monapay-mcp — MCP server cho MONA Pay

MONA Pay là cổng thanh toán và API ngân hàng của The MONA Group, giúp doanh nghiệp Việt Nam nhận và xác nhận tiền chuyển khoản theo thời gian thực qua tài khoản ảo (VA), VietQR, webhook, Telegram và email, thiết kế để cả lập trình viên lẫn AI agent tích hợp trong vài phút. Miễn phí hoàn toàn, tiền không đi qua MONA Pay.

`monapay-mcp` cho **Claude Code, Cursor, Codex** (hoặc bất kỳ client MCP nào) gọi thẳng MONA Pay ngay trong lúc code: tạo VietQR cho đơn, tra giao dịch, cấu hình và bắn thử webhook, kiểm chữ ký HMAC, lấy code mẫu nhận webhook. Không cần rời IDE.

## Cài đặt

Cần Node ≥ 18 và một tài khoản MONA Pay (đăng ký xong dùng ngay, không cần duyệt): https://my.monapay.vn/auth?mode=register

```bash
npx monapay-mcp   # chạy server qua stdio
```

Biến môi trường:

| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `MONAPAY_CLIENT_ID` | có (khuyến nghị) | client_id của API key tạo trong dashboard |
| `MONAPAY_CLIENT_SECRET` | có (khuyến nghị) | client_secret hiện một lần; dùng lấy OAuth token và ký quyền cho lệnh ghi |
| `MONAPAY_USERNAME` | cách cũ | tên đăng nhập MONA Pay; chỉ dùng khi không có client credentials |
| `MONAPAY_PASSWORD` | cách cũ | mật khẩu; tài khoản bật 2FA không dùng được cách này |
| `MONAPAY_BASE_URL` | không | mặc định `https://api.monapay.vn` |

### Claude Code

```bash
claude mcp add monapay \
  -e MONAPAY_CLIENT_ID=client_id_cua_anh_chi \
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
      "env": { "MONAPAY_CLIENT_ID": "client_id", "MONAPAY_CLIENT_SECRET": "client_secret" }
    }
  }
}
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.monapay]
command = "npx"
args = ["-y", "monapay-mcp"]
env = { MONAPAY_CLIENT_ID = "client_id", MONAPAY_CLIENT_SECRET = "client_secret" }
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "monapay": {
      "command": "npx",
      "args": ["-y", "monapay-mcp"],
      "env": { "MONAPAY_CLIENT_ID": "client_id", "MONAPAY_CLIENT_SECRET": "client_secret" }
    }
  }
}
```

### Cách cũ: username/password

Nếu chưa tạo API key, có thể đặt `MONAPAY_USERNAME` và `MONAPAY_PASSWORD`. Nên chuyển sang `client_id`/`client_secret`; tài khoản bật 2FA không login bằng mật khẩu được.

## Tool

| Tool | Làm gì |
|---|---|
| `monapay_whoami` | kiểm tra kết nối, đếm bank/VA và gợi ý kênh thông báo tiếp theo |
| `monapay_me` | hồ sơ tài khoản đang đăng nhập |
| `monapay_link_bank_start` · `monapay_link_bank_verify_otp` | nối tài khoản ACB và tạo VA bằng OTP lần 1 |
| `monapay_notification_register` · `monapay_notification_verify_otp` | bật thông báo tiền vào bằng OTP lần 2 |
| `monapay_list_bank_accounts` · `monapay_list_virtual_accounts` | tài khoản ngân hàng đã nối, tài khoản ảo (VA) |
| `monapay_get_payment_profile` · `monapay_set_payment_profile` | xem hoặc thiết lập hồ sơ dùng cho trang thanh toán |
| `monapay_create_checkout` · `monapay_get_checkout` · `monapay_list_checkouts` · `monapay_cancel_checkout` | tạo link thu tiền, kiểm tra, lọc và huỷ phiên thanh toán |
| `monapay_create_qr` · `monapay_cancel_qr` | tạo / huỷ VietQR động cho đơn hàng |
| `monapay_list_transactions` | tra giao dịch tiền vào theo VA (đối soát) |
| `monapay_list_webhooks` · `monapay_create_webhook` · `monapay_update_webhook` · `monapay_delete_webhook` | cấu hình webhook (HMAC-SHA256 khuyến nghị) |
| `monapay_test_webhook` · `monapay_webhook_logs` · `monapay_webhook_stats` | bắn thử, lịch sử từng lần gửi, tỷ lệ thành công / P95 |
| `monapay_sandbox_transaction` | Tạo giao dịch tiền vào giả cho VA đã nối (webhook/Telegram/email chạy như thật, không tính hạn mức). |
| `monapay_list_email_configs` · `monapay_create_email_config` · `monapay_update_email_config` · `monapay_delete_email_config` | cấu hình email cho tối đa 10 người nhận |
| `monapay_verify_email` · `monapay_resend_email_verification` · `monapay_test_email` | xác minh bằng mã 6 số, gửi lại mã và gửi email thử |
| `monapay_email_logs` · `monapay_email_stats` | lịch sử meta, tỷ lệ thành công / P95 và nhóm lỗi gửi email |
| `monapay_list_email_suppressions` · `monapay_remove_email_suppression` | xem và gỡ địa chỉ bị chặn gửi |
| `monapay_retry_transaction` | gửi lại webhook hoặc Telegram cho một giao dịch |
| `monapay_generate_key` | sinh client_secret mới |
| `monapay_rotate_key` | xoay secret của key hiện tại khi nghi bị lộ; sau đó phải cập nhật `MONAPAY_CLIENT_SECRET` |
| `monapay_verify_signature` | kiểm chữ ký webhook ngay tại chỗ, không gọi mạng |
| `monapay_generate_webhook_snippet` | code mẫu endpoint nhận webhook PHP / Node / Python đúng chuẩn |

Resource: `monapay://docs/llms` (mục lục tài liệu máy đọc), `monapay://docs/{slug}` (một trang docs dạng markdown, ví dụ `monapay://docs/webhooks/tich-hop-webhook`). Prompt: `integrate-monapay` (6 bước để agent tự tích hợp).

`monapay_rotate_key` dùng `X-Client-Secret` hiện tại để xoay đúng key khớp với `MONAPAY_CLIENT_ID`. Secret cũ hết hiệu lực ngay; hãy thay `MONAPAY_CLIENT_SECRET` trong cấu hình MCP và khởi động lại plugin/agent.

## Ví dụ hội thoại

> "Tích hợp nhận tiền chuyển khoản cho web Laravel này bằng MONA Pay."

Agent sẽ: gọi `monapay_me` → lấy code mẫu bằng `monapay_generate_webhook_snippet(language="php")` → viết endpoint vào dự án → `monapay_create_webhook(auth_type="HMAC_SHA256", secret_key=...)` → `monapay_test_webhook` → đọc `monapay_webhook_logs` để chắc endpoint trả 200 → dùng `monapay_create_checkout` cho từng đơn và đợi `CHECKOUT_PAID`.

## Nối ngân hàng bằng OTP (4 bước)

OTP do ACB gửi về số điện thoại đăng ký của chủ tài khoản. Agent phải hỏi người dùng ở bước 2 và bước 4, tuyệt đối không tự đoán OTP.

1. Gọi `monapay_link_bank_start` với số tài khoản ACB, số điện thoại, loại khách hàng, prefix VA và mã định danh. Tool trả `acb_request_id`; ACB gửi OTP lần 1.
2. Hỏi người dùng OTP rồi gọi `monapay_link_bank_verify_otp`. Tool trả `virtual_account_id` và số VA.
3. Gọi `monapay_notification_register` với `virtual_account_id`; ACB gửi OTP lần 2.
4. Hỏi người dùng OTP lần 2 rồi gọi `monapay_notification_verify_otp`. Từ đây tiền vào sẽ được MONA Pay chuyển tiếp qua webhook đã cấu hình.

Nếu OTP sai hoặc hết hạn, gọi lại bước trước để ACB gửi mã mới.

## Chữ ký webhook

`X-Mona-Signature: sha256=<hex>` với `hex = HMAC-SHA256(secret, "<X-Mona-Timestamp>.<raw_body>")`, từ chối nếu timestamp lệch quá 300 giây, so sánh constant-time. `transaction_code` không đổi qua mọi lần gửi lại, dùng làm khoá chống trùng. Chi tiết: https://monapay.vn/docs/webhooks/bao-mat

## Phát triển

```bash
npm install && npm test        # build + node --test
MONAPAY_CLIENT_ID=... MONAPAY_CLIENT_SECRET=... npm run smoke   # gọi thật vài tool GET
```

Tài liệu: https://monapay.vn/docs · llms.txt: https://monapay.vn/llms.txt · OpenAPI: https://monapay.vn/openapi.json · Hotline 1900 636 648 · info@themona.global
