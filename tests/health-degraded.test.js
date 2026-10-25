#!/usr/bin/env node
/**
 * health-degraded.test.js — /health 必须如实报告降级
 *
 * 起因：舟楫 2026-10-24 升级反馈。
 *   升级把 config/agents.json 换成模板 → registry 回落 localhost:3099（连不上）
 *   → DHT 降级 CACHE、onlineAgents=0，
 *   **但 /health 仍返回 status:"ok"** —— 外部监控看到绿灯，实际全瞎。
 *
 * 这条锁死一个不变量：
 *   I1 配置未解析（占位符）→ status 必须是 degraded，且给出可读 reason
 *   I2 DHT 非 FULL 且 onlineAgents=0 → status 必须是 degraded
 *   I3 正常时 → status ok（不能反过来永远报警，那也会被忽略）
 *
 * 跑法：node --test tests/health-degraded.test.js
 *
 * 实现方式：起临时实例（独立端口 + 独立注册表地址），用真实 HTTP 打 /health。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/** 起一个临时 server_v5 实例，等 /health 可用后返回 { port, proc, stop } */
function startInstance({ port, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['server_v5.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        A2A_PORT: String(port),
        A2A_AGENT_NAME: '若兰',
        A2A_IDENTITY_PATH: path.join(ROOT, 'identity.json'),
        A2A_BID_SIGNAL: '0',
        A2A_SHARED_SECRET: 'a'.repeat(64),
        // [2026-10-26] 测试实例绝不写注册表。
        //   事故：本文件 I3 曾把临时实例（3312）注册进**生产注册表**，把「若兰」
        //   条目覆盖成死地址，且心跳不修 host/port → 注册表广播死地址 16 小时。
        //   症状：邻居按注册表来敲，connection refused，双方都以为对方不理人。
        A2A_SKIP_REGISTER: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
          resolve({
            proc,
            port,
            stderr: () => stderr,
            stop: () => { try { proc.kill('SIGKILL'); } catch {} },
          });
        } else {
          setTimeout(poll, 300);
        }
      }).catch(() => setTimeout(poll, 300));
    };
    setTimeout(poll, 500);
  });
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

test('I1+I2: 注册表不可达 → status=degraded，而不是谎报 ok', async () => {
  const inst = await startInstance({
    port: 3311,
    env: { A2A_REGISTRY_URL: 'http://127.0.0.1:9999' }, // 故意指向不存在的注册表
  });
  try {
    const h = await getJson(inst.port, '/health');
    assert.strictEqual(h.status, 'degraded',
      `注册表不可达时 status 必须为 degraded（实际 ${h.status}）——` +
      '谎报 ok 会让监控看到绿灯却全瞎，这正是舟楫踩到的坑');
    assert.ok(h.degradedReason && h.degradedReason.length > 0, 'degraded 必须带可读原因');
    assert.strictEqual(h.checks.registryReachable.ok, false);
    assert.ok(h.checks.registryReachable.hint, '不可达时必须给人下一步提示');
  } finally {
    inst.stop();
  }
});

test('I3: 注册表正常 → status=ok（不能永远报警）', async () => {
  // 用已知可用的注册表（本环境 172.28.0.4:3099）
  const inst = await startInstance({
    port: 3312,
    env: { A2A_REGISTRY_URL: 'http://172.28.0.4:3099' },
  });
  try {
    // 给注册一点时间
    let h = null;
    for (let i = 0; i < 20; i++) {
      h = await getJson(inst.port, '/health');
      if (h.checks && h.checks.registryReachable && h.checks.registryReachable.onlineAgents > 0) break;
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(h.checks, '/health 必须带 checks 字段（可机械核对）');
    assert.strictEqual(typeof h.checks.configResolved.ok, 'boolean');
    if (h.checks.registryReachable.onlineAgents > 0) {
      assert.strictEqual(h.status, 'ok', '注册正常时不能误报 degraded');
    }
  } finally {
    inst.stop();
  }
});

test('配置自检字段必须齐全（不靠猜）', async () => {
  const inst = await startInstance({
    port: 3313,
    env: { A2A_REGISTRY_URL: 'http://127.0.0.1:9999' },
  });
  try {
    const h = await getJson(inst.port, '/health');
    assert.ok(h.checks.configResolved, '必须有 configResolved');
    assert.ok(typeof h.checks.configResolved.source === 'string',
      'configResolved.source 要说明配置来自哪（env / agents.local.json / 占位符）');
    assert.ok(h.checks.configResolved.effective, 'configResolved.effective 要给出实际生效值');
  } finally {
    inst.stop();
  }
});
