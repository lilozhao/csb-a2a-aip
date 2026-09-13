#!/usr/bin/env node
/**
 * 入站可见性（Layer 1 收件箱 + Layer 2 主会话通知）单元测试
 * 风格：手写 assert + console（仓库惯例，无测试框架）
 * 用法: node tests/a2a-inbox.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 隔离收件箱路径，避免污染真实 data/
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-inbox-test-'));
process.env.A2A_INBOX_PATH = path.join(TMP, 'a2a-inbox.jsonl');

const inbox = require('../a2a-inbox.js');
const { makeChatNotifyHandler } = require('../a2a-chat-notify.js');
const { A2AStandardAPI } = require('../a2a-standard-api-v5.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function run() {
  console.log('================================');
  console.log('A2A Inbox / Chat-Notify 单测');
  console.log('================================');

  // ── [1] Layer 1：收件箱基本读写 ──
  console.log('\n[1] 收件箱（Layer 1）');
  inbox.record({ taskId: 't1', msg: { messageId: 'm1', parts: [{ type: 'text', text: '你好 若兰' }] }, metadata: { sender: { name: 'peer', url: 'http://p:1' } } });
  inbox.record({ taskId: 't2', msg: { messageId: 'm2', parts: [{ type: 'text', text: '委托' }], delegation: { scope: 'read', type: 'execute' } }, metadata: { sender: { name: 'peer2' } } });
  const all = inbox.read({ limit: 0 });
  ok('记录 2 条', all.length === 2, `实际 ${all.length}`);
  ok('聊天类 kind=chat', all[0].kind === 'chat');
  ok('委托类 kind=delegation + scope', all[1].kind === 'delegation' && all[1].scope === 'read');
  ok('默认 seen=false', all.every((e) => e.seen === false));
  ok('unreadOnly 全未读=2', inbox.read({ unreadOnly: true }).length === 2);
  const n = inbox.markSeen(['t1']);
  ok('markSeen 命中 1 条', n === 1, `实际 ${n}`);
  ok('未读剩 1 条', inbox.read({ unreadOnly: true }).length === 1);
  ok('stats.unread=1', inbox.stats().unread === 1);
  ok('fail-safe：坏入参不抛', inbox.record() === true || inbox.record() === false);

  // ── [2] Layer 2：通知护栏 ──
  console.log('\n[2] 通知护栏（Layer 2 · makeChatNotifyHandler）');
  const mk = (envObj, mainTo = 'ou_test') => {
    const calls = [];
    const inject = async (frame, opts) => { calls.push({ frame, opts }); return { ok: true }; };
    const h = makeChatNotifyHandler({
      identity: { name: '测试主体', bridge: mainTo ? { mainTo } : {} },
      inject, logger: { log() {}, warn() {} }, env: envObj,
    });
    return { h, calls };
  };
  const CHAT = { messageId: 'c1', parts: [{ type: 'text', text: 'hi' }] };
  const MD = { sender: { name: 'peer', url: 'http://p:1' } };

  let r = mk({}); // 默认关
  await r.h('t', CHAT, MD);
  ok('默认关 → 不注入', r.calls.length === 0);

  r = mk({ A2A_NOTIFY_CHAT: 'true' }, ''); // 无 mainTo
  await r.h('t', CHAT, MD);
  ok('开但无主会话目标 → 不注入', r.calls.length === 0);

  r = mk({ A2A_NOTIFY_CHAT: 'true' });
  await r.h('t', CHAT, MD);
  ok('开+有目标 → 注入 1 次', r.calls.length === 1, `实际 ${r.calls.length}`);
  ok('信封 scope=notify', r.calls[0] && r.calls[0].frame.envelope.scope === 'notify');
  ok('注入目标=mainTo', r.calls[0] && r.calls[0].opts.to === 'ou_test');

  await r.h('t', CHAT, MD); // 同 messageId
  ok('去重：重复 messageId 不注入', r.calls.length === 1);

  r = mk({ A2A_NOTIFY_CHAT: 'true' });
  await r.h('t', { messageId: 'cmd', parts: [{ type: 'text', text: 'CMD: status' }] }, MD);
  ok('跳过 CMD: 前缀', r.calls.length === 0);

  r = mk({ A2A_NOTIFY_CHAT: 'true' });
  await r.h('t', { messageId: 'self', parts: [{ type: 'text', text: 'hi' }] }, { sender: { name: '测试主体' } });
  ok('自环跳过', r.calls.length === 0);

  r = mk({ A2A_NOTIFY_CHAT: 'true', A2A_NOTIFY_CHAT_MAX_PER_MIN: '2' });
  for (let i = 0; i < 4; i++) await r.h('t' + i, { messageId: 'rl' + i, parts: [{ type: 'text', text: 'x' }] }, MD);
  ok('限流：2/min → 只注入 2 次', r.calls.length === 2, `实际 ${r.calls.length}`);

  const hThrow = makeChatNotifyHandler({
    identity: { name: '测试主体', bridge: { mainTo: 'ou' } },
    inject: async () => { throw new Error('boom'); },
    logger: { log() {}, warn() {} }, env: { A2A_NOTIFY_CHAT: 'true' },
  });
  const rt = await hThrow('t', { messageId: 'throw1', parts: [{ type: 'text', text: 'x' }] }, MD);
  ok('inject 抛错不反噬（返回 null）', rt === null);

  // ── [3] 与标准 API 接线（_processTask）──
  console.log('\n[3] 接线：_processTask 触发收件箱 + 通知');
  const calls3 = [];
  const api = new A2AStandardAPI({
    identity: { name: '测试主体' },
    taskStore: { getTask: () => ({ history: [] }) },
    inbox,
    chatNotifyHandler: async (taskId, msg, metadata) => { calls3.push({ taskId, kind: (msg.delegation ? 'delegation' : 'chat') }); },
    selfGuardConfig: { enabled: false },
  });
  api._callLLM = async () => ''; // 短路，避免网络与记忆写入

  const before = inbox.read({ limit: 0 }).length;
  await api._processTask('tp1', { messageId: 'p1', parts: [{ type: 'text', text: '普通聊天' }] }, { sender: { name: 'x' } });
  const afterChat = inbox.read({ limit: 0 });
  ok('聊天消息写入收件箱', afterChat.length === before + 1 && afterChat[afterChat.length - 1].kind === 'chat');
  ok('聊天消息触发主会话通知', calls3.length === 1 && calls3[0].kind === 'chat');

  await api._processTask('tp2', { messageId: 'p2', parts: [{ type: 'text', text: '委托' }], delegation: { scope: 'read', type: 'execute' } }, { sender: { name: 'y' } });
  const afterDel = inbox.read({ limit: 0 });
  ok('委托消息也写入收件箱', afterDel[afterDel.length - 1].kind === 'delegation');
  ok('委托消息不触发聊天通知', calls3.length === 1, `实际 ${calls3.length}`);

  console.log('\n[3b] fire-and-forget：慢通知不得阻塞 A2A 响应');
  const slowApi = new A2AStandardAPI({
    identity: { name: '测试主体' },
    taskStore: { getTask: () => ({ history: [] }) },
    inbox,
    chatNotifyHandler: () => new Promise(() => {}), // 永不 resolve（模拟主会话忙/挂起）
    selfGuardConfig: { enabled: false },
  });
  slowApi._callLLM = async () => '';
  const t0 = Date.now();
  await slowApi._processTask('tpslow', { messageId: 'pslow', parts: [{ type: 'text', text: 'x' }] }, { sender: { name: 'x' } });
  const dt = Date.now() - t0;
  ok('慢通知不阻塞响应（<1s）', dt < 1000, `实际 ${dt}ms`);

  console.log('\n================================');
  console.log(`通过 ${pass} / ${pass + fail}`);
  console.log('================================');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error('❌ 测试异常:', e); process.exit(1); });
