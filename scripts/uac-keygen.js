#!/usr/bin/env node
/**
 * uac-keygen.js —— 「主人」用户密钥（P1 · 签发侧）
 *
 * 两种模式（**默认推荐复用已有锚钥**）:
 *   ① 复用既有锚钥（推荐）:
 *        node scripts/uac-keygen.js --from-pem ../../csb-security/data/yilan-user-key.pem --kid user-yilan --out .uac/user-key.json --force
 *      —— 把已在身份链/握手里用过的用户钥导入为本机签发钥（**不新造一个身份**）
 *      —— `--from-pem anchor` 为快捷写法：自动用 ../data/users/yilan-user-pub.json 对应的 PEM
 *          （PEM 路径见 --anchor-pem，默认 ../../csb-security/data/yilan-user-key.pem）
 *   ② 生成新钥（谨慎，会造出「无锚钥」）:
 *        node scripts/uac-keygen.js [--kid user-yilan-01] [--force] [--json]
 *
 * 说明:
 *   - 私钥材料**只落本地**（默认 600），.uac/ 已 gitignore，**绝不入仓/外发**
 *   - 打印**公钥 JWK** + **锚指纹**（RFC 7638，供人—人带外核对）
 *
 * [2026-09-15 护栏] 若本机存在既有锚钥（csb-security/data/yilan-user-key.pem）却仍走模式②，
 *   会**高声告警**：新钥没有归属证据链，收货方无法对账（阿轩踩到的正是这个）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const tk = require(path.join(__dirname, '..', 'a2a-uac-toolkit.js'));

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

const out = path.resolve(arg('--out', path.join(__dirname, '..', '.uac', 'user-key.json')));
const kid = arg('--kid', null);
const fromPemRaw = arg('--from-pem', null);

// 既有锚钥的默认位置（本仓内 + 兄弟仓 csb-security）
const ANCHOR_PUB = path.resolve(arg('--anchor-pub', path.join(__dirname, '..', 'data', 'users', 'yilan-user-pub.json')));
const ANCHOR_PEM = path.resolve(arg('--anchor-pem', path.join(__dirname, '..', '..', 'csb-security', 'data', 'yilan-user-key.pem')));

if (fs.existsSync(out) && !has('--force')) {
  console.error(`❌ 已存在密钥库: ${out}\n   如需覆盖请显式加 --force（旧私钥将被替换，已签发的 UAC 仍可用旧公钥验证）`);
  process.exit(1);
}

let ks;
if (fromPemRaw) {
  const pem = (fromPemRaw === 'anchor') ? ANCHOR_PEM : path.resolve(fromPemRaw);
  if (!fs.existsSync(pem)) {
    console.error(`❌ 找不到 PEM: ${pem}`);
    process.exit(1);
  }
  ks = tk.importUserKeyFromPem(pem, { kid: kid || 'user-yilan' });
  if (fromPemRaw === 'anchor' && fs.existsSync(ANCHOR_PUB)) {
    const anchorJwk = tk.readJsonSafe(ANCHOR_PUB);
    const same = anchorJwk && anchorJwk.x === ks.publicJwk.x;
    console.log(`🔗 对账既有锚钥 ${ANCHOR_PUB}: ${same ? '✅ 一致' : '⚠️ 不一致（请人工核对）'}`);
  }
} else {
  if (fs.existsSync(ANCHOR_PEM)) {
    console.warn(
      `⚠️  本机存在既有锚钥（${ANCHOR_PEM}），你却在进行「生成新钥」模式。\n` +
      `    新钥**没有归属证据链** —— 收货方无法与既有身份对账（阿轩 2026-09-15 踩到这个坑）。\n` +
      `    若要复用锚钥，请改跑: node scripts/uac-keygen.js --from-pem anchor --kid user-yilan --force`
    );
  }
  ks = tk.generateUserKey({ kid });
}

tk.writeJson(out, ks, { mode: 0o600 });

// 另存「只含公钥」的文件：这份才是**可以外发**给接收方登记的
const pubPath = out.replace(/\.json$/, '') + '.pub.json';
tk.writeJson(pubPath, ks.publicJwk, { mode: 0o644 });

const tp = tk.thumbprint(ks.publicJwk);

if (has('--json')) {
  console.log(JSON.stringify({ path: out, pubPath, kid: ks.kid, publicJwk: ks.publicJwk, thumbprint: tp }, null, 2));
} else {
  console.log(`✅ 主人密钥就绪（本地，600）`);
  console.log(`   密钥库（含私钥，勿外传）: ${out}`);
  console.log(`   kid : ${ks.kid}${ks.importedFrom ? `（导入自 ${ks.importedFrom}）` : '（**新生成**）'}`);
  console.log(`\n📤 公钥（可外发登记）: ${pubPath}`);
  console.log(JSON.stringify(ks.publicJwk, null, 2));
  console.log(`\n🔖 锚指纹（RFC 7638 · SHA-256）: ${tk.formatThumbprint(tp)}`);
  console.log(`   ${tp}`);
  console.log(`   （把这个指纹交给人—人带外核对；收货方登记的钥指纹必须与它一致）`);
  console.log(`\n⚠️  私钥只在密钥库里（.uac/ 已 gitignore）；对外只发 .pub.json 那份。`);
}
