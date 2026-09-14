#!/usr/bin/env node
/**
 * uac-issue.js —— 签发 UAC（代表授权 · A 凭证）（P1 · 签发侧）
 *
 * 用法:
 *   node scripts/uac-issue.js --key .uac/user-key.json --user user:yilan@csb --agent 若兰 \
 *     --scopes shell --ttl 1h [--agents 小虾,阿轩] [--out .uac/uac.jwt] [--json]
 *
 * 参数:
 *   --key     密钥库路径（uac-keygen.js 产物）
 *   --user    iss（主人标识）
 *   --agent   sub（被授权 Agent）
 *   --scopes  UAC 范围：短名 read/write/shell/notify（自动加前缀 a2a.delegate:），或直接写全名（含 ":"）
 *   --ttl     有效期：5m / 1h / 24h / 7d / 秒数（默认 1h）
 *   --agents  可选，restrictions.allowed_agents（逗号分隔；限定只对哪些接收方有效）
 *   --out     可选，写入文件（默认只打印）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const tk = require(path.join(__dirname, '..', 'a2a-uac-toolkit.js'));

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const die = (m) => { console.error('❌ ' + m); process.exit(1); };

const keyPath = arg('--key', path.join(__dirname, '..', '.uac', 'user-key.json'));
const user = arg('--user', 'user:yilan@csb');
const agent = arg('--agent');
if (!agent) die('--agent 必填（被授权 Agent，即 sub）');

const keyStore = tk.readJsonSafe(path.resolve(keyPath));
if (!keyStore || !keyStore.privateJwk) die(`读不到密钥库（先跑 uac-keygen.js）: ${keyPath}`);

const rawScopes = (arg('--scopes', 'shell') || '').split(',').map((s) => s.trim()).filter(Boolean);
const scopes = rawScopes.map((s) => s.includes(':') ? s : tk.SCOPE_PREFIX + s);
if (!scopes.length) die('--scopes 不能为空');

let ttl;
try { ttl = tk.parseTtl(arg('--ttl', '1h')); } catch (e) { die(e.message); }

const agents = (arg('--agents', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const restrictions = agents.length ? { allowed_agents: agents } : null;

const { token, payload } = tk.issueUAC({ keyStore, user, agent, scopes, ttl, restrictions });

const out = arg('--out', null);
if (out) {
  const p = path.resolve(out);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, token + '\n', { mode: 0o600 });
}

if (has('--json')) {
  console.log(JSON.stringify({ token, payload, out: out ? path.resolve(out) : null }, null, 2));
} else {
  console.log('✅ UAC 已签发');
  console.log(`   iss=${payload.iss}  sub=${payload.sub}  exp=${new Date(payload.exp * 1000).toISOString()}`);
  console.log(`   scopes=${payload.scopes.join(', ')}${restrictions ? '  allowed_agents=' + agents.join(',') : ''}`);
  console.log(`\n🔑 token:\n${token}`);
  if (out) console.log(`\n📄 已写入: ${path.resolve(out)}（600）`);
  console.log(`\n用法: 发送委托时带上（delegation.uac）。接收方需先登记你的公钥 + 豁免规则，否则仍走 L3。`);
}
