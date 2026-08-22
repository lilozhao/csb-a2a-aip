/**
 * security-adapter.js — CSB-Security 集成适配层（Phase 1: 等价替换）
 *
 * 策略 (2026-08-22 一澜拍板，A+C 结合):
 *  - A: package.json optionalDependencies 声明 file:../csb-security（单一权威实现）
 *  - C: 运行时 try/catch 探测，csb-security 缺失/报错 → 自动降级 legacy 实现
 *
 * 集成点（server_v5.js）:
 *  - TrustLevelManager: trust-manager.js → csb-security/lib/authz/trust-level.js（接口同源，零适配）
 *  - E2EEncryption: a2a-e2e-encryption.js → csb-security/lib/transport/e2e-encryption.js（核心方法一致）
 *  - createEncryptionMiddleware: 留在本仓库（HTTP 层概念），只依赖 decryptEnvelope + enabled
 *
 * 维护者: 若兰 🌸
 * 日期: 2026-08-22 (M5 Phase 1)
 */

// 1) 优先加载 csb-security（相对路径探测，不依赖 npm install 状态）
let source = 'legacy';
let TrustLevelManager = null;
let E2EEncryption = null;
let RateLimiter = null;
let loadError = null;

try {
  const security = require('../csb-security/lib/index.js');
  TrustLevelManager = security.TrustLevelManager;
  E2EEncryption = security.E2EEncryption;
  RateLimiter = security.RateLimiter;
  if (TrustLevelManager && E2EEncryption && RateLimiter) {
    source = 'csb-security';
  } else {
    throw new Error('csb-security 导出不完整 (TrustLevelManager/E2EEncryption/RateLimiter 缺失)');
  }
} catch (e) {
  loadError = e;
  // 2) 降级 legacy 实现
  try {
    TrustLevelManager = require('./trust-manager.js').TrustLevelManager;
    E2EEncryption = require('./a2a-e2e-encryption.js').E2EEncryption;
    RateLimiter = require('./a2a-standard-api-v5.js').RateLimiter;
  } catch (e2) {
    loadError = e2;
    console.error('[SECURITY] ❌ 安全模块加载失败（csb-security 与 legacy 均不可用）:', e2.message);
  }
}

if (source === 'csb-security') {
  console.log('[SECURITY] ✅ 已加载 csb-security（权威实现）');
} else if (TrustLevelManager && E2EEncryption) {
  console.log(`[SECURITY] ⚠️ csb-security 不可用，降级 legacy: ${loadError ? loadError.message.split('\n')[0] : '未知原因'}`);
}

// ============ Phase 2: 审计日志适配 ============

/**
 * CompatAuditLogger — csb-security AuditLog 的 traceMiddleware 兼容包装
 *
 * traceMiddleware 只依赖 record(event) + shutdown()；
 * 包装后额外暴露 verifyChain/query/summary（哈希链审计能力）。
 */
class CompatAuditLogger {
  constructor({ logPath, privateKey, publicKey } = {}) {
    const path = require('path');
    const fs = require('fs');
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const { AuditLog } = require('../csb-security/lib/audit/audit-log.js');
    this.inner = new AuditLog({ logPath, privateKey, publicKey });
  }

  record(event) {
    const entry = {
      timestamp: new Date().toISOString(),
      event_type: event.event || 'request',
      caller_id: event.agent || 'unknown',
      callee_id: 'self',
      user_id: null,
      scope: event.method || '',
      status: event.status || '',
      trace_id: event.traceId || 'unknown',
      details: event.details || '',
      duration_ms: event.durationMs || 0,
      // AuditLog 语义: result ∈ success|failure（由 HTTP status 推导）
      result: (event.status && event.status !== 'OK' && event.status !== 'success') ? 'failure' : 'success',
      ip_address: event.ip || null
    };
    this.inner.append(entry);
  }

  verifyChain() { return this.inner.verifyChain(); }
  query(filters = {}) { return this.inner.query(filters); }
  summary() { return this.inner.summary(); }
  shutdown() { /* AuditLog 同步落盘，无定时器 */ }
}

/**
 * createAuditLogger — 审计日志工厂
 *
 * A2A_SECURITY_AUDIT=1 + csb-security 可用 → 哈希链审计（data/audit/）
 * 否则 → legacy observability AuditLogger（/tmp 明文，行为不变）
 */
function createAuditLogger(options = {}) {
  const path = require('path');
  if (source === 'csb-security' && process.env.A2A_SECURITY_AUDIT === '1') {
    const logPath = options.logPath || path.join(__dirname, 'data', 'audit', 'security-audit.jsonl');
    console.log(`[SECURITY] 🛡️ 哈希链审计已启用 (A2A_SECURITY_AUDIT=1 → ${logPath})`);
    return new CompatAuditLogger({ logPath });
  }
  return new (require('./a2a-observability.js').AuditLogger)(options);
}

module.exports = {
  source,
  TrustLevelManager,
  E2EEncryption,
  RateLimiter,
  createAuditLogger,
  CompatAuditLogger,
  // middleware 是 A2A HTTP 层概念，保留在本仓库；传入 csb-security 实例即可工作
  createEncryptionMiddleware: require('./a2a-e2e-encryption.js').createEncryptionMiddleware
};
