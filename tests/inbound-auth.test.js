#!/usr/bin/env node
/**
 * P0-5 · 入站鉴权分级与灰度决策的验收
 *
 * 判据（机械可核）：
 *   1. 模式只有 off/shadow/enforce，非法值回落 off（不误拦）
 *   2. shadow 一律放行 —— 这是「只记不打回」的字面含义，任何分类都不得例外
 *   3. enforce 只拦 A/B；C/D 放行（D 是「新邻居」，一刀切等于关门）
 *   4. sender 的三种历史形态都能取到（sender 对象 / params.sender / from 字符串）
 *   5. 记录失败不抛错（只有记录，不该影响业务）
 *   6. 接线核验：server_v5.js 真的把中间件挂到了两个入站路径上
 *
 * 运行：node tests/inbound-auth.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../a2a-inbound-auth');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

const known = new Set(['若兰', '阿轩', '若琢 🌸', 'mingde']);

console.log('\n=== 1. 模式解析 ===');
t('shadow/enforce 原样返回', () => {
  assert.strictEqual(A.modeFromEnv({ A2A_INBOUND_AUTH_MODE: 'shadow' }), 'shadow');
  assert.strictEqual(A.modeFromEnv({ A2A_INBOUND_AUTH_MODE: 'ENFORCE' }), 'enforce');
});
t('未设 / 乱填 → off（宁可少拦）', () => {
  assert.strictEqual(A.modeFromEnv({}), 'off');
  assert.strictEqual(A.modeFromEnv({ A2A_INBOUND_AUTH_MODE: 'yes' }), 'off');
  assert.strictEqual(A.modeFromEnv({ A2A_INBOUND_AUTH_MODE: 'True' }), 'off');
});

console.log('\n=== 2. 取 sender 的三种形态 ===');
t('sender 字符串', () => {
  assert.deepStrictEqual(A.extractSender({ sender: '若兰' }), { name: '若兰', url: '', aat: null });
});
t('sender 对象带 url', () => {
  assert.deepStrictEqual(A.extractSender({ sender: { name: '阿轩', url: 'http://172.28.0.5:3100' } }), { name: '阿轩', url: 'http://172.28.0.5:3100', aat: null });
});
t('JSON-RPC params.sender', () => {
  assert.strictEqual(A.extractSender({ params: { sender: { name: 'mingde', host: '172.28.0.9' } } }).url, '172.28.0.9');
});
t('from 字符串（AIP 旧形态）', () => {
  assert.strictEqual(A.extractSender({ from: '若琢' }).name, '若琢');
});
t('什么都没有 → 空（判 A）', () => {
  assert.deepStrictEqual(A.extractSender({}), { name: '', url: '', aat: null });
});
t('header 里的 AAT 能被取到（我方写入侧就这么带）', () => {
  assert.strictEqual(A.extractSender({ sender: { name: 'x' } }, { 'x-csb-aat': 'aaa.bbb.ccc' }).aat, 'aaa.bbb.ccc');
});
t('header 的 AAT 优先于 body', () => {
  assert.strictEqual(A.extractSender({ sender: { name: 'x', aat: 'body' } }, { 'x-csb-aat': 'header' }).aat, 'header');
});

console.log('\n=== 3. 分类 ===');
t('A/B/C/D 四类', () => {
  assert.strictEqual(A.classify({ name: '', url: '' }, known).cls, 'A');
  assert.strictEqual(A.classify({ name: 'unknown', url: '' }, known).cls, 'A');
  assert.strictEqual(A.classify({ name: '若兰', url: '' }, known).cls, 'B');
  assert.strictEqual(A.classify({ name: '若兰', url: 'http://a:1' }, known).cls, 'C');
  assert.strictEqual(A.classify({ name: '新邻居', url: 'http://b:1' }, known).cls, 'D');
});
t('C 的 why 写明「未验签」——不许把自洽说成验签', () => {
  assert.ok(A.classify({ name: '若兰', url: 'http://a:1' }, known).why.includes('未验签'));
});
t('hasAat 透传（只记录，不改变分类）', () => {
  const r = A.classify({ name: '若兰', url: '' }, known, { hasAat: true, aatVerifiable: false });
  assert.strictEqual(r.cls, 'B');
  assert.strictEqual(r.hasAat, true);
});

console.log('\n=== 3b. AAT 凭据（「一次性重新握手续期」的凭据一侧） ===');
t('AAT 验过 → C，且标记 verified=aat（这才是真有签字的 C）', () => {
  const r = A.classify({ name: '若辰', url: '', aat: 't' }, known, { aatVerified: true, aatVerifiable: true });
  assert.strictEqual(r.cls, 'C');
  assert.strictEqual(r.verified, 'aat');
  assert.ok(r.why.includes('AAT'));
});
t('AAT 验过时没 url 也算 C（NAT 下地址不可靠，密码学身份更强）', () => {
  assert.strictEqual(A.classify({ name: '若辰', url: '', aat: 't' }, known, { aatVerified: true, aatVerifiable: true }).cls, 'C');
});
t('带了 AAT 但验签失败 → B（有凭据却对不上，比没凭据更可疑）', () => {
  const r = A.classify({ name: '若辰', url: '', aat: 'bad' }, known, { aatVerifiable: true, aatVerified: false, aatError: 'signature_mismatch' });
  assert.strictEqual(r.cls, 'B');
  assert.ok(r.why.includes('signature_mismatch'));
});
t('带了 AAT 但**我们**验不了 → 不判 B，保留原分类 + 标 aatUnverifiable', () => {
  const r = A.classify({ name: '若兰', url: '', aat: 't' }, known, { aatVerifiable: false, aatError: 'self_agent_id_unavailable' });
  assert.strictEqual(r.cls, 'B');  // 原本就是 B（已知名无 url），不得因我方故障升为更重
  assert.strictEqual(r.aatUnverifiable, true);
  assert.ok(r.why.includes('无法验签'));
});
t('enforce 下 AAT 验过的调用放行，reason 写明 aat', () => {
  const c = A.classify({ name: '若辰', url: '', aat: 't' }, known, { aatVerified: true, aatVerifiable: true });
  const d = A.decide(c, 'enforce');
  assert.strictEqual(d.action, 'allow');
  assert.strictEqual(d.reason, 'allow_aat_verified');
});
t('enforce 下 B（含带坏 AAT 的）仍然拦', () => {
  const c = A.classify({ name: '若辰', url: '', aat: 'bad' }, known, { aatVerifiable: true, aatVerified: false, aatError: 'x' });
  assert.strictEqual(A.decide(c, 'enforce').action, 'block');
});

console.log('\n=== 4. 决策：shadow 一律放行 ===');
for (const cls of ['A', 'B', 'C', 'D']) {
  t(`shadow + ${cls} → 放行但记录`, () => {
    const d = A.decide({ cls }, 'shadow');
    assert.strictEqual(d.action, 'allow');
    assert.strictEqual(d.record, true);
  });
}
t('shadow 对 A/B 标 wouldBlock=true（这才是"只记不打回"）', () => {
  assert.strictEqual(A.decide({ cls: 'A' }, 'shadow').wouldBlock, true);
  assert.strictEqual(A.decide({ cls: 'B' }, 'shadow').wouldBlock, true);
  assert.strictEqual(A.decide({ cls: 'C' }, 'shadow').wouldBlock, false);
});
t('off → 不记不管', () => {
  const d = A.decide({ cls: 'A' }, 'off');
  assert.deepStrictEqual([d.action, d.record, d.wouldBlock], ['allow', false, false]);
});

console.log('\n=== 5. 决策：enforce ===');
t('A/B → 401，reason 写清拦的是哪类', () => {
  const a = A.decide({ cls: 'A' }, 'enforce');
  assert.strictEqual(a.action, 'block');
  assert.strictEqual(a.httpStatus, 401);
  assert.strictEqual(a.reason, 'blocked_A');
  assert.strictEqual(A.decide({ cls: 'B' }, 'enforce').reason, 'blocked_B');
});
t('C/D → 放行（D 是未注册新邻居，不在这一步拦）', () => {
  assert.strictEqual(A.decide({ cls: 'C' }, 'enforce').action, 'allow');
  assert.strictEqual(A.decide({ cls: 'D' }, 'enforce').action, 'allow');
});

console.log('\n=== 6. 记录失败不抛错 ===');
t('父路径是普通文件（ENOTDIR）→ 返回 false，不抛', () => {
  // 注意：别用 /proc 之类做负例 —— 在容器里 mkdir 可能长时间阻塞，测试会假死
  const blocker = path.join(__dirname, '..', 'logs', 'not-a-dir.tmp');
  fs.writeFileSync(blocker, 'x');
  try {
    const got = A.recordShadow({ cls: 'A' }, path.join(blocker, 'sub.jsonl'));
    assert.strictEqual(got, false);
  } finally {
    try { fs.unlinkSync(blocker); } catch { /* noop */ }
  }
});
t('正常写入 → true 且是一行 JSON', () => {
  const tmp = path.join(__dirname, '..', 'logs', 'inbound-auth-test.jsonl');
  try { fs.unlinkSync(tmp); } catch { /* 首次 */ }
  assert.strictEqual(A.recordShadow({ cls: 'B', name: '若兰' }, tmp), true);
  const line = fs.readFileSync(tmp, 'utf8').trim();
  const obj = JSON.parse(line);
  assert.strictEqual(obj.cls, 'B');
  assert.ok(obj.ts);
  fs.unlinkSync(tmp);
});

