// Smoke thật: gọi tool qua server in-process (không cần Claude) bằng tài khoản test — chỉ GET/login.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
process.env.MONAPAY_USERNAME ||= 'qc-site-20260828'; process.env.MONAPAY_PASSWORD ||= 'Qc!site-2026-0828x'; process.env.MONAPAY_BASE_URL ||= 'https://ipn.mona.host';
const server = createServer(); const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st); const client = new Client({ name: 'smoke', version: '0.0.0' }); await client.connect(ct);
const tools = await client.listTools(); console.log('tools:', tools.tools.length, tools.tools.map((t) => t.name).join(', '));
for (const [name, args] of [['monapay_me', {}], ['monapay_list_bank_accounts', {}], ['monapay_list_transactions', { virtual_account_number: '0000000000', limit: 2 }], ['monapay_list_webhooks', {}], ['monapay_generate_webhook_snippet', { language: 'php' }], ['monapay_verify_signature', { raw_body: '{}', timestamp: '1', signature: 'x', secret: 's', skip_time_check: true }]]) {
  const r = await client.callTool({ name, arguments: args }); console.log(`\n== ${name} ${r.isError ? 'ERROR' : 'OK'}\n` + String(r.content?.[0]?.text || '').slice(0, 220));
}
const res = await client.readResource({ uri: 'monapay://docs/llms' }); console.log('\n== resource llms:', String(res.contents[0].text).split('\n')[0]);
const p = await client.getPrompt({ name: 'integrate-monapay', arguments: { language: 'node' } }); console.log('== prompt:', p.messages[0].content.text.slice(0, 80));
await client.close(); process.exit(0);
