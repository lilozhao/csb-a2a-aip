#!/usr/bin/env node
/**
 * aat-remediation.test.js —— W-54 判据（Security v1.1.1 §3.6）
 * ------------------------------------------------------------------
 * 本测试只认一件事：**每种 AAT 拒绝原因都必须给出一个可执行、且不越俎代庖的下一步。**
 *
 * 测什么（每条都是一个「故意造错就会红」的断言）：
 *   1. aat.js + a2a-aat.js 真实产出的**每一种** error 都被收录（防新增 error 漏补）
 *   2. 每条 remediation 非空、够长、含动词性指令（§3.6.1 的可执行判据）
 *   3. 每条 remediation 都能说清「该谁做」（§3.6.3-3：只能要求对方做得到的事）
 *   4. 兜底路径也存在（未收录 error 不许静默给空）
 *   5. **反向断言**：verifyInbound 的每个拒绝返回都带 remediation
 *      （只测 remediationFor 是不够的——它好，不代表接线接上了）
 *
 * 为什么不测「这条建议好不好」：测不了。判据只能到「存在性 + 形状 + 归属」这一层。
 * 把测不了的东西写进断言，会让测试变成自我安慰。
 *
 * 署名: 若兰 🌸 | 2026-11-05
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { remediationFor, nextStepFor, REMEDIATIONS, KNOWN_ERRORS, UNKNOWN_REMEDIATION } = require('../aat-remediation.js');

const ROOT = path.join(__dirname, '..');

/** 从源码里把真实的 error 码抓出来 —— 不维护第二份清单 */
function errorsFromSource(file, pattern) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = new Set();
  for (const m of src.matchAll(pattern)) out.add(m[1]);
  return out;
}

// ── ① 覆盖面：真实 error 全被收录 ─────────────────────────────
test('① aat.js 的每种 error 都被收录（新增 error 必须补 remediation）', () => {
  const errs = errorsFromSource('../csb-security/lib/identity/aat.js', /error: '([a-z_]+)'/g);
  assert.ok(errs.size >= 13, `应至少抓到 13 种，实际 ${errs.size}：${[...errs].join(',')}`);
  const missing = [...errs].filter((e) => !REMEDIATIONS[e]);
  assert.deepStrictEqual(missing, [], `aat.js 里这些 error 没有补救说明：${missing.join(', ')}`);
});

