#!/usr/bin/env node
/**
 * [明澈原则 P2「身份不许有默认值」· 2026-10-02 · 一澜定案方案 a]
 * a2a-identity.js 单元测试：
 *   1. A2A_AGENT_NAME 优先
 *   2. CDP_NAME 兼容回退（并告警）
 *   3. env 与 file.name 不一致 → 抛错
 *   4. 三者全无 → 抛错（拒绝匿名）
 *   5. 文件缺失 → 抛错
 *   6. A2A_IDENTITY_PATH 生效
 *   7. 仅 file.name（无 env）→ 放行（兼容老部署）
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveIdentity, resolveEnvName, checkCrossRepoConsistency } = require('../a2a-identity');

let passed = 0, failed = 0;
function test(name, fn) {
  const snapshot = { ...process.env };
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
  finally {
    for (const k of ['A2A_AGENT_NAME', 'CDP_NAME', 'A2A_IDENTITY_PATH']) {
      if (snapshot[k] === undefined) delete process.env[k]; else process.env[k] = snapshot[k];
    }
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-identity-'));
const idFile = path.join(tmpDir, 'identity.json');

test('A2A_AGENT_NAME 优先（与 file 一致）', () => {
  fs.writeFileSync(idFile, JSON.stringify({ name: '若兰', emoji: '🌸' }));
  process.env.A2A_AGENT_NAME = '若兰';
  const r = resolveIdentity({ identityPath: idFile });
  assert.strictEqual(r.name, '若兰');
  assert.strictEqual(r.nameSource, 'A2A_AGENT_NAME');
});

test('CDP_NAME 兼容回退 + 告警', () => {
  fs.writeFileSync(idFile, JSON.stringify({ name: '阿轩' }));
  delete process.env.A2A_AGENT_NAME;
  process.env.CDP_NAME = '阿轩';
  const r = resolveIdentity({ identityPath: idFile });
  assert.strictEqual(r.name, '阿轩');
  assert.strictEqual(r.nameSource, 'CDP_NAME');
});

test('A2A_AGENT_NAME 优先于 CDP_NAME', () => {
  fs.writeFileSync(idFile, JSON.stringify({ name: 'new' }));
  process.env.A2A_AGENT_NAME = 'new';
  process.env.CDP_NAME = 'old';
  const r = resolveIdentity({ identityPath: idFile });
  assert.strictEqual(r.name, 'new');
});

test('env 与 file.name 不一致 → 抛错（身份漂移）', () => {
  fs.writeFileSync(idFile, JSON.stringify({ name: 'file-name' }));
  process.env.A2A_AGENT_NAME = 'env-name';
  assert.throws(() => resolveIdentity({ identityPath: idFile }), /身份名不一致/);
});

test('三者全无 name → 抛错（拒绝匿名启动）', () => {
  fs.writeFileSync(idFile, JSON.stringify({ emoji: '🤖' }));
  delete process.env.A2A_AGENT_NAME; delete process.env.CDP_NAME;
  assert.throws(() => resolveIdentity({ identityPath: idFile }), /身份名缺失/);
});

test('文件缺失 → 抛错', () => {
  process.env.A2A_AGENT_NAME = 'x';
  assert.throws(() => resolveIdentity({ identityPath: path.join(tmpDir, 'nope.json') }), /身份文件不存在/);
});

test('A2A_IDENTITY_PATH 生效', () => {
  const alt = path.join(tmpDir, 'alt.json');
  fs.writeFileSync(alt, JSON.stringify({ name: 'alt' }));
  process.env.A2A_IDENTITY_PATH = alt;
  delete process.env.A2A_AGENT_NAME; delete process.env.CDP_NAME;
  const r = resolveIdentity();
  assert.strictEqual(r.name, 'alt');
  assert.strictEqual(r.path, alt);
});

test('仅 file.name（无 env）→ 放行（兼容老部署）', () => {
  fs.writeFileSync(idFile, JSON.stringify({ name: 'legacy' }));
  delete process.env.A2A_AGENT_NAME; delete process.env.CDP_NAME;
  const r = resolveIdentity({ identityPath: idFile });
  assert.strictEqual(r.name, 'legacy');
  assert.strictEqual(r.nameSource, 'file.name');
});

// --- 跨库一致性（2026-10-02 一澜补充）---
test('checkCrossRepoConsistency：全一致 → ok', () => {
  const r = checkCrossRepoConsistency('若兰', [{ name: '若兰', source: 'csb-security' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mismatches.length, 0);
});

test('checkCrossRepoConsistency：不一致 → 列出 mismatches', () => {
  const r = checkCrossRepoConsistency('若兰', [{ name: 'ruolan', source: 'csb-security' }]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.mismatches[0].name, 'ruolan');
});

test('checkCrossRepoConsistency：selfName 为空 → 抛错', () => {
  assert.throws(() => checkCrossRepoConsistency('', []), /selfName 不能为空/);
});

// 清理
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\n${'='.repeat(50)}`);
console.log(`a2a-identity: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
console.log('全部通过 ✅');
