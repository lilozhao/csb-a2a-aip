#!/usr/bin/env node
/**
 * hermes-adapter.test.js —— Hermes 注入适配器（C4-H）单元测试 · P0-C
 * 覆盖：默认关 / 双契约 / 禁词 / 非零退出 / 超时 / 空输出 / 拒绝识别 /
 *       无 shell 拼接 / 配置优先级 / confirm 路径 C / extractReply
 * 依赖：无网络、无外部二进制（runner 全部注入假实现）
 * 用法: node tests/hermes-adapter.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const H = require('../adapters/hermes');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch((e) => { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); });
}

const ENV_KEYS = ['A2A_BRIDGE_HERMES', 'A2A_HERMES_BIN', 'A2A_HERMES_HOME', 'A2A_HERMES_TIMEOUT_MS', 'A2A_BRIDGE_MAIN_TO', 'A2A_BRIDGE_CHANNEL', 'A2A_BRIDGE_SESSION_KEY', 'A2A_HERMES_CWD'];
const _saved = {};
for (const k of ENV_KEYS) _saved[k] = process.env[k];
function resetEnv() { for (const k of ENV_KEYS) { if (_saved[k] === undefined) delete process.env[k]; else process.env[k] = _saved[k]; } }
function on() { process.env.A2A_BRIDGE_HERMES = 'on'; }
function off() { process.env.A2A_BRIDGE_HERMES = 'off'; }

const ENV = { task: 'git pull --ff-only && npm test', scope: 'shell', delegator: '若兰' };
const TID = 'task_1789520000000_test';

// 记录 runner 收到的调用参数
let lastCall = null;
function okRunner(behavior) {
  return async (call) => { lastCall = call; return behavior(call); };
}

(async () => {
  console.log('\n[hermes-adapter · P0-C]\n');

  await t('1. 默认关：isEnabled()=false（未设 env）', () => {
    delete process.env.A2A_BRIDGE_HERMES;
    assert.strictEqual(H.isEnabled(), false);
  });

  await t('2. 默认关：非 frame 形式 inject 抛错（含 off 提示）', async () => {
    off();
    await assert.rejects(() => H.inject(ENV, TID), /A2A_BRIDGE_HERMES=off/);
  });

  await t('3. 默认关：frame 形式返回 {ok:false,error} 且不抛', async () => {
    off();
    const r = await H.inject({ taskId: TID, delegatorLabel: '若兰', envelope: ENV }, {});
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /off/);
  });

  await t('4. 成功注入（frame 双契约 → ok:true + result.via）', async () => {
    on();
    H._setRunner(okRunner(() => ({ code: 0, stdout: '已执行：拉取完成，测试 17/17 通过', stderr: '' })));
    const r = await H.inject({ taskId: TID, delegatorLabel: '若兰', envelope: ENV }, {});
    assert.strictEqual(r.ok, true);
    assert.match(r.summary, /17\/17/);
    assert.strictEqual(r.result.via, 'hermes-cli');
    assert.strictEqual(r.refused, false);
  });

  await t('5. 成功注入（非 frame 形式 → 直接返回 {summary,artifact}）', async () => {
    on();
    H._setRunner(okRunner(() => ({ code: 0, stdout: 'OK', stderr: '' })));
    const r = await H.inject(ENV, TID);
    assert.strictEqual(r.summary, 'OK');
    assert.strictEqual(r.artifact.via, 'hermes-cli');
  });

  await t('6. 调用参数：bin + ["-z", prompt] + shell 未被使用（args 数组）', async () => {
    on();
    process.env.A2A_HERMES_BIN = '/opt/hermes/.venv/bin/hermes';
    H._setRunner(okRunner(() => ({ code: 0, stdout: 'ok', stderr: '' })));
    await H.inject(ENV, TID);
    assert.strictEqual(lastCall.bin, '/opt/hermes/.venv/bin/hermes');
    assert.strictEqual(lastCall.args[0], '-z');
    assert.strictEqual(typeof lastCall.args[1], 'string');
    assert.ok(lastCall.args[1].includes(TID), 'prompt 应含 taskId');
    assert.ok(lastCall.env.HERMES_HOME, 'env 应带 HERMES_HOME');
    delete process.env.A2A_HERMES_BIN;
  });

  await t('7. 无 shell 拼接：payload 里的 "; touch /tmp/pwned && $(id)" 不做命令执行（仅作为 prompt 文本）', async () => {
    on();
    const evil = { task: 'echo hi ; touch /tmp/pwned-hermes-test && $(id)', scope: 'shell', delegator: 'X' };
    H._setRunner(okRunner((call) => {
      // 若被 shell 拼接，args[1] 会被拆开/或 bin 被替换；这里断言它原样在 args[1] 字符串里
      assert.strictEqual(call.args.length, 2, '必须只有两个参数（-z, prompt），不得被 shell 拆分');
      assert.ok(call.args[1].includes('touch /tmp/pwned-hermes-test'), '恶意串应原样留在 prompt 文本里');
      return { code: 0, stdout: 'ok', stderr: '' };
    }));
    await H.inject(evil, TID);
    const fs = require('fs');
    assert.strictEqual(fs.existsSync('/tmp/pwned-hermes-test'), false, '恶意命令绝不能被真的执行');
  });

  await t('8. 禁词：prompt 含 "hermes gateway restart" → 拒绝注入', async () => {
    on();
    H._setRunner(okRunner(() => ({ code: 0, stdout: 'ok', stderr: '' })));
    await assert.rejects(
      () => H.inject({ task: '请在网关内执行 hermes gateway restart 以生效', scope: 'shell' }, TID),
      /禁词/
    );
  });

  await t('9. 禁词：s6 监管层 / pkill 类命令 → 拒绝', async () => {
    on();
    H._setRunner(okRunner(() => ({ code: 0, stdout: 'ok', stderr: '' })));
    await assert.rejects(() => H.inject({ task: 's6-svc -r /run/service/hermes' }, TID), /禁词/);
    await assert.rejects(() => H.inject({ task: 'pkill -f server_v5' }, TID), /禁词/);
    assert.strictEqual(H.assertPromptSafe('普通只读任务：ls -la'), true);
  });

  await t('10. 非零退出 → 抛错（含 code + stderr 摘要）', async () => {
    on();
    H._setRunner(okRunner(() => ({ code: 2, stdout: '', stderr: 'boom: config missing' })));
    await assert.rejects(() => H.inject(ENV, TID), /非零退出.*code=2.*config missing/s);
  });

  await t('11. 超时（runner 抛超时错）→ 抛错', async () => {
    on();
    H._setRunner(async () => { throw new Error('注入超时（120000ms）'); });
    await assert.rejects(() => H.inject(ENV, TID), /超时/);
  });

  await t('12. 空输出 → 抛错（不把空当成功）', async () => {
    on();
    H._setRunner(okRunner(() => ({ code: 0, stdout: '   \n  ', stderr: '' })));
    await assert.rejects(() => H.inject(ENV, TID), /无输出/);
  });

  await t('13. 拒绝识别：⛔ 开头 → refused=true', async () => {
    on();
    H._setRunner(okRunner(() => ({ code: 0, stdout: '⛔ 我不能执行：超出我的权限范围', stderr: '' })));
    const r = await H.inject(ENV, TID);
    assert.strictEqual(r.refused, true);
  });

  await t('14. 拒绝识别不误伤：长报告里的统计数字（"拒绝 4" 不在开头窗口）→ refused=false', () => {
    const long = '任务处理完成。' + 'x'.repeat(400) + ' 统计：完成 452 / 拒绝 4';
    assert.strictEqual(H.detectRefusal(long), false);
    assert.strictEqual(H.detectRefusal(''), false);
  });

  await t('15. 配置优先级：env > 默认；超时封顶 15min', () => {
    resetEnv();
    process.env.A2A_BRIDGE_MAIN_TO = 'ou_env_wins';
    process.env.A2A_BRIDGE_CHANNEL = 'feishu';
    process.env.A2A_HERMES_TIMEOUT_MS = '999999999';
    const cfg = H.resolveConfig();
    assert.strictEqual(cfg.mainTo, 'ou_env_wins');
    assert.strictEqual(cfg.channel, 'feishu');
    assert.strictEqual(cfg.timeoutMs, 15 * 60 * 1000, '超时应封顶');
    assert.strictEqual(cfg.bin, 'hermes');
    assert.strictEqual(cfg.home, '/opt/data');
  });

  await t('16. confirm 读回：默认路径 C（保守不自动读）→ ok:false 且提示路径', async () => {
    off();
    const r = await H.fetchResult(TID);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /路径 C/);
    const r2 = await H.fetchResult(TID, { path: 'webhook' });
    assert.strictEqual(r2.ok, false);
    assert.match(r2.error, /尚未实现/);
  });

  await t('17. extractReply：确认/拒绝 #<taskId> 归一', () => {
    assert.deepStrictEqual(H.extractReply(`确认 #${TID}`, TID), { action: 'approve' });
    assert.deepStrictEqual(H.extractReply(`拒绝 #${TID}`, TID), { action: 'decline' });
    assert.deepStrictEqual(H.extractReply('随便说点什么', TID), { action: 'none' });
  });

  await t('18. injectIsolated 与主路径同构（-z 本身即隔离），且禁词不可绕过', async () => {
    on();
    H._setRunner(okRunner(() => ({ code: 0, stdout: 'isolated ok', stderr: '' })));
    const r = await H.injectIsolated(ENV, TID);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.summary, 'isolated ok');
    await assert.rejects(() => H.injectIsolated({ task: 'killall node' }, TID), /禁词/);
  });

  // 收尾
  H._setRunner(null);
  resetEnv();

  console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed}）\n`);
  if (failed > 0) process.exit(1);
})();
