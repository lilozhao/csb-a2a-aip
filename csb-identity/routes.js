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
const { createConnectionStore } = require('./connections.js');
const { createHumanStore } = require('./humans.js');
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

  // ---- 唯一写者锁（防两个进程同写一份数据 → 互相覆盖 / 断链）----
  // 说明：identities/claims/audit 均为无锁文件，**只能一个进程写**。
  // 判定"占用中"必须同时满足三条（若琢 2026-10-08 反馈：僵尸进程会让 process.kill(pid,0) 误判 → 锁永久卡死）：
  //   ① pid 存在；② **不是僵尸**（/proc/<pid>/status State: Z）；③ starttime 与锁记录一致（防 PID 复用）；
  //   ④ 心跳新鲜（beat 超过 STALE_MS 视为陈旧，可接管——兜底，覆盖 /proc 读不到的极端情形）。
  // 占用 → 抛 DATA_DIR_LOCKED → 挂载方 try/catch **降级不挂载**（不双写、也不让主服务崩）。
  const LOCK_FILE = path.join(DATA_DIR, '.writer.lock');
  const LOCK_BEAT_MS = 30 * 1000;      // 心跳间隔
  const LOCK_STALE_MS = 5 * 60 * 1000; // 心跳超过此值 → 视为陈旧，可接管
  function procInfo(pid) {
    try {
      const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const rest = st.slice(st.lastIndexOf(')') + 2).split(' ');   // 跳过 comm（含空格/括号）
      return { state: rest[0], starttime: rest[19] };              // 3=state, 22=starttime → rest[19]
    } catch { return null; }
  }
  let lockBeatTimer = null;
  (function acquireWriterLock() {
    try {
      if (fs.existsSync(LOCK_FILE)) {
        let o = {};
        try { o = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch {}
        const info = o.pid ? procInfo(o.pid) : null;
        const beatAge = o.beat ? (Date.now() - Date.parse(o.beat)) : Infinity;
        const samePid = o.pid === process.pid;
        const alive = !!info && info.state !== 'Z' && (!o.starttime || String(o.starttime) === String(info.starttime));
        const fresh = beatAge <= LOCK_STALE_MS;
        if (!samePid && alive && fresh) {
          const e = new Error(`数据目录已被 pid ${o.pid} 占用（${o.dir || ''}，state=${info.state}，心跳 ${Math.round(beatAge / 1000)}s 前）——拒绝成为第二个写者`);
          e.code = 'DATA_DIR_LOCKED';
          throw e;
        }
        log('WARN', '接管陈旧/僵尸写者锁：', JSON.stringify({ lock: o, now: info, beatAgeMs: beatAge === Infinity ? null : beatAge }));
      }
      const info = procInfo(process.pid) || {};
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, starttime: info.starttime || null, state: info.state || null, dir: DATA_DIR, since: new Date().toISOString(), beat: new Date().toISOString() }, null, 2));
      // 心跳（改写 beat，避免"锁在但写者其实死了"）
      lockBeatTimer = setInterval(() => {
        try {
          const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
          if (cur.pid === process.pid) { cur.beat = new Date().toISOString(); fs.writeFileSync(LOCK_FILE, JSON.stringify(cur, null, 2)); }
        } catch {}
      }, LOCK_BEAT_MS);
      if (lockBeatTimer.unref) lockBeatTimer.unref();
    } catch (e) {
      if (e.code === 'DATA_DIR_LOCKED') throw e;
      log('WARN', '写者锁建立失败（继续运行）:', e.message);
    }
  })();

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
  const conn = createConnectionStore({ dataDir: DATA_DIR, log }); // 连接分级（跟主体走）
  const humans = createHumanStore({ dataDir: DATA_DIR, log, nameKey: S.nameKey, checkReserved: S.checkReserved }); // 人类标识
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
  const uriOr = (handle) => 'human://' + handle;
  /** 连接分级：属性级 trust_level（v2 §四：先只算 L1＝身份验证通过） */
  function computeTrustLevel(agentId) {
    if (!identities.has(agentId)) return { trust_level: 'L0', trust_level_source: 'unverified' };
    return { trust_level: 'L1', trust_level_source: 'identity_verified' };
  }
  /** 主体签名校验（揭示精确值 / 设定连接级别 共用） */
  function verifySubjectSig(subjectId, payload, sigB64) {
    const rec = identities.get(subjectId);
    if (!rec) return { ok: false, error: 'subject_not_registered', hint: '先接入身份（/identity/register）' };
    if (!sigB64) return { ok: false, error: 'signature_required' };
    try {
      const pub = crypto.createPublicKey({ key: rec.aid.public_key, format: 'jwk' });
      const ok = crypto.verify(null, Buffer.from(S.jcs(payload)), pub, Buffer.from(sigB64, 'base64'));
      return ok ? { ok: true } : { ok: false, error: 'bad_signature' };
    } catch { return { ok: false, error: 'bad_public_key' }; }
  }

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
    // ⚠️ 前缀必须"精确或带斜杠"（若琢 2026-10-08 反馈）：
    //   原写法 p.startsWith('/identity') 会把 /identity-pack/... 也截走 → 走本 handler 的兜底 404，
    //   而返回格式与真 404 一样 → 极难排查。故统一用 under()。
    const under = (x) => p === x || p.startsWith(x + '/');
    const MINE = p === '/ready' || p === '/service/aid' || under('/identity') || under('/reserved') ||
      under('/aat') || under('/breach') || under('/audit') || under('/human') || p === '/registry/onboarding';
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
        const r = S.verifyIdentitySubmission(b.aid, b.proof || {}, { owner: b.owner, passport_uri: b.passport_uri, passport_slug: b.passport_slug, humanExists: (k) => humans.exists(k) });
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
        const id = decodeURIComponent(mi[1]);
        const rec = identities.get(id);
        if (!rec) return send(res, 404, { ok: false, error: 'agent_not_registered' }), true;
        const tl = computeTrustLevel(id);
        return send(res, 200, {
          ok: true,
          identity: {
            agent_id: rec.agent_id, name: rec.name, passport_uri: rec.passport_uri,
            reserved_claimed: rec.reserved_claimed, covenant: rec.covenant || null,
            trust_level: tl.trust_level, trust_level_source: tl.trust_level_source,   // 属性级（对外）
            breach: breach.isBlocked(id) ? 'effective' : null,
            connections_band: conn.band(conn.count(id)), // 粗粒度：连接数本身是隐私（若兰反馈）
            aid: rec.aid
          }
        }), true;
      }

      // ===== 人类标识 human_handle（H1=B 独立命名空间）=====
      if (p === '/human/register' && m === 'POST') {
        const b = await body();
        if (!b.handle) return send(res, 400, { ok: false, error: 'handle_required' }), true;
        if (String(b.handle).length > 200 || String(b.display_name || '').length > 200 || String(b.note || '').length > 2000) return send(res, 413, { ok: false, error: 'payload_too_long' }), true;
        const tok = req.headers['x-admin-token'] || '';
        const adminOk = !!ADMIN_TOKEN && tok.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(String(tok)), Buffer.from(ADMIN_TOKEN));
        const key = S.nameKey(humans.handleOf(b.handle));
        // 跨命名空间同名互斥：人的 handle 不得与在册 agent 显示名同名
        const clash = [...identities.values()].find(x => S.nameKey(x.name) === key);
        if (clash) {
          audit.append({ event_type: 'human_register', caller_id: uriOr(key), ip_address: ip, result: 'denied', scopes_denied: ['conflicts_with_agent_name'] });
          return send(res, 409, { ok: false, error: 'conflicts_with_agent_name', key, agent_id: clash.agent_id, hint: '跨命名空间同名互斥（防冒名）' }), true;
        }
        const r = humans.register(b, { isGovernance: adminOk });
        audit.append({ event_type: 'human_register', caller_id: uriOr(key), ip_address: ip, result: r.ok ? 'success' : 'denied', scopes_denied: r.ok ? [] : [r.error] });
        if (!r.ok) return send(res, r.error === 'handle_taken' ? 409 : 400, r), true;
        return send(res, 201, { ok: true, human: humans.view(r.human), human_uri: r.human_uri }), true;
      }
      if (p === '/human' && m === 'GET') {
        const all = humans.list();
        return send(res, 200, { ok: true, count: all.length, humans: all.map(h => humans.view(h)) }), true;
      }
      let mh = /^\/human\/([^/]+)$/.exec(p);
      if (mh && m === 'GET') {
        const rec = humans.get(decodeURIComponent(mh[1]));
        if (!rec) return send(res, 404, { ok: false, error: 'human_not_found' }), true;
        return send(res, 200, { ok: true, human: humans.view(rec) }), true;
      }
      let mhk = /^\/human\/([^/]+)\/key$/.exec(p);
      if (mhk && m === 'PUT') {
        return send(res, 501, { ok: false, error: 'not_enabled', hint: '人的密钥绑定属 H2=C（D2 A→B 升级项），本轮未启用；humans[].pubkey 已留位' }), true;
      }

      // ===== 连接分级（connection_level）：关系级，跟主体走，永不进 AID =====
      let mcl = /^\/identity\/([^/]+)\/connections$/.exec(p);
      if (mcl && m === 'GET') {
        const subject = decodeURIComponent(mcl[1]);
        if (!identities.has(subject)) return send(res, 404, { ok: false, error: 'subject_not_registered' }), true;
        const rows = conn.list(subject);
        const nonce = req.headers['x-reveal-nonce'], ts = req.headers['x-reveal-timestamp'], sig = req.headers['x-reveal-sig'];
        const tok = req.headers['x-admin-token'] || '';
        const adminOk = !!ADMIN_TOKEN && tok.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(String(tok)), Buffer.from(ADMIN_TOKEN));
        let exact = adminOk;
        if (!exact && u.searchParams.get('reveal') === '1' && nonce && ts && sig) {
          const tsChk = replayGuard.checkTimestamp(ts);
          const v = tsChk.allowed ? verifySubjectSig(subject, { subject_id: subject, peer_id: null, reveal: 'exact', nonce, timestamp: ts }, sig) : { ok: false, error: 'ts_' + (tsChk.error || 'bad') };
          if (v.ok && replayGuard.checkNonce(nonce).allowed) exact = true;
        }
        const out = rows.map(r => ({ peer_id: r.peer_id, peer_kind: r.peer_kind, level: exact ? r.level : conn.coarse(r.level), source: r.source, updated_at: r.updated_at, exact }));
        // 连接数本身也是隐私（若兰 2026-10-08）：非揭示态只给档位，不给精确数
        return send(res, 200, {
          ok: true, subject_id: subject, exact,
          count: exact ? out.length : undefined,
          count_band: exact ? undefined : conn.band(out.length),
          note: exact ? null : '默认粗粒度（collab+ / limited-；连接数只给档位）；精确值需 reveal=1 + 主体签名或治理令牌',
          connections: out
        }), true;
      }

      let mcs = /^\/identity\/([^/]+)\/connections\/(.+)$/.exec(p); // peer 可含 '/'（如 human://yuan）
      if (mcs && m === 'GET') {
        const subject = decodeURIComponent(mcs[1]), peer = decodeURIComponent(mcs[2]);
        if (!identities.has(subject)) return send(res, 404, { ok: false, error: 'subject_not_registered' }), true;
        const row = conn.get(subject, peer);
        const nonce = req.headers['x-reveal-nonce'], ts = req.headers['x-reveal-timestamp'], sig = req.headers['x-reveal-sig'];
        const tok = req.headers['x-admin-token'] || '';
        const adminOk = !!ADMIN_TOKEN && tok.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(String(tok)), Buffer.from(ADMIN_TOKEN));
        let exact = adminOk;
        if (!exact && u.searchParams.get('reveal') === '1' && nonce && ts && sig) {
          const tsChk = replayGuard.checkTimestamp(ts);
          const v = tsChk.allowed ? verifySubjectSig(subject, { subject_id: subject, peer_id: peer, reveal: 'exact', nonce, timestamp: ts }, sig) : { ok: false, error: 'ts_' + (tsChk.error || 'bad') };
          if (v.ok && replayGuard.checkNonce(nonce).allowed) exact = true;
        }
        return send(res, 200, { ok: true, peer_id: peer, level: exact ? row.level : conn.coarse(row.level), source: row.source, evidence: exact ? row.evidence : null, history: exact ? row.history : undefined, updated_at: row.updated_at, exact }), true;
      }

      if (mcs && m === 'PUT') {
        const subject = decodeURIComponent(mcs[1]), peer = decodeURIComponent(mcs[2]);
        if (!identities.has(subject)) return send(res, 404, { ok: false, error: 'subject_not_registered' }), true;
        const b = await body();
        // 签名内容（v2 §八 + confirm 扩展）：JCS({subject_id, peer_id, level, source, nonce, timestamp, confirm})
        if (!b.level || !conn.isLevel(b.level)) return send(res, 400, { ok: false, error: 'bad_level', levels: conn.LEVELS }), true;
        // peer 若为 human://<handle> → 强制 peer_kind=human 且须已登记且 active
        let peerKind = b.peer_kind === 'human' ? 'human' : 'agent';
        if (String(peer).startsWith('human://')) {
          peerKind = 'human';
          const hrec = humans.get(peer);
          if (!hrec) return send(res, 404, { ok: false, error: 'human_not_found', handle: humans.handleOf(peer) }), true;
          if (hrec.status !== 'active') return send(res, 409, { ok: false, error: 'human_not_active', status: hrec.status }), true;
        }
        if (!b.nonce || !b.timestamp) return send(res, 400, { ok: false, error: 'proof_required' }), true;
        const tsChk = replayGuard.checkTimestamp(b.timestamp);
        if (!tsChk.allowed) return send(res, 401, { ok: false, error: 'ts_' + tsChk.error }), true;
        const confirm = b.confirm === true;
        const payload = { subject_id: subject, peer_id: peer, level: b.level, source: b.source === 'auto' ? 'auto' : 'manual', nonce: b.nonce, timestamp: b.timestamp, confirm };
        const v = verifySubjectSig(subject, payload, b.sig);
        if (!v.ok) {
          audit.append({ event_type: 'connection_set', caller_id: subject, callee_id: peer, ip_address: ip, result: 'denied', scopes_denied: [v.error] });
          return send(res, 403, { ok: false, ...v }), true;
        }
        if (!replayGuard.checkNonce(b.nonce).allowed) return send(res, 401, { ok: false, error: 'nonce_replay' }), true;
        // 防手滑：intimate/self 属高授权，升级需 confirm=true（二次确认）
        const cur = conn.get(subject, peer);
        const upgrading = conn.rank(b.level) > conn.rank(cur.level);
        // 若兰 2026-10-08 反馈：高授权只需"目标级别是 intimate/self 且**非降级**"就须 confirm
        // （原写法只看 upgrading，导致"已是 self 再 PUT self 重签"会绕过二次确认）
        const highAuth = (b.level === 'intimate' || b.level === 'self') && !(conn.rank(b.level) < conn.rank(cur.level));
        if (highAuth && !confirm) {
          return send(res, 409, { ok: false, error: 'confirm_required', hint: '升至 intimate/self 属高授权，须在签名载荷内含 confirm:true' }), true;
        }
        // 被 effective breach 的 agent：须人工放行（治理令牌）才可升
        if (upgrading && breach.isBlocked(peer)) {
          const tok = req.headers['x-admin-token'] || '';
          const adminOk = !!ADMIN_TOKEN && tok.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(String(tok)), Buffer.from(ADMIN_TOKEN));
          if (!adminOk) return send(res, 409, { ok: false, error: 'peer_under_effective_breach', hint: '被 breach 生效的 agent，升级需治理放行（X-Admin-Token）' }), true;
        }
        const r = conn.put(subject, peer, { level: b.level, source: payload.source, evidence: b.evidence, by: subject, why: b.why || null, sig: b.sig, peer_kind: peerKind });
        audit.append({ event_type: 'connection_set', caller_id: subject, callee_id: peer, ip_address: ip, result: r.ok ? 'success' : 'denied', scopes_granted: r.ok ? [payload.source + ':' + r.from + '->' + r.to] : [], scopes_denied: r.ok ? [] : [r.error] });
        return send(res, r.ok ? 200 : 400, r), true;
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
        if (r.ok) {
          stats.transitions++;
          // 连接分级联动（v2 §六）：effective → 仅"举报方↔被举报方"自动降级（其他对端不连坐）
          try {
            const rec = breach.get(r.breach_id);
            if (rec && rec.reporter && rec.agent_id) {
              if (b.to === 'effective') { const d = conn.breachDowngrade(rec.reporter, rec.agent_id, r.breach_id, b.downgrade_to || 'blocked'); log('breach→conn', rec.reporter, '→', rec.agent_id, JSON.stringify(d)); }
              if (b.to === 'cleared') { const d = conn.breachRevert(rec.reporter, rec.agent_id, r.breach_id); log('breach cleared→conn revert', JSON.stringify(d)); }
            }
          } catch (e) { log('WARN', 'breach→connections 联动失败:', e.message); }
        }
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
