#!/usr/bin/env node
/**
 * A2A 看门狗（通用版）测试 —— [2026-09-18] 一澜指定「仓内通用版 + 参数化 + 测试」
 *
 * 缘起：舟楫宿主那份 a2a-watchdog.sh 不在任何 git 仓，两个真问题逐行可核：
 *   ① 单发探活无重试 → 误报"挂了"  ② 启动日志用单 `>` → 每次重启截断 server.log
 *
 * 本测试钉死通用版的四条行为（都用**真进程 + 假 health 端点**跑，不 mock 逻辑）：
 *   [1] 探活重试：一次抖动不再判死（第 3 次成功 → 不重启）
 *   [2] 不截断：重复重启后 server.log 旧内容仍在（`>>` 而非 `>`）
 *   [3] 按大小轮转：超阈值 → 改名 .1
 *   [4] fail-loud：缺必需配置 → 退出码 2 + 明确指路（不拿默认值伪装成"配了"）
 *   [5] 诚实日志：失败带 `last=<code>` 与尝试次数（不再是裸 HTTP 000 干瞪眼）
 *
 * 风格：手写 assert + console（仓库惯例，无测试框架）
 * 用法: node tests/watchdog.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'watchdog', 'a2a-watchdog.sh');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-')); }

/** 假 health 端点：按顺序返回 status codes（最后一个会一直重复） */
function stubHealth(codes) {
  return new Promise((resolve) => {
    let i = 0, count = 0;
    const srv = http.createServer((req, res) => {
      count++;
      const code = codes[Math.min(i, codes.length - 1)];
      i++;
      res.statusCode = code;
      res.end('stub');
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({
        url: `http://127.0.0.1:${port}/health`,
        close: () => new Promise((r) => srv.close(() => r())),
        requests: () => count,
      });
    });
  });
}

/** 跑看门狗：构造**干净**env（防本机 A2A_* 污染），只给必要项。
 *  用异步 spawn —— spawnSync 会阻塞事件循环，假 health 端点没法应答。 */
function runWatchdog(dir, overrides = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || '/tmp',
    A2A_INSTANCE_ENV: path.join(dir, 'no-such-instance.env'), // 不读真实实例配置
    A2A_DIR: dir,
    A2A_START_CMD: 'echo START-OUTPUT',
    A2A_PROC_PATTERN: '__no_such_proc_kanmenhuo__',
    A2A_HEALTH_RETRIES: '1',
    A2A_HEALTH_INTERVAL: '0',
    A2A_HEALTH_INTERVAL_MAX: '0',
    A2A_HEALTH_TIMEOUT: '2',
    ...overrides,
  };
  return new Promise((resolve) => {
    const p = spawn('bash', [SCRIPT], { env });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
  });
}
const wlog = (dir) => fs.readFileSync(path.join(dir, 'logs', 'watchdog.log'), 'utf8');
const slog = (dir) => fs.readFileSync(path.join(dir, 'logs', 'server.log'), 'utf8');

(async () => {
  console.log('\n[1] 探活重试：一次抖动不判死（第 3 次成功 → 不重启）');
  await test('第 3 次探活成功 → exit 0 且未进重启分支', async () => {
    const dir = tmpdir();
    const h = await stubHealth([503, 503, 200]);
    try {
      const r = await runWatchdog(dir, {
        A2A_HEALTH_URL: h.url, A2A_HEALTH_RETRIES: '5', A2A_HEALTH_INTERVAL: '0', A2A_HEALTH_INTERVAL_MAX: '0',
      });
      assert.strictEqual(r.status, 0, `exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
      assert.ok(/OK health=200 attempts=3/.test(r.stdout), r.stdout);
      assert.ok(/health ok after 3 次探测/.test(wlog(dir)), wlog(dir));
      assert.ok(!fs.existsSync(path.join(dir, 'logs', 'server.log')), '不该启动服务（health 已通）');
    } finally { await h.close(); }
  });

  console.log('\n[2] 不截断：重复重启后 server.log 旧内容仍在（`>>` 而非 `>`）');
  await test('跑两次 → 旧标记仍在，且两次启动输出都累积', async () => {
    const dir = tmpdir();
    const h = await stubHealth([503]);           // 永远不通 → 每次都走重启分支
    try {
      fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'logs', 'server.log'), 'PREVIOUS-RUN\n');
      const env = { A2A_HEALTH_URL: h.url };
      const r1 = await runWatchdog(dir, env);
      const r2 = await runWatchdog(dir, env);
      assert.strictEqual(r1.status, 1, `第一次应 restart_failed, exit=${r1.status}`);
      assert.strictEqual(r2.status, 1);
      const content = slog(dir);
      assert.ok(content.startsWith('PREVIOUS-RUN'), '旧内容必须是第一行（被截断就会丢）:\n' + content);
      const hits = (content.match(/START-OUTPUT/g) || []).length;
      assert.strictEqual(hits, 2, '两次启动输出都应累积，实际 ' + hits + ' 次:\n' + content);
    } finally { await h.close(); }
  });

  console.log('\n[3] 按大小轮转：超阈值 → 改名 .1');
  await test('A2A_SERVER_LOG_MAX_BYTES=50 + 预置 200B → 出现 server.log.1', async () => {
    const dir = tmpdir();
    const h = await stubHealth([503]);
    try {
      fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'logs', 'server.log'), 'x'.repeat(200));
      await runWatchdog(dir, { A2A_HEALTH_URL: h.url, A2A_SERVER_LOG_MAX_BYTES: '50' });
      assert.ok(fs.existsSync(path.join(dir, 'logs', 'server.log.1')), '应轮转出 .1');
      assert.ok(/轮转日志/.test(wlog(dir)), wlog(dir));
    } finally { await h.close(); }
  });

  console.log('\n[4] fail-loud：缺必需配置 → exit 2 + 明确指路');
  await test('缺 A2A_DIR / A2A_START_CMD → 退出码 2 且 stderr 点名', async () => {
    const dir = tmpdir();
    const r = await runWatchdog(dir, { A2A_DIR: '', A2A_START_CMD: '' });
    assert.strictEqual(r.status, 2, `exit=${r.status}`);
    assert.ok(/A2A_DIR/.test(r.stderr) && /A2A_START_CMD/.test(r.stderr), r.stderr);
    assert.ok(/instance\.env/.test(r.stderr), '应指路到 instance.env: ' + r.stderr);
  });

  console.log('\n[5] 诚实日志：失败带 last=<code> 与尝试次数');
  await test('全失败 → watchdog.log 含 last=503 与探测次数', async () => {
    const dir = tmpdir();
    const h = await stubHealth([503]);
    try {
      await runWatchdog(dir, { A2A_HEALTH_URL: h.url, A2A_HEALTH_RETRIES: '3', A2A_HEALTH_INTERVAL: '0', A2A_HEALTH_INTERVAL_MAX: '0' });
      const log = wlog(dir);
      assert.ok(/last=503/.test(log), log);
      assert.ok(/探测 3 次全失败/.test(log), log);
      assert.ok(/重启失败 \(health last=503/.test(log), log);
    } finally { await h.close(); }
  });

  console.log('\n' + '─'.repeat(60));
  console.log(`通过: ${passed}\n失败: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
