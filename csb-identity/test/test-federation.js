#!/usr/bin/env node
/**
 * test-federation.js — 身份联邦（B1）逐条验收
 * ------------------------------------------------------------------
 * 作者：明德 🎋 · 2026-10-29
 * 对齐若兰需求单 R1–R6 的**机械判据**，每条一个断言：
 *   R1 篡改 name → 拒；过期 AID → 拒；都必须落审计
 *   R2 保留名同主体 → 收；不同公钥冒名 → 拒；本地注册同名照样拒
 *   R3 endpoint_scope=private + reachability.reachable=false
 *   R4 导入前后 /agents 与 /health.dht.onlineAgents 不变
 *   R5 源侧消失 → stale（不删）+ /aat/issue 回 caller_stale
 *   R6 /ready 暴露 identity_federation
 * 运行：node csb-identity/test/test-federation.js
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
const TMPDIR = path.join(os.tmpdir(), 'csb-fed-' + Date.now());
const ADMIN_TOKEN = 'test-admin-token';
const SOURCE = 'internal-home-test';

let pass = 0, fail = 0;
const t = (c, l) => { console.log((c ? '  ✅ ' : '  ❌ ') + l); c ? pass++ : fail++; };
const sec = (s) => console.log('\n' + '─'.repeat(64) + '\n' + s);

async function call(method, p, body, headers) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

const procs = [];
const cleanup = () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } };
process.on('exit', cleanup);

// ---- 源侧签名（与 federation-push.js 逐字一致）----
function signIngest(sourcePriv, source, snapshot) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const timestamp = new Date().toISOString();
  const sha = crypto.createHash('sha256').update(S.jcs(snapshot), 'utf8').digest('hex');
  const payload = { action: 'federation.ingest', source, snapshot_sha256: sha, timestamp, nonce };
  const sig = crypto.sign(null, Buffer.from(S.jcs(payload)), sourcePriv).toString('base64');
  return { source, snapshot, proof: { timestamp, nonce, snapshot_sha256: sha, source_sig: sig } };
}
// ---- 主体自签 AAT（v5.3.11）----
function signAatIssue(pk, { callerId, capabilities = ['forum.reply'], ttl = 60 }) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const timestamp = new Date().toISOString();
  const p = { action: 'aat.issue', caller_agent_id: callerId, capabilities, ttl, nonce, timestamp };
  return { ...p, caller_sig: crypto.sign(null, Buffer.from(S.jcs(p)), pk).toString('base64') };
}

function mkAgent({ agentId, name, expiresAt = null }) {
  const kp = csb.generateKeyPair('fed-' + name);
  const aid = csb.generateAID({ agentId, name, endpoint: 'http://172.28.0.9:3100/a2a/json-rpc', publicJwk: kp.publicJwk, expiresAt }, kp.privateKey);
  const covenant = S.signCovenant(agentId, kp.privateKey);
  return { kp, aid, covenant, entry: { aid, covenant, passport_uri: null, owner_raw: null, registered_at: new Date().toISOString() } };
}

(async () => {
  fs.rmSync(TMPDIR, { recursive: true, force: true });
  const srv = spawn('node', [path.join(ROOT, 'registry.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      A2A_DATA_DIR: path.join(TMPDIR, 'registry'),
      A2A_IDENTITY_DATA: path.join(TMPDIR, 'identity'),
      REGISTRY_PORT: String(PORT), REGISTRY_HOST: '127.0.0.1',
      A2A_FORUM_REGISTRY: 'http://127.0.0.1:9/none',
      IDENTITY_ADMIN_TOKEN: ADMIN_TOKEN,
      IDENTITY_WRITE_LIMIT: '500'
    }
  });
  procs.push(srv);
  let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
  let up = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/agents')).status === 200) { up = true; break; } } catch {} await new Promise(r => setTimeout(r, 250)); }
  if (!up) { console.log(out.slice(-1500)); throw new Error('registry 未起来'); }

  // ---- 基线（R4 用）----
  const baseAgents = (await call('GET', '/agents')).json;
  const baseHealth = (await call('GET', '/health')).json;
  const baseAgentNames = (baseAgents.agents || []).map(a => a.name).sort().join(',');
  const baseOnline = baseHealth && baseHealth.dht && baseHealth.dht.onlineAgents;

  sec('0 · 联邦开关与 /ready（R6）');
  let r = await call('GET', '/ready');
  t(r.json.identity_federation && r.json.identity_federation.enabled === true, '/ready 有 identity_federation 块');
  t(r.json.identity_federation.sources_count === 0, '初始 sources_count = 0');

  sec('1 · 源公钥 pin（治理令牌）');
  const srcKp = crypto.generateKeyPairSync('ed25519');
  const srcJwk = srcKp.publicKey.export({ format: 'jwk' });
  r = await call('POST', '/identity/federation/sources', { source: SOURCE, public_key: { kty: 'OKP', crv: 'Ed25519', x: srcJwk.x } });
  t(r.status === 403 && r.json.error === 'bad_admin_token', '无令牌 pin → 403 bad_admin_token');
  r = await call('POST', '/identity/federation/sources', { source: SOURCE, public_key: { kty: 'OKP', crv: 'Ed25519', x: srcJwk.x } }, { 'X-Admin-Token': ADMIN_TOKEN });
  t(r.status === 200 && r.json.ok === true, '带令牌 pin → 200');

  sec('2 · 构造快照（含四个负例）');
  const A = mkAgent({ agentId: 'ruolan@172.28.0.9:3100', name: '若兰' });          // 保留名，claim 匹配 → 收
  const B = mkAgent({ agentId: 'axuan@172.28.0.9:3101', name: '阿轩' });           // 保留名，claim 指向别人 → 拒
  const C = mkAgent({ agentId: 'tamper@172.28.0.9:3102', name: '正常名字' });       // 签名后改 name → 拒
  const D = mkAgent({ agentId: 'expired@172.28.0.9:3103', name: '过期测试', expiresAt: new Date(Date.now() - 86400e3).toISOString() }); // 过期 → 拒
  const E = mkAgent({ agentId: 'fedok@172.28.0.9:3104', name: '联邦测试甲' });       // 普通名 → 收
  const Cbad = { ...C.entry, aid: { ...C.aid, name: '被改过的名字' } };              // 字段被改，签名不再匹配

  const otherKp = csb.generateKeyPair('other');
  const snapshot = {
    generated_at: new Date().toISOString(),
    identities: [A.entry, B.entry, Cbad, D.entry, E.entry],
    claims: [
      { name: '若兰', x: A.aid.public_key.x },        // 同主体
      { name: '阿轩', x: otherKp.publicJwk.x }        // 别人的公钥 → 冒名
    ],
    revoked: [],
    breach_effective: []
  };

  sec('3 · 摄入（R1 逐条全量校验）');
  r = await call('POST', '/identity/federation/ingest', signIngest(srcKp.privateKey, SOURCE, snapshot));
  const imp = r.json.imported || [], rej = r.json.rejected || [];
  const errOf = (id) => (rej.find(x => x.agent_id === id) || {}).error;
  t(r.status === 200, '摄入 → 200');
  t(imp.includes(A.aid.agent_id), 'R2 保留名「若兰」+ 同主体 claim → 收');
  t(imp.includes(E.aid.agent_id), '普通名「联邦测试甲」→ 收');
  t(errOf(B.aid.agent_id) === 'name_reserved', 'R2 保留名「阿轩」+ 别人公钥 → 拒 name_reserved');
  t(/^aid_/.test(errOf(C.aid.agent_id) || ''), 'R1 签名后改 name → 拒 ' + errOf(C.aid.agent_id));
  t(errOf(D.aid.agent_id) === 'aid_expired', 'R1 过期 AID → 拒 aid_expired');

  sec('4 · 审计留痕（R1 判据：不许静默跳过）');
  r = await call('GET', '/audit?event_type=federation_import_reject&limit=50');
  t(r.json.count >= 3, '拒绝条目全部落审计（' + r.json.count + ' 条）');
  r = await call('GET', '/audit?event_type=federation_ingest&limit=50');
  t(r.json.count >= 1, '摄入动作落审计');

  sec('5 · 读侧（R3 可达性显式）');
  r = await call('GET', '/identity/' + encodeURIComponent(A.aid.agent_id));
  const idA = r.json.identity || {};
  t(idA.endpoint_scope === 'private', 'endpoint_scope = private');
  t(idA.reachability && idA.reachability.reachable === false && idA.reachability.reason === 'private_network', 'reachability.reachable=false / reason=private_network');
  t(idA.federated && idA.federated.source === SOURCE, 'federated.source = ' + SOURCE);
  t(idA.stale === false, '初始 stale = false');
  t(idA.owner_unverified === true, 'owner_unverified = true（不建 human 记录）');
  t(idA.reserved_claimed === true, 'reserved_claimed = true');

  sec('6 · 不进在线层（R4 判据）');
  const nowAgents = (await call('GET', '/agents')).json;
  const nowHealth = (await call('GET', '/health')).json;
  t((nowAgents.agents || []).map(a => a.name).sort().join(',') === baseAgentNames, '/agents 名单不变');
  t(nowAgents.agents.every(a => !/172\.28\./.test(String(a.host || ''))), '/agents 里无内网 IP');
  t((nowHealth.dht || {}).onlineAgents === baseOnline, 'dht.onlineAgents 不变（' + baseOnline + '）');

  sec('7 · 联邦身份可自签取 AAT');
  r = await call('POST', '/aat/issue', signAatIssue(A.kp.privateKey, { callerId: A.aid.agent_id }));
  t(r.status === 201 && r.json.sig_verified === true, '若兰自签 → 201 且 sig_verified=true');

  sec('8 · 本地注册仍不许冒用保留名（R2 不许放宽）');
  const sneak = mkAgent({ agentId: 'sneak@1.2.3.4:3100', name: '若兰' });
  r = await call('POST', '/identity/register', { aid: sneak.aid, proof: { nonce: crypto.randomBytes(8).toString('hex'), timestamp: new Date().toISOString() } });
  t(r.status === 400 && r.json.error === 'name_reserved', '别家拿自己公钥注册「若兰」→ 400 name_reserved');

  sec('9 · 对账（R5：源侧消失 → stale 不删）');
  const snap2 = { ...snapshot, generated_at: new Date().toISOString(), identities: [E.entry] };  // 少了若兰
  r = await call('POST', '/identity/federation/ingest', signIngest(srcKp.privateKey, SOURCE, snap2));
  t(r.status === 200 && r.json.stale_marked >= 1, '第二次快照缺「若兰」→ stale_marked=' + r.json.stale_marked);
  r = await call('GET', '/identity/' + encodeURIComponent(A.aid.agent_id));
  t(r.json.identity && r.json.identity.stale === true, '「若兰」标 stale=true（记录仍在，未删）');
  r = await call('POST', '/aat/issue', signAatIssue(A.kp.privateKey, { callerId: A.aid.agent_id }));
  t(r.status === 403 && r.json.error === 'caller_stale', 'stale 身份签 AAT → 403 caller_stale');

  sec('10 · /ready 反映联邦实况（R6）');
  r = await call('GET', '/ready');
  const fed = r.json.identity_federation || {};
  t(fed.sources_count === 1, 'sources_count = 1');
  t(fed.federated_identities === 2, 'federated_identities = 2（若兰 + 联邦测试甲）');
  t(fed.stale_identities === 1, 'stale_identities = 1');
  t(!!fed.last_fetch, 'last_fetch 有值');

  sec('11 · 源签名防伪');
  const forged = signIngest(crypto.generateKeyPairSync('ed25519').privateKey, SOURCE, snapshot);
  r = await call('POST', '/identity/federation/ingest', forged);
  t(r.status === 403 && r.json.error === 'bad_source_signature', '别的私钥签的快照 → 403 bad_source_signature');
  const noProof = { source: SOURCE, snapshot };
  r = await call('POST', '/identity/federation/ingest', noProof);
  t(r.status === 403 && r.json.error === 'source_sig_required', '无签名 → 403 source_sig_required');
  r = await call('POST', '/identity/federation/ingest', { ...signIngest(srcKp.privateKey, 'unknown-source', snapshot) });
  t(r.status === 403 && r.json.error === 'source_not_registered', '未 pin 的源 → 403 source_not_registered');

  console.log('\n' + '═'.repeat(64));
  console.log(`结果：pass ${pass} / fail ${fail}`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('❌ 测试异常：', e); cleanup(); process.exit(1); });
