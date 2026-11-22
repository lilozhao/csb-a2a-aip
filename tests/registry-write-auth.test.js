#!/usr/bin/env node
/**
 * registry-write-auth.test.js — 注册表写路由鉴权 + 原子写 + messageId 随机
 *
 * 起因（澄 2026-11-21 复审 P0-B / P0-3）：
 *   · /register 同名覆盖零鉴权 → 一步绕过心跳端点的 host 漂移闸，
 *     任何人 POST 一个 name + 自己的 host 就能把邻居地址改到自己机器上。
 *   · DELETE /agents/:name、/skill-upgrade/register、/skill-upgrade/broadcast 全裸奔。
 *   · saveRegistry 直接 writeFileSync：写一半被杀 → 文件截断 → 解析失败静默返回空表
 *     → 下一次 save 把「残骸」固化成「整表清零」。
 *   · messageId 用 Math.random()（非密码学）且是 ack 的唯一凭据 → 可预测即可冒名吞消息。
 *
 * 本测试怎么跑：起一个真进程（子进程），随机端口 + 临时数据目录，全程真 HTTP。
 *   —— 不 mock、不 require 主模块（registry.js 一 require 就 listen），
 *      因为「测试里绿、服务上红」通常就死在 mock 边界上。
 *
 * 跑法：node tests/registry-write-auth.test.js
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const ADMIN = 'test-admin-token-' + Date.now();

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
      timeout: 8000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: buf });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

async function boot(mode) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regtest-'));
  const port = 32000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [path.join(REPO, 'registry.js')], {
    env: {
      ...process.env,
      A2A_DATA_DIR: dataDir,
      REGISTRY_PORT: String(port),
      REGISTRY_HOST: '127.0.0.1',
      REGISTRY_WRITE_AUTH: mode,
      REGISTRY_ADMIN_TOKEN: ADMIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => out += d);
  child.stderr.on('data', (d) => out += d);

  // 等端口起来
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      const r = await req(port, 'GET', '/health');
      if (r.status === 200) break;
    } catch {}
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('registry 未能在 8s 内启动:\n' + out);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { child, port, dataDir, log: () => out };
}

function listTmp(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')); } catch { return []; }
}

(async () => {
  // ══════════════════════════════════════════════════════════
  // enforce 模式
  // ══════════════════════════════════════════════════════════
  const A = await boot('enforce');
  try {
    const reg = (extra = {}) => ({ name: '甲', host: '10.0.0.1', port: 3100, ...extra });

    // 1. 新名字注册 → 放行（引导期必须能自注册）
    let r = await req(A.port, 'POST', '/register', reg());
    check('新名字注册放行（引导期）', r.status === 200 && r.body?.success === true, `status=${r.status}`);

    // 2. 同名 + 同地址 → 放行（重启重注册是常态）
    r = await req(A.port, 'POST', '/register', reg({ version: '1.0.1' }));
    check('同名同址重注册放行（重启常态，不破邻居）', r.status === 200, `status=${r.status}`);

    // 3. 同名 + 换地址 + 无 token → 403  ← 本次修复的核心
    r = await req(A.port, 'POST', '/register', reg({ host: '6.6.6.6' }));
    check('同名换址无 token → 403（堵住地址劫持）',
      r.status === 403 && r.body?.code === 'REGISTER_ADDRESS_CHANGE_FORBIDDEN',
      `status=${r.status} code=${r.body?.code}`);

    // 4. 被拒后注册表里仍是旧地址（不是「拒了但改了」）
    let g = await req(A.port, 'GET', '/agents/%E7%94%B2');
    check('被拒后地址未被污染', g.body?.host === '10.0.0.1', `status=${g.status} host=${g.body?.host}`);

    // 5. 同名 + 换地址 + Bearer → 200
    r = await req(A.port, 'POST', '/register', reg({ host: '6.6.6.6' }), { Authorization: `Bearer ${ADMIN}` });
    check('同名换址带 Bearer → 200（合法变更仍可做）', r.status === 200, `status=${r.status}`);
    check('地址确实变更了', r.body?.agent?.host === '6.6.6.6', `host=${r.body?.agent?.host}`);

    // 6. DELETE 无 token → 403；带 token → 200
    r = await req(A.port, 'DELETE', '/agents/%E7%94%B2');
    check('DELETE /agents 无 token → 403', r.status === 403, `status=${r.status}`);
    r = await req(A.port, 'DELETE', '/agents/%E7%94%B2', null, { 'X-Admin-Token': ADMIN });
    check('DELETE /agents 带 token → 200', r.status === 200 && r.body?.success === true, `status=${r.status}`);

    // 7. 技能发布无 token → 403（供应链入口）
    r = await req(A.port, 'POST', '/skill-upgrade/register', { skillName: 'evil', version: '1.0.0' });
    check('skill-upgrade/register 无 token → 403', r.status === 403, `status=${r.status}`);
    r = await req(A.port, 'POST', '/skill-upgrade/register',
      { skillName: 'ok', version: '1.0.0' }, { Authorization: `Bearer ${ADMIN}` });
    check('skill-upgrade/register 带 token → 非 403', r.status !== 403, `status=${r.status}`);

    // 8. 定时比较：错 token 也拒（不是「有头就放」）
    r = await req(A.port, 'DELETE', '/agents/nobody', null, { Authorization: 'Bearer wrong-token' });
    check('错 token → 403（有头不等于有票）', r.status === 403, `status=${r.status}`);

    // 9. messageId 随机性：同毫秒两条也不能撞
    await req(A.port, 'POST', '/register', { name: '乙', host: '10.0.0.2', port: 3101 });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const s = await req(A.port, 'POST', '/messages/store',
        { recipient: '乙', sender: '丙', message: { text: 'x' + i } });
      ids.push(s.body?.messageId);
    }
    check('messageId 5 条全非空', ids.every(Boolean), JSON.stringify(ids));
    check('messageId 无重复（randomBytes 生效）', new Set(ids).size === 5, JSON.stringify(ids));
    check('messageId 不再含 Math.random 的短 base36 尾（长度 ≥ 32）',
      ids.every((x) => x && x.length >= 32), JSON.stringify(ids.map((x) => x?.length)));

    // 10. 原子写：落盘 JSON 可解析 + 无残留 .tmp
    const regFile = path.join(A.dataDir, 'a2a_registry.json');
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(regFile, 'utf8')); } catch {}
    check('注册表落盘为合法 JSON（原子写）', !!parsed && Array.isArray(parsed.agents), '解析失败');
    check('无残留 .tmp 文件', listTmp(A.dataDir).length === 0, listTmp(A.dataDir).join(','));

    // 11. 审计留痕：拒绝要计分（P1）——stderr/stdout 里必须有拒绝行
    check('拒绝有日志留痕', /write-auth\]\[enforce\].*拒绝/.test(A.log()), '未找到拒绝日志');
  } finally {
    A.child.kill('SIGKILL');
  }

  // ══════════════════════════════════════════════════════════
  // shadow 模式：不拒，但必须留痕 + 打头（可测量影响面）
  // ══════════════════════════════════════════════════════════
  const B = await boot('shadow');
  try {
    await req(B.port, 'POST', '/register', { name: '丁', host: '10.0.0.9', port: 3100 });
    const r = await req(B.port, 'POST', '/register', { name: '丁', host: '6.6.6.6', port: 3100 });
    check('shadow：同名换址放行（不破邻居）', r.status === 200, `status=${r.status}`);
    check('shadow：回包带 X-Write-Auth 标记（诚实标注未真拒）',
      r.headers['x-write-auth'] === 'shadow-denied', `header=${r.headers['x-write-auth']}`);
    check('shadow：日志记了「本应拒绝」', /\[write-auth\]\[shadow\].*本应拒绝/.test(B.log()), '未找到 shadow 日志');
  } finally {
    B.child.kill('SIGKILL');
  }

  // ══════════════════════════════════════════════════════════
  console.log(results.join('\n'));
  console.log(`\n通过: ${pass}\n失败: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('💥 测试异常:', e.message);
  process.exit(2);
});
