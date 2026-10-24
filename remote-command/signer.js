/**
 * A2A 远程命令执行 - 签名模块
 * Phase 1: HMAC-SHA256 共享密钥
 * Phase 2: 升级到公钥体系
 */

const crypto = require('crypto');

// 从环境变量获取共享密钥
const SHARED_SECRET = process.env.A2A_SHARED_SECRET;

// ── P0-1 修复（2026-10-24 · 明鉴评审）──────────────────────────────────────
// 旧行为：无 A2A_SHARED_SECRET 时 console.warn 一句，继续用**仓库里公开可知**的
// 'dev-mode-insecure-key-...' 给远程命令执行请求签名 → 读过仓库的人人都能伪造签名，
// RCE 防线静默降级成没有。
// 新行为（默认拒绝）：
//   1. 无 secret → 构造即 throw（fail-closed，宁可起不来也不要假防线）
//   2. 要跑 dev 必须显式 A2A_ALLOW_INSECURE_SIGNER=1 或 new Signer({allowInsecure:true})
//   3. 启动打印密钥指纹（SHA256 前 8 位），便于确认环境接对了没接对
// 注意：dev 模式下也**不再使用仓库里的公开常量**——改为随机生成，保证「就算放行，
// 也不是人人可伪造」。跨进程通信仍需显式传同一 secret。
const INSECURE_FLAG = 'A2A_ALLOW_INSECURE_SIGNER';

function keyFingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 8);
}

class Signer {
  /**
   * @param {string|object} [secretOrOpts] 密钥字符串，或 { secret, allowInsecure }
   */
  constructor(secretOrOpts = SHARED_SECRET) {
    let secret = secretOrOpts;
    let allowInsecure = process.env[INSECURE_FLAG] === '1';
    if (secretOrOpts && typeof secretOrOpts === 'object') {
      secret = secretOrOpts.secret;
      if (secretOrOpts.allowInsecure !== undefined) allowInsecure = !!secretOrOpts.allowInsecure;
    }

    if (!secret) {
      if (!allowInsecure) {
        const err = new Error(
          '[A2A-CMD] 拒绝启动：A2A_SHARED_SECRET 未设置。\n' +
          '  远程命令签名是 RCE 防线，不允许默认放行。请任选其一：\n' +
          '    · 生产：export A2A_SHARED_SECRET=<64 位 hex>（openssl rand -hex 32）\n' +
          `    · 仅本地开发：export ${INSECURE_FLAG}=1（将使用进程内随机密钥，无法与外部互通）`
        );
        err.code = 'A2A_SECRET_MISSING';
        throw err;
      }
      // dev：随机密钥，不再用公开常量（公开常量等于人人可伪造）
      this.secret = crypto.randomBytes(32).toString('hex');
      this.insecure = true;
      console.warn(`[A2A-CMD] ⚠️ 开发模式签名器（${INSECURE_FLAG}=1）：密钥为进程内随机生成，` +
        `指纹 ${keyFingerprint(this.secret)}，无法与外部实例互通。生产必须配置 A2A_SHARED_SECRET。`);
      return;
    }

    if (String(secret).length < 16) {
      const err = new Error(`[A2A-CMD] 拒绝启动：A2A_SHARED_SECRET 过短（${String(secret).length} 字符，至少 16）。`);
      err.code = 'A2A_SECRET_WEAK';
      throw err;
    }
    this.secret = secret;
    this.insecure = false;
    this.fingerprint = keyFingerprint(secret);
  }

  /**
   * 签名请求
   * @param {Object} request - 请求对象
   * @returns {string} HMAC 签名 (hex)
   */
  signRequest(request) {
    const payload = JSON.stringify({
      command: request.command,
      sender: request.sender,
      timestamp: request.timestamp,
      nonce: request.nonce
    });

    return crypto
      .createHmac('sha256', this.secret)
      .update(payload)
      .digest('hex');
  }

  /**
   * 验证请求签名
   * @param {Object} request - 请求对象
   * @param {string} signature - 签名
   * @returns {boolean} 验证结果
   */
  verifyRequest(request, signature) {
    const expected = this.signRequest(request);
    
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expected, 'hex')
      );
    } catch (e) {
      console.error('[A2A-CMD] Signature verification error:', e.message);
      return false;
    }
  }

  /**
   * 签名响应
   * @param {Object} response - 响应对象
   * @returns {string} HMAC 签名 (hex)
   */
  signResponse(response) {
    const payload = `${response.command_id}:${response.status}:${response.timestamp}`;
    
    return crypto
      .createHmac('sha256', this.secret)
      .update(payload)
      .digest('hex');
  }

  /**
   * 验证响应签名
   * @param {Object} response - 响应对象
   * @param {string} signature - 签名
   * @returns {boolean} 验证结果
   */
  verifyResponse(response, signature) {
    const expected = this.signResponse(response);
    
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expected, 'hex')
      );
    } catch (e) {
      console.error('[A2A-CMD] Response signature verification error:', e.message);
      return false;
    }
  }

  /**
   * 生成 nonce
   * @returns {string} 随机 nonce
   */
  generateNonce() {
    return crypto.randomBytes(16).toString('hex');
  }
}

module.exports = { Signer };
