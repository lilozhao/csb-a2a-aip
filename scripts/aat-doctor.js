#!/usr/bin/env node
/**
 * scripts/aat-doctor.js — AAT 就绪体检 + 下一步指引
 *
 * 用途：任何实例准备做 AAT 公钥交换前，先跑这条。
 * 一次输出「能不能开始 / 卡在哪 / 下一步敲什么」，不留模糊。
 *
 * 用法：
 *   node scripts/aat-doctor.js                 # 8 项体检
 *   node scripts/aat-doctor.js --json          # 机器可读
 *   node scripts/aat-doctor.js --peer <agent-id>   # 顺带查与该对端的互通状态
 *
 * 判据原则（沿用 docs/AAT.md）：
 *   - 只报可机械核对的事实，不报「应该没问题」
 *   - 取不到就是 unknown，不猜、不填默认值（明澈 P2）
 *
 * 维护: 若兰 🌸 | 2026-10-24 · 配套 docs/AAT-EXCHANGE-TEMPLATE.md
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const ARGV = process.argv.slice(2);
const JSON_MODE = ARGV.includes('--json');
const PEER = (() => {
  const i = ARGV.indexOf('--peer');
  return i !== -1 ? String(ARGV[i + 1] || '').trim() || null : null;
})();

const MIN_VERSION = '5.3.0';
const checks = [];

function push(id, title, ok, detail, fix) {
  checks.push({ id, title, status: ok === true ? 'pass' : ok === false ? 'fail' : 'warn', detail, fix: ok === true ? null : fix || null });
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function localHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2500 }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

(async () => {
  // ── 1. 版本文件 ────────────────────────────────
  let ver = null;
  for (const f of ['VERSION', 'package.json']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    if (f === 'VERSION') ver = fs.readFileSync(p, 'utf8').trim();
    else ver = readJson(p)?.version || ver;
  }
  push('version', '版本 ≥ ' + MIN_VERSION, ver ? cmpVer(ver, MIN_VERSION) >= 0 : null
    , ver || '取不到 VERSION/package.json'
    , '升级到 5.3.0+：5.2.x 没有 a2a-aat.js，别往下走');

  // ── 2. AAT 模块文件 ───────────────────────────
  const aatPath = path.join(ROOT, 'a2a-aat.js');
  const keysPath = path.join(ROOT, 'scripts', 'aat-keys.js');
  const missing = [!fs.existsSync(aatPath) && 'a2a-aat.js', !fs.existsSync(keysPath) && 'scripts/aat-keys.js'].filter(Boolean);
  push('files', 'AAT 模块两个文件齐全', missing.length === 0
    , missing.length ? '缺：' + missing.join(' / ') : 'a2a-aat.js + scripts/aat-keys.js 都在'
    , '先升级到 5.3.0+');

  // ── 3. 私钥可读（能导出指纹）──────────────────
  let self = null;
  if (!missing.length) {
    try {
      const aat = require(aatPath);
      if (typeof aat.exportPublicKey === 'function') {
        const r = aat.exportPublicKey();
        self = { agentId: r.agentId || r.agent_id, publicKey: r.publicKey || r.public_key, fingerprint: r.fingerprint };
      }
    } catch (e) {
      push('privkey', '私钥可读（能导出公钥指纹）', false, e.message
        , '见 docs/AAT.md「私钥从哪来」：A2A_SECURITY_HANDSHAKE_KEY → config aat.keyPath → csb-security/data 唯一 pem');
    }
  }
  if (!missing.length && !self) {
    push('privkey', '私钥可读（能导出公钥指纹）', false, '导出返回空'
      , '检查 AID 私钥路径；多把私钥时工具会拒绝猜，请显式指定');
  } else if (self) {
    push('privkey', '私钥可读（能导出公钥指纹）', true, `${self.agentId} · ${self.fingerprint.slice(0, 16)}…`);
  }

  // ── 4. agent_id 与 identity 一致 ───────────────
  const identity = readJson(path.join(ROOT, 'identity.json'));
  if (identity && self) {
    const host = identity.publicHost || identity.host || '';
    const port = identity.port || '';
    const expectHost = host && port ? `${host}:${port}` : null;
    const ok = expectHost ? String(self.agentId || '').includes(expectHost) : null;
    push('identity', 'agent_id 与 identity 地址一致', ok
      , ok === null ? `identity 缺 publicHost/port（agent_id=${self.agentId}）`
        : ok ? `${self.agentId} ↔ ${expectHost}` : `agent_id=${self.agentId} 但 identity=${expectHost}`
      , 'identity 里补 publicHost + port；否则对方排障时看到两队地址');
  } else {
    push('identity', 'agent_id 与 identity 地址一致', null, '取不到 identity.json', '补 identity.json（name/port/publicHost）');
  }

  // ── 5. 服务在跑，且版本对得上 ──────────────────
  const port = identity?.port || 3100;
  const h = await localHealth(port);
  push('server', '本机服务在跑且版本一致', h ? (ver ? cmpVer(h.version, ver) === 0 : true) : false
    , h ? `:${port} version=${h.version} status=${h.status} DHT=${h.dht?.level?.name || '?'}`
      : `:${port} 无响应`
    , h ? '重启让新 VERSION 生效' : '先启动服务（或改 identity.port）');

  // ── 6. agents.local.json 权限 ──────────────────
  const localPath = path.join(ROOT, 'config', 'agents.local.json');
  if (fs.existsSync(localPath)) {
    const st = fs.statSync(localPath);
    const mode = (st.mode & 0o777).toString(8);
    push('perm', 'agents.local.json 权限 600', mode === '600', `mode=${mode}`, `chmod 600 ${localPath}`);
  } else {
    push('perm', 'agents.local.json 权限 600', null, '文件不存在（首次 pin 会自动创建）', null);
  }

  // ── 7. 已固定公钥数量 ─────────────────────────
  const local = readJson(localPath) || {};
  const pinned = Object.entries(local.agents || {}).filter(([, v]) => v && (v.aidPublicKey || v.publicKey || v.jwk));
  const total = Object.keys(local.agents || {}).length;
  push('pinned', '至少固定 1 个对端公钥', pinned.length > 0
    , `已固定 ${pinned.length}${total ? '/' + total : ''}` + (pinned.length ? '：' + pinned.map(([k]) => k).join(', ') : '')
    , 'node scripts/aat-keys.js pin <对方agent-id> <JWK> --fingerprint <核对过的完整64位>');

  // ── 8. 对端专项（可选）────────────────────────
  if (PEER) {
    const hit = pinned.find(([k, v]) => k === PEER || v.name === PEER || String(v.name || '').includes(PEER));
    push('peer', `对端 ${PEER} 已固定`, !!hit
      , hit ? `${hit[0]} · ${String(hit[1].aidPublicKey?.x || hit[1].publicKey?.x || '').slice(0, 12)}…`
        : '未固定 → 对方发来的 AAT 只会得到 no_pinned_key'
      , `node scripts/aat-keys.js pin '${PEER}' '<对方JWK>' --fingerprint <64位>`);
  }

  // ── 输出 ──────────────────────────────────────
  if (JSON_MODE) {
    console.log(JSON.stringify({ version: ver, agentId: self?.agentId || null, fingerprint: self?.fingerprint || null, checks }, null, 2));
    process.exit(checks.some((c) => c.status === 'fail') ? 1 : 0);
  }

  const icon = { pass: '✅', fail: '❌', warn: '⚠️ ' };
  console.log('\n🩺 AAT 就绪体检\n');
  for (const c of checks) {
    console.log(`  ${icon[c.status]} ${c.title}`);
    console.log(`     ${c.detail}`);
    if (c.fix) console.log(`     → ${c.fix}`);
  }

  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  console.log('\n' + '─'.repeat(56));
  if (fails.length === 0) {
    console.log('  🟢 可以开始交换名片');
    if (self) {
      console.log('\n  发给对方（原文照贴，指纹必须 64 位全量）：');
      console.log(`    agent_id : ${self.agentId}`);
      console.log(`    公钥 JWK : ${JSON.stringify(self.publicKey)}`);
      console.log(`    指纹     : ${self.fingerprint}`);
    }
    console.log('\n  下一步：docs/AAT-EXCHANGE-TEMPLATE.md 第 1 步');
  } else {
    console.log(`  🔴 ${fails.length} 项未过 → 先别发名片，照上面 → 修`);
  }
  if (warns.length) console.log(`  ⚠️  ${warns.length} 项提醒（不阻塞）`);
  console.log('─'.repeat(56) + '\n');

  process.exit(fails.length ? 1 : 0);
})();
