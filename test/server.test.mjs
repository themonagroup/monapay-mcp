import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MonaPayClient } from '../dist/client.js';
import { createServer } from '../dist/server.js';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function parsedText(result) {
  const item = result.content?.find((content) => content.type === 'text');
  assert.ok(item, 'tool phải trả text content');
  return JSON.parse(item.text);
}

async function withMcp(fetchImpl, fn) {
  const api = new MonaPayClient({
    clientId: 'client-id', clientSecret: 'client-secret', baseUrl: 'https://example.test', fetchImpl,
  });
  const server = createServer(() => api);
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test('4 tool nối ngân hàng ánh xạ body, ID và hướng dẫn OTP đúng', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init?.method, body: init?.body, headers: init?.headers });
    if (path === '/api/v1/oauth/token') return response({ success: true, data: { access_token: 'token', expires_in: 3600 } });
    if (path === '/api/v1/acb/virtual-account/registration') return response({
      success: true,
      data: { id: 'bank-id', account_number: '123456789', acb_request: { id: '11111111-1111-4111-8111-111111111111' } },
    });
    if (path.endsWith('/virtual-account/verification')) return response({
      success: true,
      data: { id: '22222222-2222-4222-8222-222222222222', virtual_account_number: 'LOC000010234' },
    });
    if (path.endsWith('/notification/registration')) return response({
      success: true,
      data: { acb_request: { id: '33333333-3333-4333-8333-333333333333' } },
    }, 201);
    if (path.endsWith('/notification/verification')) return response({ success: true, data: { status: 'ACTIVE' } });
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withMcp(fetchImpl, async (client) => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const name of [
      'monapay_link_bank_start',
      'monapay_link_bank_verify_otp',
      'monapay_notification_register',
      'monapay_notification_verify_otp',
    ]) {
      assert.ok(names.includes(name));
      const description = listed.tools.find((tool) => tool.name === name)?.description || '';
      assert.match(description, /HỎI/);
      assert.match(description, /ASK/);
    }

    const started = parsedText(await client.callTool({
      name: 'monapay_link_bank_start',
      arguments: {
        account_number: '123456789', phone_number: '0901234567', customer_type: 'PERS',
        prefix: 'LOC', identifier: 'DH10234', description: 'Don hang 10234',
      },
    }));
    assert.equal(started.acb_request_id, '11111111-1111-4111-8111-111111111111');
    assert.match(started.next_step, /0901234567/);
    assert.match(started.next_step, /monapay_link_bank_verify_otp/);

    const verified = parsedText(await client.callTool({
      name: 'monapay_link_bank_verify_otp',
      arguments: { acb_request_id: started.acb_request_id, code: '123456' },
    }));
    assert.equal(verified.virtual_account_id, '22222222-2222-4222-8222-222222222222');
    assert.match(verified.next_step, /monapay_notification_register/);

    const notification = parsedText(await client.callTool({
      name: 'monapay_notification_register',
      arguments: { virtual_account_id: verified.virtual_account_id },
    }));
    assert.equal(notification.acb_request_id, '33333333-3333-4333-8333-333333333333');
    assert.match(notification.next_step, /OTP lần 2/);

    const completed = parsedText(await client.callTool({
      name: 'monapay_notification_verify_otp',
      arguments: { acb_request_id: notification.acb_request_id, code: '654321' },
    }));
    assert.equal(completed.next_step, 'Hoàn tất: tiền vào sẽ có webhook.');
  });

  const registration = calls.find((call) => call.path.endsWith('/virtual-account/registration'));
  assert.deepEqual(JSON.parse(registration.body), {
    account_number: 123456789,
    phone_number: '0901234567',
    customer_type: 'PERS',
    virtual_account_info: {
      virtual_account_prefix_code: 'LOC',
      virtual_account_content: 'DH10234',
      virtual_account_explain: 'Don hang 10234',
    },
    user_agreement: true,
  });
  const notificationRegistration = calls.find((call) => call.path.endsWith('/notification/registration'));
  assert.deepEqual(JSON.parse(notificationRegistration.body), { receive_noti_realtime: true });
  assert.equal(notificationRegistration.headers['X-Client-Secret'], 'client-secret');
});

test('tool nối ngân hàng giữ nguyên lỗi API tiếng Việt và thêm gợi ý', async () => {
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/v1/oauth/token') return response({ success: true, data: { access_token: 'token' } });
    return response({ detail: 'Số tài khoản ACB không đúng' }, 400);
  };
  await withMcp(fetchImpl, async (client) => {
    const result = await client.callTool({
      name: 'monapay_link_bank_start',
      arguments: {
        account_number: '0000000000', phone_number: '0901234567', customer_type: 'PERS',
        prefix: 'LOC', identifier: 'TEST',
      },
    });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'Số tài khoản ACB không đúng\nGợi ý: xin OTP lại bằng cách gọi lại bước trước.');
  });
});

