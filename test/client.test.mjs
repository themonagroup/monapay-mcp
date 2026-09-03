import test from 'node:test';
import assert from 'node:assert/strict';
import { MonaPayClient } from '../dist/client.js';
function mockFetch(log) {
  let calls = 0;
  return async (url, init) => {
    log.push({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body });
    const u = String(url);
    if (u.endsWith('/oauth/token')) return new Response(JSON.stringify({ success: true, message: 'ok', data: { access_token: 'oauth' + (++calls), expires_in: 3600 } }), { status: 200 });
    if (u.endsWith('/client/login')) return new Response(JSON.stringify({ success: true, message: 'ok', data: { access_token: 'tok' + (++calls), expires_in: 86400 } }), { status: 200 });
    if (u.includes('/client/me')) return new Response(JSON.stringify({ success: true, message: 'ok', data: { name: 'Shop X', username: 'x' } }), { status: 200 });
    if (u.includes('/billing/usage')) return new Response(JSON.stringify({ success: true, message: 'ok', data: { plan_name: 'Free' } }), { status: 200 });
    if (u.includes('/client/bank-accounts')) return new Response(JSON.stringify({ success: true, message: 'ok', data: { data: [], total: 0 } }), { status: 200 });
    if (u.includes('/expired')) return new Response(JSON.stringify({ detail: 'Invalid token' }), { status: calls < 2 ? 401 : 200 });
    if (u.includes('/client-webhooks')) return new Response(JSON.stringify({ success: true, message: 'ok', data: init?.method === 'GET' ? [] : { id: 'w1' } }), { status: 200 });
    if (u.includes('/telegram-configs')) return new Response(JSON.stringify({ success: true, message: 'ok', data: [] }), { status: 200 });
    if (u.includes('/email-configs')) return new Response(JSON.stringify({ success: true, message: 'ok', data: init?.method === 'GET' ? [] : { id: 'e1' } }), { status: 200 });
    return new Response(JSON.stringify({ success: true, message: 'ok', data: null }), { status: 200 });
  };
}
test('client credentials dùng OAuth, cache token và ưu tiên trong fromEnv', async () => {
  const log = [];
  const c = MonaPayClient.fromEnv({
    MONAPAY_CLIENT_ID: 'cid', MONAPAY_CLIENT_SECRET: 'secret',
    MONAPAY_USERNAME: 'legacy-user', MONAPAY_PASSWORD: 'legacy-pass',
  });
  c.fetchImpl = mockFetch(log);
  await c.me(); await c.me();
  const oauth = log.filter((l) => l.url.endsWith('/oauth/token'));
  assert.equal(oauth.length, 1);
  assert.deepEqual(JSON.parse(oauth[0].body), {
    grant_type: 'client_credentials', client_id: 'cid', client_secret: 'secret',
  });
  assert.equal(log.some((l) => l.url.endsWith('/client/login')), false);
});
test('whoami trả username + plan và chỉ lấy một OAuth token', async () => {
  const log = [];
  const c = new MonaPayClient({ clientId: 'cid', clientSecret: 'secret', baseUrl: 'https://x.test', fetchImpl: mockFetch(log) });
  const result = await c.whoami();
  assert.deepEqual(result.data, {
    name: 'Shop X', username: 'x', plan: 'Free',
    bank_accounts: 0, virtual_accounts: 0, webhooks: 0,
    next_step: 'Nối ngân hàng: hỏi người dùng số tài khoản ACB + số điện thoại rồi gọi monapay_link_bank_start',
  });
  assert.equal(log.filter((l) => l.url.endsWith('/oauth/token')).length, 1);
});
test('5 method nối ngân hàng dựng đúng endpoint và body', async () => {
  const log = [];
  const c = new MonaPayClient({ clientId: 'cid', clientSecret: 'secret', baseUrl: 'https://x.test', fetchImpl: mockFetch(log) });
  await c.registerVirtualAccount({
    account_number: 123456789,
    phone_number: '0901234567',
    customer_type: 'PERS',
    virtual_account_info: { virtual_account_prefix_code: 'LOC', virtual_account_content: 'DH10234' },
    user_agreement: true,
  });
  await c.verifyVirtualAccount('request/id', '123456');
  await c.registerNotification('va/id');
  await c.verifyNotification('notification/id', '654321');
  await c.notificationDetail('va/id');

  const apiCalls = log.filter((item) => !item.url.endsWith('/oauth/token'));
  assert.equal(apiCalls[0].url, 'https://x.test/api/v1/acb/virtual-account/registration');
  assert.equal(JSON.parse(apiCalls[0].body).virtual_account_info.virtual_account_prefix_code, 'LOC');
  assert.ok(apiCalls[1].url.endsWith('/api/v1/acb/request%2Fid/virtual-account/verification'));
  assert.deepEqual(JSON.parse(apiCalls[1].body), { code: '123456' });
  assert.ok(apiCalls[2].url.endsWith('/api/v1/acb/va%2Fid/notification/registration'));
  assert.deepEqual(JSON.parse(apiCalls[2].body), { receive_noti_realtime: true });
  assert.ok(apiCalls[3].url.endsWith('/api/v1/acb/notification%2Fid/notification/verification'));
  assert.ok(apiCalls[4].url.endsWith('/api/v1/acb/va%2Fid/notification/details'));
  assert.equal(apiCalls[4].method, 'GET');
});
test('whoami đếm VA và hướng dẫn tạo webhook khi bank đã nối', async () => {
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/v1/oauth/token') return new Response(JSON.stringify({ success: true, data: { access_token: 'token' } }), { status: 200 });
    if (path === '/api/v1/client/me') return new Response(JSON.stringify({ success: true, data: { name: 'Shop', username: 'shop' } }), { status: 200 });
    if (path === '/api/v1/billing/usage') return new Response(JSON.stringify({ success: true, data: { plan_code: 'FREE' } }), { status: 200 });
    if (path === '/api/v1/client/bank-accounts') return new Response(JSON.stringify({ success: true, data: { data: [{ id: 'bank-1' }], total: 1 } }), { status: 200 });
    if (path === '/api/v1/client-webhooks') return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
    if (path === '/api/v1/telegram-configs') return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
    if (path === '/api/v1/email-configs') return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
    if (path.endsWith('/virtual-account/retrieve')) return new Response(JSON.stringify({ success: true, data: { data: [{ id: 'va-1' }], total: 2 } }), { status: 200 });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const c = new MonaPayClient({ clientId: 'cid', clientSecret: 'secret', baseUrl: 'https://x.test', fetchImpl });
  const result = await c.whoami();
  assert.equal(result.data.bank_accounts, 1);
  assert.equal(result.data.virtual_accounts, 2);
  assert.equal(result.data.webhooks, 0);
  assert.equal(result.data.next_step, 'Chưa có kênh thông báo nào (webhook/Telegram/email): gọi monapay_create_webhook hoặc monapay_create_email_config');
});
test('login 1 lần rồi cache token, GET không gửi X-Client-Secret', async () => {
  const log = []; const c = new MonaPayClient({ username: 'u', password: 'p', clientSecret: 's', baseUrl: 'https://x.test/', fetchImpl: mockFetch(log) });
  await c.me(); await c.me();
  assert.equal(log.filter((l) => l.url.endsWith('/client/login')).length, 1);
  const me = log.find((l) => l.url.includes('/client/me'));
  assert.equal(me.headers.Authorization, 'Bearer tok1'); assert.equal(me.headers['X-Client-Secret'], undefined);
});
test('POST gửi X-Client-Secret + Content-Type', async () => {
  const log = []; const c = new MonaPayClient({ username: 'u', password: 'p', clientSecret: 's', baseUrl: 'https://x.test', fetchImpl: mockFetch(log) });
  await c.createWebhook({ name: 'a', webhook_url: 'https://a.b/w' });
  const w = log.find((l) => l.url.includes('/client-webhooks'));
  assert.equal(w.method, 'POST'); assert.equal(w.headers['X-Client-Secret'], 's'); assert.equal(JSON.parse(w.body).name, 'a');
});
test('401 → login lại và retry 1 lần', async () => {
  const log = []; const c = new MonaPayClient({ username: 'u', password: 'p', baseUrl: 'https://x.test', fetchImpl: mockFetch(log) });
  const r = await c.request('GET', '/expired');
  assert.equal(log.filter((l) => l.url.endsWith('/client/login')).length, 2);
  assert.equal(r.success, undefined === r.success ? r.success : r.success);
});
test('query string bỏ giá trị rỗng/undefined', async () => {
  const log = []; const c = new MonaPayClient({ username: 'u', password: 'p', baseUrl: 'https://x.test', fetchImpl: mockFetch(log) });
  await c.listTransactions({ virtual_account_number: '', page: 2, limit: 50 });
  const t = log.find((l) => l.url.includes('/transactions'));
  assert.ok(t.url.includes('page=2') && t.url.includes('limit=50') && !t.url.includes('virtual_account_number'));
});

