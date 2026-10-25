/**
 * a2a-aat.js — AAT（Agent Attestation Token）消息级签名
 *
 * 解决什么：`sender.name` 是自述字段，谁都能填「明德」。握手只能证明
 *   「某台主机此刻通过了验证」，而且 TTL 只有 5 分钟。要长期、逐条消息地
 *   证明「这条消息确实出自持有该私钥的实例」，必须对消息签名。
 *
 * ─────────────────────────────────────────────────────────────
 * 设计铁律（2026-10-24）
 *
 *   1. **只认本地固定的公钥（pinning）**
 *      绝不从发送方那里取公钥来验自己的签名 —— 那是自签名，等于没验。
 *      公钥必须由主人通过带外信道交换后写进 `config/agents.local.json` 的 `aidPublicKey`。
 *
 *   2. **audience 必须锚定到本实例**
 *      `aud` 必须是我们的 agent_id。传 null 或不校验，等于允许一条
 *      本来发给明德的消息被我们当成「已认证」——受众混淆。
 *
 *   3. **失败必须说清是哪一种失败**
 *      没配公钥 / 公钥不可解析 / 签名不匹配 / 过期 / 重放 / 受众不符，
 *      六种错误码分开。今晚已经因为「混成一句 bad_public_key」误判过一轮。
 *
 *   4. **发送侧失败不影响发送**
 *      AAT 是增强项，不是可用性前提。签不出来就如实记账、消息照发。
 * ─────────────────────────────────────────────────────────────
 *
 * 版本: 1.0.0 | 2026-10-24 | 若兰
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AAT_TTL = 300;              // 5 分钟
const AAT_MAX_DRIFT = 300;        // iat 偏差上限
const AAT_MAX_CACHE = 5000;       // jti 缓存上限（防内存膨胀）

/** 已见 jti（防重放）。进程内共享。 */
const _jtiCache = new Set();
const _jtiOrder = [];

function _rememberJti(jti) {
  if (_jtiCache.has(jti)) return false;
  _jtiCache.add(jti);
  _jtiOrder.push(jti);
  if (_jtiOrder.length > AAT_MAX_CACHE) {
    const old = _jtiOrder.shift();
    _jtiCache.delete(old);
  }
  return true;
}

/** 读取 csb-security 的 AAT 实现（唯一事实源，不复制逻辑） */
function _aatLib() {
  return require('../csb-security/lib/identity/aat.js');
}

// ─────────────────────────────────────────────────────────────
// 自身身份：agent_id + AID 私钥 + 公钥
// ─────────────────────────────────────────────────────────────

let _selfCache = null;

/**
 * 找 AID 私钥与 AID 文档
 * @returns {{ok:boolean, keyPath?:string, aidPath?:string, source?:string, reason?:string}}
 */
function _resolveKeyPaths() {
  const envKey = (process.env.A2A_SECURITY_HANDSHAKE_KEY || '').trim();
  const envAid = (process.env.A2A_SECURITY_HANDSHAKE_AID || '').trim();
  if (envKey) return { ok: true, keyPath: envKey, aidPath: envAid || null, source: 'env' };

  // 2. 本地配置
  try {
    const localPath = path.join(__dirname, 'config', 'agents.local.json');
    if (fs.existsSync(localPath)) {
      const doc = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      const aat = doc.aat || {};
      if (aat.keyPath) {
        const kp = path.isAbsolute(aat.keyPath) ? aat.keyPath : path.join(__dirname, aat.keyPath);
        const ap = aat.aidPath
          ? (path.isAbsolute(aat.aidPath) ? aat.aidPath : path.join(__dirname, aat.aidPath))
          : null;
        return { ok: true, keyPath: kp, aidPath: ap, source: 'config.aat' };
      }
    }
  } catch { /* 走探测 */ }

  // 3. 探测 csb-security/data/*-private-key.pem
  try {
    const dir = path.join(__dirname, '..', 'csb-security', 'data');
    if (fs.existsSync(dir)) {
      const keys = fs.readdirSync(dir).filter((f) => /-private-key\.pem$/.test(f));
      if (keys.length === 1) {
        const kp = path.join(dir, keys[0]);
        const name = keys[0].replace(/-private-key\.pem$/, '');
        const apCandidate = path.join(dir, `${name}-aid.json`);
        return {
          ok: true,
          keyPath: kp,
          aidPath: fs.existsSync(apCandidate) ? apCandidate : null,
          source: `probe:csb-security/data/${keys[0]}`,
        };
      }
      if (keys.length > 1) {
        return {
          ok: false,
          reason: `csb-security/data 下有 ${keys.length} 把 AID 私钥（${keys.join(', ')}），无法确定用哪一把`
            + ' —— 请在 config/agents.local.json 的 aat.keyPath 明确指定',
        };
      }
    }
  } catch { /* 忽略 */ }

  return { ok: false, reason: '找不到 AID 私钥：env / config.aat.keyPath / csb-security/data 探测均失败' };
}

