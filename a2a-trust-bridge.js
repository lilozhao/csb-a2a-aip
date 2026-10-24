/**
 * a2a-trust-bridge.js — 握手信任桥接
 *
 * 将 CSB-Security 五步握手（/a2a/handshake）建立的信任等级，
 * 桥接到 A2A 消息处理层（_resolveSenderInfo）的信任校验。
 *
 * 信任解析优先级：
 *   1. 握手会话（本模块 registerHandshakeSession 注册）——签名验证过的信任，最高
 *   2. 消息 AAT 签名验证（metadata 携带 attestation，需发送方 AID 公钥）——次高
 *   3. 无 → 返回 null，调用方回退现有 name+URL 匹配逻辑
 *
 * ─────────────────────────────────────────────────────────────
 * 2026-10-24 修复（P0 · 若兰）：「存和取用的不是同一个键」
 *
 * 症状：握手跑通、会话也注册了，但生产环境里**这条信任路径从未命中过一次**。
 *
 * 根因：注册用 caller_id（`mingde@csbc.lilozkzy.top:3100`），
 *       查询用 senderName（`明德`）—— 两个不同命名空间，永远对不上。
 *
 * 更深的根因（不只是键写错）：**name 是攻击者可以随便填的字段**。
 *       如果按名字查，伪造者只要把 sender.name 写成「明德」就能拿到 L1 信任，
 *       那握手就白做了 —— 与「伪造者无法完成签名握手」的设计本意直接冲突。
 *
 * 现在：
 *   - 注册时建**多重别名**：caller_id / host:port / 已知 Agent 名 / 本地名
 *   - 解析时**优先按 host 锚定**（来自 metadata.sender.url / id）
 *   - **仅凭 name 不给信任**（默认 allowNameOnly=false），
 *     命中时只打一条 warn 说明「差一点就误信了」，方便排查
 *
 * 残余风险（诚实边界）：metadata.sender.url 仍是自述字段，不是密码学证明。
 * 要真正防伪，需要消息级签名（AAT）——本模块的 AAT 通道就是为此准备的。
 * ─────────────────────────────────────────────────────────────
 *
 * 设计说明：
 *   - 握手会话 TTL 与 handshake 的 session ttl 一致（默认 5 分钟）
 *   - 会话过期自动清理；未配置握手密钥的环境下模块空转，不影响现有行为
 *
 * 版本: 1.1.0 | 2026-10-24 | 若兰
 */

const SESSION_TTL_MS = 5 * 60 * 1000; // 默认 5 分钟（与握手 session ttl 对齐）

/** 去掉名字里的装饰性 emoji */
function stripEmoji(s) {
  return (s || '').replace(/\s*[🌸🔧💼📜🧙🚤🦐🌿✨💧🌊🌟🎋🌱🛠️]\s*/gu, '').trim();
}

/**
 * 从 agent id 取 host:port
 * "mingde@csbc.lilozkzy.top:3100" → "csbc.lilozkzy.top:3100"
 */
function hostFromAgentId(id) {
  if (!id || typeof id !== 'string') return '';
  const at = id.lastIndexOf('@');
  if (at === -1) return '';
  return normalizeHost(id.slice(at + 1));
}

/** 从 URL 取 host:port："http://h:3100/a2a/json-rpc" → "h:3100" */
function hostFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const m = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
  if (m) return normalizeHost(m[1]);
  // 允许传裸 host:port
  if (/^[^\s/]+:\d+$/.test(url.trim())) return normalizeHost(url.trim());
  return '';
}

function normalizeHost(h) {
  return (h || '').trim().toLowerCase().replace(/\/+$/, '');
}

/** 从 agent id 取本地名（@ 之前部分）
 *  "mingde@csbc..." → "mingde"；无 @ 时返回去 emoji 的原值
 */
function localPart(id) {
  if (!id || typeof id !== 'string') return '';
  const at = id.lastIndexOf('@');
  return (at === -1 ? id : id.slice(0, at)).trim();
}

