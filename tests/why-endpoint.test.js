#!/usr/bin/env node
/**
 * why-endpoint.test.js —— §2.2 追问通道单测（node --test）
 * 运行: node --test tests/why-endpoint.test.js
 *
 * 重点（和 warm-reject.test.js 同款口径）：每条正例都必须配一条**会红的反例**。
 * 这个端点最容易骗人的地方是「开好了但查谁都是 404」——
 * 所以测试里必须有一条真的造出审计行、再查回来的 E2E；
 * 只测「404 分支」等于没测。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const W = require(path.join(REPO, 'warm-reject.js'));
const { buildWhy, ID_RE, registerWhyEndpoint } = require(path.join(REPO, 'why-endpoint.js'));

let seq = 0;
const tmpFile = () => path.join(os.tmpdir(), `why-${process.pid}-${seq++}.jsonl`);

/** 造一条真实审计（走 warm-reject 真出口，不手写 JSON —— 手写会掩盖整形 bug） */
function seed(file, extra = {}) {
  return W.warmReject({
    code: W.CODES.SCOPE_VIOLATION,
    reason: '命中 BR-04：命令匹配高危正则（rm -rf）',
    next_step: '拆成单条可核命令重试',
    agent: 'probe-agent',
    action: 'shell.exec',
    auditFile: file,
    context: {
      ruleId: 'BR-04', tier: 'L3', decision: 'deny', warnings: [],
      matchedRules: ['BR-04'],
      decision_chain: [
        { rule: 'BR-03', value: null, result: 'no_match' },
        { rule: 'BR-04', value: 'rm -rf /tmp/x', result: 'matched' },
      ],
      ...extra,
    },
  });
}

// ── ① 正例：真造一条 → 能查回来，且链是结构化的 ──────────
test('正例：审计号能查回，decision_chain 是对象数组而非字符串', () => {
  const f = tmpFile();
  const created = seed(f);
  const hit = W.findAudit(created.audit_id, { file: f });
  const { http, body } = buildWhy(created.audit_id, hit);

  assert.strictEqual(http, 200);
  assert.strictEqual(body.decision_id, created.audit_id);
  assert.ok(Array.isArray(body.decision_chain), '链必须是数组（被压成字符串就是这次要修的 bug）');
  assert.strictEqual(body.decision_chain.length, 2);
  assert.deepStrictEqual(body.decision_chain[1],
    { rule: 'BR-04', value: 'rm -rf /tmp/x', result: 'matched' });
  assert.strictEqual(body.chain_source, 'snapshot_at_decision_time');
});

// ── ② 反例：链里塞了自由文本充当判据 → 必须被挑出来，不许静默通过 ──
test('反例：链里出现自由文本步骤 → 进 malformed_steps，不进 decision_chain', () => {
  const f = tmpFile();
  const created = W.warmReject({
    code: W.CODES.SCOPE_VIOLATION,
    reason: '命中 BR-02：受保护文件需确认',
    next_step: '经一澜确认后用 protect-write 写入',
    auditFile: f,
    context: {
      decision_chain: [
        { rule: 'BR-02', value: 'SOUL.md', result: 'matched' },
        { rule: 'BR-02', recommendation: '建议不要写', why: '因为这是灵魂文件' }, // 自由文本冒充判据
      ],
    },
  });
  const { http, body } = buildWhy(created.audit_id, W.findAudit(created.audit_id, { file: f }));
  assert.strictEqual(http, 200);
  assert.strictEqual(body.decision_chain.length, 1);
  assert.strictEqual(body.malformed_count, 1);
  assert.ok(body.malformed_steps[0].recommendation, '应原样列出，便于发现「有人把解释当判据」');
});

// ── ③ 反例：查不到 → 必须说清「哪种查不到」 ──────────────
test('反例：文件不存在 → 503 且明说这是部署问题，不是对方查错', () => {
  const f = path.join(os.tmpdir(), `definitely-missing-${process.pid}-${Date.now()}.jsonl`);
  const { http, body } = buildWhy('reject_1793787965061_8ae2d6', W.findAudit('x', { file: f }));
  assert.strictEqual(http, 503);
  assert.strictEqual(body.error, 'audit_log_missing');
  assert.match(body.reason, /不是你查错了/);
  assert.ok(body.next_step.length > 6);
});

test('反例：日志存在但没这条 → 404，并给出「扩窗重试」这条可执行下一步', () => {
  const f = tmpFile();
  seed(f);
  const { http, body } = buildWhy('reject_1_abcdef', W.findAudit('reject_1_abcdef', { file: f }));
  assert.strictEqual(http, 404);
  assert.strictEqual(body.error, 'decision_not_found');
  assert.strictEqual(body.scanned, 1);
  assert.ok(body.next_step.length > 6);
});