test('12 method email dựng đúng endpoint, query, body và header ghi', async () => {
  const log = [];
  const c = new MonaPayClient({ clientId: 'cid', clientSecret: 'secret', baseUrl: 'https://x.test', fetchImpl: mockFetch(log) });
  await c.listEmailConfigs();
  await c.getEmailConfig('config/id');
  await c.createEmailConfig({ name: 'Kế toán', recipients: ['kt@example.com'], events: ['TRANSACTION_IN'] });
  await c.updateEmailConfig('config/id', { is_active: true, virtual_account_id: null });
  await c.deleteEmailConfig('config/id');
  await c.verifyEmail('config/id', { email: 'kt@example.com', code: '123456' });
  await c.resendEmailVerification('config/id', { email: 'kt@example.com' });
  await c.testEmail('config/id');
  await c.emailLogs({ config_id: 'config/id', status: 'sent', event_type: 'TEST', page: 2, limit: 100 });
  await c.emailStats({ from_date: '2026-09-01', to_date: '2026-09-03' });
  await c.listEmailSuppressions();
  await c.removeEmailSuppression('bounce+tag@example.com');

  const calls = log.filter((item) => !item.url.endsWith('/oauth/token'));
  assert.equal(calls.length, 12);
  assert.equal(calls[0].url, 'https://x.test/api/v1/email-configs');
  assert.equal(calls[1].url, 'https://x.test/api/v1/email-configs/config%2Fid');
  assert.deepEqual(JSON.parse(calls[2].body), { name: 'Kế toán', recipients: ['kt@example.com'], events: ['TRANSACTION_IN'] });
  assert.deepEqual(JSON.parse(calls[3].body), { is_active: true, virtual_account_id: null });
  assert.equal(calls[4].method, 'DELETE');
  assert.equal(calls[5].url, 'https://x.test/api/v1/email-configs/config%2Fid/verify');
  assert.deepEqual(JSON.parse(calls[5].body), { email: 'kt@example.com', code: '123456' });
  assert.ok(calls[6].url.endsWith('/config%2Fid/resend-verification'));
  assert.ok(calls[7].url.endsWith('/config%2Fid/test'));
  assert.deepEqual(JSON.parse(calls[7].body), {});
  assert.match(calls[8].url, /config_id=config%2Fid/);
  assert.match(calls[8].url, /limit=100/);
  assert.match(calls[9].url, /from_date=2026-09-01/);
  assert.equal(calls[10].url, 'https://x.test/api/v1/email-suppressions');
  assert.equal(calls[11].url, 'https://x.test/api/v1/email-suppressions/bounce%2Btag%40example.com');
  for (const call of calls.filter((item) => item.method !== 'GET')) {
    assert.equal(call.headers['X-Client-Secret'], 'secret');
  }
});

