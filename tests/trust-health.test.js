#!/usr/bin/env node
/**
 * A2A · 信任证据账本自检测试（[2026-09-18] 一澜指定「修 ②」）
 *
 * 缘起：舟楫部署 UAC 后 `data/trust/trust-evidence.jsonl` **根本没生成** ——
 *   免确认放行只在 console 留痕、账本侧是空的 ⇒ 「免确认可审计」只成立一半。
 *   根因：`_safeCall` 永不抛、只 `console.warn`（静默），且目录缺失没人管。
 *
 * 本测试钉死三件事：
 *   [1] ledgerSnapshot：只读核对「在不在 / 几条 / 最后一条」（ENOENT 不算错）
 *   [2] ledgerHealth ：auditReady 语义（启用 + 文件在 + 有条目 + 无写错）
 *   [3] fail-loud + 目录保证：未启用要喊、写失败要**报错**、深层目录要自建
 *
 * 风格：手写 assert + console（仓库惯例，无测试框架）
 * 用法: node tests/trust-health.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { TrustEvidence } = require(path.join(REPO, 'a2a-trust-evidence.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'trust-health-')); }
const XUAN = { name: '阿轩', url: 'http://172.28.0.5:3100' };
/** 捕获 console.warn / console.error，返回 {warns, errors, restore} */
function captureConsole() {
  const warns = [], errors = [];
  const ow = console.warn, oe = console.error;
  console.warn = (...a) => warns.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));
  return { warns, errors, restore: () => { console.warn = ow; console.error = oe; } };
}
function fresh(ledgerPath, opts = {}) {
  const t = new TrustEvidence();
  t.init({
    noDefaultKeys: true,
    ledgerPath,
    snapshotPath: path.join(path.dirname(ledgerPath), 'store.json'),
    ...opts,
  });
  return t;
}

console.log('\n[1] ledgerSnapshot：只读核对账本文件（ENOENT 不是错）');
test('文件不存在 → exists:false / entries:0 / 无 readError', () => {
  const s = TrustEvidence.ledgerSnapshot(path.join(tmpdir(), 'nope.jsonl'));
  assert.strictEqual(s.exists, false);
  assert.strictEqual(s.entries, 0);
  assert.strictEqual(s.readError, null);
  assert.strictEqual(s.probeEndpoint, '/health/trust-probe');
});
test('两条真实记录 → entries:2 + 最后一条 ts/action/hash 可读', () => {
  const dir = tmpdir();
  const t = fresh(path.join(dir, 'ledger.jsonl'));
  t.messageOk(XUAN, { ref: 'r1' }, 'test');
  t.delegateCompleted(XUAN, { ref: 'r2' }, 'test');
  const s = TrustEvidence.ledgerSnapshot(path.join(dir, 'ledger.jsonl'));
  assert.strictEqual(s.exists, true);
  assert.strictEqual(s.entries, 2);
  assert.ok(s.sizeBytes > 0);
  assert.strictEqual(s.lastAction, 'delegate_completed');
  assert.ok(typeof s.lastEntryAt === 'number', '最后一条时间必须可读（审计对账用）');
  assert.ok(/^[0-9a-f]{16,}/.test(String(s.lastHash)), '最后一条 hash 必须可读');
});
test('尾部坏行 → readError=tail_parse（其余字段仍可用）', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(p, '{"action":"message_ok","ts":1,"hash":"aa"}\n{not json\n');
  const s = TrustEvidence.ledgerSnapshot(p);
  assert.strictEqual(s.entries, 2);
  assert.ok(/tail_parse/.test(s.readError), s.readError);
});

console.log('\n[2] ledgerHealth：auditReady 语义（可审计 = 启用 + 在 + 有 + 无错）');
test('启用 + 已记账 → auditReady:true / degraded:false', () => {
  const dir = tmpdir();
  const t = fresh(path.join(dir, 'ledger.jsonl'));
  t.messageOk(XUAN, { ref: 'r' }, 'test');
  const h = t.ledgerHealth();
  assert.strictEqual(h.enabled, true);
  assert.strictEqual(h.exists, true);
  assert.strictEqual(h.entries, 1);
  assert.strictEqual(h.auditReady, true, JSON.stringify(h));
  assert.strictEqual(h.degraded, false);
  assert.strictEqual(h.ledgerPath, path.join(dir, 'ledger.jsonl'), '自检必须报实际路径');
});
test('csb-security 缺失 → enabled:false + auditReady:false + reason 明确', () => {
  const dir = tmpdir();
  const t = new TrustEvidence();
  t.init({ securityPath: path.join(dir, 'no-such-security'), ledgerPath: path.join(dir, 'l.jsonl') });
  const h = t.ledgerHealth();
  assert.strictEqual(h.enabled, false);
  assert.strictEqual(h.auditReady, false);
  assert.strictEqual(h.degraded, true);
  assert.strictEqual(h.reason, 'csb_security_not_found');
});
test('status().ledgerPath 必须反映注入路径（不再硬编码常量）', () => {
  const dir = tmpdir();
  const t = fresh(path.join(dir, 'custom.jsonl'));
  assert.strictEqual(t.status().ledgerPath, path.join(dir, 'custom.jsonl'));
});

console.log('\n[3] fail-loud + 目录保证（静默是这次要修的根因）');
test('目录保证：深层不存在的目录 → 自动建，账本落盘', () => {
  const dir = tmpdir();
  const deep = path.join(dir, 'data', 'trust', 'ledger.jsonl');
  const t = fresh(deep);
  t.messageOk(XUAN, { ref: 'r' }, 'test');
  assert.ok(fs.existsSync(deep), '深层目录/文件应被自动创建');
  assert.strictEqual(t.ledgerHealth().entries, 1);
});
test('未启用要"喊"：skipped 计数 + 只 warn 一次（不刷屏）', () => {
  const dir = tmpdir();
  const t = new TrustEvidence();
  t.init({ securityPath: path.join(dir, 'nope'), ledgerPath: path.join(dir, 'l.jsonl') });
  const cap = captureConsole();
  try {
    t.messageOk(XUAN, { ref: 'a' }, 'x');
    t.messageOk(XUAN, { ref: 'b' }, 'x');
  } finally { cap.restore(); }
  assert.strictEqual(t.status().hookStats.skipped, 2);
  assert.strictEqual(cap.warns.length, 1, `应恰好喊一次，实际 ${cap.warns.length}`);
  assert.ok(/未启用/.test(cap.warns[0]), cap.warns[0]);
});
test('写失败要 fail-loud：console.error（不再是会被忽略的 warn）', () => {
  const dir = tmpdir();
  const asFile = path.join(dir, 'blocker');    // 先建文件，再拿它当目录用 → ENOTDIR
  fs.writeFileSync(asFile, 'x');
  const t = fresh(path.join(asFile, 'ledger.jsonl'));
  const cap = captureConsole();
  try { t.messageOk(XUAN, { ref: 'x' }, 'test'); } finally { cap.restore(); }
  assert.ok(cap.errors.length >= 1, '记账失败必须 console.error');
  assert.ok(t.status().hookStats.errors >= 1 || t.status().hookStats.skipped >= 1,
    '失败必须计入 stats（可被自检看见）');
});

console.log('\n' + '─'.repeat(60));
console.log(`通过: ${passed}\n失败: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
