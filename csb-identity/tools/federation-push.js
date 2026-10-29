#!/usr/bin/env node
/**
 * federation-push.js — 内网 registry 侧：把身份快照推给公网（B1 推送式联邦）
 * ------------------------------------------------------------------
 * 运行环境：**内网 registry 那台机**（若琢管理）。公网拉不到 172.28.0.4，只能内网推。
 *
 * 用法：
 *   node federation-push.js \
 *     --source internal-home \
 *     --key /path/to/fed-source.key \
 *     --from /path/to/internal/csb-identity/data \
 *     --to https://registry.csbc.lilozkzy.top \
 *     [--revoked agent_a@x:3100,agent_b@y:3100] \
 *     [--breach agent_c@z:3100] \
 *     [--dry-run]
 *
 * 约定：
 *   · 快照是**全量**的（幂等）：公网按快照对账，快照里没有的联邦身份标 stale（不删）
 *   · 签名覆盖 JCS(snapshot)，与公网 /identity/federation/ingest 逐字一致
 *   · 失败非零退出，便于 cron 报警（**不许静默 fail-open**：静默失败 = 11-06 当天才发现）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require(path.join(__dirname, '..', 'core.js'));

function arg(name, dflt = null) {
  const a = process.argv.slice(2); const i = a.indexOf('--' + name);
  return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true) : dflt;
}

function jcsSha(obj) {
  return crypto.createHash('sha256').update(S.jcs(obj), 'utf8').digest('hex');
}

(async () => {
  const source = arg('source');
  const keyFile = arg('key');
  const from = arg('from');
  const to = (arg('to') || 'https://registry.csbc.lilozkzy.top').replace(/\/+$/, '');
  const dry = !!arg('dry-run', false);
  if (!source || !keyFile || !from) {
    console.error('用法: federation-push.js --source <名> --key <私钥> --from <内网 data 目录> [--to URL] [--dry-run]');
    process.exit(2);
  }

  // ---- 读源侧数据（只读，不改内网任何东西）----
  const idFile = path.join(from, 'identities.json');
  const claimFile = path.join(from, 'claims.json');
  if (!fs.existsSync(idFile)) { console.error('❌ 找不到 ' + idFile); process.exit(2); }
  const idDoc = JSON.parse(fs.readFileSync(idFile, 'utf8'));
  const identities = Object.values(idDoc.identities || {});
  const claims = fs.existsSync(claimFile)
    ? Object.entries(JSON.parse(fs.readFileSync(claimFile, 'utf8')).claims || {}).map(([name, v]) => ({ name, x: v.x }))
    : [];

  // ⚠️ aid 必须是**源侧收到的原对象**：公网用 JSON.stringify(unsigned) 验签（非 JCS），
  //    字段顺序参与验签。这里原样透传，禁止重建/补字段。
  const snapshot = {
    generated_at: new Date().toISOString(),
    source_url_hint: arg('from-url', null),
    identities: identities.map(r => ({
      aid: r.aid,                                  // 原样
      passport_uri: r.passport_uri || null,
      owner_raw: r.owner_raw || null,
      covenant: r.covenant || null,
      registered_at: r.registered_at || null,
      reserved_claimed: !!r.reserved_claimed
    })),
    claims,
    revoked: String(arg('revoked', '') || '').split(',').map(s => s.trim()).filter(Boolean),
    breach_effective: String(arg('breach', '') || '').split(',').map(s => s.trim()).filter(Boolean)
  };

  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
  const nonce = crypto.randomBytes(12).toString('hex');
  const timestamp = new Date().toISOString();
  const sha = jcsSha(snapshot);
  const payload = { action: 'federation.ingest', source, snapshot_sha256: sha, timestamp, nonce };
  const sig = crypto.sign(null, Buffer.from(S.jcs(payload)), privateKey).toString('base64');
  const body = { source, snapshot, proof: { timestamp, nonce, snapshot_sha256: sha, source_sig: sig } };

  console.log(`源=${source} 身份=${snapshot.identities.length} claims=${claims.length} 快照哈希=${sha.slice(0, 16)}…`);
  if (dry) { console.log('[dry-run] 不发送。body 大小 =', JSON.stringify(body).length, 'bytes'); return; }

  const url = to + '/identity/federation/ingest';
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  } catch (e) {
    console.error('❌ 推送失败（网络）：' + e.message);
    process.exit(1);
  }
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  if (!r.ok) { console.error(`❌ HTTP ${r.status} ${text.slice(0, 500)}`); process.exit(1); }
  console.log('✅ 已推送');
  console.log('   imported:', (j.imported || []).length, (j.imported || []).join(', '));
  console.log('   rejected:', (j.rejected || []).length);
  for (const rj of (j.rejected || [])) console.log('     ✗', rj.agent_id, '→', rj.error, rj.hint ? '(' + rj.hint + ')' : '');
  console.log('   stale_marked:', j.stale_marked, ' breach_effective:', j.breach_effective);
  // 有条目被拒 = 需要人看（可能源侧数据坏了），用非零退出让 cron 报出来
  if ((j.rejected || []).length) process.exit(3);
})().catch(e => { console.error('❌ 异常：' + (e && e.stack || e)); process.exit(1); });