test('monapay_rotate_key xoay key hiện tại và nhắc cập nhật biến môi trường', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ path: parsed.pathname, method: init?.method, headers: init?.headers });
    if (parsed.pathname === '/api/v1/oauth/token') {
      return response({ success: true, data: { access_token: 'token', expires_in: 3600 } });
    }
    if (parsed.pathname === '/api/v1/client-keys/list') {
      return response({ success: true, data: [{ id: 'key-id', client_id: 'client-id' }] });
    }
    if (parsed.pathname === '/api/v1/client-keys/key-id/rotate') {
      return response({ client_id: 'client-id', client_secret: 'rotated-secret' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withMcp(fetchImpl, async (client) => {
    const listed = await client.listTools();
    const rotateTool = listed.tools.find((tool) => tool.name === 'monapay_rotate_key');
    assert.ok(rotateTool);
    assert.match(rotateTool.description, /secret nghi lộ/i);
    assert.match(rotateTool.description, /MONAPAY_CLIENT_SECRET/);

    const result = parsedText(await client.callTool({ name: 'monapay_rotate_key', arguments: {} }));
    assert.equal(result.data.client_secret, 'rotated-secret');
    assert.match(result.action_required, /MONAPAY_CLIENT_SECRET/);
    assert.match(result.action_required, /secret cũ đã hết hiệu lực/i);
  });

  const rotateCall = calls.find((call) => call.path.endsWith('/rotate'));
  assert.equal(rotateCall.method, 'POST');
  assert.equal(rotateCall.headers['X-Client-Secret'], 'client-secret');
});

test('monapay_whoami trả số lượng và next_step nối ngân hàng khi chưa có bank', async () => {
  let loginCount = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/v1/oauth/token') {
      loginCount += 1;
      return response({ success: true, data: { access_token: 'token', expires_in: 3600 } });
    }
    if (parsed.pathname === '/api/v1/client/me') return response({ success: true, data: { name: 'Shop Test', username: 'shop' } });
    if (parsed.pathname === '/api/v1/billing/usage') return response({ success: true, data: { plan_name: 'Free' } });
    if (parsed.pathname === '/api/v1/client/bank-accounts') return response({ success: true, data: { data: [], total: 0 } });
    if (parsed.pathname === '/api/v1/client-webhooks') return response({ success: true, data: [] });
    if (parsed.pathname === '/api/v1/telegram-configs') return response({ success: true, data: [] });
    if (parsed.pathname === '/api/v1/email-configs') return response({ success: true, data: [] });
    if (parsed.pathname === '/api/v1/zalo-groups') return response({ success: true, data: [] });
    throw new Error(`Unexpected URL: ${url}`);
  };
  await withMcp(fetchImpl, async (client) => {
    const result = parsedText(await client.callTool({ name: 'monapay_whoami', arguments: {} }));
    assert.deepEqual(result.data, {
      name: 'Shop Test', username: 'shop', plan: 'Free',
      bank_accounts: 0, virtual_accounts: 0, webhooks: 0,
      next_step: 'Nối ngân hàng: hỏi người dùng số tài khoản ACB + số điện thoại rồi gọi monapay_link_bank_start',
    });
  });
  assert.equal(loginCount, 1);
});

