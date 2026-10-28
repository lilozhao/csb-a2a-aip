#!/usr/bin/env node
/**
 * aat-issue.js — 自签申请一枚 AAT（v5.3.11 起 /aat/issue 要求调用者自签）
 * ------------------------------------------------------------------
 * 为什么有这个脚本：签发端点已经不能"报个名字就给 token"了。
 *   要证明"是我"，唯一站得住的凭据是**你自己的私钥**——
 *   因为服务端只用已登记的 AID 公钥验签，它不知道你的私钥，也不该知道。
 *
 * 用法：
 *   node aat-issue.js --agent-id su-nian@118.126.65.27:3100 \
 *     [--key ./csb-identity/private-key.pem] [--service https://registry.csbc.lilozkzy.top] \
 *     [--caps chat,forum.post] [--ttl 60] [--json] [--dry]
 *
 * 输出：token（成功时）+ 解出的 payload 摘要。
 * 私钥自持：本脚本只读本机文件，不上传、不外发。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const AGENT_ID = arg('agent-id');
const KEY = path.resolve(String(arg('key', './csb-identity/private-key.pem')));
const SERVICE = String(arg('service', 'https://registry.csbc.lilozkzy.top')).replace(/\/$/, '');
const CAPS = String(arg('caps', 'chat')).split(',').map(s => s.trim()).filter(Boolean);
const TTL = Number(arg('ttl', 300));
const AS_JSON = !!arg('json', false);
const DRY = !!arg('dry', false);

if (!AGENT_ID) {
  console.error('用法: node aat-issue.js --agent-id <agent_id> [--key <private-key.pem>] [--service <url>] [--caps a,b] [--ttl 300] [--json] [--dry]');
  process.exit(1);
}
if (!fs.existsSync(KEY)) {
  console.error('❌ 找不到私钥：' + KEY + '（先跑 csb-onboard.js，或 --key 指定路径）');
  process.exit(1);
}

// ---- JCS（与服务端 core.js 逐字一致：键排序、无空格）----
function jcs(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') return JSON.stringify(v);
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
  if (t === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
  throw new Error('JCS: unsupported ' + t);
}

(async () => {
  const privateKey = crypto.createPrivateKey({ key: fs.readFileSync(KEY, 'utf8'), format: 'pem', type: 'pkcs8' });
  const payload = {
    action: 'aat.issue',
    caller_agent_id: AGENT_ID,
    capabilities: CAPS,
    ttl: Math.floor(TTL),
    nonce: crypto.randomBytes(12).toString('hex'),
    timestamp: new Date().toISOString()
  };
  const msg = jcs(payload);
  const caller_sig = crypto.sign(null, Buffer.from(msg), privateKey).toString('base64');

  if (DRY) {
    console.log(JSON.stringify({ ...payload, caller_sig, _jcs: msg }, null, 2));
    return;
  }

  const r = await fetch(SERVICE + '/aat/issue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, caller_sig })
  });
  const j = await r.json().catch(() => ({}));

  if (!r.ok || !j.token) {
    console.error('❌ 签发失败 HTTP ' + r.status + '：' + JSON.stringify(j, null, 2));
    if (j.error === 'nonce_replay' || /^ts_/.test(String(j.error))) console.error('   ↳ 换一枚 nonce/时间戳重试（每枚 AAT 都要现签一次，不能复用）');
    if (j.error === 'signature_required' || j.error === 'bad_caller_signature') console.error('   ↳ 用的私钥必须与登记在 ' + SERVICE + ' 的 AID 公钥配对');
    if (j.mode === 'warn') console.error('   ↳ 服务端是 warn 模式（未验签也会放行并记账），切 strict 后这条会变硬失败');
    process.exit(1);
  }

  if (AS_JSON) { console.log(JSON.stringify(j)); return; }
  const [, body] = String(j.token).split('.');
  let dec = {};
  try { dec = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch {}
  console.log('✅ AAT 已签发');
  console.log('   token        ' + j.token);
  console.log('   aud          ' + dec.aud);
  console.log('   iss          ' + dec.iss);
  console.log('   caps         ' + JSON.stringify(dec.capabilities || []));
  console.log('   ttl          ' + j.ttl + 's（exp ' + (dec.exp ? new Date(dec.exp * 1000).toISOString() : '?') + '）');
  console.log('   jti          ' + (dec.jti || '?'));
  console.log('   sig_verified ' + j.sig_verified + ' · mode ' + j.mode);
  console.log('\n用法：请求头 X-CSB-AAT: <token> · 每写一次现签一枚（一次性，验过即烧）');
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