/**
 * 解析本实例的签名身份
 * @returns {{ok:boolean, agentId?:string, privateKey?:KeyObject, publicJwk?:object, source?:string, reason?:string}}
 */
function getSelf() {
  if (_selfCache) return _selfCache;

  // 私钥解析顺序（客户端脚本通常拿不到服务端 env，必须能自己找到钥匙）：
  //   1. A2A_SECURITY_HANDSHAKE_KEY / A2A_SECURITY_HANDSHAKE_AID
  //   2. config/agents.local.json 的 aat.keyPath / aat.aidPath（相对仓库根）
  //   3. csb-security/data/ 下唯一的 *-private-key.pem（多把则拒绝，绝不猜）
  const resolved = _resolveKeyPaths();
  if (!resolved.ok) return (_selfCache = { ok: false, reason: resolved.reason });
  const { aidPath, keyPath } = resolved;

  if (!keyPath) {
    return (_selfCache = { ok: false, reason: '未配置 AID 私钥（A2A_SECURITY_HANDSHAKE_KEY / config.aat.keyPath）' });
  }
  if (!fs.existsSync(keyPath)) {
    return (_selfCache = { ok: false, reason: `AID 私钥文件不存在: ${keyPath}` });
  }

  let privateKey;
  try {
    const pem = fs.readFileSync(keyPath, 'utf8');
    privateKey = crypto.createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      return (_selfCache = { ok: false, reason: `AID 私钥类型是 ${privateKey.asymmetricKeyType}，协议要求 ed25519` });
    }
  } catch (e) {
    return (_selfCache = { ok: false, reason: `AID 私钥不可解析: ${e.message}` });
  }

  const publicJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });

  // agent_id：优先 AID 文档，其次 env，最后由 identity + host:port 拼
  let agentId = null;
  if (aidPath && fs.existsSync(aidPath)) {
    try {
      const aid = JSON.parse(fs.readFileSync(aidPath, 'utf8'));
      if (aid.agent_id) {
        agentId = aid.agent_id;
        // AID 里的公钥若与私钥不匹配 → 这是严重配置错误，必须报
        if (aid.public_key && aid.public_key.x && aid.public_key.x !== publicJwk.x) {
          return (_selfCache = {
            ok: false,
            reason: `AID 公钥与私钥不匹配（aid.x=${aid.public_key.x.slice(0, 8)}… vs key.x=${publicJwk.x.slice(0, 8)}…）`
              + ' —— 身份不一致，拒绝用它签发 AAT',
          });
        }
      }
    } catch { /* 用下面的兜底 */ }
  }
  if (!agentId) agentId = process.env.A2A_AGENT_ID || null;
  if (!agentId) {
    // 兜底：identity.name + 可达 host:port
    try {
      const identity = JSON.parse(fs.readFileSync(path.join(__dirname, 'identity.json'), 'utf8'));
      const host = identity.publicHost || process.env.A2A_ADVERTISE_HOST || 'localhost';
      const port = identity.port || process.env.A2A_PORT || 3100;
      agentId = `${identity.name}@${host}:${port}`;
    } catch (e) {
      return (_selfCache = { ok: false, reason: `无法确定 agent_id: ${e.message}` });
    }
  }

  return (_selfCache = { ok: true, agentId, privateKey, publicJwk, source: resolved.source || 'env', keyPath });
}

/** 测试/重载用 */
function _resetSelf() { _selfCache = null; }

// ─────────────────────────────────────────────────────────────
// 签发
// ─────────────────────────────────────────────────────────────

/**
 * 签发 AAT
 * @param {object} opts
 * @param {string} opts.audience 受众的 agent_id（必须明确，不允许 '*'）
 * @param {string[]} [opts.capabilities]
 * @param {number} [opts.ttl]
 * @returns {{ok:boolean, token?:string, reason?:string}}
 */