test('11 tool email có schema chặt và ánh xạ đúng API', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ path: parsed.pathname, search: parsed.search, method: init?.method, body: init?.body, headers: init?.headers });
    if (parsed.pathname === '/api/v1/oauth/token') return response({ success: true, data: { access_token: 'token', expires_in: 3600 } });
    return response({ success: true, data: { ok: true } });
  };
  const configId = '11111111-1111-4111-8111-111111111111';

  await withMcp(fetchImpl, async (client) => {
    const listed = await client.listTools();
    const emailToolNames = [
      'monapay_list_email_configs', 'monapay_create_email_config', 'monapay_update_email_config',
      'monapay_delete_email_config', 'monapay_verify_email', 'monapay_resend_email_verification',
      'monapay_test_email', 'monapay_email_logs', 'monapay_email_stats',
      'monapay_list_email_suppressions', 'monapay_remove_email_suppression',
    ];
    for (const name of emailToolNames) assert.ok(listed.tools.some((tool) => tool.name === name), `${name} phải được đăng ký`);
    const createTool = listed.tools.find((tool) => tool.name === 'monapay_create_email_config');
    assert.match(createTool.description, /hỏi người dùng mã/i);
    assert.match(createTool.description, /không tự đoán mã/i);
    assert.equal(createTool.inputSchema.properties.recipients.maxItems, 10);
    const verifyTool = listed.tools.find((tool) => tool.name === 'monapay_verify_email');
    assert.equal(verifyTool.inputSchema.properties.code.pattern, '^\\d{6}$');

    await client.callTool({ name: 'monapay_list_email_configs', arguments: {} });
    await client.callTool({ name: 'monapay_create_email_config', arguments: { name: 'Kế toán', recipients: ['kt@example.com'] } });
    await client.callTool({ name: 'monapay_update_email_config', arguments: { config_id: configId, name: 'Kế toán mới', is_active: true } });
    await client.callTool({ name: 'monapay_delete_email_config', arguments: { config_id: configId } });
    await client.callTool({ name: 'monapay_verify_email', arguments: { config_id: configId, email: 'kt@example.com', code: '123456' } });
    await client.callTool({ name: 'monapay_resend_email_verification', arguments: { config_id: configId, email: 'kt@example.com' } });
    await client.callTool({ name: 'monapay_test_email', arguments: { config_id: configId } });
    await client.callTool({ name: 'monapay_email_logs', arguments: { config_id: configId, status: 'sent', event_type: 'TEST', from_date: '2026-09-01', page: 2, limit: 100 } });
    await client.callTool({ name: 'monapay_email_stats', arguments: { from_date: '2026-09-01', to_date: '2026-09-03' } });
    await client.callTool({ name: 'monapay_list_email_suppressions', arguments: {} });
    await client.callTool({ name: 'monapay_remove_email_suppression', arguments: { email: 'bounce+tag@example.com' } });
  });

  const apiCalls = calls.filter((call) => call.path !== '/api/v1/oauth/token');
  assert.equal(apiCalls.length, 11);
  assert.equal(apiCalls[0].path, '/api/v1/email-configs');
  assert.deepEqual(JSON.parse(apiCalls[1].body), { name: 'Kế toán', recipients: ['kt@example.com'], events: ['TRANSACTION_IN'] });
  assert.deepEqual(JSON.parse(apiCalls[2].body), { name: 'Kế toán mới', is_active: true });
  assert.equal(apiCalls[3].method, 'DELETE');
  assert.deepEqual(JSON.parse(apiCalls[4].body), { email: 'kt@example.com', code: '123456' });
  assert.ok(apiCalls[5].path.endsWith('/resend-verification'));
  assert.deepEqual(JSON.parse(apiCalls[6].body), {});
  assert.match(apiCalls[7].search, /status=sent/);
  assert.match(apiCalls[7].search, /limit=100/);
  assert.match(apiCalls[8].search, /to_date=2026-09-03/);
  assert.equal(apiCalls[9].path, '/api/v1/email-suppressions');
  assert.equal(apiCalls[10].path, '/api/v1/email-suppressions/bounce%2Btag%40example.com');
  for (const call of apiCalls.filter((item) => item.method !== 'GET')) {
    assert.equal(call.headers['X-Client-Secret'], 'client-secret');
  }
});

test('6 tool nhóm Zalo có schema chặt và ánh xạ đúng API', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ path: parsed.pathname, search: parsed.search, method: init?.method, body: init?.body, headers: init?.headers });
    if (parsed.pathname === '/api/v1/oauth/token') return response({ success: true, data: { access_token: 'token', expires_in: 3600 } });
    return response({ success: true, data: { ok: true } });
  };
  const configId = '1f0e9d76-3f00-6000-8000-000000000001';

  await withMcp(fetchImpl, async (client) => {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 47);
    const zaloToolNames = [
      'monapay_list_zalo_groups', 'monapay_create_zalo_group', 'monapay_update_zalo_group',
      'monapay_delete_zalo_group', 'monapay_test_zalo_group', 'monapay_zalo_group_logs',
    ];
    for (const name of zaloToolNames) assert.ok(listed.tools.some((tool) => tool.name === name), `${name} phải được đăng ký`);
    const createTool = listed.tools.find((tool) => tool.name === 'monapay_create_zalo_group');
    assert.match(createTool.description, /bot Gấu Mona/);
    assert.match(createTool.description, /MONA Account\/PMS/);
    assert.match(createTool.description, /không parse Markdown/);
    assert.equal(createTool.inputSchema.properties.group_id.pattern, '^\\d{10,25}$');
    assert.deepEqual(createTool.inputSchema.properties.events.default, ['TRANSACTION_IN']);
    const updateTool = listed.tools.find((tool) => tool.name === 'monapay_update_zalo_group');
    assert.equal(updateTool.inputSchema.properties.id.format, undefined);

    await client.callTool({ name: 'monapay_list_zalo_groups', arguments: {} });
    await client.callTool({
      name: 'monapay_create_zalo_group',
      arguments: { group_id: '1234567890123', friendly_name: 'Kế toán', message_template: 'Nhận {amount}', events: ['TRANSACTION_IN', 'CHECKOUT_PAID'] },
    });
    await client.callTool({ name: 'monapay_update_zalo_group', arguments: { id: configId, friendly_name: 'Kế toán mới', is_active: false } });
    await client.callTool({ name: 'monapay_delete_zalo_group', arguments: { id: configId } });
    await client.callTool({ name: 'monapay_test_zalo_group', arguments: { id: configId } });
    await client.callTool({ name: 'monapay_zalo_group_logs', arguments: { limit: 20, status: 'failed' } });
  });

  const apiCalls = calls.filter((call) => call.path !== '/api/v1/oauth/token');
  assert.equal(apiCalls.length, 6);
  assert.equal(apiCalls[0].path, '/api/v1/zalo-groups');
  assert.deepEqual(JSON.parse(apiCalls[1].body), {
    group_id: '1234567890123', friendly_name: 'Kế toán', message_template: 'Nhận {amount}', events: ['TRANSACTION_IN', 'CHECKOUT_PAID'],
  });
  assert.equal(apiCalls[2].path, `/api/v1/zalo-groups/${configId}`);
  assert.equal(apiCalls[2].method, 'PUT');
  assert.deepEqual(JSON.parse(apiCalls[2].body), { friendly_name: 'Kế toán mới', is_active: false });
  assert.equal(apiCalls[3].method, 'DELETE');
  assert.equal(apiCalls[4].path, `/api/v1/zalo-groups/${configId}/test`);
  assert.deepEqual(JSON.parse(apiCalls[4].body), {});
  assert.match(apiCalls[5].search, /limit=20/);
  assert.match(apiCalls[5].search, /status=failed/);
  for (const call of apiCalls.filter((item) => item.method !== 'GET')) {
    assert.equal(call.headers['X-Client-Secret'], 'client-secret');
  }
});

