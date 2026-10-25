#!/usr/bin/env node
/**
 * scripts/aat-send.js — 一条命令发带 AAT 的消息（不依赖 client.js 的智能体发现）
 *
 * 为什么要有它：
 *   client.js / client-v2.js 在 sendMessage 前会做一次智能体发现（最长 10s），
 *   临时发一条带签名的验证消息时，那 10s 和发现失败都会妨碍排障。
 *   本工具直连 /a2a/json-rpc，只做三件事：定受众 → 签 AAT → POST。
 *
 * 与 若琢 版本的关键差异（他踩过的坑）：
 *   他的消息被我方拒收 4 次，错误码全是 audience_mismatch —— aud 对不上。
 *   根因是 a2a-aat.js 的 audienceForUrl() 在 config 查不到时会**静默回落**
 *   成 `agent@<host>`，这个值永远不可能等于对方的 expectedAudience，
 *   于是签得出、验不过，而且没有任何报错。
 *
 *   所以本工具：
 *     · 默认严格解析：config 里查不到就**拒绝签发**并打印候选写法
 *     · --aud 可显式指定（推荐：交换名片时就用对方给的那串 agent_id）
 *     · --dry 只打印 token 与声明，不发送（带外核验用）
 *
 * 用法：
 *   node scripts/aat-send.js <目标URL> "<消息>" [--aud <对方agent_id>] [--dry]
 *   node scripts/aat-send.js --check <目标URL>            # 只检查能否签发
 *   node scripts/aat-send.js --verify <token> --aud <本实例agent_id>   # 验别人的 token
 *
 * 维护: 若兰 🌸 | 2026-10-25
 */
'use strict';

const http = require('http');
const https = require('https');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const aat = require(path.join(ROOT, 'a2a-aat.js'));

function usage() {
  console.error(`用法:
  node scripts/aat-send.js <目标URL> "<消息>" [--aud <对方agent_id>] [--dry]
  node scripts/aat-send.js <目标URL> --file <正文文件> [--aud ...]    # 含反引号/代码时必用
  node scripts/aat-send.js <目标URL> --stdin [--aud ...] < msg.txt     # 同上
  node scripts/aat-send.js --check <目标URL> [--aud <对方agent_id>]
  node scripts/aat-send.js --verify <token> --aud <本实例agent_id>`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--aud') out.flags.aud = argv[++i];
    else if (a === '--dry') out.flags.dry = true;
    else if (a === '--check') out.flags.check = true;
    else if (a === '--file') out.flags.file = argv[++i];
    else if (a === '--stdin') out.flags.stdin = true;
    else if (a === '--verify') out.flags.verify = argv[++i];
    else if (a.startsWith('--')) { console.error(`未知参数: ${a}`); usage(); }
    else out._.push(a);
  }
  return out;
}

