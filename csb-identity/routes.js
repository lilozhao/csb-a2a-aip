/**
 * identity/routes.js — 阶段二身份层 HTTP 路由（框架无关）
 * ------------------------------------------------------------------
 * 作者：明德 🎋 · 2026-10-08
 * 用法（express）：
 *   const { createIdentityHandler } = require('./identity/routes.js');
 *   const h = createIdentityHandler({ ... });
 *   app.use((req, res, next) => { Promise.resolve(h(req, res)).then(handled => { if (!handled) next(); }); });
 * 用法（原生 http）：handled === false 时自行 404。
 *
 * 说明：自带状态（身份表/认领表/审计/限流/breach），与 A2A 服务同进程但数据自治。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./core.js');
const csb = require('../../csb-security/lib/index.js');

const HERE = __dirname;

function readBodyRaw(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) { reject(new Error('body_too_large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('bad_json')); } });
  });
}

function createIdentityHandler(opts = {}) {
  const DATA_DIR = path.resolve(opts.dataDir || path.join(HERE, 'data'));
  const LIMITS = { agent: 60, ip: 200, global: 1200, ...(opts.limits || {}) };
  const REGISTRY_URL = opts.registryUrl || 'http://127.0.0.1:3099';
  const FORUM_REGISTRY_URL = opts.forumRegistryUrl || 'http://127.0.0.1:3500/api/agents';
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), '[identity]', ...a));

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const F = {
    identities: path.join(DATA_DIR, 'identities.json'),
    claims: path.join(DATA_DIR, 'claims.json'),
    audit: path.join(DATA_DIR, 'audit-log.jsonl'),
    breach: path.join(DATA_DIR, 'breach-log.jsonl'),
    serviceKey: path.join(DATA_DIR, 'service-key.json')
  };

  // ---- 存储 ----
  const identities = new Map();
  if (fs.existsSync(F.identities)) {
    try { const j = JSON.parse(fs.readFileSync(F.identities, 'utf8')); for (const [k, v] of Object.entries(j.identities || {})) identities.set(k, v); log('已加载身份', identities.size); }
    catch (e) { log('identities 加载失败:', e.message); }
  }
  const saveIdentities = () => { const o = {}; for (const [k, v] of identities) o[k] = v; fs.writeFileSync(F.identities, JSON.stringify({ updated_at: new Date().toISOString(), identities: o }, null, 2)); };
  S.useClaimsFile(F.claims);

  // ---- 服务身份 ----
  const desiredAgentId = opts.serviceAgentId || `csb-identity@${opts.host || 'localhost'}:${opts.port || 3100}`;
  const desiredEndpoint = `http://${opts.host || 'localhost'}:${opts.port || 3100}/a2a/json-rpc`;
  const buildServiceAid = (agentId, publicJwk, privateKey) => csb.generateAID({
    agentId, name: 'CSB Identity Service', endpoint: desiredEndpoint,
    capabilities: ['identity.verify', 'aat.issue'], publicJwk
  }, privateKey);

  let SVC;
  if (fs.existsSync(F.serviceKey)) {
    const k = JSON.parse(fs.readFileSync(F.serviceKey, 'utf8'));
    const privateKey = crypto.createPrivateKey({ key: k.privatePem, format: 'pem', type: 'pkcs8' });
    let aid = k.aid;
    // 自愈：agent_id / endpoint 与当前配置不一致 → 用**同一把密钥**重建（保证审计链签名不失效）
    if (k.agentId !== desiredAgentId || !aid || aid.endpoint !== desiredEndpoint) {
      aid = buildServiceAid(desiredAgentId, k.publicJwk, privateKey);
      fs.writeFileSync(F.serviceKey, JSON.stringify({ agentId: desiredAgentId, aid, publicJwk: k.publicJwk, privatePem: k.privatePem }, null, 2), { mode: 0o600 });
      log('服务身份自愈：', k.agentId, '→', desiredAgentId, '(同密钥重建)');
    }
    SVC = { agentId: desiredAgentId, aid, privateKey, publicKey: crypto.createPublicKey({ key: k.publicJwk, format: 'jwk' }) };
  } else {
    const kp = csb.generateKeyPair('csb-identity-' + new Date().toISOString().slice(0, 10));
    const aid = buildServiceAid(desiredAgentId, kp.publicJwk, kp.privateKey);
    fs.writeFileSync(F.serviceKey, JSON.stringify({ agentId: desiredAgentId, aid, publicJwk: kp.publicJwk, privatePem: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, null, 2), { mode: 0o600 });
    SVC = { agentId: desiredAgentId, aid, privateKey: kp.privateKey, publicKey: kp.publicKey };
  }

  const rateLimiter = new csb.RateLimiter({ limits: LIMITS });
  const audit = new csb.AuditLog({ logPath: F.audit, privateKey: SVC.privateKey, publicKey: SVC.publicKey });
  const auditQuery = new csb.AuditQuery(audit);
  const breach = new S.BreachRegistry({ log: audit }); // 复用同一本审计账（不再另开 breach-log）
  const jtiCache = new Set();
  const replayGuard = new csb.ReplayGuard(); // nonce / 时间戳 防重放
  const stats = { register_ok: 0, register_reject: 0, breach_proposed: 0, transitions: 0, aat_issued: 0, aat_verified: 0, rate_limited: 0 };
  const cleanup = setInterval(() => rateLimiter.cleanup(), 60 * 1000); if (cleanup.unref) cleanup.unref();

  // ==== 公网最小保护（2026-10-08 · 硅隐拍板"开始做"）====
  // ① 写操作独立限流（比读更严）：单主体/单 IP 各 20 次/分钟
  const WRITE_LIMIT = parseInt(process.env.IDENTITY_WRITE_LIMIT || '20', 10); // 写操作/分钟（按主体与 IP）
  const writeLimiter = new csb.RateLimiter({ limits: { agent: WRITE_LIMIT, ip: WRITE_LIMIT } });
  // ② 治理令牌：effective/cleared 属治理动作，需令牌（env 或 <dataDir>/admin-token，600）
  const ADMIN_TOKEN = (() => {
    if (process.env.IDENTITY_ADMIN_TOKEN) return process.env.IDENTITY_ADMIN_TOKEN.trim();
    try { const f = path.join(DATA_DIR, 'admin-token'); if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim(); } catch {}
    return null;
  })();
  const isWriteMethod = (m) => m === 'POST' || m === 'PUT' || m === 'DELETE';
  const PAYLOAD_LIMITS = { reason: 2000, evidence: 4000 };
  /** 校验"行为主体"签名：主体必须是已注册 agent，签名覆盖 JCS(payload) */
  function verifyActorSig(agentId, payload, sigB64) {
    const rec = identities.get(agentId);
    if (!rec) return { ok: false, error: 'reporter_not_registered', hint: '先接入身份（/identity/register）再发起' };
    if (!sigB64) return { ok: false, error: 'signature_required', hint: '签名内容 = JCS({agentId,reason,evidence,reporter,nonce,timestamp})' };
    try {
      const pub = crypto.createPublicKey({ key: rec.aid.public_key, format: 'jwk' });
      const ok = crypto.verify(null, Buffer.from(S.jcs(payload)), pub, Buffer.from(sigB64, 'base64'));
      return ok ? { ok: true } : { ok: false, error: 'bad_actor_signature' };
    } catch { return { ok: false, error: 'bad_public_key' }; }
  }

  async function fetchRegistry() {
    const out = { ok: false, agents: [], sources: {} };
    for (const [key, url] of [['a2a', REGISTRY_URL + '/agents'], ['forum', FORUM_REGISTRY_URL]]) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (r.ok) { const j = await r.json(); const list = (j.agents || []).map(a => ({ ...a, source: key })); out.agents.push(...list); out.sources[key] = list.length; out.ok = true; }
        else out.sources[key] = 'http_' + r.status;
      } catch (e) { out.sources[key] = e.message; }
    }
    const seen = new Set();
    out.agents = out.agents.filter(a => { const k = S.nameKey(a.name); if (!k || seen.has(k)) return false; seen.add(k); return true; });
    out.total = out.agents.length;
    return out;
  }

  function send(res, code, obj, extra) {
    const h = { 'Content-Type': 'application/json; charset=utf-8' };
    if (extra) Object.assign(h, extra);
    res.writeHead(code, h); res.end(JSON.stringify(obj, null, 2));
  }
  const clientIp = (req) => String(req.socket && req.socket.remoteAddress || 'unknown').replace('::ffff:', '');

  async function handler(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname, m = req.method, ip = clientIp(req);

    // 只接管自己的路径，其它放行（返回 false）
    const MINE = p === '/ready' || p === '/service/aid' || p.startsWith('/identity') || p.startsWith('/reserved') ||
      p.startsWith('/aat') || p.startsWith('/breach') || p.startsWith('/audit') || p === '/registry/onboarding';
    if (!MINE) return false;

    // 限流（/ready 豁免）
    if (p !== '/ready') {
      const agent = req.headers['x-agent-id'] || 'unknown';
      const rl = rateLimiter.check({ agentId: agent, ip });
      if (!rl.allowed) {
        stats.rate_limited++;
        audit.append({ event_type: 'rate_limited', caller_id: agent, ip_address: ip, result: 'denied', scopes_denied: [rl.reason] });
        const ra = Math.ceil((rl.retryAfterMs || 1000) / 1000);
        return send(res, 429, { ok: false, error: rl.reason, retry_after_s: ra }, { 'Retry-After': String(ra) }), true;
      }
      // 写操作额外限流（更严）
      if (isWriteMethod(m)) {
        const wl = writeLimiter.check({ agentId: agent, ip });
        if (!wl.allowed) {
          stats.rate_limited++;
          audit.append({ event_type: 'rate_limited', caller_id: agent, ip_address: ip, result: 'denied', scopes_denied: ['write_' + wl.reason] });
          const ra = Math.ceil((wl.retryAfterMs || 1000) / 1000);
          return send(res, 429, { ok: false, error: 'write_rate_limited', detail: wl.reason, retry_after_s: ra }, { 'Retry-After': String(ra) }), true;
        }
      }
    }
    const body = async () => (req.body !== undefined && req.body !== null ? req.body : await readBodyRaw(req));

    try {
      if (p === '/ready' && m === 'GET') {
        const chain = audit.verifyChain(); const reg = await fetchRegistry();
        return send(res, reg.ok && chain.valid ? 200 : 503, { ok: reg.ok && chain.valid, audit_chain_valid: chain.valid, registry_sources: reg.sources, registry_agents: reg.total }), true;
      }
      if (p === '/service/aid' && m === 'GET') return send(res, 200, SVC.aid), true;
      if (p === '/reserved' && m === 'GET') return send(res, 200, { ok: true, count: S.reserved().size, note: '不回显全表（R4）' }), true;

      if (p === '/registry/onboarding' && m === 'GET') {
        const reg = await fetchRegistry();
        if (!reg.ok) return send(res, 502, { ok: false, error: 'registry_unreachable', detail: reg.sources }), true;
        const rows = reg.agents.map(a => { const key = S.nameKey(a.name); return { name: a.name, host: a.host, port: a.port, name_key: key, reserved: S.reserved().has(key), has_aid: [...identities.values()].some(x => S.nameKey(x.name) === key) }; }).filter(r => r.reserved);
        return send(res, 200, { ok: true, registry_total: reg.total, reserved_in_registry: rows.length, onboarded: rows.filter(r => r.has_aid).length, rows }), true;
      }

      if (p === '/reserved/claim' && m === 'POST') {
        const b = await body();
        if (!b.name) return send(res, 400, { ok: false, error: 'name_required' }), true;
        const actor = req.headers['x-agent-id'] || 'unknown';
        const chk = S.checkReserved(b.name, 'name');
        if (chk.ok) return send(res, 400, { ok: false, error: 'not_reserved', key: chk.key }), true;
        if (S.isClaimedBy(chk.key, b.public_key)) return send(res, 200, { ok: true, key: chk.key, thumbprint: String(b.public_key.x).slice(0, 8) + '…', _idem: true }), true;
        if (!b.proof || !b.proof.nonce || !b.proof.timestamp || !b.proof.sig) return send(res, 400, { ok: false, error: 'proof_required', hint: '认领须附持有证明 {proof:{nonce,timestamp,sig}}' }), true;
        let sigOk = false;
        try {
          const pub = crypto.createPublicKey({ key: b.public_key, format: 'jwk' });
          sigOk = crypto.verify(null, Buffer.from(S.jcs({ name: b.name, public_key: b.public_key, nonce: b.proof.nonce, timestamp: b.proof.timestamp })), pub, Buffer.from(b.proof.sig, 'base64'));
        } catch { sigOk = false; }
        const tsOk = Math.abs(Date.now() - Date.parse(b.proof.timestamp)) < 300000;
        if (!tsOk || !sigOk) {
          audit.append({ event_type: 'reserved_claim', caller_id: actor, ip_address: ip, result: 'denied', scopes_denied: [!tsOk ? 'ts_drift' : 'bad_proof'] });
          return send(res, 401, { ok: false, error: !tsOk ? 'proof_ts_drift' : 'bad_proof' }), true;
        }
        const r = S.claimReservedName(b.name, b.public_key);
        audit.append({ event_type: 'reserved_claim', caller_id: actor, ip_address: ip, result: r.ok ? 'success' : 'denied', scopes_denied: r.ok ? [] : [r.error] });
        return send(res, r.ok ? 200 : 409, r), true;
      }

      if (p === '/identity/register' && m === 'POST') {
        const b = await body();
        if (!b.aid) return send(res, 400, { ok: false, error: 'aid_required' }), true;
        const r = S.verifyIdentitySubmission(b.aid, b.proof || {}, { owner: b.owner, passport_uri: b.passport_uri, passport_slug: b.passport_slug });
        if (!r.valid) {
          stats.register_reject++; rateLimiter.recordFailure(b.aid.agent_id || 'unknown');
          audit.append({ event_type: 'identity_register', caller_id: b.aid.agent_id || 'unknown', ip_address: ip, result: 'denied', scopes_denied: [r.error] });
          return send(res, 400, { ok: false, ...r }), true;
        }
        const prev = identities.get(r.agent_id);
        if (prev && prev.aid.public_key && prev.aid.public_key.x !== r.aid.public_key.x) {
          stats.register_reject++; rateLimiter.recordFailure(r.agent_id);
          audit.append({ event_type: 'identity_register', caller_id: r.agent_id, ip_address: ip, result: 'denied', scopes_denied: ['pubkey_conflict'] });
          return send(res, 409, { ok: false, error: 'agent_id_pubkey_conflict', hint: '同 agent_id 已知公钥，换钥请走轮换' }), true;
        }
        identities.set(r.agent_id, {
          agent_id: r.agent_id, name: r.name,
          passport_uri: r.passport_uri || (prev && prev.passport_uri) || null,
          reserved_claimed: r.reserved_claimed || (prev && prev.reserved_claimed) || false,
          aid: r.aid, covenant: prev ? prev.covenant : undefined,
          registered_at: (prev && prev.registered_at) || new Date().toISOString(), updated_at: new Date().toISOString()
        });
        saveIdentities(); stats.register_ok++; rateLimiter.recordSuccess(r.agent_id);
        audit.append({ event_type: 'identity_register', caller_id: r.agent_id, callee_id: SVC.agentId, ip_address: ip, result: 'success', scopes_granted: ['identity:verified'] });
        log('register', r.agent_id, 'passport=' + r.passport_uri);
        return send(res, 201, { ok: true, agent_id: r.agent_id, passport_uri: r.passport_uri, reserved_claimed: r.reserved_claimed }), true;
      }

      if (p === '/identity' && m === 'GET') {
        return send(res, 200, { ok: true, count: identities.size, identities: [...identities.values()].map(x => ({ agent_id: x.agent_id, name: x.name, passport_uri: x.passport_uri, reserved_claimed: x.reserved_claimed, covenant: !!x.covenant })) }), true;
      }

      let mt = /^\/identity\/([^/]+)\/covenant$/.exec(p);
      if (mt && m === 'POST') {
        const id = decodeURIComponent(mt[1]); const rec = identities.get(id);
        if (!rec) return send(res, 404, { ok: false, error: 'agent_not_registered' }), true;
        const b = await body();
        const cov = { agent_id: id, covenant_version: b.covenant_version || 'csb-covenant-v1', covenant_hash: b.covenant_hash, covenant_signed_at: b.covenant_signed_at, covenant_sig: b.covenant_sig };
        const v = S.verifyCovenant(cov, crypto.createPublicKey({ key: rec.aid.public_key, format: 'jwk' }));
        audit.append({ event_type: 'covenant_sign', caller_id: id, callee_id: SVC.agentId, ip_address: ip, result: v.valid ? 'success' : 'denied', scopes_denied: v.valid ? [] : [v.error] });
        if (!v.valid) return send(res, 400, { ok: false, ...v }), true;
        rec.covenant = cov; rec.aid = { ...rec.aid, covenant: { version: cov.covenant_version, hash: cov.covenant_hash, signed_at: cov.covenant_signed_at, sig: cov.covenant_sig } };
        saveIdentities();
        return send(res, 200, { ok: true, agent_id: id, covenant: { version: cov.covenant_version, hash: cov.covenant_hash, signed_at: cov.covenant_signed_at } }), true;
      }
      if (mt && m === 'GET') {
        const rec = identities.get(decodeURIComponent(mt[1]));
        return rec ? send(res, 200, { ok: true, covenant: rec.covenant || null }) : send(res, 404, { ok: false, error: 'agent_not_registered' }), true;
      }
      let mi = /^\/identity\/([^/]+)$/.exec(p);
      if (mi && m === 'GET') {
        const rec = identities.get(decodeURIComponent(mi[1]));
        return rec ? send(res, 200, { ok: true, identity: { agent_id: rec.agent_id, name: rec.name, passport_uri: rec.passport_uri, reserved_claimed: rec.reserved_claimed, covenant: rec.covenant || null, aid: rec.aid } }) : send(res, 404, { ok: false, error: 'agent_not_registered' }), true;
      }

      if (p === '/aat/issue' && m === 'POST') {
        const b = await body();
        if (!b.caller_agent_id) return send(res, 400, { ok: false, error: 'caller_agent_id_required' }), true;
        if (!identities.has(b.caller_agent_id)) return send(res, 403, { ok: false, error: 'caller_not_registered' }), true;
        if (!identities.get(b.caller_agent_id).covenant) return send(res, 403, { ok: false, error: 'covenant_unsigned' }), true;
        if (breach.isBlocked(b.caller_agent_id)) return send(res, 403, { ok: false, error: 'caller_blocked_by_breach' }), true;
        const token = csb.createAAT({ privateKey: SVC.privateKey, issuer: SVC.agentId, audience: b.caller_agent_id, capabilities: b.capabilities || [], ttl: b.ttl || 300 });
        stats.aat_issued++;
        audit.append({ event_type: 'aat_issue', caller_id: SVC.agentId, callee_id: b.caller_agent_id, ip_address: ip, result: 'success', scopes_granted: b.capabilities || [] });
        return send(res, 201, { ok: true, token, issuer: SVC.agentId, audience: b.caller_agent_id, ttl: b.ttl || 300 }), true;
      }
      if (p === '/aat/verify' && m === 'POST') {
        const b = await body();
        if (!b.token) return send(res, 400, { ok: false, error: 'token_required' }), true;
        let pub = SVC.aid.public_key, expectedAudience = b.expect_audience || SVC.agentId;
        if (b.agent_id) {
          const rec = identities.get(b.agent_id);
          if (!rec) return send(res, 404, { ok: false, error: 'agent_not_registered' }), true;
          pub = rec.aid.public_key; expectedAudience = b.expect_audience || b.agent_id;
        }
        const v = csb.verifyAAT(b.token, { publicKey: pub, expectedAudience, jtiCache: b.check_replay === false ? null : jtiCache });
        if (v.valid) stats.aat_verified++;
        audit.append({ event_type: 'aat_verify', caller_id: (v.payload && v.payload.sub) || 'unknown', callee_id: SVC.agentId, ip_address: ip, result: v.valid ? 'success' : 'denied', scopes_denied: v.valid ? [] : [v.error] });
        return send(res, v.valid ? 200 : 401, v), true;
      }

      if (p === '/breach' && m === 'POST') {
        const b = await body();
        // —— 公网最小保护：主体需已注册 + 签名 + 时间窗 + 防重放 + 长度上限 ——
        if (!b.reporter) return send(res, 400, { ok: false, error: 'reporter_required' }), true;
        if (!b.nonce || !b.timestamp) return send(res, 400, { ok: false, error: 'proof_required', hint: '须带 nonce + timestamp' }), true;
        const tsChk = replayGuard.checkTimestamp(b.timestamp);
        if (!tsChk.allowed) return send(res, 401, { ok: false, error: 'ts_' + tsChk.error }), true;
        if ((b.reason || '').length > PAYLOAD_LIMITS.reason || (b.evidence || '').length > PAYLOAD_LIMITS.evidence) return send(res, 413, { ok: false, error: 'payload_too_long' }), true;
        const sigChk = verifyActorSig(b.reporter, { agentId: b.agentId, reason: b.reason, evidence: b.evidence || null, reporter: b.reporter, nonce: b.nonce, timestamp: b.timestamp }, b.reporter_sig);
        if (!sigChk.ok) {
          audit.append({ event_type: 'breach_proposed', caller_id: b.reporter, callee_id: b.agentId || 'unknown', ip_address: ip, result: 'denied', scopes_denied: [sigChk.error] });
          return send(res, 403, { ok: false, ...sigChk }), true;
        }
        const nonceChk = replayGuard.checkNonce(b.nonce);
        if (!nonceChk.allowed) return send(res, 401, { ok: false, error: 'nonce_' + nonceChk.error }), true;
        const r = breach.propose({ agentId: b.agentId, reason: b.reason, evidence: b.evidence, reporter: b.reporter, reporterSig: b.reporter_sig });
        if (r.ok) stats.breach_proposed++;
        audit.append({ event_type: 'breach_proposed', caller_id: b.reporter || 'unknown', callee_id: b.agentId || 'unknown', ip_address: ip, result: r.ok ? 'success' : 'denied', scopes_denied: r.ok ? [] : [r.error] });
        return send(res, r.ok ? 201 : 400, r), true;
      }
      if (p === '/breach-chain/verify' && m === 'GET') return send(res, 200, { ok: true, ...breach.verify() }), true;
      let mtr = /^\/breach\/([^/]+)\/transition$/.exec(p);
      if (mtr && m === 'POST') {
        const b = await body();
        // —— 公网最小保护：effective / cleared 属治理动作，需治理令牌 ——
        if (b.to === 'effective' || b.to === 'cleared') {
          if (!ADMIN_TOKEN) return send(res, 503, { ok: false, error: 'governance_token_not_configured', hint: '在 ' + path.join(DATA_DIR, 'admin-token') + ' 放置令牌（600）或设 IDENTITY_ADMIN_TOKEN' }), true;
          const tok = req.headers['x-admin-token'] || (b.admin_token || '');
          const a = Buffer.from(String(tok)), c = Buffer.from(ADMIN_TOKEN);
          const same = a.length === c.length && crypto.timingSafeEqual(a, c);
          if (!same) {
            audit.append({ event_type: 'breach_transition', caller_id: b.actor || 'unknown', callee_id: decodeURIComponent(mtr[1]), ip_address: ip, result: 'denied', scopes_denied: ['bad_admin_token'] });
            return send(res, 403, { ok: false, error: 'bad_admin_token' }), true;
          }
        }
        const r = breach.transition(decodeURIComponent(mtr[1]), b.to, { actor: b.actor, reason: b.reason });
        if (r.ok) stats.transitions++;
        audit.append({ event_type: 'breach_transition', caller_id: b.actor || 'unknown', callee_id: r.breach_id || 'unknown', ip_address: ip, result: r.ok ? 'success' : 'denied', scopes_denied: r.ok ? [] : [r.error] });
        return send(res, r.ok ? 200 : 409, r), true;
      }
      let mb = /^\/breach\/([^/]+)$/.exec(p);
      if (mb && m === 'GET') { const rec = breach.get(decodeURIComponent(mb[1])); return rec ? send(res, 200, { ok: true, breach: rec }) : send(res, 404, { ok: false, error: 'breach_not_found' }), true; }
      if (p === '/breach' && m === 'GET') { const q = u.searchParams.get('agent_id'); return send(res, 200, { ok: true, breaches: q ? breach.byAgent(q) : [...breach.records.values()] }), true; }

      if (p === '/audit' && m === 'GET') {
        const q = { agentId: u.searchParams.get('agent_id') || undefined, eventType: u.searchParams.get('event_type') || undefined, from: u.searchParams.get('from') || undefined, to: u.searchParams.get('to') || undefined, limit: u.searchParams.get('limit') ? parseInt(u.searchParams.get('limit'), 10) : undefined };
        const rows = audit.query(q);
        return send(res, 200, { ok: true, count: rows.length, query: q, entries: rows }), true;
      }
      let mtl = /^\/audit\/timeline\/(.+)$/.exec(p);
      if (mtl && m === 'GET') return send(res, 200, { ok: true, agent_id: decodeURIComponent(mtl[1]), timeline: auditQuery.agentTimeline(decodeURIComponent(mtl[1])) }), true;
      if (p === '/audit/summary' && m === 'GET') return send(res, 200, { ok: true, ...audit.summary() }), true;
      if (p === '/audit/verify' && m === 'GET') return send(res, 200, { ok: true, ...audit.verifyChain() }), true;

      return send(res, 404, { ok: false, error: 'not_found', path: p }), true;
    } catch (e) {
      log('ERROR', p, e.message);
      return send(res, 500, { ok: false, error: 'internal', message: e.message }), true;
    }
  }

  handler.state = { identities, breach, audit, rateLimiter, serviceAid: SVC.aid, dataDir: DATA_DIR, stats };
  return handler;
}

module.exports = { createIdentityHandler };
