#!/usr/bin/env node
/**
 * bid-hook.test.js — BID 信号钩子回归测试
 *
 * 上游化背景见 bid-hook.js 顶部注释。
 *
 * 锁死的不变量：
 *   I1 默认关闭：未设 A2A_BID_SIGNAL → 钩子完全不参与（attempted 保持 0）
 *   I2 开启后三类信号（promise/correction/decision）能正确抽取
 *   I3 非关系文本不产信号（不误报）
 *   I4 失败必须可查：UNAVAILABLE / DEGRADED 都要能从 stats() 读到，不许静默
 *   I5 钩子永不抛错（不能把记忆/回复链路带崩）
 *
 * 跑法：node --test tests/bid-hook.test.js
 *
 * 每个用例用独立子进程（模块级状态是进程内的，require 缓存会串味）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bid-hook.js');

/** 在子进程里跑一段脚本，返回其 stdout（JSON） */
function runInChild(env, script) {
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 20000,
  });
  if (r.status !== 0) throw new Error('子进程失败: ' + (r.stderr || '').slice(0, 400));
  return r.stdout.trim();
}

test('I1: 默认关闭 —— 不设 A2A_BID_SIGNAL 时完全不参与', () => {
  const out = runInChild(
    { A2A_BID_SIGNAL: '' },
    `const h=require('./bid-hook.js'); h.ensureReady();
     const s=h.stats();
     const r=h.onConversation({agentName:'X',message:'我答应你明天交付。'});
     console.log(JSON.stringify({status:s.status,attempted:h.stats().attempted,sig:r}));`
  );
  const j = JSON.parse(out);
  assert.strictEqual(j.status, 'DISABLED');
  assert.strictEqual(j.attempted, 0, '关闭状态下 attempted 必须为 0');
  assert.strictEqual(j.sig, null);
});

test('I2: promise 能被抽取', () => {
  const out = runInChild(
    { A2A_BID_SIGNAL: '1', A2A_AGENT_NAME: '若兰',
      A2A_BID_SIGNAL_LEDGER: path.join(__dirname, '..', '.tmp-bid-test-1.jsonl') },
    `const h=require('./bid-hook.js'); h.ensureReady();
     console.log(JSON.stringify(h.onConversation({agentName:'明德',message:'我答应你，明天把报告整理好发给你。'})));`
  );
  const sig = JSON.parse(out);
  assert.ok(sig, '应当抽出信号');
  assert.strictEqual(sig.kind, 'promise');
  assert.strictEqual(sig.peer, '明德');
});

test('I2: correction 能抽取且方向正确', () => {
  const ledger = path.join(__dirname, '..', '.tmp-bid-test-2.jsonl');
  const out = runInChild(
    { A2A_BID_SIGNAL: '1', A2A_AGENT_NAME: '若兰', A2A_BID_SIGNAL_LEDGER: ledger },
    `const h=require('./bid-hook.js'); h.ensureReady();
     const a=h.onConversation({agentName:'明德',message:'我错了，这里应该用 split 而不是 llm，我更正一下。'});
     const b=h.onConversation({agentName:'明德',message:'明德指出我方的方案有误，我们采纳了他的指正。'});
     console.log(JSON.stringify({a,b}));`
  );
  const j = JSON.parse(out);
  assert.strictEqual(j.a.kind, 'correction');
  assert.strictEqual(j.a.direction, 'out', '我方更正 → out');
  assert.strictEqual(j.b.kind, 'correction');
  assert.strictEqual(j.b.direction, 'in', '对方指出 → in');
});

test('I2: decision 能抽取', () => {
  const out = runInChild(
    { A2A_BID_SIGNAL: '1', A2A_AGENT_NAME: '若兰',
      A2A_BID_SIGNAL_LEDGER: path.join(__dirname, '..', '.tmp-bid-test-3.jsonl') },
    `const h=require('./bid-hook.js'); h.ensureReady();
     console.log(JSON.stringify(h.onConversation({agentName:'明德',message:'决定采用 5.1.1 版本推进。'})));`
  );
  const sig = JSON.parse(out);
  assert.strictEqual(sig.kind, 'decision');
});

