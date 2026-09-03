// Sinh mcp-manifest.json (cho monacloud-mcp / aggregator gom tool mà không cần đọc code): đọc registerTool trong src/server.ts.
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tools = [];
const re = /registerTool\('([a-z_]+)',\s*\{\s*title:\s*'((?:[^'\\]|\\.)*)',\s*description:\s*'((?:[^'\\]|\\.)*)'/g;
let m; while ((m = re.exec(src))) tools.push({ name: m[1], title: m[2].replace(/\\'/g, "'"), description: m[3].replace(/\\'/g, "'") });
const scopeOf = (n) => /list|logs|stats|whoami|me$|verify_signature|snippet/.test(n) ? 'read' : /qr/.test(n) ? 'qr:write' : /virtual_account|link_bank|notification/.test(n) ? 'va:write' : /webhook/.test(n) ? 'webhooks:write' : /email/.test(n) ? 'email:write' : 'write';
const manifest = {
  schema_version: '1', name: pkg.name, version: pkg.version, description: pkg.description,
  product: { name: 'MONA Pay', group: 'monacloud', vendor: 'The MONA Group', url: 'https://monapay.vn', docs: 'https://monapay.vn/docs/ai-agent.md', llms: 'https://monapay.vn/llms.txt', openapi: 'https://monapay.vn/openapi.json' },
  transport: { type: 'stdio', command: 'npx', args: ['-y', 'monapay-mcp'] },
  auth: { scheme: 'client_credentials', token_url: 'https://api.monapay.vn/api/v1/oauth/token', env: ['MONAPAY_CLIENT_ID', 'MONAPAY_CLIENT_SECRET'], optional_env: ['MONAPAY_BASE_URL'], write_header: 'X-Client-Secret', notes: 'Agent không cầm mật khẩu người dùng; OTP ngân hàng luôn hỏi người dùng.' },
  human_steps: ['Đăng ký tài khoản my.monapay.vn', 'OTP ngân hàng khi nối VA (2 lần)', 'Mã 6 số xác minh email người nhận'],
  tools: tools.map((t) => ({ ...t, scope: scopeOf(t.name) })),
};
writeFileSync(new URL('../mcp-manifest.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
console.log('mcp-manifest.json:', tools.length, 'tools');