test('② a2a-aat.js 的每种 error 都被收录（含 pin / 同源）', () => {
  // 扫描两种写法：早期分支是 error: 'x'，重构后走 _reflect('x', ...)。
  // 两种都要扫 —— 只扫一种会漏掉另一种，而「漏掉」在测试里表现为「全绿」。
  const errs = new Set([
    ...errorsFromSource('a2a-aat.js', /error: '([a-z_]+)'/g),
    ...errorsFromSource('a2a-aat.js', /_reflect\(\s*'([a-z_]+)'/g),
  ]);
  assert.ok(errs.size >= 6, `应至少 6 种，实际 ${errs.size}：${[...errs].join(',')}`);
  const missing = [...errs].filter((e) => !REMEDIATIONS[e]);
  assert.deepStrictEqual(missing, [], `a2a-aat.js 里这些 error 没有补救说明：${missing.join(', ')}`);
});

// ── ② 形状：非空 + 够长 + 含动作指令 ─────────────────────────
test('③ 每条 remediation 非空、≥6 字符、含动词性指令', () => {
  const ACTION_WORDS = /(可|请|先|则|即|→|完成|改用|改为|改|重试|重新|提交|联系|申请|降|加|补|换|等|走|经|用|按|向|让|带上|确认|检查|同步|签发|发给|去掉|校准|保留|加入|发给)/;
  const bad = [];
  for (const [code, v] of Object.entries(REMEDIATIONS)) {
    const s = (v.next_step || '').trim();
    if (!s) bad.push(`${code}: 空`);
    else if (s.length < 6) bad.push(`${code}: 太短(${s.length})`);
    else if (!ACTION_WORDS.test(s)) bad.push(`${code}: 不像可执行动作「${s}」`);
  }
  assert.deepStrictEqual(bad, [], bad.join(' | '));
});

test('④ 每条 remediation 都标明 fixable_by，且取值合法', () => {
  const bad = [];
  for (const [code, v] of Object.entries(REMEDIATIONS)) {
    if (!['caller', 'host', 'both'].includes(v.fixable_by)) bad.push(`${code}: ${v.fixable_by}`);
  }
  assert.deepStrictEqual(bad, [], bad.join(' | '));
});

// ── ③ 归属：不许把我们的配置错误推给对方（§3.6.3-3）────────────
test('⑤ 配置类错误归 host，不许要求对端去改我方配置', () => {
  // 这几条按定义都是「本实例侧的配置问题」，归为 caller 就是把责任推给对方
  for (const code of ['no_pinned_key', 'key_conflict', 'bad_public_key', 'missing_public_key', 'no_entry', 'missing_expected_audience']) {
    assert.strictEqual(REMEDIATIONS[code].fixable_by, 'host', `${code} 应归 host`);
  }
});

test('⑥ 对端能自修的错误归 caller', () => {
  for (const code of ['expired', 'replay_detected', 'missing_jti', 'missing_exp', 'bad_signature', 'no_token']) {
    assert.strictEqual(REMEDIATIONS[code].fixable_by, 'caller', `${code} 应归 caller`);
  }
});

test('⑦ 双向责任的两条标 both（受众/时钟）', () => {
  for (const code of ['time_drift', 'audience_mismatch']) {
    assert.strictEqual(REMEDIATIONS[code].fixable_by, 'both', `${code} 应归 both`);
  }
});

// ── ④ 兜底：未收录也不许空 ────────────────────────────────────
test('⑧ 未收录的 error 走兜底，返回非空且 known=false', () => {
  const r = remediationFor('some_brand_new_error_code');
  assert.strictEqual(r.known, false);
  assert.ok(r.next_step && r.next_step.length >= 6);
  assert.strictEqual(r.fixable_by, 'host');
});

test('⑨ 畸形输入不抛错（null / undefined / 对象）', () => {
  for (const v of [null, undefined, 42, {}, [], '']) {
    assert.doesNotThrow(() => nextStepFor(v));
    assert.ok(nextStepFor(v).length > 0, `${JSON.stringify(v)} 返回了空`);
  }
});

test('⑩ KNOWN_ERRORS 与 REMEDIATIONS 一致', () => {
  assert.deepStrictEqual([...KNOWN_ERRORS].sort(), Object.keys(REMEDIATIONS).sort());
});

// ── ⑤ 接线：verifyInbound 的每个拒绝返回都带 remediation ──────
test('⑪ verifyInbound 的每个拒绝出口都带 remediation（形状级）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'a2a-aat.js'), 'utf8');
  const body = src.slice(src.indexOf('function verifyInbound'), src.indexOf('function _explain'));
  // 拒绝出口必须全部走 _reflect（它统一加 remediation）；出现裸 ok:false 就是漏网
  const bare = [...body.matchAll(/return\s*\{\s*ok:\s*false/g)];
  assert.deepStrictEqual(bare.map((m) => m[0]), [], `verifyInbound 里有 ${bare.length} 处未走 _reflect 的裸拒绝`);
  assert.ok(body.includes('_reflect('), 'verifyInbound 应使用 _reflect');
});

test('⑫ /aat/verify 端点接线：所有拒绝分支都返回 remediation', () => {
  const src = fs.readFileSync(path.join(ROOT, 'csb-identity/routes.js'), 'utf8');
  const i = src.indexOf("p === '/aat/verify'");
  assert.ok(i > 0, '没找到 /aat/verify 端点');
  const end = src.indexOf("p === '/breach'", i);
  const seg = src.slice(i, end > i ? end : i + 2000);
  assert.ok(/remediation/.test(seg), '/aat/verify 的拒绝分支未接 remediation');
  assert.ok(/aat-remediation/.test(seg), '/aat/verify 应复用 aat-remediation.js 而非另写一份');
  // 2026-11-05 实测抽到两处漏网（token_required / agent_not_registered）。
  // 只断言「出现了 remediation 字样」不够——一段里出现一次也算出现。
  // 真正要断言的是：**每一个 send(res, 4xx ...)** 都带上了。
  const denies = [...seg.matchAll(/send\(res,\s*(4\d\d)[^;]*;/g)].map((m) => m[0]);
  assert.ok(denies.length >= 3, `应至少有 3 处拒绝出口，实际 ${denies.length}`);
  const bare = denies.filter((d) => !/_withRem|remediation/.test(d));
  assert.deepStrictEqual(bare, [], `${bare.length} 处 4xx 拒绝未带 remediation：\n${bare.join('\n')}`);
});

test('⑮ 前置拦截的两个 error 也收录（token_required / agent_not_registered）', () => {
  for (const code of ['token_required', 'agent_not_registered']) {
    const r = remediationFor(code);
    assert.strictEqual(r.known, true, `${code} 未收录`);
    assert.ok(r.next_step.length > 6);
  }
});

// ── ⑥ 行为级：真跑一次 verifyInbound，确认字段在结果里 ────────
test('⑬ 行为级：真调 verifyInbound（无 token）→ 返回 remediation 非空', () => {
  const aat = require('../a2a-aat.js');
  const r = aat.verifyInbound({}, { expectedAudience: 'test-agent' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'no_token');
  assert.ok(r.remediation && r.remediation.length > 6, `remediation 缺失：${JSON.stringify(r)}`);
  assert.ok(['caller', 'host', 'both'].includes(r.fixable_by));
});

test('⑭ 行为级：期望受众缺失 → 也有 remediation（不自相矛盾）', () => {
  const aat = require('../a2a-aat.js');
  const r = aat.verifyInbound({ aat: 'x.y.z' }, {});
  assert.strictEqual(r.error, 'missing_expected_audience');
  assert.ok(r.remediation && r.remediation.length > 6);
  assert.strictEqual(r.fixable_by, 'host', '这是调用方的 bug，不该让对方修');
});