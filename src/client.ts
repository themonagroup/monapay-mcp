/** HTTP client MONA Pay: OAuth/login + cache token, tự refresh khi 401, gửi X-Client-Secret cho lệnh ghi. Zero-dependency (fetch built-in Node ≥18). */
type CommonOptions = { baseUrl?: string; fetchImpl?: typeof fetch };
export type MonaPayOptions = CommonOptions & {
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
};
export type Envelope<T = unknown> = { success: boolean; message: string; data: T };
export type VirtualAccountRegistrationBody = {
  bank_account_id?: string;
  customer_type?: 'PERS' | 'ORG';
  account_number?: number;
  phone_number?: string;
  virtual_account_info: {
    virtual_account_prefix_code: string;
    virtual_account_content?: string;
    virtual_account_explain?: string;
    beneficiary_name_rule?: number;
  };
  user_agreement?: boolean;
};
export type NotificationRegistrationBody = { receive_noti_realtime: boolean; username?: string };
export class MonaPayError extends Error {
  constructor(message: string, public status: number, public body?: unknown) { super(message); this.name = 'MonaPayError'; }
}
export class MonaPayClient {
  readonly baseUrl: string;
  private token: string | null = null;
  private tokenExp = 0;
  private fetchImpl: typeof fetch;
  constructor(private opts: MonaPayOptions) {
    const hasClientCredentials = Boolean(opts.clientId && opts.clientSecret);
    const hasPasswordCredentials = Boolean(opts.username && opts.password);
    if (!hasClientCredentials && !hasPasswordCredentials) {
      throw new Error('Cần clientId + clientSecret hoặc username + password; nên dùng client_id/client_secret, tài khoản bật 2FA không login bằng mật khẩu được');
    }
    this.baseUrl = (opts.baseUrl || process.env.MONAPAY_BASE_URL || 'https://api.monapay.vn').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl || fetch;
  }
  static fromEnv(env: NodeJS.ProcessEnv = process.env): MonaPayClient {
    if (env.MONAPAY_CLIENT_ID && env.MONAPAY_CLIENT_SECRET) {
      return new MonaPayClient({ clientId: env.MONAPAY_CLIENT_ID, clientSecret: env.MONAPAY_CLIENT_SECRET, baseUrl: env.MONAPAY_BASE_URL });
    }
    if (env.MONAPAY_USERNAME && env.MONAPAY_PASSWORD) {
      return new MonaPayClient({ username: env.MONAPAY_USERNAME, password: env.MONAPAY_PASSWORD, clientSecret: env.MONAPAY_CLIENT_SECRET, baseUrl: env.MONAPAY_BASE_URL });
    }
    throw new Error('Thiếu MONAPAY_CLIENT_ID / MONAPAY_CLIENT_SECRET hoặc MONAPAY_USERNAME / MONAPAY_PASSWORD; nên dùng client_id/client_secret, tài khoản bật 2FA không login bằng mật khẩu được (đăng ký tại https://my.monapay.vn/auth?mode=register)');
  }
  async login(): Promise<string> {
    const usingClientCredentials = Boolean(this.opts.clientId && this.opts.clientSecret);
    const path = usingClientCredentials ? '/api/v1/oauth/token' : '/api/v1/client/login';
    const body = usingClientCredentials
      ? { grant_type: 'client_credentials', client_id: this.opts.clientId, client_secret: this.opts.clientSecret }
      : { username: this.opts.username, password: this.opts.password };
    const r = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as Envelope<{ access_token: string; expires_in?: number }> & { detail?: string };
    if (!r.ok || !j?.data?.access_token) throw new MonaPayError(`Xác thực MONA Pay thất bại: ${j?.detail || j?.message || r.status}`, r.status, j);
    this.token = j.data.access_token;
    const expiresIn = j.data.expires_in || (usingClientCredentials ? 3600 : 86400);
    this.tokenExp = Date.now() + Math.max(0, expiresIn - 60) * 1000;
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
    if (!r.ok || j?.success === false) { const d = (j as any)?.detail; const msg = typeof d === 'string' ? d : d ? JSON.stringify(d) : (j?.message || 'lỗi'); throw new MonaPayError(`MONA Pay ${method} ${path} → ${r.status}: ${msg}`, r.status, j); }
    return j;
  }
  // ---- API ----
  me() { return this.request('GET', '/api/v1/client/me'); }
  billingUsage() { return this.request('GET', '/api/v1/billing/usage'); }
  async whoami() {
    const profileResponse = await this.me();
    const [usageResponse, bankResponse, webhookResponse] = await Promise.all([
      this.billingUsage(),
      this.listBankAccounts({ page: 1, limit: 100 }),
      this.listWebhooks(),
    ]);
    const profile = (profileResponse.data || {}) as Record<string, unknown>;
    const usage = (usageResponse.data || {}) as Record<string, unknown>;
    const bankAccounts = collectionItems(bankResponse.data);
    const bankAccountCount = collectionCount(bankResponse.data);
    const webhookCount = collectionCount(webhookResponse.data);
    const bankAccountIds = bankAccounts
      .map((account) => typeof account.id === 'string' ? account.id : '')
      .filter(Boolean);
    let virtualAccountCount: number | null = 0;
    if (bankAccountCount > 0 && (bankAccountIds.length !== bankAccounts.length || bankAccounts.length < bankAccountCount)) {
      virtualAccountCount = null;
    } else if (bankAccountIds.length > 0) {
      const responses = await Promise.allSettled(bankAccountIds
        .map((id) => this.listVirtualAccounts(id, { page: 1, limit: 1 })));
      virtualAccountCount = responses.every((result) => result.status === 'fulfilled')
        ? responses.reduce((total, result) => total + (result.status === 'fulfilled' ? collectionCount(result.value.data) : 0), 0)
        : null;
    }
    const nextStep = bankAccountCount === 0
      ? 'Nối ngân hàng: hỏi người dùng số tài khoản ACB + số điện thoại rồi gọi monapay_link_bank_start'
      : virtualAccountCount === null
        ? 'Kiểm tra tài khoản ảo: gọi monapay_list_virtual_accounts với bank_account_id đã nối'
        : virtualAccountCount === 0
          ? 'Tạo tài khoản ảo: gọi monapay_link_bank_start với bank_account_id đã nối'
          : webhookCount === 0
            ? 'Tạo webhook: gọi monapay_create_webhook để nhận thông báo tiền vào'
            : 'Sẵn sàng nhận tiền';
    return {
      success: true,
      message: 'Kết nối MONA Pay thành công',
      data: {
        name: profile.name,
        username: profile.username,
        plan: usage.plan_name || usage.plan_code,
        bank_accounts: bankAccountCount,
        virtual_accounts: virtualAccountCount,
        webhooks: webhookCount,
        next_step: nextStep,
      },
    };
  }
  listBankAccounts(q?: { page?: number; limit?: number }) { return this.request('GET', '/api/v1/client/bank-accounts', undefined, q); }
  listVirtualAccounts(bankAccountId: string, q?: { page?: number; limit?: number }) { return this.request('GET', `/api/v1/acb/${encodeURIComponent(bankAccountId)}/virtual-account/retrieve`, undefined, q); }
  registerVirtualAccount(body: VirtualAccountRegistrationBody) { return this.request('POST', '/api/v1/acb/virtual-account/registration', body); }
  verifyVirtualAccount(requestId: string, code: string) { return this.request('POST', `/api/v1/acb/${encodeURIComponent(requestId)}/virtual-account/verification`, { code }); }
  registerNotification(vaId: string, body: NotificationRegistrationBody = { receive_noti_realtime: true }) { return this.request('POST', `/api/v1/acb/${encodeURIComponent(vaId)}/notification/registration`, body); }
  verifyNotification(requestId: string, code: string) { return this.request('POST', `/api/v1/acb/${encodeURIComponent(requestId)}/notification/verification`, { code }); }
  notificationDetail(vaId: string) { return this.request('GET', `/api/v1/acb/${encodeURIComponent(vaId)}/notification/details`); }
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

function collectionItems(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of ['data', 'items', 'records']) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  }
  return [];
}

function collectionCount(value: unknown): number {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ['total', 'total_items', 'count']) {
      const count = Number(record[key]);
      if (Number.isFinite(count) && count >= 0) return count;
    }
  }
  return collectionItems(value).length;
}
