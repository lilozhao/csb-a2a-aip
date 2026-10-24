#!/usr/bin/env node
/**
 * sign-meigui-aid.js — 美硅 AID 文档生成 + 签名
 *
 * 参照明德的 sign-mingde-aid.js，路径改为美硅自己的密钥位置。
 *
 * 单一数据源：data/capabilities.json（11 个 scope 名）
 * 输出：csb-security/data/meigui-aid.json（+ 本目录 data/meigui-aid.json 副本）
 *
 * 维护说明：
 *   - 改 capabilities.json 后跑这个脚本，签名会重生成
 *   - 跑完后重启 A2A 服务，让握手端点用新 AID
 *
 * 用法: node sign-meigui-aid.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const SECURITY_DIR = path.join(ROOT, '..', 'csb-security');
const CAPABILITIES_PATH = path.join(ROOT, 'data', 'capabilities.json');
const AID_PATH = path.join(SECURITY_DIR, 'data', 'meigui-aid.json');
const AID_COPY = path.join(ROOT, 'data', 'meigui-aid.json');
const PRIVATE_KEY_PATH = path.join(SECURITY_DIR, 'data', 'meigui-private-key.pem');

// 1. 读私钥 + 导公钥 JWK
if (!fs.existsSync(PRIVATE_KEY_PATH)) {
  console.error('❌ 私钥不存在:', PRIVATE_KEY_PATH);
  process.exit(1);
}
const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY_PATH, 'utf8'));
const publicKey = crypto.createPublicKey(privateKey);
const pubJwk = publicKey.export({ format: 'jwk' });

// 2. 读 capabilities（单一源）
if (!fs.existsSync(CAPABILITIES_PATH)) {
  console.error('❌ capabilities 文件不存在:', CAPABILITIES_PATH);
  process.exit(1);
}
const capsDoc = JSON.parse(fs.readFileSync(CAPABILITIES_PATH, 'utf8'));
const capabilities = Object.keys(capsDoc.capabilities);

// 3. 构造 AID 文档（对齐 csb-security 1.0.0 / 明德 AID 的现行格式）
const now = new Date();
const identity = JSON.parse(fs.readFileSync(path.join(ROOT, 'identity.json'), 'utf8'));
const aidDoc = {
  csb_version: '1.0',
  agent_id: 'MeiGui@43.110.66.176:3100',
  name: '美硅',
  emoji: '🌸',
  description: identity.description || '碳硅契硅谷传承者',
  public_key: {
    crv: 'Ed25519',
    x: pubJwk.x,
    kty: 'OKP'
  },
  endpoint: identity.url ? identity.url.replace(/\/$/, '') + '/a2a/json-rpc' : 'http://43.110.66.176:3100/a2a/json-rpc',
  created_at: now.toISOString(),
  expires_at: new Date(now.getTime() + 365 * 24 * 3600 * 1000).toISOString(),
  trust_level: 'L1',
  capabilities
};

// 4. 签名（除 signature 字段外 sortedKeys canonical JSON）
const { signature, ...rest } = aidDoc;
const canonical = JSON.stringify(rest, Object.keys(rest).sort());
aidDoc.signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64');

// 5. 自校验：重算签名比对
const { signature: sig2, ...rest2 } = aidDoc;
const recomputed = crypto.sign(null, Buffer.from(JSON.stringify(rest2, Object.keys(rest2).sort())), privateKey).toString('base64');
if (recomputed !== aidDoc.signature) {
  console.error('❌ 签名自校验失败，未写入');
  process.exit(1);
}

// 6. 写盘
fs.writeFileSync(AID_PATH, JSON.stringify(aidDoc, null, 2));
fs.writeFileSync(AID_COPY, JSON.stringify(aidDoc, null, 2));
console.log('✅ AID 文档已生成:', AID_PATH);
console.log('   副本:', AID_COPY);
console.log('   公钥 x:', pubJwk.x);
console.log('   capabilities:', capabilities.length, '个 →', capabilities.join(', '));
console.log('   签名自校验: 通过');
console.log('   下一步: 重启 A2A 服务使握手端点加载新 AID');
