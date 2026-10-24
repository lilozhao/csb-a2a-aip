#!/usr/bin/env node
/**
 * api-critical-wiring.test.js — 「关键接线必须在」回归锁
 *
 * 起因（2026-10-25 凌晨排查）：
 *   明德 2026-10-08 提交 ac94694（改自动回复为固定回执）时，**基于自己的旧副本整文件重写**
 *   a2a-standard-api-v5.js，把我方四块改动静默删掉 —— 17 天无人发现：
 *     ① /tasks Bearer 鉴权（0614442 + 19863ef）
 *     ② 自环守卫（e1bfb7e）
 *     ③ delegation 信封 → bridgeHandler 接线
 *     ④ 信任证据 messageOk / guardBlocked
 *   为什么没人发现：删掉的是「分支」和「调用点」，语法合法、服务照跑、/health 全绿；
 *   症状只在「有人正好发一条委托」时才出现，而那时它表现为一句 LLM 闲聊。
 *
 * 这条测试锁的是**接线存在性**（不是实现细节）：
 *   W1 五个关键方法必须挂在类上（整文件覆盖会立刻红）
 *   W2 bridgeHandler 必须真被构造器接收，且 delegation 真正路由过去
 *   W3 __terminalState 必须被尊重（否则拒绝会被盖成 COMPLETED）
 *   W4 自环调用必须快速拒绝（REJECTED + SELF_MESSAGE_IGNORED）
 *
 * 跑法：node tests/api-critical-wiring.test.js
 */

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { A2AStandardAPI } = require(path.join(REPO, 'a2a-standard-api-v5.js'));
const { TASK_STATE, createMessage, createPart } = require(path.join(REPO, 'a2a-task-store.js'));

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

const mkApi = (opts = {}) => new A2AStandardAPI({
  identity: { name: '测试实例', emoji: '🧪', port: 3199 },
  ...opts,
});

(async () => {
  console.log('\n[接线存在性回归 · ac94694 事故]\n');

  console.log('[W1] 关键方法必须挂在类上');
  const api = mkApi();
  for (const m of ['_checkTasksAuth', '_isInternalIp', '_tasksToken', '_checkSelfMessage', '_buildSelfRejectedTask']) {
    await t(`${m} 存在`, () => assert.strictEqual(typeof api[m], 'function'));
  }
  await t('172.28.0.1（宿主机入口）不算内网', () => assert.strictEqual(api._isInternalIp('172.28.0.1'), false));
  await t('172.28.0.214（Agent）算内网', () => assert.strictEqual(api._isInternalIp('172.28.0.214'), true));

  console.log('\n[W2] delegation 必须真正路由到 bridgeHandler');
  let bridgeCalls = 0;
  const bridgeApi = mkApi({
    bridgeHandler: async (taskId, msg) => {
      bridgeCalls++;
      return {
        artifacts: [],
        message: createMessage('agent', [createPart('bridge-ok')]),
        __terminalState: TASK_STATE.REJECTED,
      };
    },
  });
  await t('构造器接收 bridgeHandler', () => assert.strictEqual(typeof bridgeApi._bridgeHandler, 'function'));

  const resp = await bridgeApi._processTask('t-w2', {
    delegation: { type: 'notify', scope: 'read', target: 'x' },
    parts: [{ type: 'text', text: '委托内容' }],
  }, { sender: { name: '邻居' } });
  await t('带 delegation 的信封进入桥接（不是走 LLM）', () => assert.strictEqual(bridgeCalls, 1));
  await t('桥接返回值原样透传（含 __terminalState）', () =>
    assert.strictEqual(resp.__terminalState, TASK_STATE.REJECTED));

  console.log('\n[W3] __terminalState 不能被盖成 COMPLETED');
  const taskRejected = await bridgeApi._sendMessage({
    message: {
      role: 'user',
      messageId: `m-${Date.now()}`,
      parts: [{ type: 'text', text: '委托探针' }],
      delegation: { type: 'notify', scope: 'read', target: 'x' },
    },
  });
  await t('终态保持 REJECTED', () =>
    assert.strictEqual(taskRejected.task.status.state, TASK_STATE.REJECTED));

  console.log('\n[W4] 自环调用必须快速拒绝');
  const fs = require('fs');
  const src = fs.readFileSync(path.join(REPO, 'a2a-standard-api-v5.js'), 'utf8');
  await t('两个入站入口（JSON-RPC + REST）都调了 _checkSelfMessage', () => {
    const hits = (src.match(/_checkSelfMessage\(/g) || []).length;
    // 1 处定义 + 2 处调用；少一处就说明有入口漏了守卫
    assert.ok(hits >= 3, `_checkSelfMessage 出现 ${hits} 次，应为 ≥3（定义+两入口）`);
  });

  const selfApi = mkApi();
  const selfParams = {
    sender: { name: '测试实例' },
    message: { role: 'user', messageId: `m-self-${Date.now()}`, parts: [{ type: 'text', text: '自己发给自己' }] },
  };
  const selfCheck = selfApi._checkSelfMessage(selfParams, { socket: { remoteAddress: '172.28.0.1' } });
  await t('名字是自己 → 判定为自环', () => assert.strictEqual(selfCheck.self, true));
  const selfRes = selfApi._buildSelfRejectedTask(selfParams, selfCheck);
  await t('自环 → REJECTED', () =>
    assert.strictEqual(selfRes.task.status.state, TASK_STATE.REJECTED));
  await t('拒绝文案 = SELF_MESSAGE_IGNORED', () =>
    assert.ok(JSON.stringify(selfRes.task).includes('SELF_MESSAGE_IGNORED')));

  console.log('\n─────────────────────────────────────────');
  console.log(`  通过 ${pass} / ${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
