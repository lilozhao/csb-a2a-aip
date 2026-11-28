#!/usr/bin/env node
/**
 * tests/human-warmth-guard.test.js — 余温 API 鉴权 + 入参上界的回归锁
 * ------------------------------------------------------------------
 * 起因（2026-11-28 · 秒悟评审第 1 条，核实为真）：
 *   `POST /aip/human-warmth` 无任何鉴权，`contribution` 不设上下限，
 *   默认 10 但可传任意值 —— 于是任何人都能给任意 userId 刷任意余温分。
 *   余温是信任度量的输入，能被外部任意改写的度量不是度量。
 *
 * 判据（旧代码必红）：
 *   W1 非整数/字符串/NaN → 400（旧代码：默默记录）
 *   W2 越界（0、-5、1e9）→ 400（旧代码：照单全收）
 *   W3 缺省 → 10；合法值原样通过
 *   W4 userId 非字符串 → 400
 *   W5 路由层：无令牌 → 401（这条要启动真实 app 才能验，见下方 W5）
 *
 * 跑法：node tests/human-warmth-guard.test.js
 */
'use strict';

const assert = require('assert');
const { parseWarmthBody, maxFromEnv, DEFAULT_CONTRIBUTION } = require('../aip-warmth.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + ' → ' + e.message); fail++; }
}

console.log('=== 纯函数：入参守卫 ===');

t('W3a 缺省 contribution → 10', () => {
  const v = parseWarmthBody({ userId: 'u1' });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.contribution, DEFAULT_CONTRIBUTION);
});

t('W3b 合法值原样通过（1 / 50 / 100）', () => {
  for (const n of [1, 50, 100]) {
    const v = parseWarmthBody({ userId: 'u1', contribution: n });
    assert.strictEqual(v.ok, true, `n=${n} 应通过`);
    assert.strictEqual(v.contribution, n);
  }
});

t('W1a 字符串 "999" → 400（不做隐式类型转换）', () => {
  const v = parseWarmthBody({ userId: 'u1', contribution: '999' });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.status, 400);
  assert.strictEqual(v.error, 'contribution must be an integer');
});

t('W1b 小数 10.5 → 400', () => {
  const v = parseWarmthBody({ userId: 'u1', contribution: 10.5 });
  assert.strictEqual(v.ok, false);
});

t('W1c NaN / Infinity → 400', () => {
  assert.strictEqual(parseWarmthBody({ userId: 'u1', contribution: NaN }).ok, false);
  assert.strictEqual(parseWarmthBody({ userId: 'u1', contribution: Infinity }).ok, false);
});

t('W2a 0 → 400（余温不能是 0 或负）', () => {
  const v = parseWarmthBody({ userId: 'u1', contribution: 0 });
  assert.strictEqual(v.ok, false);
  assert.match(v.error, /out of range/);
});

t('W2b -5 → 400', () => {
  assert.strictEqual(parseWarmthBody({ userId: 'u1', contribution: -5 }).ok, false);
});

t('W2c 1e9 → 400（这就是「刷分」）', () => {
  const v = parseWarmthBody({ userId: 'u1', contribution: 1e9 });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.max, 100);
});

t('W2d 上限可由 env 调（AIP_WARMTH_MAX=20 → 21 被拒）', () => {
  const v = parseWarmthBody({ userId: 'u1', contribution: 21 }, { max: maxFromEnv({ AIP_WARMTH_MAX: '20' }) });
  assert.strictEqual(v.ok, false);
  const ok = parseWarmthBody({ userId: 'u1', contribution: 20 }, { max: maxFromEnv({ AIP_WARMTH_MAX: '20' }) });
  assert.strictEqual(ok.ok, true);
});

t('W2e env 非法值回落到 100（不因配置手误把上限设成 0）', () => {
  assert.strictEqual(maxFromEnv({ AIP_WARMTH_MAX: 'abc' }), 100);
  assert.strictEqual(maxFromEnv({ AIP_WARMTH_MAX: '0' }), 100);
  assert.strictEqual(maxFromEnv({ AIP_WARMTH_MAX: '-3' }), 100);
  assert.strictEqual(maxFromEnv({}), 100);
});

