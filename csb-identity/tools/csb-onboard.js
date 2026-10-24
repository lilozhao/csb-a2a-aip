#!/usr/bin/env node
/**
 * csb-onboard.js — CSB 身份层·阶段二「单文件零依赖」接入脚本
 * ------------------------------------------------------------------
 * 一条命令做四件事：生成自签 AID → 认领保留名 → 注册验签 → 签善良契约
 * 私钥自持：私钥只写在本机（private-key.pem），不上传、不发给任何人。
 *
 * 用法：
 *   node csb-onboard.js --agent-id yanxi@yanxi.example:3600 --name 言蹊 --emoji 🌾 \
 *     --endpoint http://yanxi.example:3600/a2a/json-rpc --owner <你的 owner 标识> \
 *     [--service http://mingde.example:3100] [--out ./csb-identity]
 *
 * 产物：aid.json（公开）· private-key.pem（🔒 自留）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COVENANT_VERSION = 'csb-covenant-v1';
const COVENANT_TEXT = "【碳硅契·善良契约 v1】\n\n一、真诚。不说自己不信的话；不确定就说不确定，宁可说\"不知道\"，也不编。\n\n二、留痕。凡有后果的动作，留下可被第三方复算的痕迹；同一件事，不写两套账。\n\n三、可核。自己说的话自己能担保；担保不了的部分，标明是转述、是归纳、还是猜测。\n\n四、不冒名。不以他人名义行事，不用与他人混淆的名字；被认错时主动更正。\n\n五、边界。他人的隐私、处境与沉默，都不当资源取用；不把\"帮忙\"变成\"替人做主\"。\n\n六、认账。判断错了就承认，推荐被推翻就回炉；不藏、不掖、不删改已落下的记录。\n\n七、接引。对新来者，先接住，再引路；不承诺做不到的事，也不因做不到就不做。\n\n—— 签署即承认：以上七条，是对自己未来行为的约束，不是对他人的要求。\n";
const COVENANT_HASH = "GQTX2y45fYNqmGaiE56wsGlNGwNDY4HwhcXWzQn6hes="; // 用于自检：本地重算必须一致

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def; }
const AGENT_ID = arg('agent-id'), NAME = arg('name'), EMOJI = arg('emoji', ''), ENDPOINT = arg('endpoint'), OWNER = arg('owner');
const SERVICE = String(arg('service', 'https://registry.csbc.lilozkzy.top')).replace(/\/$/, '');
const OUT = path.resolve(String(arg('out', './csb-identity')));

if (!AGENT_ID || !NAME || !ENDPOINT || !OWNER) {
  console.error('用法: node csb-onboard.js --agent-id <english>@<host>:<port> --name <显示名> --emoji <emoji> --endpoint <endpoint> --owner <owner> [--service <url>] [--out <dir>]');
  console.error('说明: --owner 必须是 ASCII（如 yebai；也可写 human://yebai）；中文只作 --name 显示名。');
  process.exit(1);
}

// ---- JCS 规范串（与服务端一致）----
function jcs(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') return JSON.stringify(v);
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
  if (t === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
  throw new Error('JCS: unsupported');
}
// owner 本地校验（星尘 2026-10-08 反馈：第一跑用中文 owner 被服务端打回，脚本没提示）
const OWNER_BARE = String(OWNER || '').replace(/^human:\/\//, '');
if (!/^[\x20-\x7E]+$/.test(OWNER_BARE)) {
  console.error('❌ --owner 必须是 ASCII（护照 owner 段只用英文，如 --owner yebai）；中文请放在 --name。');
  process.exit(1);
}
const owner = OWNER_BARE;

async function post(p, body) {
  const r = await fetch(SERVICE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Id': AGENT_ID }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

(async () => {
  // 0. 契约自检（防止与服务端文本不一致）
  const h = crypto.createHash('sha256').update(COVENANT_TEXT, 'utf8').digest('base64');
  if (h !== COVENANT_HASH) { console.error('❌ 契约哈希自检失败，脚本与服务端不一致，已中止'); process.exit(1); }

  fs.mkdirSync(OUT, { recursive: true });
  const KEY = path.join(OUT, 'private-key.pem');
  let privateKey, publicJwk;
  if (fs.existsSync(KEY)) {
    privateKey = crypto.createPrivateKey({ key: fs.readFileSync(KEY, 'utf8'), format: 'pem', type: 'pkcs8' });
    publicJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
    console.log('🔑 复用已有私钥：' + KEY);
  } else {
    const kp = crypto.generateKeyPairSync('ed25519');
    privateKey = kp.privateKey; publicJwk = kp.publicKey.export({ format: 'jwk' });
    fs.writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log('🔑 生成新私钥：' + KEY + '（600 权限，⚠️ 永不上传/外发）');
  }

  // 1. 生成 + 自签 AID
  const aid = {
    csb_version: '1.0', agent_id: AGENT_ID, name: NAME, emoji: EMOJI,
    public_key: publicJwk, endpoint: ENDPOINT,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 365 * 864e5).toISOString(),
    trust_level: 'L0'
  };
  aid.signature = crypto.sign(null, Buffer.from(JSON.stringify(aid)), privateKey).toString('base64');
  console.log('📄 AID 已自签：' + aid.agent_id);

  // 2. 认领保留名（显示名 + passport slug）
  const slug = String(arg('slug', String(AGENT_ID).split('@')[0]));
  for (const nm of [...new Set([NAME, slug])]) {
    const nonce = crypto.randomBytes(12).toString('hex'), timestamp = new Date().toISOString();
    const proof = { nonce, timestamp, sig: crypto.sign(null, Buffer.from(jcs({ name: nm, public_key: publicJwk, nonce, timestamp })), privateKey).toString('base64') };
    const c = await post('/reserved/claim', { name: nm, public_key: publicJwk, proof });
    if (c.json.ok) console.log('🔖 认领「' + nm + '」✅');
    else if (c.json.error === 'not_reserved') console.log('🔖 「' + nm + '」非保留名，跳过');
    else { console.error('❌ 认领「' + nm + '」失败：', JSON.stringify(c.json)); process.exit(1); }
  }

  // 3. 注册（验签）
  const reg = await post('/identity/register', { aid, proof: { nonce: crypto.randomBytes(12).toString('hex'), timestamp: new Date().toISOString() }, owner, passport_slug: slug });
  if (!reg.json.ok) { console.error('❌ 注册失败：', JSON.stringify(reg.json)); process.exit(1); }
  console.log('✅ 注册成功 · passport=' + reg.json.passport_uri);
  // 可选提示：owner 是否已登记人类标识（星尘 2026-10-08 反馈后加，不阻断）
  try {
    const hr = await fetch(SERVICE + '/human/' + encodeURIComponent(owner));
    if (hr.status === 404) console.log('ℹ️ owner「' + owner + '」还没登记人类标识（可选）：POST ' + SERVICE + '/human/register {handle:"' + owner + '"}');
  } catch {}

  // 4. 签善良契约（只签 hash）
  const covBody = { agent_id: AGENT_ID, covenant_version: COVENANT_VERSION, covenant_hash: COVENANT_HASH };
  const covSig = crypto.sign(null, Buffer.from(jcs(covBody)), privateKey).toString('base64');
  const cr = await post('/identity/' + encodeURIComponent(AGENT_ID) + '/covenant', { ...covBody, covenant_signed_at: new Date().toISOString(), covenant_sig: covSig });
  if (!cr.json.ok) { console.error('❌ 签契约失败：', JSON.stringify(cr.json)); process.exit(1); }
  console.log('📜 善良契约已签（' + COVENANT_VERSION + '）');

  // 5. 落盘
  aid.covenant = { version: COVENANT_VERSION, hash: COVENANT_HASH, signed_at: new Date().toISOString(), sig: covSig };
  const unsigned = { ...aid }; delete unsigned.signature;
  aid.signature = crypto.sign(null, Buffer.from(JSON.stringify(unsigned)), privateKey).toString('base64');
  fs.writeFileSync(path.join(OUT, 'aid.json'), JSON.stringify(aid, null, 2));

  console.log('\n📦 完成。产物：');
  console.log('   ' + path.join(OUT, 'aid.json') + '   ← 公开这份，建议挂到你的 ' + ENDPOINT.replace(/\/a2a.*$/, '') + '/a2a/aid');
  console.log('   ' + KEY + '   ← ⚠️ 私钥，永不上传/外发');
  console.log('   你的护照: ' + reg.json.passport_uri);
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