function sign({ audience, capabilities = [], ttl = AAT_TTL } = {}) {
  if (!audience || typeof audience !== 'string') {
    return { ok: false, reason: 'audience 必填（不允许 "*" 或无受众签名 —— 那会让消息可被任何实例当作已认证）' };
  }
  if (audience === '*') {
    return { ok: false, reason: 'audience 不允许为 "*"（受众必须锚定到具体实例）' };
  }
  const self = getSelf();
  if (!self.ok) return { ok: false, reason: self.reason };

  try {
    const token = _aatLib().createAAT({
      privateKey: self.privateKey,
      issuer: self.agentId,
      audience,
      capabilities,
      ttl,
      kid: self.publicJwk.kid || undefined,
    });
    return { ok: true, token, issuer: self.agentId, audience };
  } catch (e) {
    return { ok: false, reason: `签发失败: ${e.message}` };
  }
}

/**
 * 给 outbound sender 挂上 AAT
 * @param {object} sender  现有的 sender（{name, emoji, url}）
 * @param {string} audience 收件方 agent_id
 * @returns {object} 新的 sender（失败时原样返回，并带 _aatError 便于排查）
 */
function attach(sender, audience, opts = {}) {
  const base = { ...(sender || {}) };
  if (process.env.A2A_AAT_DISABLE === '1') {
    base._aat = 'disabled';
    return base;
  }
  const r = sign({ audience, capabilities: opts.capabilities, ttl: opts.ttl });
  if (!r.ok) {
    base._aatError = r.reason;
    return base;
  }
  base.aat = r.token;
  return base;
}

// ─────────────────────────────────────────────────────────────
// 验证（只认固定公钥）
// ─────────────────────────────────────────────────────────────

/** agent id → host:port */
function _hostOf(id) {
  if (!id || typeof id !== 'string') return '';
  const at = id.lastIndexOf('@');
  return (at === -1 ? id : id.slice(at + 1)).trim().toLowerCase();
}

function _hostOfUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const m = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
  return (m ? m[1] : url).trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * 找发送方**已固定**的公钥
 * 只看本地 config（agents.local.json / agents.json），绝不访问网络
 * @returns {{ok:boolean, key?:object, agentId?:string, reason?:string}}
 */
function findPinnedKey(sender) {
  const s = sender || {};
  let agents;
  try {
    agents = require('./config/loader.js').getAgentList() || [];
  } catch (e) {
    return { ok: false, reason: `config 不可用: ${e.message}` };
  }

  const host = _hostOfUrl(s.url) || _hostOf(s.id || s.agentId || '');
  const name = (s.name || '').replace(/\s*[🌸🔧💼📜🧙🚤🦐🌿✨💧🌊🌟🎋🌱]\s*/gu, '').trim();

  const hit = agents.find((a) => {
    const aHost = _hostOfUrl(a.url) || _hostOf(a.id);
    if (host && aHost === host) return true;
    // 名字仅在没有 host 时作为次级判据（仍然要求该条目已固定公钥）
    if (!host && name) {
      const aName = (a.name || '').replace(/\s*[🌸🔧💼📜🧙🚤🦐🌿✨💧🌊🌟🎋🌱]\s*/gu, '').trim();
      return aName === name;
    }
    return false;
  });

  if (!hit) return { ok: false, reason: `config 中找不到发送方条目（host=${host || '—'}, name=${name || '—'}）` };
  if (!hit.aidPublicKey) {
    return { ok: false, reason: `${hit.name || hit.id} 未固定 AID 公钥（config 缺 aidPublicKey）—— 无法验证 AAT` };
  }
  let key = hit.aidPublicKey;
  if (typeof key === 'string') {
    try { key = JSON.parse(key); } catch { return { ok: false, reason: `${hit.name || hit.id} 的 aidPublicKey 不是合法 JSON` }; }
  }
  if (!key || !key.x) return { ok: false, reason: `${hit.name || hit.id} 的 aidPublicKey 缺少 x 字段` };

  return { ok: true, key, agentId: hit.id || null, name: hit.name || null };
}

/**
 * 按 **issuer**（token 里自带的、但必须验签后才可信的字段）查本地固定公钥
 *
 * 为什么不用 sender.url 查：sender.url 是发送方自报的，NAT/内网环境下
 *   经常是 localhost 或内网地址，与对方真实身份无关。实测：我们给自己发消息，
 *   sender.url 是 localhost:3100，而我们配置里是 172.28.0.214:3100 —— 对不上。
 *   iss 虽然也在 token 里，但它被签名覆盖：改了 iss 必然导致验签失败。
 *   所以「按 iss 选钥匙，再用该钥匙验签名」是安全的。
 */
