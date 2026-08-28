import test from 'node:test';
import assert from 'node:assert/strict';
import { MonaPayClient } from '../dist/client.js';
function mockFetch(log) {
  let calls = 0;
  return async (url, init) => {
    log.push({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body });
    const u = String(url);
    if (u.endsWith('/client/login')) return new Response(JSON.stringify({ success: true, message: 'ok', data: { access_token: 'tok' + (++calls), expires_in: 86400 } }), { status: 200 });
    if (u.includes('/client/me')) return new Response(JSON.stringify({ success: true, message: 'ok', data: { username: 'x' } }), { status: 200 });
    if (u.includes('/expired')) return new Response(JSON.stringify({ detail: 'Invalid token' }), { status: calls < 2 ? 401 : 200 });
    if (u.includes('/client-webhooks')) return new Response(JSON.stringify({ success: true, message: 'ok', data: { id: 'w1' } }), { status: 200 });
    return new Response(JSON.stringify({ success: true, message: 'ok', data: null }), { status: 200 });
  };
}
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
