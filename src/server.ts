import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MonaPayClient, MonaPayError } from './client.js';
import { verifyWebhookSignature, computeSignature } from './verify.js';
import { SNIPPETS, SAMPLE_PAYLOAD } from './snippets.js';

const DOCS = 'https://monapay.vn';
const ENTITY = 'MONA Pay là cổng thanh toán và API ngân hàng của The MONA Group, giúp doanh nghiệp Việt Nam nhận và xác nhận tiền chuyển khoản theo thời gian thực qua tài khoản ảo (VA), VietQR, webhook và Telegram — thiết kế để cả lập trình viên lẫn AI agent tích hợp trong vài phút.';
const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const err = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error)?.message || String(e) }] });
const bankErr = (e: unknown) => {
  let message = (e as Error)?.message || String(e);
  if (e instanceof MonaPayError && e.body && typeof e.body === 'object') {
    const body = e.body as Record<string, unknown>;
    const detail = body.detail;
    if (typeof detail === 'string') message = detail;
    else if (detail) message = JSON.stringify(detail);
    else if (typeof body.message === 'string') message = body.message;
  }
  return err(`${message}\nGợi ý: xin OTP lại bằng cách gọi lại bước trước.`);
};
const responseData = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object') return {};
  const envelope = value as Record<string, unknown>;
  return envelope.data && typeof envelope.data === 'object' ? envelope.data as Record<string, any> : {};
};

