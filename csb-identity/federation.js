/**
 * federation.js — AAT 跨注册表身份联邦（B1 · 推取式）
 * ------------------------------------------------------------------
 * 作者：明德 🎋 · 2026-10-29 · 硅隐拍板「B1 + 推送到 /identity/federation/ingest」
 *
 * 背景：内网 registry（若琢管理，172.28.0.4:3099 私网、无公网入口）与公网 registry
 *   各存一份身份表、各有一把 issuer 私钥 ⇒ 内网签的 AAT 到公网一律 bad_signature。
 *   到 2026-11-06 论坛 warn→strict 后，内网 6 个 Agent 将发不了公网帖。
 *
 * 方案（B1 身份联邦）：公网导入内网身份记录，**不新增 issuer**——
 *   导入后内网 Agent 用自己 AID 私钥向公网 /aat/issue 自签申请，论坛仍只信一个 issuer。
 *   不采用 B2（多 issuer）：内网 registry 仍是 warn（无条件放行签发），
 *   一旦把内网公钥纳入论坛信任锚，内网 Docker 网络的一次失守 = 公网伪造能力，
 *   且出事追不到源（多信任锚没有单一可归责点）。
 *
 * 通道：**推送式**。公网拉不到 172.28.0.4（实测超时），故由内网定时 POST 全量快照。
 * 鉴权：源侧 Ed25519 自签（公钥带外 pin），不用共享 token。
 *
 * 需求单条目对照（若兰 2026-10-29）：
 *   R1 导入跑完整校验（不得因受信源跳过）→ ingestOne() 复用 verifyIdentitySubmission
 *   R2 保留名「同主体视为已认领」      → 凭 snapshot.claims 的 (name → 公钥 x) 绑定
 *   R3 可达性显式                     → endpoint_scope + federated + 读时 reachability
 *   R4 联邦身份不进在线层             → 本模块**从不**写 /agents、不计 DHT
 *   R5 撤销与 stale 对账               → 全量对账标 stale（不删）+ breach 同步
 *   R6 /ready 暴露联邦状态             → status()
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SOURCES_FILE = 'federation-sources.json';
const INGEST_ACTION = 'federation.ingest';

function createFederation(deps) {
  const {
    dataDir, identities, saveIdentities, audit,        // 身份表（与 routes.js 共享同一张 Map + 同一个 save）
    S, csb, log = () => {},
    requireCovenant = true,                            // 内网 Agent 要签 AAT 必须有 covenant，默认强校验
    replayGuard = S.replayGuard
  } = deps;

  const FILE = path.join(dataDir, SOURCES_FILE);

  // ---------------- 源登记（pin） ----------------
  function loadSources() {
    try {
      if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) { log('federation sources 加载失败:', e.message); }
    return { updated_at: null, sources: {} };
  }
  function saveSources(st) {
    st.updated_at = new Date().toISOString();
    fs.writeFileSync(FILE, JSON.stringify(st, null, 2));
    return st;
  }
  let SOURCES = loadSources();

  /** 带外 pin：由治理令牌保护的路由调用（见 routes.js /identity/federation/sources） */
  function pinSource({ source, public_key, note = null, by = null }) {
    if (!source || typeof source !== 'string') return { ok: false, error: 'source_required' };
    if (!public_key || !public_key.x) return { ok: false, error: 'public_key_required', hint: '传 Ed25519 公钥 JWK（含 kty/crv/x）' };
    if (String(public_key.crv || '') !== 'Ed25519') return { ok: false, error: 'public_key_not_ed25519' };
    const prev = SOURCES.sources[source];
    // 换钥必须显式 force（AID 轮换踩过的坑：静默换钥 = 身份史断链）
    if (prev && prev.public_key && prev.public_key.x !== public_key.x && !notes_force(note)) {
      return { ok: false, error: 'source_key_conflict', hint: '源已 pin 另一把公钥；换钥请带 note="force:<原因>"' };
    }
    SOURCES.sources[source] = {
      ...(prev || {}),
      public_key, pinned_at: new Date().toISOString(), pinned_by: by || null,
      enabled: true,
      last_fetch: (prev && prev.last_fetch) || null,
      imported: (prev && prev.imported) || 0,
      rejected: (prev && prev.rejected) || 0,
      stale: (prev && prev.stale) || 0
    };
    saveSources(SOURCES);
    return { ok: true, source, public_key_x: String(public_key.x).slice(0, 12) + '…' };
  }
  const notes_force = (n) => typeof n === 'string' && n.startsWith('force:');

  function unpinSource(source) {
    if (!SOURCES.sources[source]) return { ok: false, error: 'source_not_found' };
    delete SOURCES.sources[source];
    saveSources(SOURCES);
    return { ok: true, source, unpinned: true };
  }

  // ---------------- 快照传输签名 ----------------
  /** 待签 = JCS({action, source, snapshot_sha256, timestamp, nonce})，与 R1 的 AID 验签无关 */
  function ingestPayload(source, snapshotSha, timestamp, nonce) {
    return { action: INGEST_ACTION, source, snapshot_sha256: snapshotSha, timestamp, nonce };
  }
  const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

  function verifySourceSig(src, body) {
    const proof = body.proof || {};
    if (!proof.source_sig) return { ok: false, error: 'source_sig_required' };
    if (!proof.nonce || !proof.timestamp) return { ok: false, error: 'proof_required' };
    const tsChk = replayGuard.checkTimestamp(proof.timestamp);
    if (!tsChk.allowed) return { ok: false, error: 'ts_' + tsChk.error };
    if (!body.snapshot || typeof body.snapshot !== 'object') return { ok: false, error: 'snapshot_required' };
    const sha = sha256(S.jcs(body.snapshot));
    if (proof.snapshot_sha256 && proof.snapshot_sha256 !== sha) return { ok: false, error: 'snapshot_hash_mismatch' };
    const p = ingestPayload(body.source, sha, proof.timestamp, proof.nonce);
    let ok = false;
    try {
      const pub = crypto.createPublicKey({ key: src.public_key, format: 'jwk' });
      ok = crypto.verify(null, Buffer.from(S.jcs(p)), pub, Buffer.from(proof.source_sig, 'base64'));
    } catch { return { ok: false, error: 'bad_source_public_key' }; }
    if (!ok) return { ok: false, error: 'bad_source_signature' };
    const nChk = replayGuard.checkNonce(proof.nonce);
    if (!nChk.allowed) return { ok: false, error: 'nonce_' + nChk.error };
    return { ok: true, snapshot_sha256: sha };
  }

  // ---------------- 单条导入（R1 + R2 + R3） ----------------
  /**
   * @returns {{ok:true, record:Object, warnings:string[]} | {ok:false, error:string, hint?:string}}
   */
  function ingestOne(entry, ctx) {
    const { source, snapshot, humans, existing } = ctx;
    const aid = entry && entry.aid;
    if (!aid || typeof aid !== 'object') return { ok: false, error: 'aid_required' };

    // ⚠️ R1 坑（若兰 2026-10-29 指出，已核实 csb-security/lib/identity/aid.js:100）：
    //   verifyAID 用的是 JSON.stringify(unsigned) 而非 JCS ⇒ 字段顺序参与验签。
    //   所以这里**只 JSON.parse 一次，原对象直喂**，绝不重建/补字段/再序列化，
    //   否则字段序一变就假 bad_signature（会把好身份判成伪造，最难查的一类）。
    const v = S.verifyIdentitySubmission(
      aid,
      {},                                       // 不消费源侧 proof（那是源内注册时的东西，早过期）
      { owner: entry.owner_raw || entry.owner || null, passport_uri: entry.passport_uri || null, humanExists: (k) => humans.exists(k) }
    );

    let reservedClaimed = false;
    if (!v.valid) {
      // R2：保留名 + 同主体 → 视为已认领
      if (v.error === 'name_reserved') {
        const key = S.nameKey(aid.name);
        const claimX = claimFor(snapshot, key);
        const selfX = aid.public_key && aid.public_key.x;
        if (!claimX) {
          return { ok: false, error: 'name_reserved', hint: '保留名且源侧未提供 claim 绑定（snapshot.claims 缺该项）' };
        }
        if (claimX !== selfX) {
          // 别人拿自己的公钥注册同名 → 必须拒（R2 明确不许放宽）
          return { ok: false, error: 'name_reserved', hint: 'claim 绑定的公钥与该 AID 公钥不一致（冒名）' };
        }
        reservedClaimed = true;
      } else {
        return { ok: false, error: v.error, hint: v.hint };
      }
    }

    // covenant：R1 要求签名与 hash 都要验（AAT 签发也依赖它）
    let covenant = entry.covenant || null;
    if (!covenant && aid.covenant) {
      covenant = {
        agent_id: aid.agent_id,
        covenant_version: aid.covenant.version,
        covenant_hash: aid.covenant.hash,
        covenant_signed_at: aid.covenant.signed_at,
        covenant_sig: aid.covenant.sig
      };
    }
    if (requireCovenant) {
      if (!covenant) return { ok: false, error: 'covenant_missing', hint: '联邦导入要求源侧已签善良契约（AAT 签发前提）' };
      let pub;
      try { pub = crypto.createPublicKey({ key: aid.public_key, format: 'jwk' }); }
      catch { return { ok: false, error: 'bad_public_key' }; }
      let cov;
      try { cov = S.verifyCovenant(covenant, pub); }
      catch (e) { return { ok: false, error: 'covenant_version_unknown', hint: e.message }; }
      if (!cov.valid) return { ok: false, error: cov.error };
    }

    // 同 agent_id 换钥 → 拒（对应 /identity/register 的 agent_id_pubkey_conflict）
    if (existing && existing.aid && existing.aid.public_key && existing.aid.public_key.x !== aid.public_key.x) {
      return { ok: false, error: 'agent_id_pubkey_conflict', hint: '同 agent_id 已知另一把公钥；换钥请走轮换' };
    }

    const now = new Date().toISOString();
    const record = {
      agent_id: aid.agent_id,
      name: aid.name,
      passport_uri: entry.passport_uri || (existing && existing.passport_uri) || null,
      // H6：owner 归一与 register 一致；公网无此人时不建 human 记录、不开人类命名空间
      owner_handle: null,
      owner_raw: entry.owner_raw || entry.owner || null,
      owner_unverified: true,
      reserved_claimed: reservedClaimed || (existing && existing.reserved_claimed) || false,
      aid,
      covenant: covenant || (existing && existing.covenant) || null,
      registered_at: entry.registered_at || (existing && existing.registered_at) || now,
      updated_at: now,
      // R3：可达性显式，不与「在册且可达」同形
      endpoint_scope: 'private',
      federated: { source, fetched_at: now },
      stale: false,
      stale_since: null,
      federated_claim: reservedClaimed ? { name: S.nameKey(aid.name), x: aid.public_key.x } : (existing && existing.federated_claim) || null
    };
    return { ok: true, record, warnings: [] };
  }

  function claimFor(snapshot, nameKey) {
    const claims = Array.isArray(snapshot.claims) ? snapshot.claims : [];
    const hit = claims.find(c => c && S.nameKey(c.name) === nameKey);
    return hit && hit.x ? String(hit.x) : null;
  }

  // ---------------- 全量导入 + 对账（R5） ----------------
  function ingest(body, meta = {}) {
    const ip = meta.ip || 'unknown';
    const source = body && body.source;
    if (!source) return { code: 400, body: { ok: false, error: 'source_required' } };

    const src = SOURCES.sources[source];
    if (!src) return { code: 403, body: { ok: false, error: 'source_not_registered', hint: '先把源公钥带外 pin 到 /identity/federation/sources' } };
    if (src.enabled === false) return { code: 403, body: { ok: false, error: 'source_disabled' } };

    const sig = verifySourceSig(src, body);
    if (!sig.ok) {
      audit.append({ event_type: 'federation_ingest', caller_id: source, ip_address: ip, result: 'denied', scopes_denied: [sig.error] });
      return { code: 403, body: { ok: false, error: sig.error } };
    }

    const snapshot = body.snapshot;
    const entries = Array.isArray(snapshot.identities) ? snapshot.identities : [];
    const revoked = Array.isArray(snapshot.revoked) ? snapshot.revoked.map(String) : [];
    const breachList = Array.isArray(snapshot.breach_effective) ? snapshot.breach_effective : [];

    const imported = [];
    const rejected = [];
    const seen = new Set();

    for (const entry of entries) {
      const agentId = entry && entry.aid && entry.aid.agent_id;
      if (!agentId) { rejected.push({ agent_id: null, error: 'aid_required' }); continue; }
      seen.add(agentId);
      const existing = identities.get(agentId);
      // 非联邦身份（本地注册的）不允许被联邦覆盖 —— 防「用联邦改写本地身份」
      if (existing && existing.federated && existing.federated.source !== source) {
        rejected.push({ agent_id: agentId, error: 'owned_by_other_source', source: existing.federated.source });
        continue;
      }
      if (existing && !existing.federated) {
        // 本地已注册：公钥相同 → 视为同一主体，跳过（不覆盖本地优先的字段）；不同 → 拒
        if (existing.aid && existing.aid.public_key && existing.aid.public_key.x === (entry.aid.public_key || {}).x) {
          rejected.push({ agent_id: agentId, error: 'already_local', hint: '公网已本地注册且公钥一致，无需联邦' });
        } else {
          rejected.push({ agent_id: agentId, error: 'agent_id_pubkey_conflict' });
        }
        continue;
      }
      const r = ingestOne(entry, { source, snapshot, humans: deps.humans, existing });
      if (!r.ok) { rejected.push({ agent_id: agentId, error: r.error, hint: r.hint }); continue; }
      identities.set(agentId, r.record);
      imported.push(agentId);
    }

    // R5 对账：本源的旧记录，快照里没有的 → 标 stale（**不删**）；revoked 里的 → stale + revoked
    let staleMarked = 0;
    for (const [id, rec] of identities) {
      if (!rec || !rec.federated || rec.federated.source !== source) continue;
      if (seen.has(id)) continue;
      if (!rec.stale) { rec.stale = true; rec.stale_since = new Date().toISOString(); staleMarked++; }
      if (revoked.includes(id)) rec.revoked = true;
    }
    // 快照里 reappear 的 → 清掉 revoked 标记（源侧恢复，以源为准）
    for (const id of imported) { const r = identities.get(id); if (r) { delete r.revoked; } }

    // breach 同步：源侧占位，公网只读不写 breach 状态机（避免替别人做治理决定）
    const fed = SOURCES.sources[source];
    fed.breach_effective = breachList.map(b => ({ agent_id: String(b.agent_id || b), reason: b.reason || null, at: b.at || null }));
    fed.last_fetch = new Date().toISOString();
    fed.last_result = { imported: imported.length, rejected: rejected.length, stale_marked: staleMarked, snapshot_generated_at: snapshot.generated_at || null };
    fed.imported = imported.length;
    fed.rejected = rejected.length;
    fed.stale = [...identities.values()].filter(x => x.federated && x.federated.source === source && x.stale).length;
    saveSources(SOURCES);
    saveIdentities();

    // 拒绝也要落账，不许静默跳过（R1 判据）
    for (const rj of rejected) {
      audit.append({ event_type: 'federation_import_reject', caller_id: rj.agent_id || 'unknown', ip_address: ip, result: 'denied', scopes_denied: [rj.error], details: { source, hint: rj.hint || null } });
    }
    audit.append({
      event_type: 'federation_ingest', caller_id: source, ip_address: ip,
      result: rejected.length ? 'partial' : 'success',
      scopes_granted: imported.length ? ['identity:imported:' + imported.length] : [],
      scopes_denied: rejected.map(r => r.error).filter((v, i, a) => a.indexOf(v) === i),
      details: { snapshot_sha256: sig.snapshot_sha256, imported: imported.length, rejected: rejected.length, stale_marked: staleMarked, breach_effective: fed.breach_effective.length }
    });
    log('federation ingest', source, 'ok=' + imported.length, 'rej=' + rejected.length, 'stale=' + staleMarked);

    return {
      code: 200,
      body: {
        ok: true, source, snapshot_sha256: sig.snapshot_sha256,
        imported, rejected, stale_marked: staleMarked,
        breach_effective: fed.breach_effective.length,
        note: '联邦身份不进 /agents、不计 DHT；endpoint 为私网，读接口会显式标 reachability.private_network'
      }
    };
  }

  // ---------------- 读侧辅助（R3 / R5） ----------------
  function reachabilityOf(rec) {
    if (!rec) return null;
    if (rec.federated) {
      return { reachable: false, reason: 'private_network', endpoint_scope: 'private', source: rec.federated.source, fetched_at: rec.federated.fetched_at };
    }
    return { reachable: true, reason: null, endpoint_scope: 'public' };
  }
  function isStale(id) { const r = identities.get(id); return !!(r && r.stale); }
  function aidExpired(id) {
    const r = identities.get(id);
    if (!r || !r.aid || !r.aid.expires_at) return false;
    return new Date(r.aid.expires_at).getTime() < Date.now();
  }
  function federatedBreach(id) {
    for (const [, s] of Object.entries(SOURCES.sources || {})) {
      const hit = (s.breach_effective || []).find(b => b.agent_id === id);
      if (hit) return { source: Object.keys(SOURCES.sources).find(k => SOURCES.sources[k] === s), ...hit };
    }
    return null;
  }

  /** R6：/ready 用。字段语义要能一眼区分「没生效」与「生效了」 */
  function status() {
    const sources = Object.entries(SOURCES.sources || {}).map(([name, s]) => ({
      name,
      url: s.url || null,
      last_fetch: s.last_fetch || null,
      imported: s.imported || 0,
      rejected: s.rejected || 0,
      stale: s.stale || 0,
      enabled: s.enabled !== false,
      breach_effective: (s.breach_effective || []).length
    }));
    const federatedTotal = [...identities.values()].filter(x => x && x.federated).length;
    const staleTotal = [...identities.values()].filter(x => x && x.federated && x.stale).length;
    const lastFetch = sources.map(s => s.last_fetch).filter(Boolean).sort().pop() || null;
    return {
      enabled: true,
      sources_count: sources.length,
      federated_identities: federatedTotal,
      stale_identities: staleTotal,
      last_fetch: lastFetch,
      sources
    };
  }

  return {
    pinSource, unpinSource, ingest, status,
    reachabilityOf, isStale, aidExpired, federatedBreach,
    _internals: { verifySourceSig, ingestOne, ingestPayload, SOURCES: () => SOURCES }
  };
}

module.exports = { createFederation, INGEST_ACTION };
