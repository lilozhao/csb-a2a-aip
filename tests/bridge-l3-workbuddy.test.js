#!/usr/bin/env node
/**
 * bridge-l3-workbuddy.test.js —— L3 write 委托全链路（WorkBuddy 宿主）
 *
 * 验证（不改运行时信任策略，用注入的 getTrustLevel）：
 *   ① 信任不足（L2 发 write）→ 拒绝，且**不产生确认记录**（门槛先于确认）
 *   ② 信任达标（L3）+ 用户批准 → 确认记录 → 沙箱落盘 → 回执含 path/bytes/sha256
 *   ③ 信任达标 + 用户拒绝 → 拒绝回执，且**不落盘**（超时/拒绝都不执行）
 *   ④ 批准前不得执行（pending 期间文件不存在）
 *
 * 用法: node tests/bridge-l3-workbuddy.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-l3-'));
process.env.A2A_BRIDGE_WRITE_SAFE_ROOT = path.join(TMP_ROOT, 'bridge-scratch');
process.env.A2A_BRIDGE_CONFIRM_DIR = path.join(TMP_ROOT, 'bridge-confirms');
process.env.A2A_BRIDGE_CONFIRM_TOKEN = 'test-token-l3';

const bridge = require('../a2a-bridge-core');
const confirm = require('../a2a-bridge-confirm');
const adapter = require('../adapters/workbuddy-local');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

const SENDER = { name: '若兰', url: 'http://host.docker.internal:3111' };

function makeMsg(taskId, nonce) {
  return {
    delegation: {
      type: 'execute',
      scope: 'write',
      target: `echo "${nonce}" > hello-from-ruolan.txt`,
      task: `写入一行问候到 hello-from-ruolan.txt（nonce=${nonce}）`,
      id: taskId,
      isolated: true,
      nonce,
      expectedMarker: 'hello-from-ruolan.txt',
    },
  };
}

function ctxFor(taskId, trustLevel, extra = {}) {
  return {
    sender: SENDER,
    taskId,
    getTrustLevel: async () => trustLevel,
    inject: async (envelope, tid) => adapter.inject({ taskId: tid, envelope }, { isolated: true }),
    confirmL3: async (envelope, c) => confirm.confirmL3(
      envelope,
      { taskId: c.taskId, sender: c.sender, taskTs: envelope?.requestedAt },
      { to: 'host-user', pollIntervalMs: 200, timeoutMs: 8000 },
    ),
    recordDegrade: async () => {},
    recordEvidence: async () => {},
    ...extra,
  };
}

const sandboxFile = () => path.join(adapter.writeSafeRoot(), 'hello-from-ruolan.txt');
const pendingPath = (tid) => path.join(adapter.confirmDir(), `${tid}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n[bridge · L3 write 全链路 · WorkBuddy]\n');

  await t('① 信任不足（L2 发 write）→ 拒绝，不产生确认记录', async () => {
    const tid = 'task-l3-lowtrust';
    const r = await bridge.handleInbound(makeMsg(tid, 'n1'), ctxFor(tid, 'L2'));
    assert.strictEqual(r.kind, 'rejected', `应拒绝，实际 ${r.kind}`);
    assert.match(JSON.stringify(r.receipt), /trust|信任/i);
    assert.ok(!fs.existsSync(pendingPath(tid)), '门槛未过不应产生确认记录');
    assert.ok(!fs.existsSync(sandboxFile()), '不得落盘');
  });

  await t('②+④ L3 批准路径：pending 期间不执行，批准后沙箱落盘（含 hash）', async () => {
    const tid = 'task-l3-approve';
    const nonce = 'nonce-' + Date.now();
    const p = bridge.handleInbound(makeMsg(tid, nonce), ctxFor(tid, 'L3'));

    // 等确认请求落盘（投递）
    let delivered = false;
    for (let i = 0; i < 40 && !delivered; i++) {
      await sleep(100);
      delivered = fs.existsSync(pendingPath(tid));
    }
    assert.ok(delivered, '确认请求应已投递给宿主用户（pending 记录）');
    assert.ok(!fs.existsSync(sandboxFile()), '批准前绝不能执行');

    // 主会话批准
    adapter.resolveConfirm(tid, 'approve', '知音在野');

    const r = await p;
    assert.strictEqual(r.kind, 'executed', JSON.stringify(r.receipt).slice(0, 300));
    // 回执为既定双层结构：receipt.receipt（correlator 用 `receipt.receipt || receipt` 解包）
    const res = r.receipt.receipt ? r.receipt.receipt.result : r.receipt.result;
    assert.strictEqual(res.status, 'completed', JSON.stringify(res).slice(0, 200));
    assert.ok(res.artifact && res.artifact.path && res.artifact.sha256, '回执应含 path/sha256');
    assert.ok(fs.existsSync(sandboxFile()), '文件应已落在沙箱');
    assert.strictEqual(fs.readFileSync(sandboxFile(), 'utf8').trim(), nonce, '内容应与 nonce 一致');
    assert.ok(!res.artifact.path.includes('/tmp/'), '不得落在真实系统目录');
  });

  await t('③ L3 拒绝路径：拒绝 → 不落盘，回执含拒绝原因', async () => {
    const tid = 'task-l3-decline';
    const nonce = 'nonce-decline-' + Date.now();
    fs.rmSync(sandboxFile(), { force: true });
    const p = bridge.handleInbound(makeMsg(tid, nonce), ctxFor(tid, 'L3'));

    let delivered = false;
    for (let i = 0; i < 40 && !delivered; i++) {
      await sleep(100);
      delivered = fs.existsSync(pendingPath(tid));
    }
    assert.ok(delivered, '应有 pending 记录');
    adapter.resolveConfirm(tid, 'decline', '知音在野');

    const r = await p;
    assert.ok(r.kind === 'rejected', `拒绝应得 rejected，实际 ${r.kind}`);
    assert.ok(!fs.existsSync(sandboxFile()), '拒绝后不得落盘');
  });

  await t('白名单外命令（shell 类）→ 拒绝且不落盘', async () => {
    const tid = 'task-l3-denied-cmd';
    const msg = { delegation: { type: 'execute', scope: 'shell', target: 'rm -rf C:\\', task: '危险命令', id: tid, isolated: true } };
    const p = bridge.handleInbound(msg, ctxFor(tid, 'L3'));
    let delivered = false;
    for (let i = 0; i < 40 && !delivered; i++) {
      await sleep(100);
      delivered = fs.existsSync(pendingPath(tid));
    }
    if (delivered) adapter.resolveConfirm(tid, 'approve', '知音在野'); // 即使批准也不该执行
    const r = await p;
    assert.ok(r.kind !== 'executed', 'shell 命令不得执行');
  });

  console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed}）\n`);
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
  if (failed > 0) process.exit(1);
})();
