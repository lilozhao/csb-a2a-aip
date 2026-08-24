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
 * 设计说明：
 *   - 握手会话 TTL 与 handshake 的 session ttl 一致（默认 5 分钟）
 *   - 会话过期自动清理；未配置握手密钥的环境下模块空转，不影响现有行为
 *   - 这是无签名体系（伪造 senderName）问题的根治路径：伪造者无法完成
 *     签名握手，因此无法获得握手信任等级
 *
 * 用法：
 *   const trustBridge = require('./a2a-trust-bridge.js');
 *   // 握手完成时（security-handshake.js complete 分支）：
 *   trustBridge.registerHandshakeSession(session);
 *   // 消息处理时（a2a-standard-api-v5.js _resolveSenderInfo）：
 *   const t = trustBridge.resolveTrustLevel(senderName, senderUrl, metadata);
 *
 * 版本: 1.0.0 | 2026-08-24 | 若兰 🌸
 */

const SESSION_TTL_MS = 5 * 60 * 1000; // 默认 5 分钟（与握手 session ttl 对齐）

class TrustBridge {
  constructor() {
    /** @type {Map<string, object>} callerId -> session */
    this.sessions = new Map();
    // 定期清理过期会话（unref 避免阻塞进程退出）
    this._cleanupTimer = setInterval(() => this._cleanup(), 60000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /**
   * 注册握手会话（五步握手 complete 后调用）
   * @param {object} session - HandshakeManager._createSession 返回的会话
   * @returns {boolean} 是否注册成功
   */
  registerHandshakeSession(session) {
    if (!session || !session.caller_id) return false;
    const level = session.security_level ?? 0;
    const scopes = session.scopes_granted || [];
    this.sessions.set(session.caller_id, {
      ...session,
      _registeredAt: Date.now(),
    });
    console.log(`[TrustBridge] 🔐 握手信任已注册: ${session.caller_id} → L${level} (${scopes.join(',') || '无 scope'}) TTL=${session.ttl ?? 300}s`);
    return true;
  }

  /**
   * 查询发送者的握手信任等级
   * @param {string} senderName - 发送者名称（可能带 emoji）
   * @param {object} metadata - 消息元数据（可选，含 aat/attestation）
   * @returns {object|null} { trustLevel, source: 'handshake'|'aat', session? } 或 null（无握手信任）
   */
  resolveTrustLevel(senderName, metadata = {}) {
    const cleanName = (senderName || '').replace(/\s*[🌸🔧💼📜🧙🚤🦐🌿✨💧🌊🌟]\s*/g, '');

    // 1. 握手会话优先
    const session = this.sessions.get(cleanName) || this.sessions.get(senderName);
    if (session) {
      const ttlMs = (session.ttl || 300) * 1000;
      if (Date.now() - session._registeredAt <= ttlMs) {
        return {
          trustLevel: session.security_level ?? 0,
          source: 'handshake',
          sessionId: session.session_id,
          scopes: session.scopes_granted || [],
        };
      }
      // 会话过期，清理
      this.sessions.delete(cleanName);
      this.sessions.delete(senderName);
    }

    // 2. 消息携带 AAT 签名（需发送方 AID 公钥，见 _verifyAAT）
    const aatToken = metadata?.sender?.aat || metadata?.aat || metadata?.attestation || metadata?.sender?.attestation;
    if (aatToken && typeof aatToken === 'string') {
      const aatResult = this._verifyAAT(aatToken, metadata);
      if (aatResult) return aatResult;
    }

    return null;
  }

  /**
   * 验证消息携带的 AAT（Attestation Token）
   * 需要发送方的 AID 公钥——从 config/agents.json 的 knownAgents 中查找
   * （Agent 若配置了 aid 公钥字段则可用；未配置时跳过验证）
   *
   * @param {string} token - AAT JWT
   * @param {object} metadata - 消息元数据（含 sender 信息）
   * @returns {object|null} { trustLevel, source: 'aat' } 或 null
   */
  _verifyAAT(token, metadata) {
    try {
      const { verifyAATWithAID } = require('../../csb-security/lib/identity/aat.js');
      const configLoader = require('./config/loader.js');
      const knownAgents = configLoader.getKnownAgents();
      const senderName = metadata?.sender?.name || '';
      const cleanName = senderName.replace(/\s*[🌸🔧💼📜🧙🚤🦐🌿✨💧🌊🌟]\s*/g, '');
      const agent = knownAgents.find((a) => a.name === senderName || a.name === cleanName);
      // 需要发送方 AID 公钥（agents.json 中配置 aidPublicKey 字段）
      const aid = agent?.aidPublicKey ? { public_key: agent.aidPublicKey } : null;
      if (!aid) return null; // 无公钥源，跳过 AAT 验证
      const result = verifyAATWithAID(token, aid, { expectedAudience: null });
      if (result?.valid) {
        const trustLevel = agent?.trustLevel || 1;
        console.log(`[TrustBridge] ✅ AAT 签名验证通过: ${senderName} → L${trustLevel}`);
        return { trustLevel, source: 'aat' };
      }
      console.warn(`[TrustBridge] ⚠️ AAT 验证失败: ${senderName} — ${result?.error || 'invalid'}`);
    } catch (e) {
      // csb-security 不可用或格式问题：跳过 AAT 验证（回退 name+URL）
    }
    return null;
  }

  /**
   * 列出当前握手信任会话（调试/管理用）
   */
  listSessions() {
    const out = [];
    for (const [callerId, s] of this.sessions.entries()) {
      out.push({
        caller_id: callerId,
        security_level: s.security_level,
        scopes: s.scopes_granted,
        ttl: s.ttl,
        created_at: s.created_at,
        expires_in_s: Math.max(0, Math.round(((s.ttl || 300) * 1000 - (Date.now() - s._registeredAt)) / 1000)),
      });
    }
    return out;
  }

  /** 清理过期会话 */
  _cleanup() {
    const now = Date.now();
    for (const [callerId, s] of this.sessions.entries()) {
      const ttlMs = (s.ttl || 300) * 1000;
      if (now - s._registeredAt > ttlMs) {
        this.sessions.delete(callerId);
      }
    }
  }
}

// 单例导出（server 全局共享）
const _singleton = new TrustBridge();

module.exports = { TrustBridge, trustBridge: _singleton };
