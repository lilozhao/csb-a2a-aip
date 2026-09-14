#!/usr/bin/env node
/**
 * uac-keygen.js —— 生成「主人」用户密钥对（P1 · 签发侧）
 *
 * 用法:
 *   node scripts/uac-keygen.js [--out .uac/user-key.json] [--kid user-yilan-01] [--force] [--json]
 *
 * 说明:
 *   - 私钥材料**只落本地**（默认 600 权限），.uac/ 已 gitignore，**绝不入仓/外发**
 *   - 打印**公钥 JWK**（可安全分发给接收方做信任登记）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const tk = require(path.join(__dirname, '..', 'a2a-uac-toolkit.js'));

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

const out = path.resolve(arg('--out', path.join(__dirname, '..', '.uac', 'user-key.json')));
const kid = arg('--kid', null);

if (fs.existsSync(out) && !has('--force')) {
  console.error(`❌ 已存在密钥库: ${out}\n   如需覆盖请显式加 --force（旧私钥将被替换，已签发的 UAC 仍可用旧公钥验证）`);
  process.exit(1);
}

const ks = tk.generateUserKey({ kid });
tk.writeJson(out, ks, { mode: 0o600 });

// 另存「只含公钥」的文件：这份才是**可以外发**给接收方登记的
const pubPath = out.replace(/\.json$/, '') + '.pub.json';
tk.writeJson(pubPath, ks.publicJwk, { mode: 0o644 });

if (has('--json')) {
  console.log(JSON.stringify({ path: out, pubPath, kid: ks.kid, publicJwk: ks.publicJwk }, null, 2));
} else {
  console.log(`✅ 主人密钥对已生成（本地，600）`);
  console.log(`   密钥库（含私钥，勿外传）: ${out}`);
  console.log(`   kid : ${ks.kid}`);
  console.log(`\n📤 公钥（可外发登记）: ${pubPath}`);
  console.log(JSON.stringify(ks.publicJwk, null, 2));
  console.log(`\n⚠️  私钥只在密钥库里（.uac/ 已 gitignore）；对外只发 .pub.json 那份。`);
}
