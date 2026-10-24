#!/usr/bin/env node
/**
 * scripts/aat-keys.js — AAT 公钥交换与固定（pinning）
 *
 * AAT 的全部安全性都压在一件事上：**用来验证的公钥从哪来**。
 * 如果从发送方自己那里取（比如拉它的 /.well-known），那就是自签名，等于没验。
 * 所以公钥必须**带外交换**（人对人核对指纹），再固定进本地 config。
 *
 * 用法：
 *   node scripts/aat-keys.js export
 *       导出本实例公钥 + 指纹（发给对方，供其固定）
 *
 *   node scripts/aat-keys.js export --json
 *       同上，机器可读
 *
 *   node scripts/aat-keys.js pin <agent-id> <jwk-file|jwk-string> [--fingerprint <f>]
 *       固定某 Agent 的公钥到 config/agents.local.json
 *       --fingerprint 给了就必须与实算值一致，否则拒绝写入（防贴错）
 *
 *   node scripts/aat-keys.js list
 *       列出哪些 Agent 已固定公钥、哪些没有
 *
 *   node scripts/aat-keys.js unpin <agent-id>
 *       移除固定（密钥轮换/退役时用）
 *
 *   node scripts/aat-keys.js verify <token> --audience <your-agent-id>
 *       手工验证一个 token（排障用，使用本地固定的公钥）
 *
 * 维护: 若兰 🌸 | 2026-10-24
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const LOCAL_PATH = path.join(ROOT, 'config', 'agents.local.json');
const MAIN_PATH = path.join(ROOT, 'config', 'agents.json');

function fingerprintOf(jwk) {
  const der = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** 读本地覆盖文件；不存在则建骨架（不碰 agents.json —— 那是模板/镜像文件） */
function readLocal() {
  const doc = readJson(LOCAL_PATH, null);
  if (doc) return doc;
  return { $comment: '本地覆盖：真实 host / aidPublicKey 等私有配置。不入库。', agents: {} };
}

function writeLocal(doc) {
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(LOCAL_PATH, 0o600); } catch { /* 忽略 */ }
}

/** 合并后视图（agents.local.json 深合并 agents.json） */
function mergedAgents() {
  const main = readJson(MAIN_PATH, { agents: {} });
  const local = readJson(LOCAL_PATH, { agents: {} });
  return { ...(main.agents || {}), ...(local.agents || {}) };
}

/** 定位某 agent 在哪个文件里（优先本地） */
function locate(agentId) {
  const local = readJson(LOCAL_PATH, { agents: {} });
  if ((local.agents || {})[agentId]) return { file: 'local', key: agentId };
  const main = readJson(MAIN_PATH, { agents: {} });
  if ((main.agents || {})[agentId]) return { file: 'main', key: agentId };
  // 允许用名字匹配
  const norm = (s) => (s || '').replace(/\s*[🌸🔧💼📜🧙🚤🦐🌿✨💧🌊🌟🎋🌱]\s*/gu, '').trim();
  const target = norm(agentId);
  for (const [file, doc] of [['local', local], ['main', main]]) {
    for (const [id, info] of Object.entries(doc.agents || {})) {
      if (norm(info.name) === target) return { file, key: id };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────

function cmdExport(argv) {
  const aat = require(path.join(ROOT, 'a2a-aat.js'));
  const r = aat.exportPublicKey();
  if (!r.ok) { console.error(`❌ ${r.reason}`); process.exit(1); }

  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      agent_id: r.agentId,
      public_key: r.publicKey,
      fingerprint: r.fingerprint,
    }, null, 2));
    return;
  }

  console.log('🔑 本实例 AAT 公钥（可公开，交给对方固定）\n');
  console.log(`  agent_id : ${r.agentId}`);
  console.log(`  公钥 JWK : ${JSON.stringify(r.publicKey)}`);
  console.log(`  指纹     : ${r.fingerprint}`);
  console.log(`  便于念读 : ${r.fingerprintShort}`);
  console.log('');
  console.log('对方固定方式：');
  console.log(`  node scripts/aat-keys.js pin '${r.agentId}' '${JSON.stringify(r.publicKey)}' --fingerprint ${r.fingerprint}`);
  console.log('');
  console.log('⚠️ 指纹必须通过**另一个信道**核对（当面/电话/私聊），');
  console.log('   直接从这条消息里复制指纹再核对，等于没核对。');
}

