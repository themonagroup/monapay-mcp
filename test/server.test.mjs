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
