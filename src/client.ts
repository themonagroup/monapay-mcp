/** HTTP client MONA Pay: login + cache token, tự refresh khi 401, gửi X-Client-Secret cho lệnh ghi. Zero-dependency (fetch built-in Node ≥18). */
export type MonaPayOptions = { baseUrl?: string; username: string; password: string; clientSecret?: string; fetchImpl?: typeof fetch };
export type Envelope<T = unknown> = { success: boolean; message: string; data: T };
export class MonaPayError extends Error {
  constructor(message: string, public status: number, public body?: unknown) { super(message); this.name = 'MonaPayError'; }
}
export class MonaPayClient {
  readonly baseUrl: string;
  private token: string | null = null;
  private tokenExp = 0;
  private fetchImpl: typeof fetch;
  constructor(private opts: MonaPayOptions) {
    this.baseUrl = (opts.baseUrl || process.env.MONAPAY_BASE_URL || 'https://api.monapay.vn').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl || fetch;
  }
  static fromEnv(env: NodeJS.ProcessEnv = process.env): MonaPayClient {
    if (!env.MONAPAY_USERNAME || !env.MONAPAY_PASSWORD) throw new Error('Thiếu MONAPAY_USERNAME / MONAPAY_PASSWORD (đăng ký tại https://my.monapay.vn/auth?mode=register)');
    return new MonaPayClient({ username: env.MONAPAY_USERNAME, password: env.MONAPAY_PASSWORD, clientSecret: env.MONAPAY_CLIENT_SECRET, baseUrl: env.MONAPAY_BASE_URL });
  }
  async login(): Promise<string> {
    const r = await this.fetchImpl(`${this.baseUrl}/api/v1/client/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: this.opts.username, password: this.opts.password }) });
    const j = (await r.json().catch(() => ({}))) as Envelope<{ access_token: string; expires_in?: number }> & { detail?: string };
    if (!r.ok || !j?.data?.access_token) throw new MonaPayError(`Đăng nhập MONA Pay thất bại: ${j?.detail || j?.message || r.status}`, r.status, j);
    this.token = j.data.access_token; this.tokenExp = Date.now() + ((j.data.expires_in || 86400) - 60) * 1000;
    return this.token;
  }
  private async ensureToken(): Promise<string> { if (!this.token || Date.now() > this.tokenExp) await this.login(); return this.token as string; }
  /** Gọi API với envelope; retry 1 lần khi 401 (token hết hạn). */
  async request<T = unknown>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>, _retry = true): Promise<Envelope<T>> {
    const tok = await this.ensureToken();
    const url = new URL(this.baseUrl + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${tok}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && this.opts.clientSecret) headers['X-Client-Secret'] = this.opts.clientSecret;
    const r = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 401 && _retry) { this.token = null; return this.request<T>(method, path, body, query, false); }
    const j = (await r.json().catch(() => ({}))) as Envelope<T> & { detail?: string };
    if (!r.ok) { const d = (j as any)?.detail; const msg = typeof d === 'string' ? d : d ? JSON.stringify(d) : (j?.message || 'lỗi'); throw new MonaPayError(`MONA Pay ${method} ${path} → ${r.status}: ${msg}`, r.status, j); }
    return j;
  }
  // ---- API ----
  me() { return this.request('GET', '/api/v1/client/me'); }
  listBankAccounts() { return this.request('GET', '/api/v1/client/bank-accounts'); }
  listVirtualAccounts(bankAccountId: string) { return this.request('GET', `/api/v1/acb/${bankAccountId}/virtual-account/retrieve`); }
  generateQr(body: Record<string, unknown>) { return this.request('POST', '/api/v1/acb/qr-payment/generate', body); }
  cancelQr(qrCodeId: string) { return this.request('DELETE', `/api/v1/acb/qr-payment/${qrCodeId}/cancellation`); }
  listTransactions(q: { virtual_account_number?: string; page?: number; limit?: number }) { return this.request('GET', '/api/v1/acb/virtual-account/transactions', undefined, q); }
  listWebhooks() { return this.request('GET', '/api/v1/client-webhooks'); }
  createWebhook(body: Record<string, unknown>) { return this.request('POST', '/api/v1/client-webhooks', body); }
  updateWebhook(id: string, body: Record<string, unknown>) { return this.request('PUT', `/api/v1/client-webhooks/${id}`, body); }
  deleteWebhook(id: string) { return this.request('DELETE', `/api/v1/client-webhooks/${id}`); }
  testWebhook(body: Record<string, unknown>) { return this.request('POST', '/api/v1/client-webhooks/test', { is_dummy: true, ...body }); }
  webhookLogs(q: { status?: string; from_date?: string; to_date?: string; page?: number; limit?: number }) { return this.request('GET', '/api/v1/webhook-logs', undefined, q); }
  webhookStats() { return this.request('GET', '/api/v1/webhook-logs/stats'); }
  retryTransaction(transactionId: string, body: { target_type: 'WEBHOOK' | 'TELEGRAM'; target_id?: string }) { return this.request('POST', `/api/v1/acb/virtual-account/transactions/${transactionId}/retry`, body); }
  generateKey(name: string) { return this.request('POST', '/api/v1/client-keys/generate', { name }); }
  listKeys() { return this.request('GET', '/api/v1/client-keys/list'); }
}