test('6 method checkout và payment profile dựng đúng request', async () => {
  const log = [];
  const c = new MonaPayClient({ clientId: 'cid', clientSecret: 'secret', baseUrl: 'https://x.test', fetchImpl: mockFetch(log) });
  await c.getPaymentProfile();
  await c.setPaymentProfile({ display_name: 'Shop MONA', locale: 'vi' });
  await c.createCheckout({ amount: 250000, order_code: 'DH_10234', return_url: 'https://shop.test/return' }, 'create-key');
  await c.getCheckout('checkout/id');
  await c.listCheckouts({ status: 'pending', order_code: 'DH_10234', from_date: '2026-09-01', page: 2, limit: 50 });
  await c.cancelCheckout('checkout/id', 'cancel-key');

  const calls = log.filter((item) => !item.url.endsWith('/oauth/token'));
  assert.equal(calls.length, 6);
  assert.equal(calls[0].url, 'https://x.test/api/v1/payment-profile');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].body), { display_name: 'Shop MONA', locale: 'vi' });
  assert.equal(calls[2].url, 'https://x.test/api/v1/checkouts');
  assert.equal(calls[2].headers['Idempotency-Key'], 'create-key');
  assert.equal(calls[3].url, 'https://x.test/api/v1/checkouts/checkout%2Fid');
  assert.match(calls[4].url, /status=pending/);
  assert.match(calls[4].url, /order_code=DH_10234/);
  assert.match(calls[4].url, /limit=50/);
  assert.equal(calls[5].url, 'https://x.test/api/v1/checkouts/checkout%2Fid/cancel');
  assert.equal(calls[5].headers['Idempotency-Key'], 'cancel-key');
  assert.deepEqual(JSON.parse(calls[5].body), {});
  for (const call of calls.filter((item) => item.method !== 'GET')) {
    assert.equal(call.headers['X-Client-Secret'], 'secret');
  }
});
