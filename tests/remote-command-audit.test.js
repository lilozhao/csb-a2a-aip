#!/usr/bin/env node
/**
 * remote-command/audit.js · 单元测试（K14 / §六.3）
 * 覆盖：审计路径 env 可配置（A2A_CMD_AUDIT_LOG）、显式 config 优先、不可写时降级不抛错
 * 风格：手写 assert + console（仓库惯例）
 *
 * 用法: node tests/remote-command-audit.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离临时目录（不污染仓库 logs）。env 必须在 require 前设置（DEFAULT_CONFIG 于模块加载期求值）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-audit-test-'));
const ENV_LOG = path.join(TMP, 'nested', 'a2a_command.log');
process.env.A2A_CMD_AUDIT_LOG = ENV_LOG;

const { AuditLogger } = require('../remote-command/audit.js');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch((e) => { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); });
}
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\n[1] 路径解析');

  await test('env A2A_CMD_AUDIT_LOG 覆盖硬编码默认', async () => {
    const logger = new AuditLogger();
    assert.strictEqual(logger.config.logPath, ENV_LOG);
    await tick();
    assert.strictEqual(logger.initialized, true, '可写路径应初始化成功');
    await logger.close();
  });

  await test('显式 config.logPath 优先于 env', async () => {
    const explicit = path.join(TMP, 'explicit.log');
    const logger = new AuditLogger({ logPath: explicit });
    assert.strictEqual(logger.config.logPath, explicit);
    await logger.close();
  });

  console.log('\n[2] 落盘');

  await test('日志写入 env 指定路径', async () => {
    const logger = new AuditLogger();
    await tick();
    await logger.log({
      command_id: 'cmd_k14_1', sender: 'test', sender_url: 'http://t:1',
      command: 'system.status', status: 'success', execution_time: 5,
    });
    await logger.close();
    const data = fs.readFileSync(ENV_LOG, 'utf8');
    assert.ok(data.includes('"command_id":"cmd_k14_1"'), '应含写入条目');
  });

  console.log('\n[3] 降级');

  await test('不可写路径 → 显式降级、不抛错、不静默阻塞', async () => {
    // 以「文件」充当日志目录的父级，制造 ENOTDIR
    const blocker = path.join(TMP, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const bad = path.join(blocker, 'sub', 'a2a_command.log');
    const logger = new AuditLogger({ logPath: bad });
    await tick();
    assert.strictEqual(logger.initialized, false, '初始化应失败（降级）');
    await logger.log({ command_id: 'cmd_k14_2' }); // 不应抛错
    await logger.close();
  });

  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