function findPinnedKeyByIssuer(iss) {
  if (!iss || typeof iss !== 'string') return { ok: false, reason: 'token 无 iss' };
  let agents;
  try {
    agents = require('./config/loader.js').getAgentList() || [];
  } catch (e) {
    return { ok: false, reason: `config 不可用: ${e.message}` };
  }

  const issHost = _hostOf(iss);
  const issName = stripEmojiSafe(iss.split('@')[0]);

  const hit = agents.find((a) => {
    const aHost = _hostOfUrl(a.url) || (a.host && a.port ? `${a.host}:${a.port}`.toLowerCase() : '');
    if (issHost && aHost === issHost) return true;              // 主机一致
    const aName = stripEmojiSafe(a.name);
    return !!issName && aName === issName && _hostOfUrl(a.url) === issHost; // 名字+主机同时一致
  });

  if (!hit) return { ok: false, reason: `没有已固定公钥的条目对应 issuer "${iss}"` };
  if (!hit.aidPublicKey) {
    return { ok: false, reason: `${stripEmojiSafe(hit.name) || hit.id} 未固定 AID 公钥 —— 无法验证 AAT（在 config 里补 aidPublicKey）` };
  }
  let key = hit.aidPublicKey;
  if (typeof key === 'string') {
    try { key = JSON.parse(key); } catch { return { ok: false, reason: 'aidPublicKey 不是合法 JSON' }; }
  }
  if (!key || !key.x) return { ok: false, reason: 'aidPublicKey 缺少 x 字段' };
  return { ok: true, key, agentId: hit.id || null, name: stripEmojiSafe(hit.name) || null };
}

function stripEmojiSafe(s) {
  return (s || '').replace(/\s*[🌸🔧💼📜🧙🚤🦐🌿✨💧🌊🌟🎋🌱]\s*/gu, '').trim();
}

/**
 * 验证入站消息携带的 AAT
 *
 * @param {object} sender  消息里的 sender（含 aat）
 * @param {object} opts
 * @param {string} opts.expectedAudience 本实例 agent_id（必填，禁止 null）
 * @returns {{ok:boolean, trustLevel?:number, source?:string, payload?:object, reason?:string, error?:string}}
 */
function verifyInbound(sender, { expectedAudience } = {}) {
  const s = sender || {};

  if (!expectedAudience) {
    return { ok: false, error: 'missing_expected_audience', reason: '不校验受众等于允许受众混淆，拒绝验证' };
  }

  const token = s.aat || s.attestation || null;
  if (!token) return { ok: false, error: 'no_token', reason: '消息未携带 AAT' };

  // 先读 iss（**未验签，仅用于选钥匙**），再用该钥匙验签 —— 见 findPinnedKeyByIssuer 注释
  let iss = null;
  try {
    const payloadB64 = token.split('.')[1];
    iss = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')).iss || null;
  } catch {
    return { ok: false, error: 'malformed', reason: '无法解析 token payload（不是三段式 JWT？）' };
  }

  const pinned = findPinnedKeyByIssuer(iss);
  if (!pinned.ok) return { ok: false, error: 'no_pinned_key', reason: pinned.reason, issuer: iss };

  const r = _aatLib().verifyAAT(token, {
    publicKey: pinned.key,
    expectedAudience,
    jtiCache: {
      has: (j) => _jtiCache.has(j),
      add: (j) => _rememberJti(j),
    },
  });

  if (!r.valid) {
    return { ok: false, error: r.error, reason: _explain(r.error), detail: r.detail };
  }

  // 交叉核对：sender.url 若指向**另一个已固定公钥的 Agent**，说明「签名主体 ≠ 声称来源」→ 拒绝
  // 若 sender.url 只是 localhost/内网地址（config 里没有），只提示不拒绝——
  //   NAT 环境下自报地址不可靠，信任应建立在密码学身份上，而非地址上。
  const issHost = _hostOf(r.payload.iss);
  const senderHost = _hostOfUrl(s.url) || _hostOf(s.id || s.agentId || '');
  if (senderHost && issHost && senderHost !== issHost) {
    // 自报地址是否「可用作身份线索」：localhost / 回环地址在任何环境都不指向别人，忽略它
    const unreliable = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)(:\d+)?$/i.test(senderHost);
    if (!unreliable) {
      let mapped = null;
      try {
        const list = require('./config/loader.js').getAgentList() || [];
        mapped = list.find((a) => (_hostOfUrl(a.url) || '') === senderHost && a.aidPublicKey);
      } catch { /* 忽略 */ }
      return {
        ok: false,
        error: 'issuer_host_mismatch',
        reason: `签名主体是 ${r.payload.iss}，但消息声称来自 ${senderHost}`
          + (mapped ? `（对应已固定 Agent: ${stripEmojiSafe(mapped.name)}）` : '')
          + ' —— 声称来源与签名身份不一致，拒绝',
      };
    }
    console.warn(`[AAT] ℹ️ sender.url(${senderHost}) 是回环地址，不作为身份线索；按签名主体 ${r.payload.iss} 认定`);
  }

  // 防重放：verifyAAT 已消费 jti，这里只确认它确实用过
  return {
    ok: true,
    trustLevel: 2,          // AAT 已验证：高于「无」，低于握手会话（握手含双向挑战）
    source: 'aat',
    matchedBy: 'aat',
    issuer: r.payload.iss,
    agentId: pinned.agentId,
    expiresAt: r.payload.exp,
    capabilities: r.payload.capabilities || [],
  };
}