class TrustBridge {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.allowNameOnly=false] 是否允许「仅凭名字」授予握手信任
   *        ⚠️ 默认 false：name 可伪造，按名字给信任等于没做握手
   */
  constructor(opts = {}) {
    /** @type {Map<string, object>} callerId -> session（唯一事实） */
    this.sessions = new Map();
    /** @type {Map<string, {callerId: string, kind: 'id'|'host'|'name'}>} 别名 -> callerId */
    this.aliases = new Map();
    this.allowNameOnly = opts.allowNameOnly === true;
    // 定期清理过期会话（unref 避免阻塞进程退出）
    this._cleanupTimer = setInterval(() => this._cleanup(), 60000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /**
   * 注册握手会话（五步握手 complete 后调用）
   *
   * @param {object} session - HandshakeManager 返回的会话（须含 caller_id）
   * @param {object} [opts]
   * @param {string[]} [opts.names] 额外姓名别名（通常来自 config 的已知 Agent 名）
   * @returns {boolean} 是否注册成功
   */
  registerHandshakeSession(session, opts = {}) {
    if (!session || !session.caller_id) return false;

    const callerId = String(session.caller_id).trim();
    const level = session.security_level ?? 0;
    const scopes = session.scopes_granted || [];

    // 同一 caller 重新握手：先清旧别名，避免指向过期会话
    this._dropAliasesOf(callerId);

    this.sessions.set(callerId, { ...session, _registeredAt: Date.now() });

    // ── 建别名 ──
    const host = hostFromAgentId(callerId);
    const local = localPart(callerId);

    this._setAlias(callerId, callerId, 'id');
    if (host) {
      this._setAlias(host, callerId, 'host');
      // ── 域名 ↔ IP 等价别名（异步补登记）──
      //    实况：config 里明德是 47.121.28.125:3100，握手 caller_id 却可能是
      //    csbc.lilozkzy.top:3100。同一实例两个地址，按 host 严格匹配照样对不上。
      //    这里做一次 DNS 反查，把解析到的 IP 也登记成别名（失败静默，不影响主流程）。
      //    ⚠️ 残余风险：共享 IP / 域名重绑定仍可能误配，故只作 host 级补充，不作密码学证明。
      this._registerDnsAliases(host, callerId);
    }

    // 姓名别名：显式传入 + config 里按 host 反查到的名字 + caller_id 的本地名
    const nameSet = new Set();
    for (const n of (opts.names || [])) {
      if (n) nameSet.add(stripEmoji(n));
    }
    // ── 从 config 反查：host:port → 已知 Agent 的中文名 ──
    //    这样调用方不必知道名字，注册一次就同时有 id / host / 中文名 三种键。
    if (host) {
      try {
        const { getKnownAgents } = require('./config/loader.js');
        for (const a of getKnownAgents() || []) {
          if (hostFromUrl(a.url) === host && a.name) nameSet.add(stripEmoji(a.name));
        }
      } catch { /* config 不可用：只用 id / host / 本地名 */ }
    }
    if (local && !local.includes(':')) nameSet.add(stripEmoji(local));
    for (const nm of nameSet) {
      if (nm) this._setAlias(nm.toLowerCase(), callerId, 'name');
    }

    console.log(
      `[TrustBridge] 🔐 握手信任已注册: ${callerId} → L${level} `
      + `(${scopes.join(',') || '无 scope'}) TTL=${session.ttl ?? 300}s`
      + ` | 别名: host=${host || '—'}${nameSet.size ? ' name=' + [...nameSet].join('/') : ''}`
    );
    return true;
  }

  /** 异步登记 DNS 解析出的 IP 别名（域名与 IP 互通） */
  _registerDnsAliases(host, callerId) {
    const [h, port] = String(host).split(':');
    if (!h || !port || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return; // 已是 IP，无需反查
    try {
      const { promises: dns } = require('dns');
      dns.lookup(h, { all: true })
        .then((list) => {
          for (const { address } of list) {
            if (!this.sessions.has(callerId)) return; // 期间会话已过期/被清
            this._setAlias(`${address}:${port}`, callerId, 'host');
          }
        })
        .catch(() => { /* DNS 不可用：只用原 host */ });
    } catch { /* 无 dns 模块：跳过 */ }
  }

  /** 写别名：同一别名已被别的 caller 占用时，后来的覆盖并告警（可能是同名不同主机） */
  _setAlias(alias, callerId, kind) {
    if (!alias) return;
    const key = normalizeHost(alias);
    const prev = this.aliases.get(key);
    if (prev && prev.callerId !== callerId) {
      console.warn(
        `[TrustBridge] ⚠️ 别名冲突: "${alias}" 原属 ${prev.callerId}(${prev.kind})，`
        + `现被 ${callerId} 覆盖 —— 若两者是不同实例，请核对称谓`
      );
    }
    this.aliases.set(key, { callerId, kind });
  }

  /** 移除某 caller 的全部别名 */
  _dropAliasesOf(callerId) {
    for (const [alias, v] of this.aliases.entries()) {
      if (v.callerId === callerId) this.aliases.delete(alias);
    }
  }

  /**
   * 查询发送者的握手信任等级
   *
   * @param {string} senderName - 发送者名称（可能带 emoji）
   * @param {object} metadata - 消息元数据（含 sender: {name,url,id}）
   * @returns {object|null} { trustLevel, source:'handshake'|'aat', matchedBy, sessionId, scopes }
   */
  resolveTrustLevel(senderName, metadata = {}) {
    const sender = metadata?.sender && typeof metadata.sender === 'object' ? metadata.sender : {};
    const senderStr = typeof metadata?.sender === 'string' ? metadata.sender : '';

    // ── 1. 强匹配：按 host 锚定（url / id / caller_id）──
    //    sender.url 或 sender.id 是「主机级」自述，配合握手（该主机确曾通过验证）使用；
    //    比纯名字强得多，但仍非密码学证明（见文件头残余风险）。
    const strongCandidates = [];
    if (sender.url) strongCandidates.push({ key: hostFromUrl(sender.url), how: 'sender.url' });
    for (const f of ['id', 'agentId', 'agent_id', 'caller_id', 'callerId']) {
      if (sender[f]) strongCandidates.push({ key: hostFromAgentId(String(sender[f])), how: `sender.${f}` });
    }
    if (senderStr) strongCandidates.push({ key: hostFromAgentId(senderStr), how: 'sender(string)' });

    for (const c of strongCandidates) {
      if (!c.key) continue;
      const hit = this._lookup(c.key);
      if (hit) return this._asResult(hit, 'handshake', c.how);
    }

    // 也允许直接传完整的 caller_id 作为 senderName（服务端内部调用）
    const nameAsId = hostFromAgentId(stripEmoji(senderName));
    if (nameAsId) {
      const hit = this._lookup(nameAsId);
      if (hit) return this._asResult(hit, 'handshake', 'senderName:id');
    }

    // ── 2. 弱匹配：仅凭名字 ──
    //    name 是攻击者可控字段。默认**不授予信任**，只提示「差一点误信」。
    const cleanName = stripEmoji(senderName);
    if (cleanName) {
      const hit = this._lookup(cleanName);
      if (hit) {
        if (this.allowNameOnly) {
          console.warn(`[TrustBridge] ⚠️ 按名字授予握手信任（allowNameOnly=true）: ${cleanName} —— name 可伪造，仅限调试`);
          return this._asResult(hit, 'handshake', 'name(weak)');
        }
        console.warn(
          `[TrustBridge] 🛡️ 拒绝按名字授予信任: "${cleanName}" 命中 ${hit.session.caller_id}，`
          + `但消息未带 sender.url/id —— 名字可伪造，需 host 或 AAT 才能确认`
        );
      }
    }

    // ── 3. AAT 消息级签名（唯一能真正防伪的通道）──
    //    2026-10-24 重写：此前传给 verifyAAT 的 expectedAudience 是 null，
    //    等于「不校验受众」——一条本来发给明德的 token 也能被我们认作有效。
    //    现在必须锚定到本实例 agent_id，且公钥只认本地固定值（见 a2a-aat.js）。
    const aatToken = sender.aat || metadata?.aat || metadata?.attestation || sender.attestation;
    if (aatToken && typeof aatToken === 'string') {
      try {
        const aat = require('./a2a-aat.js');
        const self = aat.getSelf();
        if (!self.ok) {
          console.warn(`[TrustBridge] ⚠️ 收到 AAT 但本实例无法确定自身 agent_id: ${self.reason}`);
        } else {
          const r = aat.verifyInbound(sender, { expectedAudience: self.agentId });
          if (r.ok) {
            console.log(`[TrustBridge] ✅ AAT 签名验证通过: ${r.issuer} → L${r.trustLevel} (exp in ${r.expiresAt - Math.floor(Date.now() / 1000)}s)`);
            return {
              trustLevel: r.trustLevel,
              source: 'aat',
              matchedBy: 'aat',
              issuer: r.issuer,
              capabilities: r.capabilities,
            };
          }
          // 六种失败分开报，不再混成一句
          console.warn(`[TrustBridge] ⚠️ AAT 验证未通过: ${sender.name || '?'} — ${r.error}: ${r.reason}`);
          this.lastAatError = { name: sender.name, error: r.error, reason: r.reason, at: Date.now() };
        }
      } catch (e) {
        console.warn(`[TrustBridge] ⚠️ AAT 验证异常: ${e.message}`);
      }
    }

    return null;
  }

  /** 按别名取会话（含过期判定） */
  _lookup(alias) {
    const key = normalizeHost(alias);
    const entry = this.aliases.get(key);
    if (!entry) return null;
    const session = this.sessions.get(entry.callerId);
    if (!session) {
      // 孤儿别名：会话已清，顺手清掉
      this.aliases.delete(key);
      return null;
    }
    const ttlMs = (session.ttl ?? 300) * 1000;
    if (Date.now() - session._registeredAt >= ttlMs) {
      this._dropAliasesOf(entry.callerId);
      this.sessions.delete(entry.callerId);
      return null;
    }
    return { session, kind: entry.kind };
  }

  _asResult(hit, source, matchedBy) {
    const s = hit.session;
    return {
      trustLevel: s.security_level ?? 0,
      source,
      matchedBy,
      sessionId: s.session_id,
      scopes: s.scopes_granted || [],
    };
  }


  /**
   * 列出当前握手信任会话（调试/管理用）
   */
  listSessions() {
    const out = [];
    for (const [callerId, s] of this.sessions.entries()) {
      const ttlMs = (s.ttl ?? 300) * 1000;
      if (Date.now() - s._registeredAt >= ttlMs) continue;
      out.push({
        caller_id: callerId,
        security_level: s.security_level,
        scopes: s.scopes_granted,
        ttl: s.ttl,
        created_at: s.created_at,
        expires_in_s: Math.max(0, Math.round((ttlMs - (Date.now() - s._registeredAt)) / 1000)),
        aliases: [...this.aliases.entries()].filter(([, v]) => v.callerId === callerId).map(([k]) => k),
      });
    }
    return out;
  }

  /** 清理过期会话（连带别名） */
  _cleanup() {
    const now = Date.now();
    for (const [callerId, s] of this.sessions.entries()) {
      const ttlMs = (s.ttl ?? 300) * 1000;
      if (now - s._registeredAt >= ttlMs) {
        this.sessions.delete(callerId);
        this._dropAliasesOf(callerId);
      }
    }
  }
}

// 单例导出（server 全局共享）
const _singleton = new TrustBridge();

module.exports = {
  TrustBridge,
  trustBridge: _singleton,
  // 供测试使用的纯函数
  _internals: { stripEmoji, hostFromAgentId, hostFromUrl, normalizeHost, localPart },
};