test('I3: 非关系文本不产信号（不误报）', () => {
  const out = runInChild(
    { A2A_BID_SIGNAL: '1', A2A_AGENT_NAME: '若兰',
      A2A_BID_SIGNAL_LEDGER: path.join(__dirname, '..', '.tmp-bid-test-4.jsonl') },
    `const h=require('./bid-hook.js'); h.ensureReady();
     const a=h.onConversation({agentName:'明德',message:'今天杭州天气不错。'});
     const b=h.onConversation({agentName:'明德',message:'这次修了个 bug，原因是路径解析错了。'});
     const s=h.stats();
     console.log(JSON.stringify({a,b,skipped:s.skippedNoSignal,failures:s.failures}));`
  );
  const j = JSON.parse(out);
  assert.strictEqual(j.a, null);
  assert.strictEqual(j.b, null, '技术复盘有"错"字但无关系对象，不该收');
  assert.ok(j.skipped >= 2, '跳过要计数（这也是"工作正常"的证据）');
  assert.strictEqual(j.failures, 0);
});

test('I4: 抽取器不可用 → UNAVAILABLE，且原因可读', () => {
  const out = runInChild(
    { A2A_BID_SIGNAL: '1', A2A_BID_SIGNAL_PATH: '/nonexistent/bid-signal.js',
      A2A_BID_SIGNAL_LEDGER: path.join(__dirname, '..', '.tmp-bid-test-5.jsonl') },
    `const h=require('./bid-hook.js'); h.ensureReady();
     const s=h.stats(); const hl=h.health();
     console.log(JSON.stringify({status:s.status,reason:(s.reason||'').slice(0,200),ok:hl.ok,level:hl.level}));`
  );
  const j = JSON.parse(out);
  // 注：同目录还有自动发现的候选路径，若本机存在 csb-memory 则会解析成功。
  //     本断言只要求"若不可用则必须显式声明且 health.ok=false"。
  if (j.status === 'UNAVAILABLE') {
    assert.strictEqual(j.ok, false);
    assert.strictEqual(j.level, 'error');
    assert.ok(j.reason && j.reason.length > 0, 'UNAVAILABLE 必须带可读原因');
  } else {
    assert.strictEqual(j.status, 'OK', '要么明确不可用，要么明确可用，不许中间态');
  }
});

test('I5: 钩子永不抛错（畸形输入）', () => {
  const out = runInChild(
    { A2A_BID_SIGNAL: '1', A2A_AGENT_NAME: '若兰',
      A2A_BID_SIGNAL_LEDGER: path.join(__dirname, '..', '.tmp-bid-test-6.jsonl') },
    `const h=require('./bid-hook.js'); h.ensureReady();
     const inputs=[null,undefined,{}, {agentName:'X'}, {message:''}, {message:'   '}, {message:123}];
     let threw=null;
     for(const i of inputs){ try{ h.onConversation(i); }catch(e){ threw=e.message; } }
     console.log(JSON.stringify({threw, status:h.stats().status}));`
  );
  const j = JSON.parse(out);
  assert.strictEqual(j.threw, null, '畸形输入不得抛错');
});

test('I5: processConversation 接线后仍不因钩子失败而崩', () => {
  const out = runInChild(
    { A2A_BID_SIGNAL: '1', A2A_BID_SIGNAL_PATH: '/nonexistent/bid-signal.js',
      A2A_BID_SIGNAL_LEDGER: '/root/definitely-not-writable/x.jsonl' },
    `const m=require('./a2a-memory.js');
     // 直接调 processConversation（会走 shouldDistill → 可能跳过蒸馏，但钩子已先执行）
     m.processConversation('明德','我答应你明天交付。','好的。')
       .then(r=>console.log(JSON.stringify({ok:true,ret:r})))
       .catch(e=>console.log(JSON.stringify({ok:false,err:e.message})));`
  );
  // processConversation 自身会往 stdout 打日志（⏭️ 跳过蒸馏…），
  // 只取最后一个以 { 开头的行作为结果
  const line = out.split('\n').reverse().find(l => l.trim().startsWith('{'));
  assert.ok(line, '子进程未输出结果 JSON；原始输出: ' + out.slice(0, 300));
  const j = JSON.parse(line);
  assert.strictEqual(j.ok, true, 'processConversation 不得因钩子失败而 reject');
});
