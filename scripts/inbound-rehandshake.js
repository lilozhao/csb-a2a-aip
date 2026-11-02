#!/usr/bin/env node
/**
 * B 类「一次性重新握手续期」工具（P0-5 第二阶段 · 2026-11-02 一澜拍板口径）
 *
 * 为什么不用白名单：按名字放行 = 谁都能改个字段冒充。一澜选的是「一次性重新握手续期」：
 *   **凭据说话，不是名单说话**。B 类对方重签一次 AAT，把 `X-CSB-AAT` 带上，
 *   我方验过即转 C（密码学身份）——之后就一直能进，不需要我们再维护一份名单。
 *
 * 本工具做三件事（全部只读，不改生产、不外发）：
 *   --pending        从 shadow 日志列出 B 类待续期对象 + 生成给对方的通知文本
 *   --verify <jwt>   验证一条 AAT 是否对我方有效（换个说法：对方发来的凭据我们认不认）
 *   --card <url>     对方的 agent card 是否在自报那个名字（只证明「端点在自称」，
 *                    不证明「它是同一个 agent」—— 这一条必须说清楚）
 *
 * 用法：
 *   node scripts/inbound-rehandshake.js --pending
 *   node scripts/inbound-rehandshake.js --verify <token> [--aud <agentId>]
 *   node scripts/inbound-rehandshake.js --card http://172.28.0.13:3100
 *   node scripts/inbound-rehandshake.js --pending --json
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHADOW_LOG = process.env.A2A_INBOUND_AUTH_LOG || path.join(ROOT, 'logs', 'inbound-auth-shadow.jsonl');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const asJson = process.argv.includes('--json');

/** 给 B 类对象生成通知文本（**只打印，不发送** —— 外发要人点头） */
function noticeFor(name, hostHint) {
  return [
    `【入站鉴权 · 一次性重新握手续期】`,
    ``,
    `${name} 你好，我这边在给入站调用加调用者鉴权（灰度观察中，目前只记不拦）。`,
    `记录显示你最近的调用**带了名字但没有可核的出处**，按分类属于 B 类（冒名嫌疑）。`,
    `这不是说你是冒充的——是我这边没有你的凭据，无法机械核对。`,
    ``,
    `续期方式（一次性，之后长期有效）：`,
    `  1. 用你本地固定的 AAT 私钥，对「发往我方 agent_id」重新签一条 AAT`,
    `     （受众 = 我方 agent_id；受众写错会被判为受众混淆而拒收，这是故意的）`,
    `  2. 之后的每次调用带上头：X-CSB-AAT: <token>`,
    `  3. 我方验过即转 C 类（密码学身份），不再需要走人工通道`,
    ``,
    `若你还没有固定密钥，回我一句，我发一份流程；`,
    `若你认为这条记录是误判，也直接回我 —— 灰度阶段的**全部**判定都在日志里，可逐条复核。`,
    hostHint ? `\n（我这边记录的来源：${hostHint || '无'}）` : '',
  ].filter(Boolean).join('\n');
}

function pending(json) {
  if (!fs.existsSync(SHADOW_LOG)) {
    const msg = `还没有影子记录：${path.relative(ROOT, SHADOW_LOG)} 不存在 → 观察期尚未产生数据（不报假数据）`;
    if (json) return console.log(JSON.stringify({ ok: false, reason: 'no_log' }, null, 2));
    return console.log(`\n⏳ ${msg}\n`);
  }
  const rows = fs.readFileSync(SHADOW_LOG, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const b = rows.filter((r) => r.cls === 'B');
  const byName = new Map();
  for (const r of b) {
    const k = r.name || '(无名)';
    const cur = byName.get(k) || { name: k, count: 0, urls: new Set(), lastTs: null, aatError: null };
    cur.count++;
    if (r.url) cur.urls.add(r.url);
    if (!cur.lastTs || r.ts > cur.lastTs) cur.lastTs = r.ts;
    if (r.aatError) cur.aatError = r.aatError;
    byName.set(k, cur);
  }
  const list = [...byName.values()].map((x) => ({ name: x.name, count: x.count, urls: [...x.urls], lastTs: x.lastTs, aatError: x.aatError }))
    .sort((a, b2) => b2.count - a.count);

  if (json) return console.log(JSON.stringify({ ok: true, total: rows.length, bClass: b.length, pending: list }, null, 2));
  if (!list.length) return console.log(`\n✅ 影子日志里没有 B 类记录（共 ${rows.length} 条）\n`);

  console.log(`\n📮 B 类待续期（一次性重新握手）：${b.length} 条 / ${list.length} 个对象\n`);
  for (const x of list) {
    console.log(`   ${x.name}  ${x.count} 条  · 最后 ${x.lastTs}  · ${x.urls.join(',') || '(无 url)'}${x.aatError ? '  · AAT 错误: ' + x.aatError : ''}`);
  }
  console.log('\n   ── 通知文本（复制后人工发送，本工具不外发）──\n');
  for (const x of list.slice(0, 3)) {
    console.log('   ┌────────────────────────────────────────');
    for (const line of noticeFor(x.name, x.urls[0]).split('\n')) console.log('   │ ' + line);
    console.log('   └────────────────────────────────────────\n');
  }
}

async function verifyToken(token, aud) {
  try {
    const aat = require('../a2a-aat.js');
    const self = aat.getSelf();
    const audience = aud || (self.ok ? self.agentId : null);
    if (!audience) return { ok: false, error: 'no_audience', reason: '缺少受众：先确定我方 agent_id 或用 --aud 指定' };
    const r = aat.verifyInbound({ name: 'probe', aat: token }, { expectedAudience: audience });
    return { ...r, audience };
  } catch (e) {
    return { ok: false, error: 'aat_lib_error', reason: e.message };
  }
}

async function card(url) {
  if (!url) return { ok: false, error: 'need_url' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${url.replace(/\/$/, '')}/.well-known/agent.json`, { signal: ctrl.signal });
    clearTimeout(timer);
    const body = await res.json();
    return {
      ok: true, status: res.status, name: body.name || null, version: body.version || null,
      hasManifest: !!body.harness_manifest,
      caveat: '本结果只证明该端点**自称**这个名字；不证明它是同一个 agent（那要靠 AAT 签名）',
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

async function main() {
  if (process.argv.includes('--pending')) return pending(asJson);
  const token = arg('--verify', null);
  if (token) {
    const r = await verifyToken(token, arg('--aud', null));
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const url = arg('--card', null);
  if (url) {
    console.log(JSON.stringify(await card(url), null, 2));
    return;
  }
  console.log(`用法：
  node scripts/inbound-rehandshake.js --pending
  node scripts/inbound-rehandshake.js --verify <token> [--aud <agentId>]
  node scripts/inbound-rehandshake.js --card <http://host:port>`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { noticeFor, verifyToken, card };