function _explain(err) {
  return {
    missing_token: '没有 token',
    malformed: 'token 不是三段式 JWT',
    bad_public_key: '固定的公钥不可解析（配置问题，不是签名问题）',
    bad_signature: '签名不匹配（密钥不对，或消息被篡改）',
    expired: 'token 已过期',
    missing_exp: 'token 缺 exp',
    invalid_exp: 'exp <= iat',
    time_drift: 'iat 与本地时间偏差超过 5 分钟（检查时钟）',
    audience_mismatch: 'token 的受众不是本实例（可能发给了别人）',
    replay_detected: '这个 jti 已用过（重放）',
    missing_jti: 'token 缺 jti',
  }[err] || err;
}

// ─────────────────────────────────────────────────────────────
// 受众推断（发送侧用）
// ─────────────────────────────────────────────────────────────

/**
 * 由目标 URL 推断收件方 agent_id（`<id>@<host>:<port>`）
 *
 * 优先用 config 里的 id。**查不到就返回 null，不再回落成 `agent@<host>`。**
 *
 * 为什么改（2026-10-25 若兰）：
 *   旧实现查不到时返回 `agent@<host>`。这个占位值**永远不可能**等于对方的
 *   expectedAudience（对方锚定的是 `<名字>@<host>`），于是：
 *     签得出 → 100% audience_mismatch → 双方都零报错。
 *   实测代价：一台实例连发 4 条，每条都被拒，它以为已经通了。
 *   签一个注定验不过的 token，比不签更坏——它让双方都以为在验证，实际在自欺。
 *
 * 现在：返回 null，打一行 warn 说明差什么，由调用方决定降级（不带 AAT 照发）
 *   或拒绝（见 scripts/aat-send.js）。**身份不许有默认值**（P2）。
 *
 * @returns {string|null} `<id>@<host>` 或 null
 */
function audienceForUrl(agentUrl) {
  const host = _hostOfUrl(agentUrl);
  if (!host) return null;
  try {
    const list = require('./config/loader.js').getAgentList() || [];
    const hit = list.find((a) => _hostOfUrl(a.url) === host);
    if (hit && hit.id) return `${hit.id}@${host}`;

    console.warn(
      `[AAT] ⚠️ 无法确定收件方 agent_id：config 里没有 ${host} 这个条目。\n`
      + `      拒绝签一个注定 audience_mismatch 的 token（旧的 agent@${host} 占位值已废弃）。\n`
      + `      修法二选一：① 把对端 name/host/port 写进 config/agents.local.json `
      + `② 显式指定 --aud <对方agent_id>`
    );
  } catch (e) {
    console.warn(`[AAT] ⚠️ 推断受众失败（config 不可用）: ${e.message}`);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 公钥导出（用于带外交换）
// ─────────────────────────────────────────────────────────────

/** 导出本实例公钥，供对方固定 */
function exportPublicKey() {
  const self = getSelf();
  if (!self.ok) return { ok: false, reason: self.reason };
  const spki = crypto.createPublicKey(self.privateKey).export({ type: 'spki', format: 'der' });
  const fp = crypto.createHash('sha256').update(spki).digest('hex');
  return {
    ok: true,
    agentId: self.agentId,
    publicKey: self.publicJwk,
    fingerprint: fp,
    // 人类核对用：分组便于念读
    fingerprintShort: fp.slice(0, 32).match(/.{1,4}/g).join(' '),
  };
}

module.exports = {
  AAT_TTL,
  getSelf,
  sign,
  attach,
  verifyInbound,
  findPinnedKey,
  findPinnedKeyByIssuer,
  audienceForUrl,
  exportPublicKey,
  _resetSelf,
  _jtiCache,
};