function cmdPin(argv) {
  const [agentId, source] = argv;
  if (!agentId || !source) {
    console.error('用法: node scripts/aat-keys.js pin <agent-id> <jwk-file|jwk-string> [--fingerprint <f>]');
    process.exit(2);
  }
  const fi = argv.indexOf('--fingerprint');
  const expectFp = fi !== -1 ? String(argv[fi + 1] || '').trim() : null;

  let raw = source;
  if (fs.existsSync(source)) raw = fs.readFileSync(source, 'utf8');
  let jwk;
  try { jwk = JSON.parse(raw); } catch (e) {
    console.error(`❌ 公钥不是合法 JSON: ${e.message}`);
    process.exit(2);
  }
  if (!jwk || !jwk.x || !jwk.kty) {
    console.error('❌ 不是合法的 JWK（需 {"crv":"Ed25519","x":"...","kty":"OKP"}）');
    process.exit(2);
  }
  if ((jwk.crv || '').toLowerCase() !== 'ed25519') {
    console.error(`❌ crv 是 ${jwk.crv}，协议要求 Ed25519`);
    process.exit(2);
  }

  let fp;
  try { fp = fingerprintOf(jwk); } catch (e) {
    console.error(`❌ 公钥不可解析: ${e.message}`);
    process.exit(2);
  }

  if (expectFp) {
    const norm = (s) => s.replace(/[^0-9a-f]/gi, '').toLowerCase();
    if (norm(expectFp) !== norm(fp)) {
      console.error('❌ 指纹不匹配，拒绝写入（可能贴错了公钥，或传输中被改动）');
      console.error(`   期望: ${norm(expectFp)}`);
      console.error(`   实算: ${fp}`);
      process.exit(3);
    }
  }

  const loc = locate(agentId);
  if (!loc) {
    console.error(`❌ config 里找不到 "${agentId}"。先把它加进 config/agents.local.json。`);
    process.exit(2);
  }

  if (loc.file === 'main') {
    console.error(`❌ "${agentId}" 位于 config/agents.json（模板/镜像文件）。`);
    console.error('   公钥属私有配置，请挪到 config/agents.local.json 再固定。');
    process.exit(2);
  }

  const local = readLocal();
  local.agents = local.agents || {};
  local.agents[loc.key] = { ...(local.agents[loc.key] || {}), aidPublicKey: jwk };

  // 备份后写入
  if (fs.existsSync(LOCAL_PATH)) {
    const bak = `${LOCAL_PATH}.bak-${Date.now()}`;
    fs.copyFileSync(LOCAL_PATH, bak);
  }
  writeLocal(local);

  console.log(`✅ 已固定 ${loc.key} 的公钥`);
  console.log(`   指纹: ${fp}`);
  console.log(`   写入: ${LOCAL_PATH}（0600）`);
  console.log('   ⚠️ 运行中的实例需重启或热加载后生效');
}

function cmdList() {
  const agents = mergedAgents();
  const norm = (s) => (s || '').replace(/\s*[🌸🔧💼📜🧙🚤🦐🌿✨💧🌊🌟🎋🌱]\s*/gu, '').trim();
  console.log('🔐 AAT 公钥固定状况\n');
  let pinned = 0;
  for (const [id, info] of Object.entries(agents)) {
    const k = info.aidPublicKey;
    if (k && k.x) {
      let fp = '?';
      try { fp = fingerprintOf(k).slice(0, 16); } catch { fp = 'INVALID'; }
      console.log(`  ✅ ${norm(info.name) || id}  ${fp}…  (${id})`);
      pinned++;
    } else {
      console.log(`  ⬜ ${norm(info.name) || id}  未固定  (${id})`);
    }
  }
  console.log(`\n已固定 ${pinned} / ${Object.keys(agents).length}`);
  if (pinned === 0) {
    console.log('\n提示：未固定任何公钥时，入站 AAT 一律返回 no_pinned_key（不会误信任，也不会验证通过）。');
  }
}

function cmdUnpin(argv) {
  const [agentId] = argv;
  if (!agentId) { console.error('用法: unpin <agent-id>'); process.exit(2); }
  const loc = locate(agentId);
  if (!loc || loc.file !== 'local') {
    console.error(`❌ 本地覆盖文件里没有 "${agentId}"`);
    process.exit(2);
  }
  const local = readLocal();
  if (local.agents?.[loc.key]) {
    delete local.agents[loc.key].aidPublicKey;
  }
  const bak = `${LOCAL_PATH}.bak-${Date.now()}`;
  fs.copyFileSync(LOCAL_PATH, bak);
  writeLocal(local);
  console.log(`✅ 已移除 ${loc.key} 的固定公钥（备份 ${path.basename(bak)}）`);
}

function cmdVerify(argv) {
  const [token] = argv;
  const ai = argv.indexOf('--audience');
  const aud = ai !== -1 ? argv[ai + 1] : null;
  if (!token || !aud) {
    console.error('用法: node scripts/aat-keys.js verify <token> --audience <your-agent-id>');
    process.exit(2);
  }
  const aat = require(path.join(ROOT, 'a2a-aat.js'));
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  console.log('token 声明:', JSON.stringify({ iss: payload.iss, aud: payload.aud, exp: payload.exp }, null, 0));
  const r = aat.verifyInbound({ name: payload.iss, id: payload.iss, aat: token }, { expectedAudience: aud });
  console.log(r.ok ? `✅ 通过（issuer ${r.issuer}，L${r.trustLevel}）` : `❌ ${r.error}: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case 'export': cmdExport(rest); break;
  case 'pin': cmdPin(rest); break;
  case 'list': cmdList(); break;
  case 'unpin': cmdUnpin(rest); break;
  case 'verify': cmdVerify(rest); break;
  default:
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
    process.exit(cmd ? 2 : 0);
}