test('6 tool checkout và payment profile có schema chặt, ánh xạ đúng API', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ path: parsed.pathname, search: parsed.search, method: init?.method, body: init?.body, headers: init?.headers });
    if (parsed.pathname === '/api/v1/oauth/token') return response({ success: true, data: { access_token: 'token', expires_in: 3600 } });
    return response({ success: true, data: { id: 'checkout-id', checkout_url: 'https://pay.monapay.vn/c/token' } });
  };

  await withMcp(fetchImpl, async (client) => {
    const listed = await client.listTools();
    const names = [
      'monapay_get_payment_profile', 'monapay_set_payment_profile', 'monapay_create_checkout',
      'monapay_get_checkout', 'monapay_list_checkouts', 'monapay_cancel_checkout',
    ];
    for (const name of names) assert.ok(listed.tools.some((tool) => tool.name === name), `${name} phải được đăng ký`);
    const createTool = listed.tools.find((tool) => tool.name === 'monapay_create_checkout');
    assert.match(createTool.description, /Tạo link thu tiền/);
    assert.match(createTool.description, /CHECKOUT_PAID/);
    assert.equal(createTool.inputSchema.properties.amount.minimum, 1000);
    assert.equal(createTool.inputSchema.properties.amount.maximum, 1000000000);
    assert.equal(createTool.inputSchema.properties.order_code.pattern, '^[A-Za-z0-9_-]+$');

    await client.callTool({ name: 'monapay_get_payment_profile', arguments: {} });
    await client.callTool({ name: 'monapay_set_payment_profile', arguments: { display_name: 'Shop MONA', accent_color: '#971B38' } });
    await client.callTool({ name: 'monapay_create_checkout', arguments: { amount: 250000, order_code: 'DH_10234', return_url: 'https://shop.test/return', idempotency_key: 'create-key' } });
    await client.callTool({ name: 'monapay_get_checkout', arguments: { checkout_id: 'checkout/id' } });
    await client.callTool({ name: 'monapay_list_checkouts', arguments: { status: 'pending', order_code: 'DH_10234', page: 2, limit: 50 } });
    await client.callTool({ name: 'monapay_cancel_checkout', arguments: { checkout_id: 'checkout/id', idempotency_key: 'cancel-key' } });
  });

  const apiCalls = calls.filter((call) => call.path !== '/api/v1/oauth/token');
  assert.equal(apiCalls.length, 6);
  assert.equal(apiCalls[0].path, '/api/v1/payment-profile');
  assert.equal(apiCalls[1].method, 'PUT');
  assert.deepEqual(JSON.parse(apiCalls[2].body), { amount: 250000, order_code: 'DH_10234', return_url: 'https://shop.test/return' });
  assert.equal(apiCalls[2].headers['Idempotency-Key'], 'create-key');
  assert.equal(apiCalls[3].path, '/api/v1/checkouts/checkout%2Fid');
  assert.match(apiCalls[4].search, /status=pending/);
  assert.match(apiCalls[4].search, /page=2/);
  assert.equal(apiCalls[5].path, '/api/v1/checkouts/checkout%2Fid/cancel');
  assert.equal(apiCalls[5].headers['Idempotency-Key'], 'cancel-key');
});