test('反例：窗口被截断时 → 提示扩窗，而不是断言「从未签发」', () => {
  const f = tmpFile();
  for (let i = 0; i < 5; i++) seed(f);
  const hit = W.findAudit('reject_1_abcdef', { file: f, maxLines: 2 });
  const { http, body } = buildWhy('reject_1_abcdef', hit);
  assert.strictEqual(http, 404);
  assert.strictEqual(body.truncated, true);
  assert.match(body.next_step, /window=/);
});

// ── ④ 反例：形状非法 → 400（先判形状再扫盘，不拿任意串去扫日志）──
test('反例：审计号形状非法 → 400，不去扫日志', () => {
  for (const bad of ['', 'a b', 'x'.repeat(200), '../../etc/passwd']) {
    const { http, body } = buildWhy(bad, { found: false, scanned: 0, truncated: false });
    assert.strictEqual(http, 400, `「${bad}」应判非法`);
    assert.strictEqual(body.error, 'invalid_decision_id');
  }
});

test('ID_RE 正例：合法审计号通过', () => {
  assert.ok(ID_RE.test('reject_1793787965061_8ae2d6'));
  assert.ok(ID_RE.test('reject_1_abcdef'));
});

// ── ⑤ 旧记录（K-1 之前，没有 next_step）→ 标 legacy，不假装合格 ──
test('旧记录缺 next_step → legacy:true（不假装当时就合格）', () => {
  const f = tmpFile();
  const id = 'reject_1793787000000_aaaaaa';
  fs.writeFileSync(f, JSON.stringify({
    ts: new Date().toISOString(), event: 'warm_reject', audit_id: id,
    code: 'scope_violation', reason: '老格式只有 reason', status: 'denied',
    agent: 'old', action: 'x', context: { ruleId: 'BR-02', tier: 'L3', decision: 'deny' },
  }) + '\n');
  const { body } = buildWhy(id, W.findAudit(id, { file: f }));
  assert.strictEqual(body.legacy, true);
  assert.strictEqual(body.next_step, null);
});

// ── ⑥ 端到端：真挂到 express 路由上跑一次（不 mock buildWhy）──
test('E2E：注册到 app 后 GET /v1/why/:id 真能取回（不靠 mock）', async () => {
  const f = tmpFile();
  const created = seed(f);

  const express = require(path.join(REPO, 'node_modules', 'express'));
  const app = express();
  let authCalls = 0;
  registerWhyEndpoint(app, { auditFile: f, checkAuth: () => { authCalls++; return true; } });

  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = server.address().port;
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/v1/why/${created.audit_id}`);
    assert.strictEqual(ok.status, 200);
    const j = await ok.json();
    assert.strictEqual(j.decision_id, created.audit_id);
    assert.ok(j.decision_chain.some((s) => s.rule === 'BR-04' && s.result === 'matched'));

    const miss = await fetch(`http://127.0.0.1:${port}/v1/why/reject_1_abcdef`);
    assert.strictEqual(miss.status, 404);
    assert.strictEqual((await miss.json()).error, 'decision_not_found');
    assert.strictEqual(authCalls, 2, '鉴权钩子必须每请求都走（不能只走一次）');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('E2E 反例：鉴权钩子返回 false → 401 且带 next_step', async () => {
  const express = require(path.join(REPO, 'node_modules', 'express'));
  const app = express();
  // 401 分支也会造温暖拒绝 → 审计落点必须指向临时文件，
  // 否则单测会往**生产**审计日志里写（2026-11-04 早上 ef68c5d 的同族错误，今天复现了一次）
  const f401 = tmpFile();
  registerWhyEndpoint(app, { auditFile: f401, checkAuth: () => false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/why/reject_1_abcdef`);
    assert.strictEqual(r.status, 401);
    const j = await r.json();
    assert.ok(j.next_step.length > 6, "401 也必须带 next_step —— 否则这个端点自己就违反了 K-1");
    assert.strictEqual(j._warm, true, "401 必须走 K-1 唯一出口（自拼字段是最隐蔽的不一致）");
    // 反证：这条 401 的审计必须落在本测试指定的临时文件里，不是生产日志
    assert.ok(W.findAudit(j.audit_id, { file: f401 }).found, "401 的审计必须落在调用方指定的文件");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
// ── ⑦ 接线存在性：端点必须真被 server_v5 加载（ac94694 同类事故的护栏）──
test('接线：server_v5.js 必须 require 并注册 why-endpoint（否则端点写了也不在服务路径上）', () => {
  const src = fs.readFileSync(path.join(REPO, 'server_v5.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/why-endpoint\.js['"]\)/, 'server_v5 必须 require why-endpoint');
  // 反例护栏：仅仅 require 不注册 = 死代码；调用点被注释掉也必须能被看出来
  const callLines = src.split('\n').filter((l) => /registerWhyEndpoint\(app/.test(l) && !l.trim().startsWith('//'));
  assert.strictEqual(callLines.length, 1, 'registerWhyEndpoint(app) 调用点应恰好一处且未被注释');
});
