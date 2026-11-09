#!/usr/bin/env node
/**
 * introspect-auth.test.js —— /a2a/introspect 鉴权拒绝的单测（node --test）
 * 运行: node --test tests/introspect-auth.test.js
 *
 * 缘起（2026-11-09）：
 *   W-51 事故修复给 introspect 加了鉴权，但拒绝是**就地手拼**的
 *   `{error, reason, next_step}`，没走 K-1 的温暖拒绝唯一出口。
 *   守门自检（scripts/warm-reject-selfcheck.js）把它当漏点报了出来 —— 这就是它该干的事。
 *
 * 为什么这个测试必须存在：
 *   「五字段齐全」很容易做到（手拼也能凑齐），
 *   真正难守住的是「**以后改代码时别把它改回手拼**」。
 *   所以这里盯的不是字段，是**出口**：`status:'denied'` + `_warm:true` +
 *   audit_id 能被 findAudit 查回来 —— 手拼的形状凑不出这三样。
 *
 * 口径与 why-endpoint.test.js 同款：每条正例配一条**会红的反例**。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const W = require(path.join(REPO, 'warm-reject.js'));
const { attachIntrospect } = require(path.join(REPO, 'a2a-introspect-middleware.js'));

let seq = 0;
const tmpFile = () => path.join(os.tmpdir(), `introspect-${process.pid}-${seq++}.jsonl`);

/** 起一个真 express 实例，挂上 introspect（不 mock 路由本身） */
async function mountIntrospect(opts = {}) {
  const express = require(path.join(REPO, 'node_modules', 'express'));
  const app = express();
  attachIntrospect(app, Object.assign({ workspace: REPO }, opts));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, port: server.address().port };
}

// ── ① 正例：鉴权不过 → 走温暖拒绝唯一出口 ─────────────────
test('正例：鉴权不过 → 401 且是合格温暖拒绝（_warm + audit_id 可回查）', async () => {
  const f = tmpFile();
  const { server, port } = await mountIntrospect({ checkAuth: () => false, auditFile: f });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/a2a/introspect`);
    assert.strictEqual(r.status, 401);

    const j = await r.json();
    // 契约五字段：status/code/reason/next_step/audit_id
    assert.strictEqual(j.status, 'denied', '必须带 status:denied —— 这是 K-1 的形状标记');
    assert.strictEqual(j.code, W.CODES.AUTH_REQUIRED, '鉴权拒绝的 code 必须是 auth_required');
    assert.ok(j.reason && j.reason.length >= 8, 'reason 不能缺、不能太短');
    assert.ok(j.next_step && j.next_step.length >= 6, 'next_step 不能缺、不能太短');
    assert.ok(j.audit_id, '必须带 audit_id —— 「可追溯」的前提');
    assert.strictEqual(j._warm, true, '必须标记 _warm:true（自拼字段凑不出这个标记）');

    // 出口判据：审计落点可回查 —— 手拼的形状不会有这条记录
    const hit = W.findAudit(j.audit_id, { file: f });
    assert.ok(hit.found, '401 的审计必须落在调用方指定的文件（单测不写生产日志）');
    assert.strictEqual(hit.entry.code, W.CODES.AUTH_REQUIRED);
    assert.strictEqual(hit.entry.event, 'warm_reject', '必须是 warm_reject 事件，不是别的通道写的');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ── ② 反例：手拼形状必须能被识别出来（防「以后改回手拼」）──
test('反例：手拼的 {error,reason,next_step} 不算温暖拒绝（守卫拦得住）', () => {
  const fake = { error: 'auth_required', reason: 'x'.repeat(20), next_step: 'y'.repeat(20) };
  assert.notStrictEqual(fake.status, 'denied', '手拼形状没有 status:denied');
  assert.notStrictEqual(fake._warm, true, '手拼形状没有 _warm:true');
  assert.ok(!fake.audit_id, '手拼形状没有 audit_id');
  // 真正的出口至少要满足这两条才叫「温暖拒绝」
  const check = W.check({
    code: W.CODES.AUTH_REQUIRED,
    reason: 'introspect 与 /tasks 同口径：一律需 Bearer 令牌（2026-11-09 起取消内网豁免），本请求未携带有效令牌（401）',
    next_step: '在请求头加 Authorization: Bearer <A2A_TASKS_TOKEN>（向本实例主人私下索取）后重试',
  });
  assert.strictEqual(check.ok, true, '真实出口用的那组文案必须过契约校验');
});

// ── ③ 契约自测：理由/next_step 被改坏时必须抛（防「模块被改宽松」）──
test('反例：把 reason 改回「内网免令牌」这种旧误导文案 → 契约必须判不合格', () => {
  // 这条不是测文案，是测**判据**：旧文案与实现不符（11-09 已取消内网豁免），
  // 所以下一句必须让人能自己补齐，而不是只说「不行」。
  const check = W.check({
    code: W.CODES.AUTH_REQUIRED,
    reason: 'introspect 内网免令牌',            // 短 + 无可核对事实 → 必须不合格
    next_step: '不行',
  });
  assert.strictEqual(check.ok, false);
  assert.ok(check.problems.some((p) => /reason/.test(p)), '必须指出 reason 的问题');
  assert.ok(check.problems.some((p) => /next_step/.test(p)), '必须指出 next_step 的问题');
});

// ── ④ 接线存在性：端点必须真被 server_v5 加载并挂鉴权 ────────
test('接线：server_v5.js 必须 require 并注册 introspect，且必须注入 checkAuth', () => {
  const src = fs.readFileSync(path.join(REPO, 'server_v5.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/a2a-introspect-middleware\.js['"]\)/, 'server_v5 必须 require introspect 中间件');
  const callLines = src.split('\n').filter((l) => /attachIntrospect\(app/.test(l) && !l.trim().startsWith('//'));
  assert.strictEqual(callLines.length, 1, 'attachIntrospect(app) 调用点应恰好一处且未被注释');
  // 反例护栏：注册了但不注入鉴权 = 回到 W-51 事故前的状态（无鉴权可读）
  const block = src.slice(src.indexOf('attachIntrospect(app'));
  assert.match(block.slice(0, 400), /checkAuth/, 'attachIntrospect 必须注入 checkAuth，否则等于没鉴权');
});

// ── ⑤ 鉴权通过时不得走拒绝通道 ──────────────────────────────
test('正例：鉴权通过 → 200 且不产生任何拒绝审计', async () => {
  const f = tmpFile();
  const { server, port } = await mountIntrospect({ checkAuth: () => true, auditFile: f });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/a2a/introspect`);
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.notStrictEqual(j.status, 'denied', '200 响应不该是拒绝形状');
    // 审计文件里不该有拒绝记录
    const raw = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    assert.ok(!raw.includes('warm_reject'), '鉴权通过时不该写拒绝审计');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
