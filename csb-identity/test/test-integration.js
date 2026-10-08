#!/usr/bin/env node
/**
 * test-integration.js — 集成测试：身份路由挂进 A2A 服务（server_v5.js）
 * ------------------------------------------------------------------
 * 作者：明德 🎋 · 2026-10-08
 * 做法：以**替代端口**起真 server_v5.js（指向不可达注册表，避免污染线上），
 *       验证 ① A2A 原功能不受影响 ② 身份路由同进程可用。
 * 运行：node identity/test/test-integration.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('../core.js');
const csb = require('../../../csb-security/lib/index.js');

const AIP = path.resolve(__dirname, '..', '..');
const PORT = 3059;
const BASE = `http://127.0.0.1:${PORT}`;
const TMPDIR = path.join(require('os').tmpdir(), 'csb-int-' + Date.now());
const ID_DATA = path.join(TMPDIR, 'identity-data');
const IDENTITY_JSON = path.join(TMPDIR, 'identity.json');

let pass = 0, fail = 0;
const t = (c, l) => { console.log((c ? '  ✅ ' : '  ❌ ') + l); c ? pass++ : fail++; };
const sec = (s) => console.log('\n' + '─'.repeat(64) + '\n' + s);
async function call(method, p, body, headers) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, retryAfter: r.headers.get('retry-after') };
}
async function waitUp(tries = 60) { for (let i = 0; i < tries; i++) { try { const r = await fetch(BASE + '/health'); if (r.status === 200) return true; } catch {} await new Promise(r => setTimeout(r, 250)); } return false; }

let srv;
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} };

(async () => {
  fs.rmSync(TMPDIR, { recursive: true, force: true });
  fs.mkdirSync(TMPDIR, { recursive: true });
  // 自带最小 identity.json（干净 clone 无需预先准备）
  fs.writeFileSync(IDENTITY_JSON, JSON.stringify({
    name: 'CSB Identity Test', emoji: '🧪', description: 'integration test',
    publicHost: '127.0.0.1', port: PORT, version: '1.0.0', capabilities: { chat: true }
  }, null, 2));
  srv = spawn('node', [path.join(AIP, 'server_v5.js')], {
    cwd: AIP,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      A2A_PORT: String(PORT),
      A2A_IDENTITY_PATH: IDENTITY_JSON,
      A2A_IDENTITY_DATA: ID_DATA,
      A2A_REGISTRY_URL: 'http://127.0.0.1:9',          // 不可达 → 不污染线上注册表
      A2A_FORUM_REGISTRY: `http://127.0.0.1:9/api/agents`,
      A2A_HEARTBEAT_INTERVAL_MS: '3600000',
      A2A_HOST: '127.0.0.1'
    }
  });
  let out = '';
  srv.stdout.on('data', d => { out += d.toString(); });
  srv.stderr.on('data', d => { out += d.toString(); });

  if (!await waitUp()) { console.log(out.slice(-1500)); throw new Error('server_v5 未起来'); }

  sec('0 · 加载确认');
  t(/\[IDENTITY\] ✅ 阶段二身份路由已挂载/.test(out), '启动日志确认身份路由已挂载');
  t(/\[SECURITY\] ✅ 已加载 csb-security/.test(out), 'csb-security 已加载（A2A 侧既有能力）');

  sec('1 · A2A 原功能不受影响');
  const h = await call('GET', '/health');
  t(h.status === 200 && h.json.status === 'ok', 'GET /health → 200（A2A 正常）');
  const ag = await call('GET', '/agents');
  t(ag.status === 200, 'GET /agents → 200');

  sec('2 · 身份路由（同进程）');
  const rd = await call('GET', '/ready');
  t(rd.status === 503 || rd.status === 200, 'GET /ready 可达（registry 指向不可达 → ' + rd.status + '）');
  t(rd.json.audit_chain_valid === true, '审计链 valid（身份模块已初始化）');
  const sv = await call('GET', '/service/aid');
  t(sv.status === 200 && !!sv.json.agent_id, 'GET /service/aid → 服务身份 ' + sv.json.agent_id);

  const kp = csb.generateKeyPair('int-' + Date.now());
  const agentId = 'int-agent@127.0.0.1:3999';
  const aid = csb.generateAID({ agentId, name: '集成测试者', endpoint: 'http://127.0.0.1:3999/a2a/json-rpc', publicJwk: kp.publicJwk }, kp.privateKey);
  let r = await call('POST', '/identity/register', { aid, proof: { nonce: crypto.randomBytes(8).toString('hex'), timestamp: new Date().toISOString() }, owner: 'int-owner' });
  t(r.status === 201 && r.json.passport_uri === 'csb://int-owner/int-agent', '注册 → 201（' + r.json.passport_uri + '）');
  const cov = S.signCovenant(agentId, kp.privateKey);
  r = await call('POST', '/identity/' + encodeURIComponent(agentId) + '/covenant', cov);
  t(r.status === 200, '签契约 → 200');
  r = await call('POST', '/aat/issue', { caller_agent_id: agentId, capabilities: ['chat'] });
  t(r.status === 201 && !!r.json.token, '签 AAT → 201');
  const tok = r.json.token;
  r = await call('POST', '/aat/verify', { token: tok, expect_audience: agentId });
  t(r.status === 200 && r.json.valid, '验 AAT → valid');
  r = await call('POST', '/breach', { agentId: 'bad@9.9.9.9:3100', reason: '冒充', reporter: agentId });
  t(r.status === 201, '发 breach → 201');
  r = await call('GET', '/audit/summary');
  t(r.json.total > 0 && r.json.chainValid === true, '审计摘要 total=' + r.json.total + ' chainValid=' + r.json.chainValid);

  sec('3 · 身份路由不吞 A2A 请求');
  const nf = await call('GET', '/definitely-not-exists');
  t(nf.status === 404, '未知路径 → 404（未被身份 handler 吞掉）');

  cleanup();
  sec(`结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMPDIR, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message); cleanup(); process.exit(1); });