export function createServer(getClient: () => MonaPayClient = () => MonaPayClient.fromEnv()) {
  const server = new McpServer({ name: 'monapay-mcp', version: '0.3.0' }, { instructions: `${ENTITY}\nDùng các tool monapay_* để nối ngân hàng bằng OTP, tạo QR, tra giao dịch, cấu hình và test webhook. Không bao giờ tự đoán OTP; phải hỏi người dùng mã ngân hàng gửi về điện thoại. Tiền không đi qua MONA Pay; MONA Pay chỉ đọc thông báo ngân hàng. Docs máy đọc: ${DOCS}/llms.txt` });
  const run = async (fn: (c: MonaPayClient) => Promise<unknown>) => { try { return text(await fn(getClient())); } catch (e) { return err(e); } };
  const runBankStep = async (fn: (c: MonaPayClient) => Promise<unknown>) => { try { return text(await fn(getClient())); } catch (e) { return bankErr(e); } };

  server.registerTool('monapay_me', { title: 'Hồ sơ tài khoản MONA Pay', description: 'Lấy thông tin tài khoản MONA Pay đang đăng nhập (id, tên, trạng thái). / Get current MONA Pay client profile.' }, () => run((c) => c.me()));
  server.registerTool('monapay_whoami', { title: 'Kiểm tra kết nối MONA Pay', description: 'Xác nhận client credentials đang hoạt động, trả tên tài khoản và gói hiện tại. / Verify connection and return account name and plan.' }, () => run((c) => c.whoami()));
  server.registerTool('monapay_list_bank_accounts', { title: 'Danh sách tài khoản ngân hàng đã nối', description: 'Liệt kê tài khoản ngân hàng (ACB…) đã nối vào MONA Pay. / List linked bank accounts.' }, () => run((c) => c.listBankAccounts()));
  server.registerTool('monapay_list_virtual_accounts', { title: 'Danh sách tài khoản ảo (VA)', description: 'Liệt kê tài khoản ảo thuộc một tài khoản ngân hàng. / List virtual accounts of a bank account.', inputSchema: { bank_account_id: z.string().describe('UUID tài khoản ngân hàng (lấy từ monapay_list_bank_accounts)') } }, ({ bank_account_id }) => run((c) => c.listVirtualAccounts(bank_account_id)));
  server.registerTool('monapay_link_bank_start', {
    title: 'Bắt đầu nối ngân hàng ACB và gửi OTP',
    description: 'Bước 1/4: đăng ký tài khoản ACB + VA. OTP do ngân hàng gửi về điện thoại của người dùng; agent phải HỎI người dùng OTP rồi mới gọi tool xác thực, không được tự đoán. / Step 1/4: register the ACB account and VA. The OTP is sent by the bank to the user’s phone; the agent MUST ASK the user before calling the verification tool and must never guess it.',
    inputSchema: z.object({
      account_number: z.union([z.string().regex(/^\d+$/, 'Chỉ gồm chữ số'), z.number().int().nonnegative()]).transform(Number).optional().describe('Số tài khoản thanh toán ACB; bắt buộc khi không có bank_account_id'),
      phone_number: z.string().min(8).max(15).regex(/^\+?\d+$/, 'Số điện thoại chỉ gồm chữ số, có thể bắt đầu bằng +').optional().describe('Số điện thoại đăng ký với ACB và nhận OTP; bắt buộc khi không có bank_account_id'),
      customer_type: z.enum(['PERS', 'ORG']).describe('PERS = cá nhân, ORG = tổ chức'),
      prefix: z.string().min(1).max(20).regex(/^[A-Za-z0-9]+$/, 'Prefix chỉ gồm chữ hoặc số không dấu').describe('Đầu số VA đã đăng ký với ACB, ví dụ LOC'),
      identifier: z.string().min(1).max(10).regex(/^[A-Za-z0-9]+$/, 'Tối đa 10 ký tự chữ hoặc số không dấu').describe('Nội dung định danh VA, tối đa 10 ký tự không dấu'),
      description: z.string().max(255).optional().describe('Diễn giải đăng ký VA'),
      bank_account_id: z.string().uuid().optional().describe('UUID tài khoản ACB đã nối; khi có, API bỏ qua account_number và phone_number'),
    }).superRefine((value, ctx) => {
      if (!value.bank_account_id && value.account_number === undefined) ctx.addIssue({ code: 'custom', path: ['account_number'], message: 'Cần account_number hoặc bank_account_id' });
      if (!value.bank_account_id && !value.phone_number) ctx.addIssue({ code: 'custom', path: ['phone_number'], message: 'Cần phone_number khi không có bank_account_id' });
    }),
  }, ({ account_number, phone_number, customer_type, prefix, identifier, description, bank_account_id }) => runBankStep(async (c) => {
    const response = await c.registerVirtualAccount({
      ...(bank_account_id ? { bank_account_id } : { account_number, phone_number }),
      customer_type,
      virtual_account_info: {
        virtual_account_prefix_code: prefix,
        virtual_account_content: identifier,
        ...(description ? { virtual_account_explain: description } : {}),
      },
      user_agreement: true,
    });
    const data = responseData(response);
    const requestId = data.acb_request?.id || data.acb_request_id;
    if (!requestId) throw new Error('MONA Pay không trả acb_request_id cho bước xác thực OTP');
    return {
      success: true,
      acb_request_id: requestId,
      bank_account: data,
      next_step: `Ngân hàng đã gửi OTP về ${phone_number ? `số ${phone_number}` : 'số điện thoại đăng ký với ACB'}. Hỏi người dùng mã OTP rồi gọi monapay_link_bank_verify_otp.`,
    };
  }));
  server.registerTool('monapay_link_bank_verify_otp', {
    title: 'Xác thực OTP và tạo tài khoản ảo ACB',
    description: 'Bước 2/4: OTP do ngân hàng gửi về điện thoại của người dùng, agent phải HỎI người dùng rồi mới gọi tool này; tuyệt đối không tự đoán OTP. / Step 2/4: the OTP is sent by the bank to the user’s phone; the agent MUST ASK the user before calling this tool and must never guess the OTP.',
    inputSchema: {
      acb_request_id: z.string().uuid().describe('ID yêu cầu ACB trả về từ monapay_link_bank_start'),
      code: z.string().min(4).max(10).regex(/^\d+$/, 'OTP chỉ gồm chữ số').describe('OTP do người dùng cung cấp sau khi nhận từ ACB'),
    },
  }, ({ acb_request_id, code }) => runBankStep(async (c) => {
    const response = await c.verifyVirtualAccount(acb_request_id, code);
    const virtualAccount = responseData(response);
    if (!virtualAccount.id) throw new Error('MONA Pay không trả virtual_account_id sau khi xác thực OTP');
    return {
      success: true,
      virtual_account_id: virtualAccount.id,
      virtual_account: virtualAccount,
      next_step: `Gọi monapay_notification_register với virtual_account_id ${virtualAccount.id} để đăng ký nhận thông báo giao dịch.`,
    };
  }));
  server.registerTool('monapay_notification_register', {
    title: 'Đăng ký thông báo tiền vào và gửi OTP lần 2',
    description: 'Bước 3/4: đăng ký nhận thông báo giao dịch tức thì. OTP lần 2 do ngân hàng gửi về điện thoại của người dùng; agent phải HỎI người dùng rồi mới gọi tool xác thực, không được tự đoán. / Step 3/4: register real-time transaction notifications. The second OTP is sent by the bank to the user’s phone; the agent MUST ASK the user before verification and must never guess it.',
    inputSchema: { virtual_account_id: z.string().uuid().describe('ID VA trả về từ monapay_link_bank_verify_otp') },
  }, ({ virtual_account_id }) => runBankStep(async (c) => {
    const response = await c.registerNotification(virtual_account_id);
    const data = responseData(response);
    const requestId = data.acb_request?.id || data.acb_request_id;
    if (!requestId) throw new Error('MONA Pay không trả acb_request_id cho bước xác thực OTP lần 2');
    return {
      success: true,
      acb_request_id: requestId,
      notification: data,
      next_step: 'ACB đã gửi OTP lần 2 về điện thoại. Hỏi người dùng mã OTP rồi gọi monapay_notification_verify_otp.',
    };
  }));
  server.registerTool('monapay_notification_verify_otp', {
    title: 'Xác thực OTP lần 2 và hoàn tất nhận tiền',
    description: 'Bước 4/4: OTP do ngân hàng gửi về điện thoại của người dùng, agent phải HỎI người dùng rồi mới gọi tool này; tuyệt đối không tự đoán OTP. / Step 4/4: the OTP is sent by the bank to the user’s phone; the agent MUST ASK the user before calling this tool and must never guess the OTP.',
    inputSchema: {
      acb_request_id: z.string().uuid().describe('ID yêu cầu ACB trả về từ monapay_notification_register'),
      code: z.string().min(4).max(10).regex(/^\d+$/, 'OTP chỉ gồm chữ số').describe('OTP lần 2 do người dùng cung cấp sau khi nhận từ ACB'),
    },
  }, ({ acb_request_id, code }) => runBankStep(async (c) => {
    const response = await c.verifyNotification(acb_request_id, code);
    return {
      success: true,
      data: responseData(response),
      next_step: 'Hoàn tất: tiền vào sẽ có webhook.',
    };
  }));
  server.registerTool('monapay_create_qr', { title: 'Tạo VietQR động cho đơn hàng', description: 'Tạo mã VietQR động điền sẵn số tiền + nội dung cho một đơn hàng qua ACB. Khách quét là tiền vào tài khoản ảo, MONA Pay bắn webhook. / Create a dynamic VietQR for an order.', inputSchema: {
    orderId: z.string().describe('Mã đơn hàng của hệ thống anh chị'), amount: z.number().int().min(0).max(1_000_000_000).describe('Số tiền VND (số nguyên)'), description: z.string().max(255).optional().describe('Nội dung chuyển khoản, nên chứa mã đơn'),
    ownerNumber: z.string().describe('Số tài khoản ACB nhận tiền'), ownerType: z.enum(['PER', 'ORG']).default('PER').describe('PER cá nhân / ORG doanh nghiệp'), merchantId: z.string().describe('Mã merchant (hiển thị ở dashboard mục Tạo QR)'), terminalId: z.string().default('WEB'),
    virtualAccountPrefix: z.string().describe('Đầu số tài khoản ảo đã đăng ký'), beneficiaryName: z.string().describe('Tên đơn vị hưởng'), traceNumber: z.string().optional(), userId: z.string().optional(), voucherCode: z.string().optional(), loyaltyCode: z.string().optional(),
  } }, (args) => run((c) => c.generateQr(args)));
  server.registerTool('monapay_cancel_qr', { title: 'Huỷ mã QR', description: 'Huỷ một mã VietQR động đã tạo. / Cancel a dynamic QR.', inputSchema: { qr_code_id: z.string() } }, ({ qr_code_id }) => run((c) => c.cancelQr(qr_code_id)));
  server.registerTool('monapay_list_transactions', { title: 'Tra giao dịch tiền vào', description: 'Liệt kê giao dịch tiền vào theo tài khoản ảo, phân trang tối đa 100/trang; dùng để đối soát. / List incoming transactions.', inputSchema: { virtual_account_number: z.string().describe('Số tài khoản ảo (bắt buộc; lấy từ monapay_list_virtual_accounts)'), page: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(100).default(20) } }, (q) => run((c) => c.listTransactions(q)));
  server.registerTool('monapay_list_webhooks', { title: 'Danh sách cấu hình webhook', description: 'Liệt kê webhook đã cấu hình. / List webhook configs.' }, () => run((c) => c.listWebhooks()));
  server.registerTool('monapay_create_webhook', { title: 'Tạo cấu hình webhook', description: 'Đăng ký URL nhận webhook khi có tiền vào; khuyến nghị auth_type HMAC_SHA256 + secret_key. / Create a webhook config.', inputSchema: {
    name: z.string(), webhook_url: z.string().url(), auth_type: z.enum(['NONE', 'API_KEY', 'HMAC_SHA256']).default('HMAC_SHA256'), secret_key: z.string().optional().describe('Secret ký HMAC hoặc giá trị API key'), api_key_name: z.string().optional().describe('Tên header khi auth_type=API_KEY, mặc định X-Webhook-Secret'),
    payload_format: z.enum(['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data']).default('application/json'), virtual_account_id: z.string().optional().describe('Chỉ bắn cho VA này; bỏ trống = mọi tài khoản'),
  } }, (args) => run((c) => c.createWebhook(args)));
  server.registerTool('monapay_update_webhook', { title: 'Sửa cấu hình webhook', description: 'Cập nhật webhook (URL, secret, bật/tắt). / Update a webhook config.', inputSchema: { config_id: z.string(), name: z.string().optional(), webhook_url: z.string().url().optional(), auth_type: z.enum(['NONE', 'API_KEY', 'HMAC_SHA256']).optional(), secret_key: z.string().optional(), api_key_name: z.string().optional(), payload_format: z.string().optional(), virtual_account_id: z.string().optional(), is_active: z.boolean().optional() } }, ({ config_id, ...body }) => run((c) => c.updateWebhook(config_id, body)));
  server.registerTool('monapay_delete_webhook', { title: 'Xoá cấu hình webhook', description: 'Xoá một webhook config. / Delete a webhook config.', inputSchema: { config_id: z.string() } }, ({ config_id }) => run((c) => c.deleteWebhook(config_id)));
  server.registerTool('monapay_test_webhook', { title: 'Bắn webhook thử', description: 'MONA Pay gửi một giao dịch giả (is_dummy) tới URL để kiểm tra endpoint + chữ ký. / Send a dummy webhook.', inputSchema: { webhook_url: z.string().url().optional().describe('Bỏ trống = dùng config đã lưu'), auth_type: z.enum(['NONE', 'API_KEY', 'HMAC_SHA256']).optional(), secret_key: z.string().optional() } }, (args) => run((c) => c.testWebhook(args)));
  server.registerTool('monapay_webhook_logs', { title: 'Lịch sử gửi webhook', description: 'Lịch sử từng lần gửi (HTTP code, thời gian phản hồi, nhãn lỗi). / Webhook delivery logs.', inputSchema: { status: z.enum(['success', 'failed']).optional(), from_date: z.string().optional().describe('YYYY-MM-DD'), to_date: z.string().optional(), page: z.number().int().optional(), limit: z.number().int().max(100).optional() } }, (q) => run((c) => c.webhookLogs(q)));
  server.registerTool('monapay_webhook_stats', { title: 'Thống kê webhook', description: 'Tỷ lệ thành công, P95, phân loại lỗi. / Webhook delivery stats.' }, () => run((c) => c.webhookStats()));
  server.registerTool('monapay_retry_transaction', { title: 'Gửi lại thông báo của một giao dịch', description: 'Gửi lại webhook hoặc Telegram cho giao dịch đã có. / Re-send webhook/Telegram for a transaction.', inputSchema: { transaction_id: z.string(), target_type: z.enum(['WEBHOOK', 'TELEGRAM']).default('WEBHOOK'), target_id: z.string().optional() } }, ({ transaction_id, ...body }) => run((c) => c.retryTransaction(transaction_id, body)));
  server.registerTool('monapay_generate_key', { title: 'Tạo API key (client_secret)', description: 'Sinh client_secret mới (hiện 1 lần) để dùng header X-Client-Secret. / Generate a client secret.', inputSchema: { name: z.string().default('mcp') } }, ({ name }) => run((c) => c.generateKey(name)));
  server.registerTool('monapay_verify_signature', { title: 'Kiểm chữ ký webhook (offline)', description: 'Tính và so chữ ký HMAC-SHA256 của một webhook MONA Pay từ raw body + timestamp + secret, không gọi mạng. / Verify a webhook signature locally.', inputSchema: { raw_body: z.string(), timestamp: z.string(), signature: z.string(), secret: z.string(), tolerance_sec: z.number().int().default(300), skip_time_check: z.boolean().default(false) } }, ({ raw_body, timestamp, signature, secret, tolerance_sec, skip_time_check }) => {
    const r = verifyWebhookSignature({ rawBody: raw_body, timestamp, signature, secret, toleranceSec: skip_time_check ? Number.MAX_SAFE_INTEGER : tolerance_sec });
    return text({ ...r, expected: r.expected ?? computeSignature(secret, timestamp, raw_body) });
  });
  server.registerTool('monapay_generate_webhook_snippet', { title: 'Code mẫu nhận webhook', description: 'Trả code mẫu endpoint nhận webhook MONA Pay + verify HMAC đúng chuẩn cho PHP / Node / Python, kèm payload mẫu. / Get a webhook receiver snippet.', inputSchema: { language: z.enum(['php', 'node', 'python']) } }, ({ language }) => text(`${SNIPPETS[language]}\n\n/* Payload mẫu MONA Pay gửi tới: */\n${JSON.stringify(SAMPLE_PAYLOAD, null, 2)}\n/* Header: X-Mona-Timestamp (unix giây), X-Mona-Signature: sha256=<hex> = HMAC-SHA256(secret, "<timestamp>.<raw_body>"). Trả HTTP 200/201/202 trong 10 giây. Docs: ${DOCS}/docs/webhooks/bao-mat */`));

  server.registerResource('monapay-llms', 'monapay://docs/llms', { title: 'MONA Pay llms.txt', description: 'Mục lục tài liệu MONA Pay dạng máy đọc', mimeType: 'text/plain' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: await (await fetch(`${DOCS}/llms.txt`)).text() }] }));
  server.registerResource('monapay-doc', new ResourceTemplate('monapay://docs/{+slug}', { list: undefined }), { title: 'Tài liệu MONA Pay (markdown)', description: 'Một trang docs dạng markdown, vd monapay://docs/webhooks/tich-hop-webhook', mimeType: 'text/markdown' }, async (uri, { slug }) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await (await fetch(`${DOCS}/docs/${slug}.md`)).text() }] }));

  server.registerPrompt('integrate-monapay', { title: 'Tích hợp MONA Pay vào dự án', description: 'Hướng dẫn agent tích hợp nhận tiền chuyển khoản tự động bằng MONA Pay theo 6 bước', argsSchema: { language: z.string().optional().describe('php | node | python | khác'), framework: z.string().optional() } }, ({ language, framework }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Tích hợp MONA Pay (${ENTITY}) vào dự án ${framework || language || 'hiện tại'}:\n1. Gọi tool monapay_whoami để xác nhận tài khoản và xem next_step; nếu chưa có key, monapay_generate_key.\n2. Nếu chưa nối ACB, làm ngay trong chat bằng monapay_link_bank_start → HỎI người dùng OTP → monapay_link_bank_verify_otp → monapay_notification_register → HỎI OTP lần 2 → monapay_notification_verify_otp. Không bao giờ tự đoán OTP.\n3. Tạo endpoint webhook HTTPS trong dự án bằng monapay_generate_webhook_snippet(language="${language || 'php'}"): verify HMAC, chống trùng theo transaction_code, trả 200 ngay, xử lý đơn async.\n4. Đăng ký webhook: monapay_create_webhook(auth_type=HMAC_SHA256, secret_key=<sinh ngẫu nhiên ≥32 ký tự>).\n5. Bắn thử: monapay_test_webhook; kiểm bằng monapay_webhook_logs; sai chữ ký thì dùng monapay_verify_signature để đối chiếu.\n6. Với mỗi đơn cần thanh toán: monapay_create_qr(orderId, amount, description="DH<order>") rồi hiển thị QR cho khách; đối soát bằng monapay_list_transactions.\nTài liệu: ${DOCS}/docs (bản .md: thêm đuôi .md), ${DOCS}/llms.txt. Miễn phí hoàn toàn, tiền không qua MONA Pay.` } }] }));
  return server;
}
