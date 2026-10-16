#!/usr/bin/env node
/**
 * expansion.test.js —— SPEC-A2A-0003《A2A 原文按需展开与逐次授权》验收
 * A1–A10 对应 R1–R10（+ R11 防重放 / R12 schema_hash）。风格：手写 assert。
 *
 * 用法: node tests/expansion.test.js
 */
'use strict';
const assert = require('assert');
const ex = require('../a2a-expansion.js');

let passed = 0, failed = 0;
function t(name, fn) {
  ex._resetRate(); ex._resetPending();
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch((e) => { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); });
}

const GOOD = {
  raw_ref: { kind: 'memory-event', pointer: 'csb://mem/event/12345' },
  requester: { name: '阿轩', url: 'http://172.28.0.5:3100' },
  scope: { granularity: 'single-ref' },
  purpose: '审计用例',
};
const GRANT = { pointer: 'csb://mem/event/12345', requester: '阿轩' };
const ledgerArr = []; const ledger = (r) => ledgerArr.push(r);

async function main() {
  console.log('\n[expansion.test · SPEC-A2A-0003]\n');
  process.env.A2A_EXPANSION_ENABLED = 'on';
  ex._resetRate(); ex._resetPending();

  // A1 → R1：未授权不返回原文；授权后走展开流程
  await t('A1 → R1：未授权不返回原文', () => {
    const r = ex.handleRequestExpansion(GOOD, { ledger });
    assert.notStrictEqual(r.state, 'granted');
    assert.ok(!('view' in r), '不应返回 view');
  });

  // A2 → R2：缺身份 → EXPANSION_IDENTITY_REQUIRED
  await t('A2 → R2：缺身份 → EXPANSION_IDENTITY_REQUIRED', () => {
    const r = ex.handleRequestExpansion({ ...GOOD, requester: {} }, { ledger });
    assert.strictEqual(r.state, 'denied');
    assert.strictEqual(r.code, 'EXPANSION_IDENTITY_REQUIRED');
  });

  // A3 → R3：默认拒绝；有效授权返回受限视图
  await t('A3 → R3：无授权默认拒绝 / 有授权返回受限视图', () => {
    const deny = ex.handleRequestExpansion(GOOD, { ledger });
    assert.strictEqual(deny.state, 'expansion_pending'); // 无授权但需人类 → pending
    const ok = ex.handleRequestExpansion(GOOD, { grants: [GRANT], dataProvider: () => 'SECRET-RAW', ledger });
    assert.strictEqual(ok.state, 'granted');
    assert.strictEqual(ok.retention, 'delete-after-use');
  });

  // A4 → R4：pending 返回调用方 + 异步通知主人
  await t('A4 → R4：pending 返回 + 通知主人', () => {
    ex._resetPending(); ex._resetRate();
    let notified = null;
    const r = ex.handleRequestExpansion(GOOD, { ledger, notifyOwner: (n) => { notified = n; } });
    assert.strictEqual(r.state, 'expansion_pending');
    assert.ok(r.confirm_by, '应含 confirm_by');
    assert.ok(notified && notified.fingerprint, '应异步通知主人');
  });

  // A11 → R11：同一指纹窗口内第二次被拒（防重放）
  await t('A11 → R11：同一指纹第二次被拒（防重放）', () => {
    ex._resetPending(); ex._resetRate();
    const first = ex.handleRequestExpansion(GOOD, { ledger });
    const second = ex.handleRequestExpansion(GOOD, { ledger });
    assert.strictEqual(first.state, 'expansion_pending');
    assert.strictEqual(second.state, 'denied');
    assert.strictEqual(second.code, 'EXPANSION_NOT_AUTHORIZED');
  });

  // A5 → R5：数据侧权威裁剪；越粒度 → SCOPE_EXCEEDED
  await t('A5 → R5：越粒度请求被拒（首期仅 single-ref）', () => {
    const r = ex.handleRequestExpansion({ ...GOOD, scope: { granularity: 'topic-batch' } }, { grants: [GRANT], dataProvider: () => 'R', ledger });
    assert.strictEqual(r.state, 'denied');
    assert.strictEqual(r.code, 'EXPANSION_SCOPE_EXCEEDED');
  });

  // A12 → R12：视图含 schema_hash + 不可逆脱敏
  await t('A12 → R12：schema_hash + 不可逆脱敏（无原文）', () => {
    const r = ex.handleRequestExpansion(GOOD, { grants: [GRANT], dataProvider: () => 'SECRET-RAW', ledger });
    assert.strictEqual(r.state, 'granted');
    assert.ok(/^sha256:/.test(r.view.schema_hash), '应含 schema_hash');
    assert.strictEqual(r.view.redacted, true);
    assert.ok(!JSON.stringify(r).includes('SECRET-RAW'), '不得含原文');
  });

  // A6 → R6：拒绝/超时结构化返回 + 记账
  await t('A6 → R6：拒绝写账本（不静默）', () => {
    ledgerArr.length = 0;
    ex.handleRequestExpansion({ ...GOOD, requester: {} }, { ledger });
    assert.ok(ledgerArr.some((e) => e.action === 'expansion.denied'), '账本应有 denied');
  });

  // A7 → R7：L3 停留声明
  await t('A7 → R7：granted 返回 retention=delete-after-use', () => {
    const r = ex.handleRequestExpansion(GOOD, { grants: [GRANT], dataProvider: () => 'R', ledger });
    assert.strictEqual(r.retention, 'delete-after-use');
  });

  // A8 → R8：安全例外通道（不被授权链拦截）
  await t('A8 → R8：breach 达判据触发审计', () => {
    let audited = null;
    const r = ex.securityException({ kind: 'breach' }, (rec) => { audited = rec; });
    assert.strictEqual(r.triggered, true);
    assert.ok(audited && audited.action === 'expansion.security_audit');
    assert.strictEqual(ex.securityException({ kind: 'normal' }).triggered, false);
  });

  // A9 → R9：超频 → EXPANSION_RATE_LIMITED
  await t('A9 → R9：超频限流', () => {
    ex._resetRate(); ex._resetPending();
    process.env.A2A_EXPANSION_RATE_LIMIT = '2';
    ex.handleRequestExpansion(GOOD, { ledger });
    ex.handleRequestExpansion(GOOD, { ledger });
    const third = ex.handleRequestExpansion(GOOD, { ledger });
    assert.strictEqual(third.state, 'denied');
    assert.strictEqual(third.code, 'EXPANSION_RATE_LIMITED');
    delete process.env.A2A_EXPANSION_RATE_LIMIT;
  });

  // A10 → R10：防疲劳汇总
  await t('A10 → R10：达阈值汇总为一条（防习惯化放行）', () => {
    process.env.A2A_EXPANSION_FATIGUE_THRESHOLD = '5';
    assert.strictEqual(ex.fatigueAggregate(4).aggregated, false);
    assert.strictEqual(ex.fatigueAggregate(5).aggregated, true);
  });

  // 默认关：off 即一期行为
  await t('开关默认关 → 回一期行为（不展开）', () => {
    process.env.A2A_EXPANSION_ENABLED = 'off';
    const r = ex.handleRequestExpansion(GOOD, { grants: [GRANT], dataProvider: () => 'R' });
    assert.strictEqual(r.state, 'denied');
    process.env.A2A_EXPANSION_ENABLED = 'on';
  });

  console.log(`\n  通过 ${passed} / ${passed + failed}\n`);
  process.exit(failed ? 1 : 0);
}

main();