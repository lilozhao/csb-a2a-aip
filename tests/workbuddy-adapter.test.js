#!/usr/bin/env node
/**
 * workbuddy-adapter.test.js —— WorkBuddy 沙箱适配器自测
 * 覆盖（对照 adapters/CONTRACT.md §五 checklist 3）：成功 / 失败 / 拒绝 / 越界 / 无 shell 拼接 / 确认读回
 * 用法: node tests/workbuddy-adapter.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 隔离沙箱：测试不污染真实数据目录
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-adapter-'));
process.env.A2A_BRIDGE_WRITE_SAFE_ROOT = path.join(TMP_ROOT, 'bridge-scratch');
process.env.A2A_BRIDGE_CONFIRM_DIR = path.join(TMP_ROOT, 'bridge-confirms');
process.env.A2A_BRIDGE_CONFIRM_TOKEN = 'test-token-local';
process.env.A2A_BRIDGE_MAIN_TO = 'host-user';
process.env.A2A_BRIDGE_SESSION_KEY = 'agent:ruochen:main';

const adapter = require('../adapters/workbuddy-local');
const { validateAdapter } = require('../adapters/_contract');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

(async () => {
  console.log('\n[workbuddy-local · 适配器自测]\n');

  await t('契约门禁（对照参照实现）', () => {
    const r = validateAdapter(adapter, { name: 'workbuddy-local' });
    assert.ok(r.ok, r.errors.join(' | '));
  });

  await t('resolveConfig 含 channel/sessionKey/mainTo + 沙箱根', () => {
    const c = adapter.resolveConfig();
    assert.strictEqual(c.channel, 'workbuddy-host');
    assert.ok(c.sessionKey && c.mainTo);
    assert.ok(c.writeSafeRoot.endsWith('bridge-scratch'), c.writeSafeRoot);
  });

  await t('沙箱写入成功：file.write + 回执含 path/bytes/sha256', async () => {
    // frame 形式：{ taskId, delegatorLabel, envelope } + opts 走**第二参数**（契约 §二）
    const r = await adapter.inject({ taskId: 'T-write', envelope: { op: 'file.write', path: 'hello-from-ruolan.txt', content: 'hello\n' } }, { isolated: true });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.artifact.bytes, 6);
    assert.strictEqual(r.artifact.sha256.length, 64);
    assert.ok(r.artifact.path.startsWith(adapter.writeSafeRoot()));
  });

  await t('echo 形态：`echo "<字面量>" > /tmp/x.txt` 映射进沙箱', async () => {
    const r = await adapter.injectIsolated({ command: 'echo "nonce-abc" > /tmp/wb-echo.txt', expectedNonce: 'nonce-abc' }, 'T-echo');
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.artifact.sideEffect, 'matched', JSON.stringify(r.artifact));
    assert.ok(!r.artifact.path.includes('/tmp/'), '不得落在真实 /tmp');
  });

  await t('nonce 不一致 → 明确失败（不算成功）', async () => {
    const r = await adapter.injectIsolated({ op: 'file.write', path: 'mismatch.txt', content: 'wrong' }, 'T-nonce', {});
    assert.ok(r.ok === true, '写入本身成功');
    const r2 = await adapter.injectIsolated({ command: 'echo "real" > mismatch2.txt', expectedNonce: 'expected' }, 'T-nonce2');
    assert.strictEqual(r2.ok, false);
    assert.match(r2.error, /nonce/);
  });

  await t('路径越界（../ 与绝对路径）一律拒绝——两种调用形态都覆盖', async () => {
    // frame 形式：返回 {ok:false, refused:true}
    const r1 = await adapter.inject({ taskId: 'T-trav', envelope: { op: 'file.write', path: '../../evil.txt', content: 'x' } }, undefined, { isolated: true });
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.refused, true);
    // 裸参形式：按契约应抛错
    await assert.rejects(
      () => adapter.inject({ op: 'file.write', path: '../../evil-bare.txt', content: 'x' }, 'T-trav2', { isolated: true }),
      /越界/,
    );
    const outside = path.join(os.tmpdir(), 'evil-abs.txt');
    const r2 = await adapter.inject({ taskId: 'T-abs', envelope: { op: 'file.write', path: outside, content: 'x' } }, undefined, { isolated: true });
    assert.strictEqual(r2.ok, false);
    assert.ok(!fs.existsSync(outside), '不得写出沙箱');
  });

  await t('白名单外命令一律拒绝（含 rm / powershell 等）', async () => {
    for (const cmd of ['rm -rf /', 'powershell -c Get-Process', 'curl http://x', 'echo hi > a.txt; rm b.txt']) {
      const r = await adapter.injectIsolated({ command: cmd }, 'T-deny');
      assert.strictEqual(r.ok, false, `应拒绝: ${cmd}`);
      assert.strictEqual(r.refused, true, `应标记 refused: ${cmd}`);
    }
  });

  await t('无 shell 拼接：代码里不存在任何外部进程调用', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'workbuddy-local.js'), 'utf8');
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/execFile|execSync|spawn\s*\(|child_process/.test(codeOnly), '适配器不应执行外部进程');
  });

  await t('常规注入（非 isolated）：诚实拒绝而非假装成功', async () => {
    // frame 形式
    const rf = await adapter.inject({ taskId: 'T-normal', envelope: { task: '随便看看' } });
    assert.strictEqual(rf.ok, false);
    assert.strictEqual(rf.refused, true);
    assert.match(rf.error, /无主 agent 注入通道/);
    // 裸参形式：抛错
    await assert.rejects(() => adapter.inject({ task: '随便看看' }, 'T-normal2', {}), /无主 agent 注入通道/);
  });

  await t('L3 确认：投递 → pending 读回未匹配 → 批准 → 匹配', async () => {
    const taskId = 'task-confirm-1';
    const d = await adapter.invokeTool('local', '', { tool: 'message', action: 'send', args: { taskId, message: '确认 #task-confirm-1 scope=write', scope: 'write', to: 'host-user' } });
    assert.strictEqual(d.ok, true, d.error);
    const r1 = await adapter.fetchResult(taskId, { sinceMs: 0 });
    assert.strictEqual(r1.result.matched, false);
    adapter.resolveConfirm(taskId, 'approve', '知音在野');
    const r2 = await adapter.fetchResult(taskId, { sinceMs: 0 });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.result.matched, true);
    assert.match(r2.result.replyText, /批准/);
    assert.strictEqual(r2.result.messages[0].text, r2.result.replyText);
  });

  await t('确认读回：sinceMs 下界过滤过期决策', async () => {
    const r = await adapter.fetchResult('task-confirm-1', { sinceMs: Date.now() + 3600_000 });
    assert.strictEqual(r.result.matched, false, '未来下界应过滤掉旧决策');
    assert.strictEqual(r.sinceMs > 0, true);
  });

  await t('无凭证读回 → ok:false（不静默成"用户没回"）', async () => {
    const saved = process.env.A2A_BRIDGE_CONFIRM_TOKEN;
    delete process.env.A2A_BRIDGE_CONFIRM_TOKEN;
    try {
      const r = await adapter.fetchResult('task-confirm-1', { sinceMs: 0 });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /凭证/);
    } finally { process.env.A2A_BRIDGE_CONFIRM_TOKEN = saved; }
  });

  await t('buildInjectMessage 含 taskId；detectRefusal 行为正确', () => {
    assert.ok(adapter.buildInjectMessage({ taskId: 'T-9', envelope: {} }).includes('T-9'));
    assert.strictEqual(adapter.detectRefusal('⛔ 拒绝执行'), true);
    assert.strictEqual(adapter.detectRefusal('完成 452 / 拒绝 4'), false);
  });

  console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed}）\n`);
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
  if (failed > 0) process.exit(1);
})();
