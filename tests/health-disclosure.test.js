#!/usr/bin/env node
/**
 * health-disclosure.test.js — W-57 公开 /health 不许泄露内网拓扑与运行画像
 *
 * 起因：2026-11-09 W-51 事故连带发现，明德第三方记录为残留项。
 *   公开 /health 一次交出 2300B / 105 个字段：内网注册表地址、4 条本地绝对路径、
 *   邻居名单 uac.peerIds、knownAgents 规模、e2e.reason=no_master_key（自曝明文）、
 *   trust/audit 行数与链尾哈希、任务状态分布，且对无 Origin 请求回 ACAO:*。
 *
 * 一澜 2026-11-13 09:55 拍板：方案 A（分级）+ 局部 C（就地改布尔）。
 *
 * 锁死的不变量：
 *   I1 公开 /health 不含 IPv4 字面量 / 绝对路径 / A 类字段名 / 「明文自曝」措辞
 *   I2 公开 /health 仍含 status / version / protocol / identity / dht.level.name
 *      （删任一项 → 我方自己的探活判据失效）
 *   I3 详细版 /health/detail：无令牌 401 / 错令牌 401 / 正确令牌 200
 *   I4 **负向**：把一条假路径与假 IP 注入公开视图，扫描器必须红（11-03 教训：
 *      只认「故意造错会红」，不认「跑绿了就算对」）
 *
 * 跑法：node --test tests/health-disclosure.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { buildPublicHealth, scanForLeaks } = require(path.join(ROOT, 'a2a-health-public.js'));

const TEST_IDENTITY_NAME = '测试实例W57';

/** 一份「真形状」的 detail 快照（含全部 A 类脏数据），用来验证公开版把它们挑掉 */
function makeDirtyDetail() {
  return {
    status: 'ok',
    checks: {
      configResolved: {
        ok: true,
        source: 'env:A2A_REGISTRY_URL',
        effective: 'http://172.28.0.4:3099',          // A 类：内网地址
        hint: null,
      },
      registryReachable: { ok: true, onlineAgents: 20, dhtLevel: 'FULL', hint: null },
    },
    version: '5.3.15',
    protocol: 'A2A v0.6',
    identity: '若兰',
    uptime: 9279,                                       // B 类：重启画像
    dht: {
      level: { level: 0, name: 'FULL', desc: 'DHT 全网在线' },
      onlineAgents: 20,
      registries: ['http://172.28.0.4:3099'],           // A 类
      lastProbeTime: 1794534961270,                     // B 类
    },
    e2e: { status: 'disabled', reason: 'no_master_key', enabled: false, outboundEncrypted: false },
    rateLimit: { suspendedAgents: [], suspiciousIps: [], agentKeys: 1, ipKeys: 1 },
    tasks: { total: 462, byState: { TASK_STATE_COMPLETED: 347 }, terminalTasks: 462 }, // B 类
    trust: {
      ledgerPath: '/home/node/.openclaw/workspace/csb-a2a-aip/data/trust/trust-evidence.jsonl', // A 类
      entries: 283,
      lastHash: 'a61586f0',                             // B 类
      signed: true,
      verified: true,
      auditReady: true,
      degraded: false,
    },
    audit: {
      logPath: '/home/node/.openclaw/workspace/csb-a2a-aip/data/audit/security-audit.jsonl', // A 类
      entries: 2573,
      chainValid: true,
    },
    uac: {
      policyPath: '/home/node/.openclaw/workspace/csb-a2a-aip/config/bridge-uac-policy.json', // A 类
      peerIds: ['小虾'],                                // A 类：邻居名单
      peersCount: 1,
    },
    inboundAuth: {
      mode: 'shadow',
      knownAgents: 27,                                  // A 类：网络规模
      shadowLog: '/home/node/.openclaw/workspace/csb-a2a-aip/logs/inbound-auth-shadow.jsonl', // A 类
    },
  };
}

// ---------------- I1 / I2：纯函数层 ----------------

test('I1: 公开视图不含 IPv4 / 绝对路径 / A 类字段名 / 明文自曝', () => {
  const pub = buildPublicHealth(makeDirtyDetail());
  const hits = scanForLeaks(pub);
  assert.deepStrictEqual(hits, [], `公开视图泄露：${hits.join(', ')}\n${JSON.stringify(pub, null, 2)}`);
  // 再加一条直接的文本证据，别只信自己的扫描器
  const text = JSON.stringify(pub);
  assert.ok(!/172\.28\.|192\.168\.|10\.\d+\.\d+\.\d+/.test(text), '不得出现内网地址');
  assert.ok(!text.includes('/home/'), '不得出现绝对路径');
  assert.ok(!text.includes('小虾'), '不得出现邻居名字');
  assert.ok(!text.includes('no_master_key'), '不得自曝「未加密」的原因字符串');
});

test('I2: 公开视图必须仍含探活/协商/可审计结论字段', () => {
  const pub = buildPublicHealth(makeDirtyDetail());
  for (const k of ['status', 'version', 'protocol', 'identity']) {
    assert.ok(pub[k], `公开 /health 缺 ${k} —— 缺它探活/版本协商/验活判据都会失效`);
  }
  assert.strictEqual(pub.dht.level.name, 'FULL', 'DHT 降级是「看起来正常实则全瞎」的唯一外部信号');
  assert.strictEqual(typeof pub.dht.onlineAgents, 'number');
  assert.strictEqual(pub.audit.chainValid, true, '外部可核「可审计」的凭据：给结论不给细节');
  assert.strictEqual(pub.trust.verified, true);
  assert.strictEqual(pub.e2e.encrypted, false, 'e2e 只给布尔，不给 reason');
  assert.strictEqual(pub.rateLimit.suspended, 0, 'rateLimit 只给计数，不给名单');
});

