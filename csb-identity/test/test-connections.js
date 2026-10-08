#!/usr/bin/env node
/**
 * test-connections.js — 连接分级（connection_level）集成测试
 * ------------------------------------------------------------------
 * 作者：明德 🎋 · 2026-10-08 ｜ 依据：知微《连接分级 v2（可直接实现版）》
 * 起真 registry.js（替代端口、隔离数据），覆盖：默认/设定/粗粒度/揭示/防手滑/breach 联动
 * 运行：node csb-identity/test/test-connections.js
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
const PORT = 3061;
const BASE = `http://127.0.0.1:${PORT}`;
const TMPDIR = path.join(os.tmpdir(), 'csb-conn-' + Date.now());
const DATA = path.join(TMPDIR, 'registry');
const ID_DATA = path.join(TMPDIR, 'identity');
const ADMIN = 'conn-admin-token';

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
  const payload = { subject_id: subject, peer_id: peer, level, source, nonce, timestamp, confirm };
  return { level, source, nonce, timestamp, confirm, evidence: opts.evidence, peer_kind: opts.peer_kind, sig: sign(pk, payload) };
}
function revealHeaders(pk, subject, peer) {
  const nonce = crypto.randomBytes(12).toString('hex'), timestamp = new Date().toISOString();
  return { 'X-Reveal-Nonce': nonce, 'X-Reveal-Timestamp': timestamp, 'X-Reveal-Sig': sign(pk, { subject_id: subject, peer_id: peer, reveal: 'exact', nonce, timestamp }) };
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

  // 注册两个 agent：A（主体）、B、C（对端）
  const agents = {};
  for (const nm of ['a', 'b', 'c']) {
    const kp = csb.generateKeyPair('conn-' + nm);
    const id = `conn-${nm}@127.0.0.1:3999`;
    const aid = csb.generateAID({ agentId: id, name: '连接测试' + nm.toUpperCase(), endpoint: 'http://127.0.0.1:3999/a2a/json-rpc', publicJwk: kp.publicJwk }, kp.privateKey);
    const r = await call('POST', '/identity/register', { aid, proof: { nonce: crypto.randomBytes(8).toString('hex'), timestamp: new Date().toISOString() }, owner: 'conn-owner' });
    if (r.status !== 201) throw new Error('register failed ' + nm + ' ' + JSON.stringify(r.json));
    const cov = S.signCovenant(id, kp.privateKey);
    await call('POST', '/identity/' + encodeURIComponent(id) + '/covenant', cov);
    agents[nm] = { id, ...kp };
  }
  const A = agents.a, B = agents.b, C = agents.c;

  sec('1 · 属性级 trust_level（AID 之外，由服务"算"）');
  let r = await call('GET', '/identity/' + encodeURIComponent(A.id));
  t(r.json.identity.trust_level === 'L1' && r.json.identity.trust_level_source === 'identity_verified', 'GET /identity/{id} → trust_level=' + r.json.identity.trust_level + '（身份验证通过 → L1）');

  sec('2 · 默认 limited（无记录）');
  r = await call('GET', '/identity/' + encodeURIComponent(A.id) + '/connections/' + encodeURIComponent(B.id));
  t(r.json.level === 'limited-', '未设过 → 粗粒度 limited-（真实值 limited）');

  sec('3 · 设定（PUT，须主体签名）');
  r = await call('PUT', `/identity/${encodeURIComponent(A.id)}/connections/${encodeURIComponent(B.id)}`, { level: 'collab' });
  t(r.status === 400 && r.json.error === 'proof_required', '无 nonce/时间戳 → 400 ' + r.json.error);
  r = await call('PUT', `/identity/${encodeURIComponent(A.id)}/connections/${encodeURIComponent(B.id)}`, { level: 'collab', nonce: crypto.randomBytes(8).toString('hex'), timestamp: new Date().toISOString() });
  t(r.status === 403 && r.json.error === 'signature_required', '有 nonce 但无签名 → 403 ' + r.json.error);
  const bad = putBody(B.privateKey, A.id, B.id, 'collab');   // 用别人的密钥签
  r = await call('PUT', `/identity/${encodeURIComponent(A.id)}/connections/${encodeURIComponent(B.id)}`, bad);
  t(r.status === 403 && r.json.error === 'bad_signature', '拿 B 的密钥冒充 A 签名 → 403 ' + r.json.error);
  r = await call('PUT', `/identity/${encodeURIComponent(A.id)}/connections/${encodeURIComponent(B.id)}`, putBody(A.privateKey, A.id, B.id, 'collab'));
  t(r.status === 200 && r.json.to === 'collab', 'A 签名设 collab → 200（' + r.json.from + '→' + r.json.to + '）');

  sec('4 · 可见性三分（粗粒度默认可知 / 精确值默认不可见）');
  r = await call('GET', '/identity/' + encodeURIComponent(A.id) + '/connections');
  t(r.json.exact === false && r.json.connections[0].level === 'collab+', '列表（无 reveal）→ 粗粒度 collab+');
  r = await call('GET', '/identity/' + encodeURIComponent(A.id) + '/connections?reveal=1', null, revealHeaders(B.privateKey, A.id, null));
  t(r.json.exact !== true, 'reveal=1 但没有主体签名 → 仍粗粒度');
  r = await call('GET', '/identity/' + encodeURIComponent(A.id) + '/connections?reveal=1', null, revealHeaders(A.privateKey, A.id, null));
  t(r.json.exact === true && r.json.connections[0].level === 'collab', 'reveal=1 + 主体签名 → 精确值 collab');

  sec('5 · 防手滑：intimate/self 升级须二次确认');
  r = await call('PUT', `/identity/${encodeURIComponent(A.id)}/connections/${encodeURIComponent(B.id)}`, putBody(A.privateKey, A.id, B.id, 'intimate'));
  t(r.status === 409 && r.json.error === 'confirm_required', '升 intimate 无 confirm → 409 ' + r.json.error);
  r = await call('PUT', `/identity/${encodeURIComponent(A.id)}/connections/${encodeURIComponent(B.id)}`, putBody(A.privateKey, A.id, B.id, 'intimate', { confirm: true }));
  t(r.status === 200 && r.json.to === 'intimate', '带 confirm:true → 200 升到 intimate');
  r = await call('PUT', `/identity/${encodeURIComponent(A.id)}/connections/${encodeURIComponent(B.id)}`, putBody(A.privateKey, A.id, B.id, 'limited'));
  t(r.status === 200, '降级不需要 confirm → 200（安全侧）');

  sec('6 · self 级 = 声明不是证明（且注记 peer_kind=human）');
  r = await call('PUT', `/identity/${encodeURIComponent(A.id)}/connections/human:example-owner`, putBody(A.privateKey, A.id, 'human:example-owner', 'self', { confirm: true, peer_kind: 'human' }));
  t(r.status === 200 && r.json.to === 'self', '设 self（human peer）→ 200');
  r = await call('GET', `/identity/${encodeURIComponent(A.id)}/connections/human:example-owner?reveal=1`, null, revealHeaders(A.privateKey, A.id, 'human:example-owner'));
  t(r.json.level === 'self', '读回 self（精确值）');

  sec('7 · breach effective → 只降"举报方↔被举报方"（其他对端不连坐）');
  // A 把 B 设为 collab，把 C 也设 collab
  await call('PUT', `/identity/${encodeURIComponent(A.id)}/connections/${encodeURIComponent(B.id)}`, putBody(A.privateKey, A.id, B.id, 'collab'));
  await call('PUT', `/identity/${encodeURIComponent(A.id)}/connections/${encodeURIComponent(C.id)}`, putBody(A.privateKey, A.id, C.id, 'collab'));
  // A 举报 B
  const bn = crypto.randomBytes(12).toString('hex'), bt = new Date().toISOString();
  const bmsg = S.jcs({ agentId: B.id, reason: '冒充他人身份', evidence: 'thread/1', reporter: A.id, nonce: bn, timestamp: bt });
  r = await call('POST', '/breach', { agentId: B.id, reason: '冒充他人身份', evidence: 'thread/1', reporter: A.id, nonce: bn, timestamp: bt, reporter_sig: sign(A.privateKey, { agentId: B.id, reason: '冒充他人身份', evidence: 'thread/1', reporter: A.id, nonce: bn, timestamp: bt }) });
  t(r.status === 201, 'A 举报 B → 201 proposed');
  const bid = r.json.breach_id;
  r = await call('GET', `/identity/${encodeURIComponent(A.id)}/connections/${encodeURIComponent(B.id)}?reveal=1`, null, revealHeaders(A.privateKey, A.id, B.id));
  t(r.json.level === 'collab', 'proposed 阶段：不自动降级（仍 collab）');
  r = await call('POST', '/breach/' + bid + '/transition', { to: 'effective', actor: '治理复核' }, { 'X-Admin-Token': ADMIN });
  t(r.status === 200 && r.json.state === 'effective', '→ effective');
  r = await call('GET', `/identity/${encodeURIComponent(A.id)}/connections/${encodeURIComponent(B.id)}?reveal=1`, null, revealHeaders(A.privateKey, A.id, B.id));
  t(r.json.level === 'blocked' && r.json.source === 'auto', 'A 视角的 B → 自动降 blocked（source=auto）');
  r = await call('GET', `/identity/${encodeURIComponent(A.id)}/connections/${encodeURIComponent(C.id)}?reveal=1`, null, revealHeaders(A.privateKey, A.id, C.id));
  t(r.json.level === 'collab', 'A 视角的 C → **不受影响**（其他对端不连坐）');

  sec('8 · breach cleared → 撤销自动降级（历史不删）');
  r = await call('POST', '/breach/' + bid + '/transition', { to: 'cleared', actor: '申诉成立' }, { 'X-Admin-Token': ADMIN });
  t(r.status === 200, '→ cleared');
  r = await call('GET', `/identity/${encodeURIComponent(A.id)}/connections/${encodeURIComponent(B.id)}?reveal=1`, null, revealHeaders(A.privateKey, A.id, B.id));
  t(r.json.level === 'collab', '自动降级已撤销 → 回到 collab');
  t((r.json.history || []).length >= 2, 'history 保留（' + (r.json.history || []).length + ' 条，含降级与恢复）');

  sec('9 · 审计一本账');
  r = await call('GET', '/audit?event_type=connection_set');
  t(r.json.count >= 5, 'connection_set 进审计（' + r.json.count + ' 条）');
  t((await call('GET', '/audit/verify')).json.valid === true, '审计链 valid');

  cleanup();
  sec(`结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMPDIR, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message); cleanup(); process.exit(1); });