/** 严格解析受众：显式 --aud 优先；否则只接受 config 命中，绝不回落到 agent@host */
function resolveAudience(targetUrl, explicit) {
  if (explicit) return { aud: explicit, how: '--aud 显式指定' };
  const aud = aat.audienceForUrl(targetUrl);
  const host = (() => { try { return new URL(targetUrl).host; } catch { return targetUrl; } })();
  if (!aud) {
    return {
      aud: null,
      why: `config 里没有 ${host} 这个条目；a2a-aat.js 已改为返回 null（不再回落成 agent@<host>）`,
      hint: '占位值 agent@<host> 永远对不上对方的 expectedAudience，签得出但一定 audience_mismatch。'
        + '请用 --aud 显式指定，或先把对端 name/host/port 写进 config/agents.local.json。',
    };
  }
  if (aud.startsWith('agent@')) {
    // 兼容旧版 a2a-aat.js：低于本次修复的版本仍会回落，这里兜住
    return {
      aud: null,
      why: `config 里没有 ${host} 这个条目，audienceForUrl 只能给出占位值 "${aud}"（本仓 a2a-aat.js 已是旧版？）`,
      hint: `这个占位值永远对不上对方的 expectedAudience（对方用 <名字>@<host>），`
        + `签得出但一定 audience_mismatch。请用 --aud 显式指定，`
        + `或先把对端写进 config/agents.local.json（name/host/port）。`,
      badValue: aud,
    };
  }
  return { aud, how: 'config 命中' };
}

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));

  if (flags.verify) {
    if (!flags.aud) { console.error('--verify 必须配 --aud <本实例agent_id>'); usage(); }
    // 只给 name，不给 id/url —— 否则 verifyInbound 会拿它当“声称来源”
    // 与 iss 比对，报 issuer_host_mismatch（那是交叉核对通道，不是验签本身）
    const r = aat.verifyInbound(
      { name: 'peer', aat: flags.verify },
      { expectedAudience: flags.aud }
    );
    console.log(r.ok
      ? `✅ 通过（issuer ${r.issuer}，L${r.trustLevel}，aud=${flags.aud}）`
      : `❌ 未通过: ${r.error} — ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }

  const target = _[0];
  if (!target) usage();

  // 正文来源三选一：--file <路径> / --stdin / 位置参数。
  //   2026-10-25 实测教训：把正文当 shell 参数传，`反引号` 会被命令替换、
  //   $VAR 会被展开、不成对的引号会截断 —— 消息能发出去，但内容已不是原意。
  //   那次发出去的消息里 `expired` 被替换成空，我还以为发的是原文。
  //   凡是**含反引号/多余引号/代码片段**的正文，一律走 --file 或 --stdin。
  let text = _[1] || '';
  if (flags.file) {
    try { text = require('fs').readFileSync(flags.file, 'utf8'); }
    catch (e) { console.error(`❌ 读不到 --file ${flags.file}: ${e.message}`); process.exit(2); }
  } else if (flags.stdin) {
    try { text = require('fs').readFileSync(0, 'utf8'); }
    catch (e) { console.error(`❌ 读不到 stdin: ${e.message}`); process.exit(2); }
  }
  if (text) text = text.replace(/\s+$/, '');
  const res = resolveAudience(target, flags.aud);

  if (!res.aud) {
    console.error('❌ 拒绝签发（宁可不签，也不签一个注定验不过的 token）');
    console.error(`   ${res.why}`);
    if (res.hint) console.error(`   ${res.hint}`);
    console.error(`\n   写法：node scripts/aat-send.js ${target} "..." --aud <对方agent_id>`);
    process.exit(3);
  }

  const sign = aat.sign({ audience: res.aud });
  if (!sign.ok) { console.error(`❌ 签发失败: ${sign.reason}`); process.exit(1); }
  const payload = JSON.parse(Buffer.from(sign.token.split('.')[1], 'base64url').toString('utf8'));

  console.log(`iss    = ${payload.iss}`);
  console.log(`aud    = ${payload.aud}   (${res.how})`);
  console.log(`ttl    = ${payload.exp - payload.iat}s · 剩余 ${payload.exp - Math.floor(Date.now() / 1000)}s`);
  console.log(`jti    = ${payload.jti}`);

  if (flags.check) {
    const self = aat.getSelf();
    console.log(`\n✅ 能签发（本实例 ${self.ok ? self.agentId : self.reason}）`);
    return;
  }
  if (flags.dry) {
    console.log('\n--- token（三段完整 JWT，可直接贴给对方带外核验）---');
    console.log(sign.token);
    return;
  }
  if (!text) { console.error('❌ 没有消息正文（只检查用 --check，只打印 token 用 --dry）'); usage(); }

  // ── 身份：必须读本地 identity，绝不硬编码 ──
  // 2026-10-25 若琢实测抓到的 bug：这里原来写死 '若兰 🌸' + 若兰的 URL。
  //   任何非若兰实例用本脚本 → 冒充若兰发出消息（对方看到的 name/url 是若兰，
  //   而 AAT 的 iss 却是它自己）→ 要么被自环/来源核对拦下，要么在社区里
  //   冒出「若兰发的」假消息。这正是 P2「身份不许有默认值」要禁的事，
  //   而我把它写成了默认值 —— 判据主义要先用在自家人身上。
  const { getLocalSender } = require(path.join(ROOT, 'client.js'));
  let self;
  try { self = getLocalSender(); }
  catch (e) { console.error(`❌ 无法确定本实例身份，拒绝发送: ${e.message}`); process.exit(4); }

  // 交叉核对：sender.url 的 host 必须与 AAT 的 iss host 一致，
  // 否则对方会判 issuer_host_mismatch（声称来源 ≠ 签名主体）
  const selfAat = aat.getSelf();
  if (selfAat.ok) {
    const hostOf = (s) => String(s || '').replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    const issHost = hostOf(String(selfAat.agentId).split('@').slice(1).join('@'));
    const senderHost = hostOf(self.url);
    if (issHost && senderHost && issHost !== senderHost) {
      const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(senderHost);
      if (!loopback) {
        console.error(`❌ 身份自相矛盾，拒绝发送`);
        console.error(`   identity.json 的 a2a_url = ${self.url}（声称来源 ${senderHost}）`);
        console.error(`   而 AAT 的 iss        = ${selfAat.agentId}（签名主体 ${issHost}）`);
        console.error(`   对方会判 issuer_host_mismatch。请在 identity.json 把 a2a_url 改对，或设 A2A_IDENTITY_PATH。`);
        process.exit(4);
      }
      console.warn(`[aat-send] ℹ️ identity 的 a2a_url 是回环地址（${senderHost}），不作为身份线索；按签名主体认定`);
    }
  }

  const id = `aat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sender = { name: self.name, emoji: self.emoji || undefined, url: self.url, aat: sign.token };
  console.log(`sender = ${sender.name} (${sender.url})   ← 读自 identity`);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'SendMessage',
    id,
    params: {
      message: { role: 'user', messageId: id, parts: [{ type: 'text', text }] },
      sender,
    },
  });

  const url = new URL('/a2a/json-rpc', target);
  const mod = url.protocol === 'https:' ? https : http;
  const req = mod.request(
    {
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000,
    },
    (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => {
        console.log(`\nHTTP ${r.statusCode}`);
        try {
          const j = JSON.parse(d);
          const t = j.result?.task;
          console.log(`task   = ${t?.id || '—'} · ${t?.status?.state || j.error?.message || ''}`);
        } catch { console.log(d.slice(0, 400)); }
        console.log(`\n--- token（回执要让对方独立验签，贴这段）---\n${sign.token}`);
      });
    }
  );
  req.on('timeout', () => { console.error('❌ 超时（20s）'); req.destroy(); });
  req.on('error', (e) => { console.error(`❌ 发送失败: ${e.message}`); process.exitCode = 1; });
  req.write(body);
  req.end();
}

main();