test('I2b: detail 里将来新增的字段不会被自动带出去（默认安全）', () => {
  const d = makeDirtyDetail();
  d.checks.configResolved.futureSecret = 'should-not-leak';
  d.brandNewSection = { anything: 'should-not-leak' };
  const text = JSON.stringify(buildPublicHealth(d));
  assert.ok(!text.includes('should-not-leak'), '公开视图必须是白名单挑字段，不是整体透传');
});

// ---------------- I4：负向（故意造错必须红） ----------------

test('I4(负向): 注入假路径 + 假 IP 到公开视图 → 扫描器必须检出', () => {
  const pub = buildPublicHealth(makeDirtyDetail());
  const leaky = JSON.parse(JSON.stringify(pub));
  leaky.checks.configResolved.effective = 'http://10.1.36.55:3100';
  leaky.trust.ledgerPath = '/home/node/.openclaw/workspace/secret.jsonl';

  const hits = scanForLeaks(leaky);
  assert.ok(hits.includes('ipv4_literal'), `扫描器没抓到假 IP（hits=${hits.join(',')}）—— 判据本身就是坏的`);
  assert.ok(hits.includes('absolute_path'), `扫描器没抓到假路径（hits=${hits.join(',')}）`);
  assert.ok(hits.includes('forbidden_key:effective'), 'A 类字段名必须被扫出来');
  assert.ok(hits.includes('forbidden_key:ledgerPath'), 'A 类字段名必须被扫出来');
});

// ---------------- I3：HTTP 层（真实例） ----------------

function makeFixtureIdentity() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-identity-w57-'));
  const file = path.join(dir, 'identity.json');
  fs.writeFileSync(file, JSON.stringify({
    name: TEST_IDENTITY_NAME,
    emoji: '🧪',
    description: '临时 fixture 身份（W-57 测试专用）',
    port: 0,
    a2a_url: 'http://127.0.0.1:0',
  }), 'utf8');
  return { file, dir };
}

function getJson(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: p, method: 'GET', timeout: 5000, headers: headers || {} },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(d); } catch { /* 非 JSON 保留原文 */ }
          resolve({ status: res.statusCode, json, raw: d, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
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
        A2A_SKIP_REGISTER: '1',        // 绝不把测试实例注册进生产注册表
        A2A_TASKS_ALLOW_LOCAL: '0',    // 环回也须令牌（隧道伪装环回，这条判据不许退）
        // [2026-11-13 W-57 连带] 审计账本必须隔离。
        //   事故：本文件起的每个临时实例都写生产 `data/audit/security-audit.jsonl`，
        //   并发 append 锁超时降级直写 → 10:04 生产账本分叉（两个 seq=2584），
        //   /health 报 degraded 4 分钟。测试不许碰生产账本。
        A2A_AUDIT_PATH: path.join(fixture.dir, 'audit.jsonl'),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('exit', code => {
      try { fs.rmSync(fixture.dir, { recursive: true, force: true }); } catch {}
      if (!settled && code !== 0 && code !== null) {
        reject(new Error(`实例异常退出 (${code}): ${stderr.slice(-400)}`));
      }
    });
    const deadline = Date.now() + 20000;
    const poll = () => {
      if (settled) return;
      if (Date.now() > deadline) {
        settled = true;
        try { proc.kill('SIGKILL'); } catch {}
        reject(new Error('实例启动超时: ' + stderr.slice(-400)));
        return;
      }
      getJson(port, '/health').then(r => {
        if (r.json && r.json.version) {
          settled = true;
          resolve({ proc, port, stderr: () => stderr, stop: () => { try { proc.kill('SIGKILL'); } catch {} } });
        } else setTimeout(poll, 300);
      }).catch(() => setTimeout(poll, 300));
    };
    setTimeout(poll, 500);
  });
}

test('I3: /health 公开干净 + /health/detail 三态鉴权', async () => {
  const TOKEN = 'w57-token-' + Date.now();
  const inst = await startInstance({
    port: 3314,
    env: { A2A_REGISTRY_URL: 'http://127.0.0.1:9999', A2A_TASKS_TOKEN: TOKEN },
  });
  try {
    // 公开版：干净
    const pub = await getJson(inst.port, '/health');
    assert.strictEqual(pub.status, 200);
    assert.deepStrictEqual(scanForLeaks(pub.json), [], '公开 /health 泄露');
    assert.ok(!pub.headers['access-control-allow-origin'],
      `无 Origin 的请求不该回 ACAO（实际 ${pub.headers['access-control-allow-origin']}）`);
    assert.ok(pub.json.identity, '公开版必须保留 identity');

    // 详细版：无令牌 / 错令牌 → 401
    const noTok = await getJson(inst.port, '/health/detail');
    assert.strictEqual(noTok.status, 401, '无令牌必须 401');
    assert.ok(noTok.json && noTok.json.next_step, '拒绝必须带 next_step（K-1 五字段出口）');

    const badTok = await getJson(inst.port, '/health/detail', { Authorization: 'Bearer wrong-token' });
    assert.strictEqual(badTok.status, 401, '错令牌必须 401');

    // 正确令牌 → 200，且能看到 A 类字段（诊断能力不丢）
    const ok = await getJson(inst.port, '/health/detail', { Authorization: 'Bearer ' + TOKEN });
    assert.strictEqual(ok.status, 200, '正确令牌必须 200');
    assert.ok(ok.json.checks.configResolved.effective, '详细版必须保留 configResolved.effective');
    assert.ok(ok.json.dht.registries, '详细版必须保留 dht.registries');
    assert.strictEqual(ok.json.identity, pub.json.identity, '两版 identity 必须一致（防「200 但不是我们的服务」）');
  } finally {
    inst.stop();
  }
});