console.log('\n=== 7. 接线核验（防「写了没人挂」） ===');
const src = fs.readFileSync(path.join(__dirname, '..', 'server_v5.js'), 'utf8');
t('挂在 /a2a/json-rpc', () => assert.ok(/app\.use\('\/a2a\/json-rpc', inboundAuthHook\)/.test(src)));
t('挂在 /message:send', () => assert.ok(/app\.use\('\/message:send', inboundAuthHook\)/.test(src)));
t('挂在 /message:stream', () => assert.ok(/app\.use\('\/message:stream', inboundAuthHook\)/.test(src)));
t('注册顺序在 registerRoutes 之前（否则路由先跑，看得见但来不及）', () => {
  const hookAt = src.indexOf("app.use('/a2a/json-rpc', inboundAuthHook)");
  const routesAt = src.indexOf('standardAPI.registerRoutes(app)');
  assert.ok(hookAt > 0 && routesAt > 0 && hookAt < routesAt, `hook@${hookAt} routes@${routesAt}`);
});
t('/health 暴露 inboundAuth.mode（外部可核）', () => {
  assert.ok(/inboundAuth:\s*\{[\s\S]{0,200}mode:\s*inboundAuthMode/.test(src));
});
t('名单为空时 enforce 降为 shadow（fail-open，不关门）', () => {
  assert.ok(/ENFORCE && inboundKnown\.size === 0/.test(src));
});

console.log(`\n${fail === 0 ? '✅' : '❌'} inbound-auth: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
