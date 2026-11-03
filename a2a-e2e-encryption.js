/**
 * a2a-e2e-encryption.js — A2A-021 端到端加密策略 v1.0
 * ------------------------------------------------------------------
 * 基于 AES-256-GCM 实现:
 *   - 密钥派生: HKDF-SHA256
 *   - 加密:   AES-256-GCM (认证加密)
 *   - 签名:   HMAC-SHA256
 *   - 密钥交换: 预共享密钥模式 (PSK, 适用于已知 Agent 网络)
 *   - 后续可扩展 ECDH
 *
 * 协议: A2A v0.5 §A2A-021
 * 版本: 1.1.0 | 2026-11-03
 *
 * ── [2026-11-03 · P0-4「A2A E2E 加密：真做，或诚实降级」] ─────────────
 * 起因（知微《CSB-Harness 2.0 优化升级方案 v1》事实 3）：
 *   原来的实现有两个「假绿」，比明说不支持更危险——
 *   因为对接方会以为可以传敏感数据：
 *     ① 出站只置 `obj.encrypted = true`，**一个字节都没加密**
 *     ② 无密钥时 `verifySignature` 直接 `return true`（签名形同虚设）
 *   而 `/health` 又按 `enabled` 报 e2e 状态 ⇒ 外部监控看到绿灯，实际没加密。
 *
 * 本次改法（方案建议先做 B「诚实降级」）：
 *   ① **三态**取代布尔：enabled | degraded | disabled
 *      - enabled  = 有密钥且出站真加密
 *      - degraded = 有密钥但**出站未真加密**（reason: not_implemented）
 *      - disabled = 无密钥，完全没启用（reason: no_master_key）
 *   ② 出站不再置假标记：真加密才标 `encrypted:true`，否则**标 `encrypted:false`
 *      并附 reason**，让对端一眼看出这包是明文。
 *   ③ 无密钥时验签**不再默认通过**：返回 false 并给出 reason
 *      （`verifySignature` 改回布尔语义；需要区分原因的调用方用 `verifySignatureDetailed`）
 *
 * 诚实边界（本文件**没有**做到的）：
 *   - 出站信封级真加密（把 task.payload 用 AES-GCM 加密后再发）**未实现**：
 *     协议层两侧的解包顺序（客户端先读 result.task 再解 payload）没打通，
 *     硬改会破坏现有 17 家客户端。故本版只做到「诚实降级」，
 *     degraded 的含义就是「有密钥但出站仍是明文」。
 *   - `degraded` 不是中间态的借口：它必须带 reason，且 reason 不允许为空。
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;

/** E2E 三态取值（与 /health.e2e.status 同名） */
const E2E_STATUS = {
  ENABLED: 'enabled',     // 有密钥 + 出站真加密
  DEGRADED: 'degraded',   // 有密钥，但出站未真加密（reason 必填）
  DISABLED: 'disabled',   // 无密钥，完全未启用
};

class E2EEncryption {
  constructor(options = {}) {
    this.masterKey = options.masterKey || process.env.A2A_ENCRYPTION_KEY;
    this.enabled = !!this.masterKey;
    this.keyVersion = options.keyVersion || 1;
    this._derivedKeys = new Map(); // Map<agentId, Buffer>
    // 出站是否真加密：默认 false。本版**不**实现出站信封加密（见文件头诚实边界），
    // 所以即使配了密钥，也只会是 degraded —— 除非外部显式声明已实现。
    this.outboundEncrypted = options.outboundEncrypted === true;
    // 显式声明本实现「出站已真加密」时才允许 enabled；
    // 这是给未来真做时留的口子，也是防止 enabled 再次变成假绿的闸。
    if (this.outboundEncrypted && !this.enabled) {
      throw new Error('E2E: outboundEncrypted=true 但没有主密钥 —— 不允许出现「声明加密却没密钥」');
    }
  }

  /**
   * 派生 Agent 专属密钥 (HKDF)
   */
  getAgentKey(agentId) {
    if (!this.masterKey) throw new Error('E2E encryption not configured');
    if (!this._derivedKeys.has(agentId)) {
      const salt = crypto.createHash('sha256').update(agentId).digest();
      this._derivedKeys.set(agentId, crypto.hkdfSync('sha256', this.masterKey, salt, `a2a-e2e-${agentId}`, 32));
    }
    return this._derivedKeys.get(agentId);
  }

  /**
   * 加密消息
   * @returns { ciphertext, iv, tag, salt, keyVersion }
   */
  encrypt(plaintext, agentId) {
    if (!this.enabled) return { plaintext, encrypted: false, reason: 'no_master_key' };

    const key = this.getAgentKey(agentId);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
    ciphertext += cipher.final('base64');
    const tag = cipher.getAuthTag().toString('base64');

    return {
      ciphertext,
      iv: iv.toString('base64'),
      tag,
      keyVersion: this.keyVersion,
      encrypted: true,
    };
  }

