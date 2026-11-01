#!/usr/bin/env node
/**
 * P0-0 验收测试：A2A 审计链 ↔ AEP GDI 跨仓互验
 *
 * 判据（机械可核）：
 *   1. 造 3 条审计 → verifyChain 返回 valid/ok true
 *   2. 同一文件交给 AEP 的 GDI verifyRate → chainValid === true（跨仓互验，这是重点）
 *   3. 篡改任一条内容 → 两侧都必须报错（不能只有一侧报）
 *   4. caller_id 必须是被审计的真实 agent 名（不是 'unknown'）
 *   5. /tmp 不再被用作默认路径
 *
 * 运行：node tests/audit-chain.test.js
 */

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-0-audit-'));
const LOG = path.join(TMP, 'audit.jsonl');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log('[audit-chain] P0-0 验收\n');

// ── 建账 ──
const { createAuditLogger } = require(path.join(ROOT, 'security-adapter.js'));
const logger = createAuditLogger({ logPath: LOG });

t('审计走哈希链实现（chainCapable=true）', () => {
  assert.strictEqual(logger.chainCapable, true, 'chainCapable 应为 true');
});

logger.record({ traceId: 't1', event: 'request', agent: '若兰', method: 'SendMessage', status: 'OK', durationMs: 10 });
logger.record({ traceId: 't2', event: 'request', agent: '阿轩', method: 'SendMessage', status: 'OK', durationMs: 20 });
logger.record({ traceId: 't3', event: 'request', agent: '若兰', method: 'SendMessage', status: 'error', durationMs: 30 });

t('写 3 条后链可验（valid/ok=true）', () => {
  const v = logger.verifyChain();
  const ok = v.valid === true || v.ok === true;
  assert.ok(ok, `verifyChain 应通过，实际 ${JSON.stringify(v)}`);
});

t('caller_id 是真名，不是 unknown', () => {
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.strictEqual(lines.length, 3, `应有 3 条，实际 ${lines.length}`);
  const names = lines.map((l) => l.caller_id);
  assert.deepStrictEqual(names, ['若兰', '阿轩', '若兰'], `caller_id 实际 ${JSON.stringify(names)}`);
});

t('result 按 HTTP status 推导（error→failure）', () => {
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.deepStrictEqual(lines.map((l) => l.result), ['success', 'success', 'failure']);
});

t('每条含 seq / prev_hash / hash（GDI 认的字段）', () => {
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  lines.forEach((l, i) => {
    assert.strictEqual(l.seq, i + 1, `第 ${i + 1} 条 seq 不对`);
    assert.ok(l.prev_hash, 'prev_hash 缺失');
    assert.ok(l.hash, 'hash 缺失');
  });
  assert.strictEqual(lines[0].prev_hash, 'GENESIS', '首条 prev_hash 应为 GENESIS');
});

logger.shutdown();

// ── 跨仓互验：AEP 的 GDI 必须能验 A2A 写的账 ──
const GDI_VERIFY = path.join(ROOT, '..', 'csb-aep', 'server', 'engine', 'gdi', 'verify.js');

t('JUDGE: AEP GDI 能验 A2A 审计（chainValid=true，跨仓互验）', () => {
  assert.ok(fs.existsSync(GDI_VERIFY), `GDI verify 不存在: ${GDI_VERIFY}`);
  const gdi = require(GDI_VERIFY);
  const r = gdi.verifyRate(TMP, '若兰');
  assert.strictEqual(r.chainValid, true, `chainValid 应为 true，实际 ${JSON.stringify(r)}`);
  assert.notStrictEqual(r.reason, 'no_audit_source', 'GDI 不应再报 no_audit_source');
  assert.notStrictEqual(r.reason, 'hash_chain_broken', 'GDI 不应报断链');
});

t('JUDGE: GDI 能按 agent 算出真实通过率', () => {
  const gdi = require(GDI_VERIFY);
  const r = gdi.verifyRate(TMP, '若兰');
  // 若兰 2 条：1 success 1 failure → 0.5
  assert.ok(typeof r.rate === 'number', `rate 应为数字，实际 ${JSON.stringify(r)}`);
  assert.ok(Math.abs(r.rate - 0.5) < 1e-9, `若兰通过率应为 0.5，实际 ${r.rate}`);
});

// ── 篡改必检出（两侧都要报）──
t('JUDGE: 篡改内容 → A2A 侧报错', () => {
  const badDir = path.join(TMP, 'bad-a2a');
  fs.mkdirSync(badDir, { recursive: true });
  const bad = path.join(badDir, 'audit.jsonl');
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  const e = JSON.parse(lines[1]);
  e.caller_id = 'ATTACKER';           // 改内容，不重算 hash
  lines[1] = JSON.stringify(e);
  fs.writeFileSync(bad, lines.join('\n') + '\n');
  const { AuditLog } = require(path.join(ROOT, '..', 'csb-security', 'lib', 'audit', 'audit-log.js'));
  const v = new AuditLog({ logPath: bad }).verifyChain();
  const ok = v.valid === true || v.ok === true;
  assert.strictEqual(ok, false, '篡改后应验不过');
});

t('JUDGE: 篡改内容 → GDI 侧报错（两侧判据一致）', () => {
  const gdi = require(GDI_VERIFY);
  // 先确认原目录（只含 audit.jsonl）仍好 —— 隔离目录，避免被篡改件污染
  const r = gdi.verifyRate(TMP, '若兰');
  assert.strictEqual(r.chainValid, true, `原账应可验，实际 ${JSON.stringify(r)}`);

  const badDir = path.join(TMP, 'bad-gdi');
  fs.mkdirSync(badDir, { recursive: true });
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  const e = JSON.parse(lines[0]);
  e.result = 'failure';
  lines[0] = JSON.stringify(e);
  fs.writeFileSync(path.join(badDir, 'audit.jsonl'), lines.join('\n') + '\n');
  const r2 = gdi.verifyRate(badDir, '若兰');
  assert.strictEqual(r2.chainValid, false, `篡改后 GDI 应报 false，实际 ${JSON.stringify(r2)}`);
});

// ── 路径不再落 /tmp ──
t('JUDGE: 未设 A2A_DATA_DIR 时不落 /tmp', () => {
  const src = fs.readFileSync(path.join(ROOT, 'a2a-observability.js'), 'utf8');
  const m = src.match(/this\.logPath\s*=\s*path\.join\(process\.env\.A2A_DATA_DIR\s*\|\|\s*'\/tmp'/);
  assert.strictEqual(m, null, '代码里不应再有 A2A_DATA_DIR || /tmp 的写法');
});

t('legacy 回退时 chainCapable=false 且标 degraded（不假装有链）', () => {
  process.env.A2A_SECURITY_AUDIT = '0';
  delete require.cache[require.resolve(path.join(ROOT, 'security-adapter.js'))];
  const sa2 = require(path.join(ROOT, 'security-adapter.js'));
  const legacy = sa2.createAuditLogger({ logPath: path.join(TMP, 'legacy.log') });
  assert.strictEqual(legacy.chainCapable, false, 'legacy 应标 chainCapable=false');
  assert.strictEqual(legacy.degradedReason, 'explicitly_disabled');
  legacy.shutdown();
  delete process.env.A2A_SECURITY_AUDIT;
});

// ── 清理 ──
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n[audit-chain] 通过: ${pass} / 失败: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
