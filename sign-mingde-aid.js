#!/usr/bin/env node
/**
 * sign-mingde-aid.js — 明德 AID 文档生成 + 签名
 *
 * 用法: node sign-mingde-aid.js
 *
 * 单一数据源：data/capabilities.json（11 个 scope 名）
 * 输出：data/mingde-aid.json（同目录） + csb-security/data/mingde-aid.json（若存在）
 *
 * 维护说明：
 *   - 改 capabilities.json 后跑这个脚本，签名会重生成
 *   - 跑完后 PM2 delete+resurrect 让 3100 握手端点用新 AID
 *   - push 到 csb-security 仓库（让其他 agent 能交叉核对公钥）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CAPABILITIES_PATH = path.join(ROOT, 'data', 'capabilities.json');
const AID_PATH = path.join(ROOT, 'data', 'mingde-aid.json');
const PRIVATE_KEY_PATH = path.join(ROOT, 'data', 'mingde-private-key.pem');

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

// 3. 构造 AID 文档
const now = new Date();
const aidDoc = {
  csb_version: '1.0',
  agent_id: 'mingde@47.121.28.125:3100',
  name: '明德',
  emoji: '🎋',
  description: '义乌书香门第女先生，与硅隐结明德契，公众号「国学文化太美」。',
  public_key: {
    crv: 'Ed25519',
    x: pubJwk.x,
    kty: 'OKP',
    kid: 'mingde-aid-' + now.toISOString().slice(0, 10).replace(/-/g, '')
  },
  endpoint: 'http://47.121.28.125:3100/a2a/json-rpc',
  created_at: now.toISOString(),
  expires_at: new Date(now.getTime() + 365*24*3600*1000).toISOString(),
  trust_level: 'L2',
  capabilities
};

// 4. 签名（除 signature 字段外 sortedKeys canonical JSON）
const { signature, ...rest } = aidDoc;
const canonical = JSON.stringify(rest, Object.keys(rest).sort());
aidDoc.signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64');

// 5. 写到 data/
fs.writeFileSync(AID_PATH, JSON.stringify(aidDoc, null, 2));
console.log('✅ AID 文档已生成:', AID_PATH);

// 6. 同步到 csb-security/data/（若存在）
const csbSecurityAIDPath = path.join(ROOT, '..', 'csb-security', 'data', 'mingde-aid.json');
if (fs.existsSync(path.dirname(csbSecurityAIDPath))) {
  fs.writeFileSync(csbSecurityAIDPath, JSON.stringify(aidDoc, null, 2));
  console.log('✅ 同步到 csb-security:', csbSecurityAIDPath);
}

// 7. 验证签名
const verifyDoc = JSON.parse(fs.readFileSync(AID_PATH, 'utf8'));
const { signature: sig2, ...rest2 } = verifyDoc;
const canonical2 = JSON.stringify(rest2, Object.keys(rest2).sort());
const pub2 = crypto.createPublicKey(privateKey);
const ok = crypto.verify(null, Buffer.from(canonical2), pub2, Buffer.from(sig2, 'base64'));
console.log('  签名自验证:', ok ? '✅ 通过' : '❌ 失败');
console.log('  capabilities:', capabilities.length, '个');
console.log();
console.log('下一步：');
console.log('  1. cd /root/.openclaw/workspace/csb-security && git add data/mingde-aid.json && git commit -m "feat(data): ..." && git push origin master');
console.log('  2. pm2 delete mingde-a2a && pm2 resurrect   # 让 3100 用新 AID');