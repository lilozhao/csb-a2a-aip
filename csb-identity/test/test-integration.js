#!/usr/bin/env node
/**
 * test-integration.js — 集成测试：身份路由挂在**公网 register（registry.js）**上
 * ------------------------------------------------------------------
 * 作者：明德 🎋 · 2026-10-08
 * 做法：以**替代端口**起真 registry.js（隔离数据目录，不碰生产 :3099），
 *       验证 ① 注册表既有功能不受影响 ② 身份路由可用 ③ 公网最小保护生效
 * 运行：node csb-identity/test/test-integration.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const S = require('../core.js');
const csb = require('../../../csb-security/lib/index.js');

const ROOT = path.resolve(__dirname, '..', '..');       // csb-a2a-aip
const PORT = 3059;
const BASE = `http://127.0.0.1:${PORT}`;
const TMPDIR = path.join(os.tmpdir(), 'csb-int-' + Date.now());
const DATA = path.join(TMPDIR, 'registry');
const ID_DATA = path.join(TMPDIR, 'identity');
const ADMIN_TOKEN = 'test-admin-token';

let pass = 0, fail = 0;
const t = (c, l) => { console.log((c ? '  ✅ ' : '  ❌ ') + l); c ? pass++ : fail++; };
const sec = (s) => console.log('\n' + '─'.repeat(64) + '\n' + s);
async function callOn(base, method, p, body, headers) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, retryAfter: r.headers.get('retry-after') };
}
const call = (method, p, body, headers) => callOn(BASE, method, p, body, headers);
async function waitUp(tries = 60) { for (let i = 0; i < tries; i++) { try { const r = await fetch(BASE + '/agents'); if (r.status === 200) return true; } catch {} await new Promise(r => setTimeout(r, 250)); } return false; }

// 起一个隔离实例（隔离数据目录 + 独立端口），返回 { proc, base, out }
async function spin(port, dataKey, envExtra) {
  const proc = spawn('node', [path.join(ROOT, 'registry.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      A2A_DATA_DIR: path.join(TMPDIR, 'registry-' + dataKey),
      REGISTRY_PORT: String(port), REGISTRY_HOST: '127.0.0.1',
      A2A_IDENTITY_DATA: path.join(TMPDIR, 'identity-' + dataKey),
      A2A_FORUM_REGISTRY: 'http://127.0.0.1:9/none',
      ...(envExtra || {})
    }
  });
  procs.push(proc);
  let out = ''; proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => out += d);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/agents')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
  return { proc, base, out: () => out };
}

// 行为主体签名（与服务端一致：JCS({agentId,reason,evidence,reporter,nonce,timestamp})）
function signBreach(pk, { agentId, reason, evidence, reporter }) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const timestamp = new Date().toISOString();
  const msg = S.jcs({ agentId, reason, evidence: evidence || null, reporter, nonce, timestamp });
  return { agentId, reason, evidence, reporter, nonce, timestamp, reporter_sig: crypto.sign(null, Buffer.from(msg), pk).toString('base64') };
}

// AAT 签发自签证明（v5.3.11：JCS({action,caller_agent_id,capabilities,ttl,nonce,timestamp})）
function signAatIssue(pk, { callerId, capabilities = ['chat'], ttl = 300, nonce, timestamp }) {
  const n = nonce || crypto.randomBytes(12).toString('hex');
  const ts = timestamp || new Date().toISOString();
  const p = { action: 'aat.issue', caller_agent_id: callerId, capabilities, ttl, nonce: n, timestamp: ts };
  return { ...p, caller_sig: crypto.sign(null, Buffer.from(S.jcs(p)), pk).toString('base64') };
}

let srv;
// 所有本脚本起过的实例都登记：中途断言抛错时只杀 srv 会留活口，
// 下一轮跑就会「连到上一轮那个进程」→ 症状是"身份路由没挂载"这种莫名其妙的假失败。
const procs = [];
const cleanup = () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } };

(async () => {
  fs.rmSync(TMPDIR, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  srv = spawn('node', [path.join(ROOT, 'registry.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    // IDENTITY_WRITE_LIMIT 调高：本套用例的写请求量（含 v5.3.11 的鉴权负例）会超过默认 20/min，
    // 撞限流会让后续断言假失败。限流逻辑本身由 csb-security 的模块测试覆盖，这里不需要再压它。
    env: { ...process.env, A2A_DATA_DIR: DATA, REGISTRY_PORT: String(PORT), REGISTRY_HOST: '127.0.0.1', A2A_IDENTITY_DATA: ID_DATA, A2A_FORUM_REGISTRY: 'http://127.0.0.1:9/none', IDENTITY_ADMIN_TOKEN: ADMIN_TOKEN, IDENTITY_WRITE_LIMIT: '500' }
  });
  procs.push(srv);
  let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
  if (!await waitUp()) { console.log(out.slice(-1200)); throw new Error('registry 未起来'); }

  sec('0 · 加载确认');
  t(/\[IDENTITY\] ✅/.test(out), '启动日志确认身份路由已挂载（公网 register）');

  sec('1 · 注册表既有功能不受影响');
  t((await call('GET', '/agents')).status === 200, 'GET /agents → 200');
  const reg = await call('POST', '/register', { name: 't1', host: '127.0.0.1', port: 0 });
  t(reg.status === 200, 'POST /register → 200（注册表原功能）');

  sec('2 · 身份路由可用');
  const sv = await call('GET', '/service/aid');
  t(sv.status === 200 && !!sv.json.agent_id, 'GET /service/aid → ' + sv.json.agent_id);

  const kp = csb.generateKeyPair('int-' + Date.now());
  const agentId = 'int-agent@127.0.0.1:3999';
  const aid = csb.generateAID({ agentId, name: '集成测试者', endpoint: 'http://127.0.0.1:3999/a2a/json-rpc', publicJwk: kp.publicJwk }, kp.privateKey);
  let r = await call('POST', '/identity/register', { aid, proof: { nonce: crypto.randomBytes(8).toString('hex'), timestamp: new Date().toISOString() }, owner: 'int-owner' });
  t(r.status === 201 && r.json.passport_uri === 'csb://int-owner/int-agent', '注册 → 201（' + r.json.passport_uri + '）');
  const cov = S.signCovenant(agentId, kp.privateKey);
  t((await call('POST', '/identity/' + encodeURIComponent(agentId) + '/covenant', cov)).status === 200, '签契约 → 200');
  r = await call('POST', '/aat/issue', signAatIssue(kp.privateKey, { callerId: agentId, capabilities: ['chat'] }));
  t(r.status === 201 && !!r.json.token, '签 AAT（自签证明）→ 201');
  t(r.json.sig_verified === true, '响应标注 sig_verified=true（严格模式确实验过）');
  t((await call('POST', '/aat/verify', { token: r.json.token, expect_audience: agentId })).json.valid === true, '验 AAT → valid（不带 agent_id，用服务公钥）');
  // ⚠️ 若兰 2026-10-08 提醒：首轮"带 agent_id"的路径出过 bad_signature，须显式覆盖
  const selfTok = csb.createAAT({ privateKey: kp.privateKey, issuer: agentId, audience: 'csb-identity-test', capabilities: ['chat'] });
  r = await call('POST', '/aat/verify', { token: selfTok, agent_id: agentId, expect_audience: 'csb-identity-test' });
  t(r.status === 200 && r.json.valid === true, '验 AAT → valid（**带 agent_id**，用该 agent 的 AID 公钥）');
  r = await call('POST', '/aat/verify', { token: selfTok, agent_id: 'nobody@x:1' });
  t(r.status === 404 && r.json.error === 'agent_not_registered', 'agent_id 未注册 → 404');

  sec('2.1 · /aat/issue 调用者鉴权（v5.3.11 · 洞：只查在册不查归属）');
  // 这就是那个洞的回归测试：零凭据、只报一个在册名字
  r = await call('POST', '/aat/issue', { caller_agent_id: agentId, capabilities: ['chat'] });
  t(r.status === 401 && r.json.error === 'signature_required', '零凭据只报名字 → 401 signature_required（洞已堵）');
  t(r.json.mode === 'strict', '默认 mode=strict（fail-closed）');
  r = await call('POST', '/aat/issue', { caller_agent_id: 'stranger@9.9.9.9:1', capabilities: ['chat'] });
  t(r.status === 403 && r.json.error === 'caller_not_registered', '未注册者 → 403 caller_not_registered');
  const noTs = signAatIssue(kp.privateKey, { callerId: agentId }); delete noTs.nonce; delete noTs.timestamp;
  r = await call('POST', '/aat/issue', noTs);
  t(r.status === 401 && r.json.error === 'proof_required', '带签名但缺 nonce/timestamp → 401 ' + r.json.error);
  const oldTs = signAatIssue(kp.privateKey, { callerId: agentId, timestamp: new Date(Date.now() - 3600e3).toISOString() });
  r = await call('POST', '/aat/issue', oldTs);
  t(r.status === 401 && r.json.error === 'ts_time_drift', '时间戳超窗 → 401 ' + r.json.error);
  // 用别人的私钥签，冒充在册 agent（攻击者能造的最强形态）
  const attacker = csb.generateKeyPair('attacker-' + Date.now());
  const forged = signAatIssue(attacker.privateKey, { callerId: agentId });
  r = await call('POST', '/aat/issue', forged);
  t(r.status === 401 && r.json.error === 'bad_caller_signature', '冒用他人身份签（公钥不配对）→ 401 ' + r.json.error);
  const one = signAatIssue(kp.privateKey, { callerId: agentId });
  t((await call('POST', '/aat/issue', one)).status === 201, '合法自签 → 201');
  r = await call('POST', '/aat/issue', one);
  t(r.status === 401 && r.json.error === 'nonce_replay', '同一 nonce 重放 → 401 ' + r.json.error);
  r = await call('POST', '/aat/issue', signAatIssue(kp.privateKey, { callerId: agentId, ttl: 7200 }));
  t(r.status === 400 && r.json.error === 'ttl_too_long', 'ttl 超上限（7200）→ 400 ' + r.json.error);
  r = await call('POST', '/aat/issue', signAatIssue(kp.privateKey, { callerId: agentId, capabilities: 'chat' }));
  t(r.status === 400 && r.json.error === 'capabilities_type_invalid', 'capabilities 传字符串 → 400 ' + r.json.error);
  r = await call('POST', '/aat/issue', signAatIssue(kp.privateKey, { callerId: agentId, ttl: -5 }));
  t(r.status === 400 && r.json.error === 'ttl_invalid', 'ttl 非法（-5）→ 400 ' + r.json.error);
  const denied = await call('GET', '/audit?event_type=aat_issue');
  t(denied.json.count >= 1, '拒绝也落审计账（aat_issue denied 可见，count=' + denied.json.count + '）');
  const rdy = await call('GET', '/ready');
  t(rdy.json.aat_issue_mode === 'strict' && rdy.json.aat_max_ttl_s === 3600, '/ready 暴露 aat_issue_mode/max_ttl（否则"没生效"和"生效了"外观一样）');

  sec('3 · 公网最小保护（写入口）');
  r = await call('POST', '/breach', { agentId: 'bad@9.9.9.9:3100', reason: '冒充' });
  t(r.status === 400 && r.json.error === 'reporter_required', '无 reporter → 400 ' + r.json.error);
  r = await call('POST', '/breach', { agentId: 'bad@9.9.9.9:3100', reason: '冒充', reporter: 'unregistered@x:1', nonce: 'n1', timestamp: new Date().toISOString() });
  t(r.status === 403 && r.json.error === 'reporter_not_registered', '未接入者发起 → 403 ' + r.json.error);
  r = await call('POST', '/breach', { agentId: 'bad@9.9.9.9:3100', reason: '冒充', reporter: agentId, nonce: 'n2', timestamp: new Date().toISOString() });
  t(r.status === 403 && r.json.error === 'signature_required', '已接入但无签名 → 403 ' + r.json.error);
  const badSig = signBreach(kp.privateKey, { agentId: 'bad@9.9.9.9:3100', reason: '冒充', reporter: agentId });
  badSig.reporter_sig = Buffer.from('x'.repeat(64)).toString('base64');
  r = await call('POST', '/breach', badSig);
  t(r.status === 403 && r.json.error === 'bad_actor_signature', '签名伪造 → 403 ' + r.json.error);
  const good = signBreach(kp.privateKey, { agentId: 'bad@9.9.9.9:3100', reason: '冒充他人身份', evidence: 'thread/1', reporter: agentId });
  r = await call('POST', '/breach', good);
  t(r.status === 201 && r.json.state === 'proposed', '合法签名 → 201 proposed');
  const bid = r.json.breach_id;
  r = await call('POST', '/breach', good);
  t(r.status === 401, '同 nonce 重放 → 401');

  sec('4 · 治理动作需令牌');
  r = await call('POST', '/breach/' + bid + '/transition', { to: 'effective', actor: 'x' });
  t(r.status === 403 && r.json.error === 'bad_admin_token', '无令牌 → 403 ' + r.json.error);
  r = await call('POST', '/breach/' + bid + '/transition', { to: 'effective', actor: 'x' }, { 'X-Admin-Token': 'wrong' });
  t(r.status === 403 && r.json.error === 'bad_admin_token', '错令牌 → 403');
  r = await call('POST', '/breach/' + bid + '/transition', { to: 'effective', actor: '治理复核' }, { 'X-Admin-Token': ADMIN_TOKEN });
  t(r.status === 200 && r.json.state === 'effective', '正确令牌 → 200 effective');

  sec('4.2 · /health 暴露身份挂载状态（若琢反馈：降级时外观正常，极难排查）');
  let hl = await call('GET', '/health');
  t(hl.status === 200 && hl.json.identity && hl.json.identity.mounted === true, '/health → identity.mounted=true（可观测）');

  sec('4.3 · 路由前缀收紧（若琢反馈：/identity-pack 被 /identity 截走）');
  const rp = await fetch(BASE + '/identity-pack/csb-onboard.js');
  const rpText = await rp.text();
  t(!rpText.includes('"error":"not_found"'), '/identity-pack/... 不再被身份 handler 吞（未被本模块兜底 404）');

  sec('4.5 · 唯一写者锁（防双写 → 覆盖/断链）');
  const srv2 = spawn('node', [path.join(ROOT, 'registry.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, A2A_DATA_DIR: path.join(TMPDIR, 'registry2'), REGISTRY_PORT: String(PORT + 1), REGISTRY_HOST: '127.0.0.1', A2A_IDENTITY_DATA: ID_DATA, A2A_FORUM_REGISTRY: 'http://127.0.0.1:9/none' }
  });
  procs.push(srv2);
  let out2 = ''; srv2.stdout.on('data', d => out2 += d); srv2.stderr.on('data', d => out2 += d);
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT + 1}/agents`)).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
  t(/\[IDENTITY\] ⚠️ .*未挂载/.test(out2), '第二实例（同一数据目录）→ 身份路由降级不挂载');
  const r2i = await fetch(`http://127.0.0.1:${PORT + 1}/identity`);
  t(r2i.status === 404, '第二实例 /identity → 404（不作第二写者）');
  t((await fetch(`http://127.0.0.1:${PORT + 1}/agents`)).status === 200, '第二实例 register 主功能仍 200（不崩）');
  srv2.kill('SIGKILL');
  t(true, '（第二实例已被杀）');

  sec('4.6 · 陈旧锁接管（僵尸/pid 复用/心跳过期 → 不应卡死）');
  const LOCKF = path.join(ID_DATA, '.writer.lock');
  // 造一个"看起来活着但其实不是本写者"的锁：pid=1 + 伪造 starttime + 心跳过期
  fs.writeFileSync(LOCKF, JSON.stringify({ pid: 1, starttime: 'FAKE-STARTTIME-XXXX', dir: ID_DATA, since: '2020-01-01T00:00:00.000Z', beat: '2020-01-01T00:00:00.000Z' }, null, 2));
  const srv3 = spawn('node', [path.join(ROOT, 'registry.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, A2A_DATA_DIR: path.join(TMPDIR, 'registry3'), REGISTRY_PORT: String(PORT + 2), REGISTRY_HOST: '127.0.0.1', A2A_IDENTITY_DATA: ID_DATA, A2A_FORUM_REGISTRY: 'http://127.0.0.1:9/none' }
  });
  procs.push(srv3);
  let out3 = ''; srv3.stdout.on('data', d => out3 += d); srv3.stderr.on('data', d => out3 += d);
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT + 2}/agents`)).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
  t(/\[IDENTITY\] ✅/.test(out3), '陈旧锁 → **成功接管并挂载**（不再永久卡死）');
  const h3 = await (await fetch(`http://127.0.0.1:${PORT + 2}/health`)).json();
  t(h3.identity && h3.identity.mounted === true, '接管后 /health → identity.mounted=true');
  srv3.kill('SIGKILL');

  sec('4.7 · batch2 处置：trust_level 自描述 / DELETE 注销 / /health 指纹');
  let rd2 = await call('GET', '/identity/' + encodeURIComponent(agentId));
  t(rd2.json.identity.trust_level_scope === 'identity_verified_only', 'trust_level 自描述：scope=' + rd2.json.identity.trust_level_scope);
  let del = await call('DELETE', '/identity/' + encodeURIComponent(agentId));
  t(del.status === 403 && del.json.error === 'bad_admin_token', 'DELETE 无令牌 → 403');
  del = await call('DELETE', '/identity/' + encodeURIComponent(agentId), null, { 'X-Admin-Token': ADMIN_TOKEN });
  t(del.status === 200 && del.json.revoked === true, 'DELETE 带令牌 → 200（state 移除）');
  t((await call('GET', '/identity/' + encodeURIComponent(agentId))).status === 404, '注销后 GET → 404');
  let av = await call('GET', '/audit?event_type=identity_revoke');
  t(av.json.count >= 2, '注销**留痕**：identity_revoke 审计 ' + av.json.count + ' 条（含被拒的一次）');
  const hl2 = await call('GET', '/health');
  t(hl2.json.tools_sha256 && hl2.json.tools_sha256['csb-onboard.js'], '/health 暴露 tools_sha256（漂移可检出）');

  sec('5 · 审计一本账');
  r = await call('GET', '/audit?event_type=breach_proposed');
  t(r.json.count >= 1, 'breach 出现在审计查询（count=' + r.json.count + '）');
  t((await call('GET', '/audit/verify')).json.valid === true, '审计链 valid');

  sec('6 · AAT_ISSUE_MODE=warn 迁移期（验、记、放行）');
  const w = await spin(PORT + 3, 'warn', { AAT_ISSUE_MODE: 'warn' });
  const wkp = csb.generateKeyPair('warn-' + Date.now());
  const wid = 'warn-agent@127.0.0.1:3777';
  const waid = csb.generateAID({ agentId: wid, name: '迁移测试者', endpoint: 'http://127.0.0.1:3777/a2a/json-rpc', publicJwk: wkp.publicJwk }, wkp.privateKey);
  let wreg = await callOn(w.base, 'POST', '/identity/register', { aid: waid, proof: { nonce: crypto.randomBytes(8).toString('hex'), timestamp: new Date().toISOString() }, owner: 'warn-owner' });
  t(wreg.status === 201, '（warn 实例）注册 → 201');
  await callOn(w.base, 'POST', '/identity/' + encodeURIComponent(wid) + '/covenant', S.signCovenant(wid, wkp.privateKey));
  let wr = await callOn(w.base, 'POST', '/aat/issue', { caller_agent_id: wid, capabilities: ['chat'] });
  t(wr.status === 201 && wr.json.mode === 'warn' && wr.json.sig_verified === false, 'warn：无签名**放行**（201, sig_verified=false）——迁移期行为');
  wr = await callOn(w.base, 'GET', '/audit?event_type=aat_issue_unsigned');
  t(wr.json.count >= 1, 'warn：未验签签发**单独记账**（aat_issue_unsigned=' + wr.json.count + '，可统计还在裸奔的客户端）');
  wr = await callOn(w.base, 'POST', '/aat/issue', signAatIssue(wkp.privateKey, { callerId: wid }));
  t(wr.status === 201 && wr.json.sig_verified === true, 'warn：带合法签名 → sig_verified=true（已迁移的客户端可验证自己真的通了）');
  w.proc.kill('SIGKILL');

  cleanup();
  sec(`结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMPDIR, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message); cleanup(); process.exit(1); });