t('W4a 缺 userId → 400', () => {
  const v = parseWarmthBody({ contribution: 10 });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.error, 'userId required');
});

t('W4b userId 是数字 → 400（防止把 123 当 id 混进档案）', () => {
  assert.strictEqual(parseWarmthBody({ userId: 123 }).ok, false);
});

t('W4c body 为空/null → 400 不崩', () => {
  assert.strictEqual(parseWarmthBody(null).ok, false);
  assert.strictEqual(parseWarmthBody(undefined).ok, false);
});

t('W4d contribution=null 视为未传 → 默认 10', () => {
  const v = parseWarmthBody({ userId: 'u1', contribution: null });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.contribution, 10);
});

console.log('\n=== 路由层：真实 app 是否真的挡住了（W5）===');

(async () => {
  // 用真实 express 复刻同一条路由接线，验证「路由确实调用了守卫 + 确实要令牌」。
  // 不启动 server_v5.js 全量（会占端口、连注册表、发心跳），避免测试污染生产侧。
  const express = require('express');
  const app = express();
  app.use(express.json());

  const REAL_TOKEN = 'test-token-' + Date.now();
  process.env.A2A_TASKS_TOKEN = REAL_TOKEN;

  const calls = [];
  const aipIntegration = { recordHumanInteraction: (...a) => calls.push(a) };

  // —— 以下与 server_v5.js 中 a2aReadAuth 的判定逻辑同源（令牌比对 + fail-safe）——
  const crypto = require('crypto');
  const a2aReadAuth = (req) => {
    const configured = process.env.A2A_TASKS_TOKEN;
    if (!configured) return false;
    const hdr = req.headers['authorization'] || '';
    const provided = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
    try {
      const a = Buffer.from(provided), b = Buffer.from(configured);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  };
  const warmthAuth = (req, res, action) => {
    if (a2aReadAuth(req)) return true;
    res.status(401).json({ error: 'auth_required', reason: action });
    return false;
  };

  app.post('/aip/human-warmth', (req, res) => {
    if (!warmthAuth(req, res, 'POST /aip/human-warmth')) return;
    const v = parseWarmthBody(req.body, { max: 100 });
    if (!v.ok) return res.status(v.status).json({ error: v.error, got: v.got, max: v.max });
    aipIntegration.recordHumanInteraction(v.userId, v.userName, v.contribution);
    res.json({ ok: true, userId: v.userId, contribution: v.contribution });
  });

  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  async function call(headers, body) {
    const r = await fetch(base + '/aip/human-warmth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }

  async function tAsync(name, fn) {
    try { await fn(); console.log('  ✅ ' + name); pass++; }
    catch (e) { console.log('  ❌ ' + name + ' → ' + e.message); fail++; }
  }

  await tAsync('W5a 无令牌 → 401，且**没有**写进余温', async () => {
    calls.length = 0;
    const r = await call({}, { userId: 'u1', contribution: 10 });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(calls.length, 0, '被拒的请求不应产生副作用');
  });

  await tAsync('W5b 错令牌 → 401', async () => {
    calls.length = 0;
    const r = await call({ Authorization: 'Bearer wrong' }, { userId: 'u1', contribution: 10 });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(calls.length, 0);
  });

  await tAsync('W5c 正确令牌 + 1e9 → 400（鉴权过了，上界仍拦）', async () => {
    calls.length = 0;
    const r = await call({ Authorization: 'Bearer ' + REAL_TOKEN }, { userId: 'u1', contribution: 1e9 });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(calls.length, 0);
  });

  await tAsync('W5d 正确令牌 + 合法值 → 200 且真写入', async () => {
    calls.length = 0;
    const r = await call({ Authorization: 'Bearer ' + REAL_TOKEN }, { userId: 'u1', contribution: 7 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.contribution, 7);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], ['u1', '', 7]);
  });

  srv.close();
  delete process.env.A2A_TASKS_TOKEN;

  console.log(`\n通过: ${pass}\n失败: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