  /**
   * 解密消息
   */
  decrypt(encryptedObj, agentId) {
    if (!encryptedObj.encrypted) return encryptedObj.plaintext;

    if (!this.enabled) {
      console.warn('[E2E] 收到加密消息但本地未配置密钥, agentId:', agentId);
    }

    try {
      const key = this.getAgentKey(agentId);
      const iv = Buffer.from(encryptedObj.iv, 'base64');
      const tag = Buffer.from(encryptedObj.tag, 'base64');
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);

      let plaintext = decipher.update(encryptedObj.ciphertext, 'base64', 'utf8');
      plaintext = plaintext + decipher.final('utf8');
      return plaintext;
    } catch (e) {
      console.error('[E2E] 解密失败:', e.message);
      return null;
    }
  }

  /**
   * 加密信封消息 (兼容现有 envelope.js)
   */
  encryptEnvelope(envelope, agentId) {
    if (!this.enabled) return envelope;

    const payload = JSON.stringify(envelope.payload || {});
    const encryptedPayload = this.encrypt(payload, agentId);

    return {
      ...envelope,
      encryption: {
        version: this.keyVersion,
        algorithm: ALGORITHM,
        encrypted: true,
      },
      payload: encryptedPayload,
    };
  }

  /**
   * 解密信封消息
   */
  decryptEnvelope(envelope, agentId) {
    if (!envelope.encryption?.encrypted) return envelope;

    const plaintext = this.decrypt(envelope.payload, agentId);
    if (!plaintext) {
      console.error('[E2E] 信封解密失败');
      return envelope;
    }

    return {
      ...envelope,
      encryption: { ...envelope.encryption, encrypted: false },
      payload: JSON.parse(plaintext),
    };
  }

  /**
   * HMAC-SHA256 消息签名
   */
  signMessage(plaintext) {
    if (!this.masterKey) return null;
    return crypto.createHmac('sha256', this.masterKey).update(plaintext).digest('base64');
  }

  /**
   * 验证签名
   *
   * [2026-11-03 · P0-4] 原来「无密钥或无签名 → 直接 return true」。
   * 那等于说：**没配密钥时，任何签名都算通过**——签名形同虚设，
   * 而外部监控看不出来（它只看 enabled）。
   * 现在：无密钥 → false（并可查详细原因）；无签名 → false。
   * 需要区分原因的调用方改用 verifySignatureDetailed()。
   */
  verifySignature(plaintext, signature) {
    return this.verifySignatureDetailed(plaintext, signature).valid;
  }

  /**
   * 验证签名（带原因）
   * @returns {{valid:boolean, reason?:string}}
   */
  verifySignatureDetailed(plaintext, signature) {
    if (!this.masterKey) return { valid: false, reason: 'no_master_key' };
    if (!signature) return { valid: false, reason: 'signature_missing' };
    const expected = this.signMessage(plaintext);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return { valid: false, reason: 'signature_length_mismatch' };
    return crypto.timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'signature_mismatch' };
  }

  /**
   * 当前 E2E 状态（三态）
   * @returns {{status:'enabled'|'degraded'|'disabled', reason:string|null}}
   */
  getStatus() {
    if (!this.enabled) {
      return { status: E2E_STATUS.DISABLED, reason: 'no_master_key' };
    }
    if (!this.outboundEncrypted) {
      // 有密钥但出站没真加密 —— 诚实说出来，不让 /health 报绿
      return { status: E2E_STATUS.DEGRADED, reason: 'not_implemented' };
    }
    return { status: E2E_STATUS.ENABLED, reason: null };
  }

  /**
   * 获取统计（/health 用）
   *
   * [2026-11-03 · P0-4] 保留 `enabled` 字段是为了**不打断旧客户端**，
   * 但它的含义已从「E2E 可用」收紧为「有主密钥」。
   * 新代码一律读 `status`（三态），不要读 `enabled`。
   */
  getStats() {
    const st = this.getStatus();
    return {
      status: st.status,
      reason: st.reason,
      // 兼容字段：语义已收紧为「有主密钥」，不代表出站已加密
      enabled: this.enabled,
      outboundEncrypted: this.outboundEncrypted,
      algorithm: ALGORITHM,
      keyVersion: this.keyVersion,
      agentKeys: this._derivedKeys.size,
    };
  }
}

/**
 * 中间件: 自动解密/加密 A2A 消息
 */
function createEncryptionMiddleware(e2eManager) {
  return (req, res, next) => {
    // 解密入站消息 (envelope 格式)
    if (req.body?.envelope?.encryption?.encrypted) {
      const senderName = req.body.envelope.sender || 'unknown';
      req.body = e2eManager.decryptEnvelope(req.body, senderName);
    }
    // 出站消息
    //
    // [2026-11-03 · P0-4] 原来这里是：
    //     if (e2eManager.enabled && obj?.result?.task) { obj.encrypted = true; }
    // —— 只置一个布尔，**一个字节都没加密**。对外看起来像加密了。
    // 现在：真加密才标 true；否则标 false 并附 reason，
    // 让对端一眼看出「这包是明文」，而不是误以为可以传敏感数据。
    const origJson = res.json.bind(res);
    res.json = function (obj) {
      if (obj?.result?.task) {
        if (e2eManager.outboundEncrypted) {
          obj.encrypted = true;
        } else {
          obj.encrypted = false;
          obj.encryptionReason = e2eManager.getStatus().reason || 'not_implemented';
        }
      }
      return origJson(obj);
    };
    next();
  };
}

module.exports = { E2EEncryption, createEncryptionMiddleware, E2E_STATUS };
