#!/usr/bin/env node
/**
 * uac-policy.js —— 接收侧「豁免规则」登记命令（P1 · 登记侧）
 *
 * 原则：**默认空、默认关**。不登记 = 现状（每次 L3）。
 *   免确认的权力属于接收方主人；本命令只在本机改本地策略文件。
 *
 * 用法:
 *   node scripts/uac-policy.js init    [--policy config/bridge-uac-policy.json] [--force]
 *   node scripts/uac-policy.js add     --peer 小虾 --pubkey <file|inline-json> --capabilities pull,test \
 *                                      [--name 小虾] [--scopes a2a.delegate:shell] [--rate 3/86400] [--expires 7d] [--enable]
 *   node scripts/uac-policy.js list    [--policy ...] [--json]
 *   node scripts/uac-policy.js revoke  --peer 小虾        # 保留登记但标记吊销（可再 add 恢复）
 *   node scripts/uac-policy.js remove  --peer 小虾        # 直接删除登记
 *   node scripts/uac-policy.js enable | disable
 */
'use strict';
const path = require('path');
const fs = require('fs');
const tk = require(path.join(__dirname, '..', 'a2a-uac-toolkit.js'));

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const die = (m) => { console.error('❌ ' + m); process.exit(1); };

const cmd = process.argv[2];
const POLICY = path.resolve(arg('--policy', path.join(__dirname, '..', 'config', 'bridge-uac-policy.json')));

function load() {
  const p = tk.readJsonSafe(POLICY);
  if (!p) die(`读不到策略文件: ${POLICY}（先跑 init）`);
  return tk.normalizePolicy(p);
}
function save(pol) { tk.writeJson(POLICY, pol, { mode: 0o644 }); }

switch (cmd) {
  case 'init': {
    if (fs.existsSync(POLICY) && !has('--force')) die(`已存在: ${POLICY}（要覆盖加 --force）`);
    save(tk.emptyPolicy());
    console.log(`✅ 已初始化空策略（enabled=false，peers=[]）: ${POLICY}`);
    break;
  }

  case 'add': {
    const peer = arg('--peer');
    if (!peer) die('--peer 必填（对方 Agent 名/id）');
    const pubArg = arg('--pubkey');
    if (!pubArg) die('--pubkey 必填（公钥文件路径 或 内联 JWK JSON）');

    let userPublicKey = null;
    try {
      const asFile = tk.readJsonSafe(path.resolve(pubArg));
      if (asFile && asFile.kty) userPublicKey = asFile;
      else if (asFile && asFile.publicJwk) userPublicKey = asFile.publicJwk;   // 兼容 uac-keygen 产物
    } catch { /* fallthrough */ }
    if (!userPublicKey) {
      try { const j = JSON.parse(pubArg); userPublicKey = j.publicJwk || j; } catch { /* ignore */ }
    }
    if (!userPublicKey || userPublicKey.kty !== 'OKP') die(`解析不出公钥（需要 OKP/Ed25519 JWK）: ${pubArg}`);

    const capabilities = (arg('--capabilities', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!capabilities.length) die('--capabilities 必填（如 pull,test）——空白名单 = 不免确认');

    const scopes = (arg('--scopes', 'a2a.delegate:shell') || '').split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => s.includes(':') ? s : tk.SCOPE_PREFIX + s);

    let rate = null;
    const rateArg = arg('--rate', null);
    if (rateArg) {
      const m = /^(\d+)\s*\/\s*(\d+)$/.exec(rateArg);
      if (!m) die('--rate 格式: max/windowSeconds（如 3/86400）');
      rate = { max: parseInt(m[1], 10), windowSeconds: parseInt(m[2], 10) };
    }

    let expiresAt = null;
    const expArg = arg('--expires', null);
    if (expArg) {
      const secs = (/^\d+$/.test(expArg)) ? parseInt(expArg, 10) : tk.parseTtl(expArg);
      expiresAt = new Date(Date.now() + secs * 1000).toISOString();
    }

    // 文件在 → 读；不在 → 从空策略起步（add 自带建库）
    const pol = fs.existsSync(POLICY) ? load() : tk.emptyPolicy();
    const next = tk.addPeer(pol, { agentId: peer, name: arg('--name', peer), userPublicKey, capabilities, scopes, rate, expiresAt });
    if (has('--enable')) next.enabled = true;
    save(next);
    console.log(`✅ 已登记豁免: ${peer} · capabilities=[${capabilities}] · scopes=[${scopes}]${rate ? ` · rate=${rate.max}/${rate.windowSeconds}s` : ''}${expiresAt ? ` · expires=${expiresAt}` : ''}`);
    console.log(`   策略开关 enabled=${next.enabled}${next.enabled ? '' : '（仍不免确认；用 enable 打开）'}`);
    break;
  }

  case 'list': {
    const pol = tk.normalizePolicy(tk.readJsonSafe(POLICY) || tk.emptyPolicy());
    if (has('--json')) { console.log(JSON.stringify(pol, null, 2)); break; }
    // [2026-09-15] 小虾建议：list 带缩略 x + kid，免得取证时还要开文件
    const shortX = (jwk) => { const x = (jwk && jwk.x) || ''; return x ? `${x.slice(0, 10)}…${x.slice(-4)}` : '(无公钥)'; };
    console.log(`📋 策略: ${POLICY}`);
    console.log(`   enabled=${pol.enabled}  peers=${pol.peers.length}`);
    for (const p of pol.peers) {
      const flags = [p.revokedAt ? 'REVOKED' : null, (p.expiresAt && Date.now() > Date.parse(p.expiresAt)) ? 'EXPIRED' : null].filter(Boolean).join(',');
      console.log(`   - ${p.agentId} · caps=[${(p.capabilities || []).join(',')}] · scopes=[${(p.scopes || []).join(',')}]${p.rate ? ` · rate=${p.rate.max}/${p.rate.windowSeconds}s` : ''}${p.expiresAt ? ` · exp=${p.expiresAt}` : ''}${flags ? ` · ${flags}` : ''}`);
      console.log(`     x=${shortX(p.userPublicKey)}${p.userPublicKey && p.userPublicKey.kid ? ` · kid=${p.userPublicKey.kid}` : ''} · 指纹=${(() => { try { return tk.formatThumbprint(tk.thumbprint(p.userPublicKey)); } catch { return '(不可算)'; } })()}`);
    }
    break;
  }

  case 'revoke': case 'remove': {
    const peer = arg('--peer'); if (!peer) die('--peer 必填');
    const pol = load();
    const next = cmd === 'revoke' ? tk.revokePeer(pol, peer) : tk.removePeer(pol, peer);
    save(next);
    console.log(`✅ 已${cmd === 'revoke' ? '吊销' : '删除'}登记: ${peer}`);
    break;
  }

  case 'enable': case 'disable': {
    const pol = load();
    save(tk.setEnabled(pol, cmd === 'enable'));
    console.log(`✅ 策略开关 → enabled=${cmd === 'enable'}`);
    if (cmd === 'enable') console.log(`   ⚠️ 已开启自动放行；请确认已登记豁免且公钥/能力白名单无误。`);
    break;
  }

  default:
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ ?\* ?/gm, '').trim());
    process.exit(cmd ? 1 : 0);
}
