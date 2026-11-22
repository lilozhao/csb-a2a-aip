#!/usr/bin/env node
/**
 * tests/handshake-token.test.js —— 握手端点：令牌签发 / 回传 / 核对
 *
 * 背景（2026-11-21 · 澄复审 P1-1 + B 批）：
 *   1. createHandshakeRouter 的解构里没有 options，但 complete 分支用 options.onSession
 *      → ReferenceError → complete 恒 400 → trust-bridge 会话表恒空。
 *      「配置了握手信任，实际从未生效」= 信任假绿。
 *   2. 即便修好，trust-bridge 原先是靠 sender.url 的 host 锚定，
 *      而 host 是自述字段 → 谁都能顶替刚握过手的邻居。
 *      故本轮把协议里本来就有的 access_token 补成「签发→回传→核对」闭环。
 *
 * 本测试覆盖：
 *   A. L1（proof 即成立）：签发令牌并回调 onSession
 *   B. L2+（complete 往返）：令牌不符 → 401；令牌正确 → 回调 onSession
 *   C. complete 时带不存在的会话 → 400
 *
 * 用法: node tests/handshake-token.test.js
 */
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const { createHandshakeRouter } = require('../security-handshake.js');

let passed = 0, failed = 0;
const results = [];

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
  results.push({ name, ok: true });
}

/** 起一个临时 express app，返回 { url, close } */
function serve(router) {
  const app = express();
  app.use(express.json());
  app.use('/a2a/handshake', router);
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({ url: `http://127.0.0.1:${port}/a2a/handshake`, close: () => srv.close() });
    });
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, text: d });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const CALLEE = { agent_id: 'ruolan@172.28.0.214:3100' };
const CALLER = 'mingde@csbc.lilozkzy.top:3100';

/** 假 handshakeManager：L1 在 proof 即返回 session；L2 返回 complete 消息 */
function mkManager(level) {
  return {
    processInit: () => ({ type: 'handshake_challenge', level, nonce_b: 'n1' }),
    processProof: () => level <= 1
      ? {
          approved: true,
          session: {
            session_id: 'sess-l1', caller_id: CALLER, callee_id: CALLEE.agent_id,
            scopes_granted: ['a2a:send'], security_level: 1, ttl: 300,
          },
        }
      : {
          approved: true,
          complete: {
            type: 'handshake_complete', session_id: 'sess-l2',
            access_token: 'issued-l2-token', level,
          },
        },
    processComplete: () => ({
      session: {
        session_id: 'sess-l2', caller_id: CALLER, callee_id: CALLEE.agent_id,
        scopes_granted: ['a2a:send'], security_level: 2, ttl: 3600,
      },
    }),
  };
}

(async () => {
  console.log('=== 握手令牌测试 ===\n');

  await test('A. L1：proof 即成立 → 签发 session_token 并回调 onSession', async () => {
    const seen = [];
    const router = createHandshakeRouter({
      handshakeManager: mkManager(1),
      calleeAID: CALLEE,
      calleePrivateKey: null,
      onSession: (s) => seen.push(s),   // ★ 这就是此前 ReferenceError 的那个回调
    });
    const s = await serve(router);
    try {
      const init = await post(s.url, { action: 'init', message: { caller_id: CALLER, level: 1 } });
      assert.strictEqual(init.status, 200, 'init 应 200');
      const r = await post(s.url, { action: 'proof', message: { caller_id: CALLER } });
      assert.strictEqual(r.status, 200);
      const tok = r.json?.message?.session_token;
      assert.ok(typeof tok === 'string' && tok.length >= 32, 'L1 必须签发 session_token');
      assert.strictEqual(seen.length, 1, 'onSession 必须被调用（曾是 ReferenceError）');
      assert.strictEqual(seen[0].access_token, tok, '回调里必须带上同一枚令牌');
      assert.strictEqual(seen[0].security_level, 1);
    } finally { s.close(); }
  });

  await test('B1. L2：complete 传错 access_token → 401，且不回调 onSession', async () => {
    const seen = [];
    const router = createHandshakeRouter({
      handshakeManager: mkManager(2),
      calleeAID: CALLEE,
      calleePrivateKey: null,
      onSession: (s) => seen.push(s),
    });
    const s = await serve(router);
    try {
      await post(s.url, { action: 'init', message: { caller_id: CALLER, level: 2 } });
      const proof = await post(s.url, { action: 'proof', message: { caller_id: CALLER } });
      assert.strictEqual(proof.json?.message?.complete?.access_token, 'issued-l2-token');
      const bad = await post(s.url, {
        action: 'complete',
        approval_msg: { session_id: 'sess-l2' },
        message: { type: 'handshake_complete', session_id: 'sess-l2', access_token: 'forged' },
      });
      assert.strictEqual(bad.status, 401, `伪造令牌必须 401，实际 ${bad.status}`);
      assert.strictEqual(bad.json?.error, 'session_token_mismatch');
      assert.strictEqual(seen.length, 0, '验票失败不得注册会话');
    } finally { s.close(); }
  });

  await test('B2. L2：complete 回传正确令牌 → 200 并回调 onSession', async () => {
    const seen = [];
    const router = createHandshakeRouter({
      handshakeManager: mkManager(2),
      calleeAID: CALLEE,
      calleePrivateKey: null,
      onSession: (s) => seen.push(s),
    });
    const s = await serve(router);
    try {
      await post(s.url, { action: 'init', message: { caller_id: CALLER, level: 2 } });
      await post(s.url, { action: 'proof', message: { caller_id: CALLER } });
      const ok = await post(s.url, {
        action: 'complete',
        approval_msg: { session_id: 'sess-l2' },
        message: { type: 'handshake_complete', session_id: 'sess-l2', access_token: 'issued-l2-token' },
      });
      assert.strictEqual(ok.status, 200, ok.text);
      assert.strictEqual(seen.length, 1, '成功后必须注册会话');
      assert.strictEqual(seen[0].access_token, 'issued-l2-token');
    } finally { s.close(); }
  });

  await test('C. complete 一个从未 init 的会话 → 400 session_token_unknown', async () => {
    const router = createHandshakeRouter({
      handshakeManager: mkManager(2), calleeAID: CALLEE, calleePrivateKey: null, onSession: () => {},
    });
    const s = await serve(router);
    try {
      const r = await post(s.url, {
        action: 'complete',
        approval_msg: { session_id: 'nope' },
        message: { type: 'handshake_complete', session_id: 'nope', access_token: 'x' },
      });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json?.error, 'session_token_unknown');
    } finally { s.close(); }
  });

  await test('D. /status 只回条数，不回 caller_id 列表（避免无鉴权泄露谁在握手）', async () => {
    const router = createHandshakeRouter({
      handshakeManager: mkManager(1), calleeAID: CALLEE, calleePrivateKey: null,
    });
    const s = await serve(router);
    try {
      await post(s.url, { action: 'init', message: { caller_id: CALLER, level: 1 } });
      const r = await new Promise((resolve, reject) => {
        http.get(`${s.url}/status`, (res) => {
          let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
      });
      assert.strictEqual(typeof r.pendingHandshakes, 'number', '必须只回条数');
      assert.ok(!Array.isArray(r.pendingHandshakes), '不得再回 id 数组');
    } finally { s.close(); }
  });

  console.log(`\n通过: ${passed}\n失败: ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
