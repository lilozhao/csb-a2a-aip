#!/usr/bin/env node
/**
 * tests/e2e-honest-degrade.test.js — E2E 状态必须诚实（P0-4）
 * ------------------------------------------------------------------
 * 起因（知微《CSB-Harness 2.0 优化升级方案 v1》事实 3 · P0-4）：
 *   升级方案原文：「A2A 的出站"加密"只是置了一个布尔」——
 *     · a2a-e2e-encryption.js 的出站只 `obj.encrypted = true`，**一个字节都没加密**
 *     · 同文件 `verifySignature` 在无密钥时直接 `return true`（签名形同虚设）
 *     · 而 `/health` 又按 `enabled` 报 e2e 状态
 *   ⇒ 外部监控看到绿灯，对接方以为可以传敏感数据。
 *   **比明说不支持更危险。**
 *
 * 本测试锁死的四条不变量：
 *   I1 无主密钥          → /health.e2e.status = 'disabled' + reason
 *   I2 有密钥未真加密    → status = 'degraded' + reason（**绝不能是 enabled**）
 *   I3 reason 必填       → 非 enabled 态必须带非空 reason
 *   I4 出站不置假标记    → 未真加密时响应体 encrypted=false 且带 encryptionReason
 *
 * 跑法：node --test tests/e2e-honest-degrade.test.js
 *
 * 实现方式：起临时实例（独立端口 + 独立身份 fixture），用真实 HTTP 打 /health。
 *   —— 必须是真 HTTP，因为要验的就是「对外暴露的那份 JSON」，不是内部函数。
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// 测试实例用假身份，绝不碰真身份文件（否则「换台机器就跑不起来」）
const TEST_IDENTITY_NAME = '测试实例';

function makeFixtureIdentity() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-e2e-identity-'));
  const file = path.join(dir, 'identity.json');
  fs.writeFileSync(file, JSON.stringify({
    name: TEST_IDENTITY_NAME,
    emoji: '🧪',
    description: '临时 fixture 身份（e2e-honest-degrade 测试专用，不代表任何真实 Agent）',
    port: 0,
    a2a_url: 'http://127.0.0.1:0',
  }), 'utf8');
  return { file, dir };
}

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: p, method: 'GET', timeout: 3000 },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json')); } });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function postJson(port, p, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: p, method: 'POST', timeout: 8000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function startInstance({ port, env }) {
  return new Promise((resolve, reject) => {
    const fixture = makeFixtureIdentity();
    const proc = spawn(process.execPath, ['server_v5.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        A2A_PORT: String(port),
        A2A_AGENT_NAME: TEST_IDENTITY_NAME,
        A2A_IDENTITY_PATH: fixture.file,
        A2A_BID_SIGNAL: '0',
        A2A_SHARED_SECRET: 'a'.repeat(64),
        // 测试实例绝不写注册表（10-26 事故：临时实例覆盖生产「若兰」条目 16 小时）
        A2A_SKIP_REGISTER: '1',
        // [2026-11-13 W-57 连带] 审计账本也不许写生产（同天 10:04 并发分叉事故）
        A2A_AUDIT_PATH: path.join(fixture.dir, 'audit.jsonl'),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.on('exit', () => { try { fs.rmSync(fixture.dir, { recursive: true, force: true }); } catch {} });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('exit', code => {
      if (code !== 0 && code !== null && !settled) {
        reject(new Error(`实例异常退出 (${code}): ${stderr.slice(-400)}`));
      }
    });

    let settled = false;
    const deadline = Date.now() + 15000;
    const poll = () => {
      if (settled) return;
      if (Date.now() > deadline) {
        settled = true;
        try { proc.kill('SIGKILL'); } catch {}
        reject(new Error('实例启动超时: ' + stderr.slice(-400)));
        return;
      }
      getJson(port, '/health').then(j => {
        if (j && j.version) {
          settled = true;
          resolve({ proc, port, stderr: () => stderr, stop: () => { try { proc.kill('SIGKILL'); } catch {} } });
        } else {
          setTimeout(poll, 300);
        }
      }).catch(() => setTimeout(poll, 300));
    };
    setTimeout(poll, 500);
  });
}

// ─────────────────────────────────────────────────────────────────────
// I1 + I3：无主密钥 → disabled，且必须带 reason
// ─────────────────────────────────────────────────────────────────────
test('I1+I3: 无主密钥 → /health.e2e.status=disabled 且 reason 非空', async () => {
  const inst = await startInstance({
    port: 3321,
    env: {
      A2A_ENCRYPTION_KEY: '',
      CSB_ENCRYPTION_KEY: '',
      // 显式清掉，避免宿主环境里恰好有值
      ...(process.env.A2A_ENCRYPTION_KEY ? { A2A_ENCRYPTION_KEY: '' } : {}),
    },
  });
  try {
    const h = await getJson(inst.port, '/health');
    assert.ok(h.e2e, '/health 缺 e2e 段');
    assert.strictEqual(h.e2e.status, 'disabled',
      `无主密钥时 status 必须是 disabled（实际 ${h.e2e.status}）`);
    assert.ok(h.e2e.reason && h.e2e.reason.length > 0,
      'disabled 必须带 reason —— 降级要说得清为什么');
    assert.strictEqual(h.e2e.enabled, false);
  } finally {
    inst.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────
// I2 + I3：有主密钥但出站未真加密 → degraded（绝不能是 enabled）
// ─────────────────────────────────────────────────────────────────────
test('I2+I3: 有主密钥但出站未真加密 → degraded（不是 enabled）', async () => {
  const inst = await startInstance({
    port: 3322,
    env: {
      A2A_ENCRYPTION_KEY: 'test-master-key-for-e2e-honest-degrade',
      CSB_ENCRYPTION_KEY: 'test-master-key-for-e2e-honest-degrade',
    },
  });
  try {
    const h = await getJson(inst.port, '/health');
    assert.ok(h.e2e, '/health 缺 e2e 段');
    assert.strictEqual(h.e2e.status, 'degraded',
      `出站未真加密时必须是 degraded（实际 ${h.e2e.status}）——` +
      '报 enabled 就是方案里点名的「假绿」：对接方会以为可以传敏感数据');
    assert.strictEqual(h.e2e.reason, 'not_implemented');
    assert.strictEqual(h.e2e.outboundEncrypted, false);
    // 兼容字段语义已收紧：enabled=true 只表示「有主密钥」
    assert.strictEqual(h.e2e.enabled, true,
      'enabled 是兼容字段，语义为「有主密钥」，不代表出站已加密');
  } finally {
    inst.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────
// I4：出站响应不得置假标记 encrypted=true
// ─────────────────────────────────────────────────────────────────────
test('I4: 出站未真加密时响应体 encrypted=false 且带 encryptionReason', async () => {
  const inst = await startInstance({
    port: 3323,
    env: {
      A2A_ENCRYPTION_KEY: 'test-master-key-for-e2e-honest-degrade',
      CSB_ENCRYPTION_KEY: 'test-master-key-for-e2e-honest-degrade',
    },
  });
  try {
    const res = await postJson(inst.port, '/a2a/json-rpc', {
      jsonrpc: '2.0',
      method: 'SendMessage',
      id: 'e2e-honest-probe-1',
      params: {
        message: {
          role: 'user',
          messageId: 'e2e-honest-probe-1',
          parts: [{ type: 'text', text: 'probe' }],
        },
      },
    });
    const body = res.body || {};
    if (body.result && body.result.task) {
      assert.notStrictEqual(body.encrypted, true,
        '出站未真加密却标了 encrypted=true —— 这正是 P0-4 要消除的假绿');
      assert.strictEqual(body.encrypted, false);
      assert.ok(body.encryptionReason,
        'encrypted=false 时必须附 encryptionReason，让对端一眼看出这包是明文');
    } else {
      // 没走到 task 返回也允许（路由未就绪等），但必须**不含** encrypted:true
      assert.notStrictEqual(body.encrypted, true,
        '任何情况下都不许出现 encrypted=true 而实际未加密');
    }
  } finally {
    inst.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────
// 负向自测：把三态拆成假绿，测试必须能抓到
// ─────────────────────────────────────────────────────────────────────
test('负向自测：三态判定器本身能识别「假 enabled」', () => {
  const { E2EEncryption } = require(path.join(ROOT, 'security-adapter.js'));
  // 有密钥 + 未声明出站真加密 → 必须不是 enabled
  const e2e = new E2EEncryption({ masterKey: 'k' });
  assert.notStrictEqual(e2e.getStatus().status, 'enabled');
  // 无密钥 → disabled
  const e2e2 = new E2EEncryption({ masterKey: null });
  assert.strictEqual(e2e2.getStatus().status, 'disabled');
  // 无密钥时验签不许默认通过
  assert.strictEqual(e2e2.verifySignature('p', 'sig'), false);
});
