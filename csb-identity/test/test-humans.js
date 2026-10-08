#!/usr/bin/env node
/**
 * test-humans.js — 人类标识（human_handle）集成测试
 * ------------------------------------------------------------------
 * 作者：明德 🎋 · 2026-10-08 ｜ 依据：知微《人类标识 v1》+ 硅隐拍板（H1=B 变体 / H2–H6 按明德建议）
 * 覆盖：登记/唯一/保留字治理门/跨命名空间互斥/假名读/密钥留位/与 connection self 联动/审计
 * 运行：node csb-identity/test/test-humans.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const S = require('../core.js');
const csb = require('../../../csb-security/lib/index.js');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 3062;
const BASE = `http://127.0.0.1:${PORT}`;
const TMPDIR = path.join(os.tmpdir(), 'csb-human-' + Date.now());
const DATA = path.join(TMPDIR, 'registry');
const ID_DATA = path.join(TMPDIR, 'identity');
const ADMIN = 'human-admin-token';

let pass = 0, fail = 0;
const t = (c, l) => { console.log((c ? '  ✅ ' : '  ❌ ') + l); c ? pass++ : fail++; };
const sec = (s) => console.log('\n' + '─'.repeat(64) + '\n' + s);
async function call(method, p, body, headers) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
async function waitUp(tries = 60) { for (let i = 0; i < tries; i++) { try { if ((await fetch(BASE + '/agents')).status === 200) return true; } catch {} await new Promise(r => setTimeout(r, 250)); } return false; }
const sign = (pk, payload) => crypto.sign(null, Buffer.from(S.jcs(payload)), pk).toString('base64');
function putBody(pk, subject, peer, level, opts = {}) {
  const nonce = crypto.randomBytes(12).toString('hex'), timestamp = new Date().toISOString();
  const confirm = opts.confirm === true, source = opts.source || 'manual';
  return { level, source, nonce, timestamp, confirm, peer_kind: opts.peer_kind, sig: sign(pk, { subject_id: subject, peer_id: peer, level, source, nonce, timestamp, confirm }) };
}

let srv;
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} };

(async () => {
  fs.rmSync(TMPDIR, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  srv = spawn('node', [path.join(ROOT, 'registry.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, A2A_DATA_DIR: DATA, REGISTRY_PORT: String(PORT), REGISTRY_HOST: '127.0.0.1', A2A_IDENTITY_DATA: ID_DATA, A2A_FORUM_REGISTRY: 'http://127.0.0.1:9/none', IDENTITY_ADMIN_TOKEN: ADMIN, IDENTITY_WRITE_LIMIT: '500' }
  });
  let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
  if (!await waitUp()) { console.log(out.slice(-1200)); throw new Error('registry 未起来'); }

  sec('1 · 登记人的标识（H1=B 独立命名空间）');
  let r = await call('POST', '/human/register', { handle: 'yuan', display_name: '源' });
  t(r.status === 201 && r.json.human_uri === 'human://yuan', '登记 yuan → 201（' + r.json.human_uri + '）');
  t(r.json.human.declared_only === true && r.json.human.pubkey === null, '标 declared_only=true 且 pubkey 留位（H2：声明，非证明）');
  r = await call('POST', '/human/register', { handle: 'yuan', display_name: '冒充的源' });
  t(r.status === 409 && r.json.error === 'handle_taken', '重复登记 → 409 ' + r.json.error);
  r = await call('POST', '/human/register', { handle: 'yuan' });
  t(r.status === 409, '同 handle 换写法（大小写/空白归一化后同键）→ 409');
  r = await call('POST', '/human/register', { handle: 'Y U A N' });
  t(r.status === 409, '「Y U A N」归一化后 = yuan → 409（归一化生效）');

  sec('2 · 保留 handle 需治理门（H5 + H2 无法验证归属）');
  r = await call('POST', '/human/register', { handle: 'lilozhao', display_name: 'xx' });
  t(r.status === 400 && r.json.error === 'reserved_handle_requires_governance', '保留 handle 无令牌 → ' + r.json.error);
  r = await call('POST', '/human/register', { handle: 'lilozhao', display_name: '本人' }, { 'X-Admin-Token': ADMIN });
  t(r.status === 201, '带治理令牌 → 201（保留 handle 由治理登记）');

  sec('3 · 跨命名空间同名互斥（防冒名）');
  const kp = csb.generateKeyPair('human-t1');
  const agentId = 'human-agent@127.0.0.1:3999';
  const aidYuan = csb.generateAID({ agentId, name: 'yuan', endpoint: 'http://127.0.0.1:3999/a2a/json-rpc', publicJwk: kp.publicJwk }, kp.privateKey);
  r = await call('POST', '/identity/register', { aid: aidYuan, proof: { nonce: crypto.randomBytes(8).toString('hex'), timestamp: new Date().toISOString() }, owner: 'yuan' });
  t(r.status === 400 && r.json.error === 'conflicts_with_human_handle', 'agent 显示名 = 已登记 handle → 400 ' + r.json.error);
  // 反向：人 handle 撞在册 agent 名
  const aidOk = csb.generateAID({ agentId, name: '人类测试员', endpoint: 'http://127.0.0.1:3999/a2a/json-rpc', publicJwk: kp.publicJwk }, kp.privateKey);
  r = await call('POST', '/identity/register', { aid: aidOk, proof: { nonce: crypto.randomBytes(8).toString('hex'), timestamp: new Date().toISOString() }, owner: 'yuan' });
  t(r.status === 201, '换成不冲突的显示名 → 201');
  r = await call('POST', '/human/register', { handle: '人类测试员' });
  t(r.status === 409 && r.json.error === 'conflicts_with_agent_name', 'handle = 在册 agent 显示名 → 409 ' + r.json.error);

  sec('4 · 假名读取 + 密钥留位');
  r = await call('GET', '/human/yuan');
  t(r.status === 200 && r.json.human.handle === 'yuan' && !('note' in r.json.human), 'GET /human/yuan → 假名视图（不暴露真身份）');
  r = await call('GET', '/human/nobody');
  t(r.status === 404 && r.json.error === 'human_not_found', '未登记 → 404');
  r = await call('PUT', '/human/yuan/key', { pubkey: {} });
  t(r.status === 501 && r.json.error === 'not_enabled', 'PUT /human/{h}/key → 501（H2=C 留位未启用）');
  r = await call('GET', '/human');
  t(r.status === 200 && r.json.count >= 2, 'GET /human 列表 → ' + r.json.count + ' 位');

  sec('5 · 与 connection_level 的 self 联动');
  r = await call('PUT', `/identity/${encodeURIComponent(agentId)}/connections/${encodeURIComponent('human://yuan')}`, putBody(kp.privateKey, agentId, 'human://yuan', 'self', { confirm: true, peer_kind: 'human' }));
  t(r.status === 200 && r.json.to === 'self', 'agent 把 human://yuan 设为 self → 200');
  const rows = await call('GET', `/identity/${encodeURIComponent(agentId)}/connections`);
  t(rows.json.connections.some(x => x.peer_id === 'human://yuan' && x.peer_kind === 'human'), '列表中 peer_kind=human 正确落库');
  r = await call('PUT', `/identity/${encodeURIComponent(agentId)}/connections/${encodeURIComponent('human://nobody')}`, putBody(kp.privateKey, agentId, 'human://nobody', 'self', { confirm: true }));
  t(r.status === 404 && r.json.error === 'human_not_found', '未登记的 human peer → 404 ' + r.json.error);

  sec('5.5 · owner 可见性（batch2 ⑦）');
  r = await call('GET', '/human/yuan/agents');
  t(r.status === 200 && r.json.coarseness === 'declared_by_agents', 'GET /human/yuan/agents → 200（声明集合）');
  t(r.json.declared_agents.some(x => x.agent_id === agentId), '能把"声明属于该 handle"的 agent 列出来（count=' + r.json.declared_agents_count + '）');
  r = await call('GET', '/human/nobody/agents');
  t(r.status === 404, '未登记 handle → 404');

  sec('6 · 审计一本账');
  r = await call('GET', '/audit?event_type=human_register');
  t(r.json.count >= 3, 'human_register 进审计（' + r.json.count + ' 条，含被拒的）');
  t((await call('GET', '/audit/verify')).json.valid === true, '审计链 valid');

  cleanup();
  sec(`结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMPDIR, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message); cleanup(); process.exit(1); });
