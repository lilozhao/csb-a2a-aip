#!/usr/bin/env node
/**
 * federation-keygen.js — 生成「联邦源登记」用的 Ed25519 密钥对
 * ------------------------------------------------------------------
 * 用途：内网 registry（若琢）需要一对密钥，用来给推送的身份快照签名。
 *      私钥留在内网；公钥交给公网，用治理令牌带外 pin：
 *        curl -X POST https://registry.csbc.lilozkzy.top/identity/federation/sources \
 *             -H "X-Admin-Token: <治理令牌>" -H 'Content-Type: application/json' \
 *             -d '{"source":"internal-home","public_key":{"kty":"OKP","crv":"Ed25519","x":"<打印出来的 x>"}}'
 *
 * 用法：
 *   node federation-keygen.js --out /path/to/fed-source.key [--force]
 * 输出：私钥文件（0600，PEM/PC8）+ 公钥 JWK（可直接贴进 pin 请求）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function main() {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const out = get('--out') || path.join(process.cwd(), 'federation-source.key');
  if (fs.existsSync(out) && !args.includes('--force')) {
    console.error('❌ 目标已存在（换钥会打断已 pin 的源）。要覆盖请加 --force');
    process.exit(1);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, pem, { mode: 0o600 });
  try { fs.chmodSync(out, 0o600); } catch {}

  console.log('✅ 已生成联邦源密钥对');
  console.log('   私钥（0600，留在内网，勿外发）：', out);
  console.log('   公钥 JWK（交给公网 pin）:');
  console.log(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, null, 2));
  console.log('\n下一步（在公网侧执行，需治理令牌）：');
  console.log('  curl -s -X POST https://registry.csbc.lilozkzy.top/identity/federation/sources \\');
  console.log('    -H "X-Admin-Token: <令牌>" -H "Content-Type: application/json" \\');
  console.log(`    -d '{"source":"<源名，如 internal-home>","public_key":{"kty":"OKP","crv":"Ed25519","x":"${jwk.x}"}}'`);
}
main();
