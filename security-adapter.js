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
let HandshakeManager = null;
let SECURITY_LEVEL = null;
let AnomalyDetector = null;
let loadError = null;

try {
  const security = require('../csb-security/lib/index.js');
  TrustLevelManager = security.TrustLevelManager;
  E2EEncryption = security.E2EEncryption;
  RateLimiter = security.RateLimiter;
  HandshakeManager = security.HandshakeManager;
  SECURITY_LEVEL = security.SECURITY_LEVEL;
  AnomalyDetector = security.AnomalyDetector;
  if (TrustLevelManager && E2EEncryption && RateLimiter && HandshakeManager && AnomalyDetector) {
    source = 'csb-security';
  } else {
    throw new Error('csb-security 导出不完整 (TrustLevelManager/E2EEncryption/RateLimiter/HandshakeManager/AnomalyDetector 缺失)');
  }
} catch (e) {
  loadError = e;
  // 2) 降级 legacy 实现（握手/异常检测为 csb-security 独有，legacy 无对应）
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

  /** [2026-11-02 P0-0] 审计自身状态 — 供 /health 消费（外部只读侧要能核「链可不可验」） */
  stats() {
    let entries = null;
    try { entries = Array.isArray(this.inner.entries) ? this.inner.entries.length : null; } catch { /* 不阻断 */ }
    return {
      logPath: this.logPath || this.inner.logPath || null,
      pathSource: 'repo',
      chainCapable: true,
      source: 'csb-security',
      algorithm: 'sha256-chain' + (this.inner.privateKey ? '+ed25519' : ''),
      entries,
      signed: !!this.inner.privateKey,
      writeFailures: this.writeFailures || 0,
      lastWriteError: this.lastWriteError || null,
    };
  }
  summary() { return this.inner.summary(); }
  shutdown() { /* AuditLog 同步落盘，无定时器 */ }
}

/**
 * createAuditLogger — 审计日志工厂
 *
 * [2026-11-02 P0-0] 改：默认走 csb-security 哈希链（不再靠 A2A_SECURITY_AUDIT 开关）
 *
 * 缘起：主审计一直是裸 append —— 无 prev_hash、无 fsync、默认落 /tmp。
 *   而 GDI 的 verify.js 正指着这份文件验链，于是它只能永远返回 no_audit_source。
 *   一个已完成的能力在空转（知微审计事实 4）。
 *
 * 决议：标准早就存在于 csb-security/lib/audit/audit-log.js（gdi/verify.js 头注释
 *   自述「算法同构」），所以不新写第三套链，直接复用权威实现。
 *
 * 降级可见：csb-security 不可用时退回 legacy（无链），但必须能被 /health 看出来，
 *   不假装「审计在运转」。
 */
function createAuditLogger(options = {}) {
  const path = require('path');
  const logPath = options.logPath || path.join(__dirname, 'data', 'audit', 'security-audit.jsonl');
  const legacy = process.env.A2A_SECURITY_AUDIT === '0'; // 显式关闭才退 legacy

  if (source === 'csb-security' && !legacy) {
    console.log(`[SECURITY] 🛡️ 哈希链审计已启用 (${logPath})`);
    const logger = new CompatAuditLogger({ logPath });
    logger.chainCapable = true;
    logger.logPath = logPath;
    logger.source = 'csb-security';
    return logger;
  }

  const fallback = new (require('./a2a-observability.js').AuditLogger)(options);
  fallback.chainCapable = false;
  fallback.degradedReason = source !== 'csb-security' ? 'csb_security_unavailable' : 'explicitly_disabled';
  console.warn(`[SECURITY] ⚠️ 审计退化为无链模式（${fallback.degradedReason}）→ ${fallback.logPath}`);
  return fallback;
}

/**
 * createAnomalyDetector — 异常检测工厂（Phase 3）
 *
 * 接入点: standard-api 限流拒绝 → recordFailure；成功 → recordSuccess
 * 告警: onAlert → console + 可选飞书 webhook（A2A_SECURITY_ALERT_WEBHOOK）
 */
function createAnomalyDetector(options = {}) {
  if (source !== 'csb-security') {
    console.log('[SECURITY] ℹ️ 异常检测需 csb-security（当前 legacy，跳过）');
    return null;
  }
  const webhook = process.env.A2A_SECURITY_ALERT_WEBHOOK || null;
  const detector = new AnomalyDetector({
    ...options,
    onAlert: (alert) => {
      const line = `[SECURITY-ALERT] [${alert.severity}] ${alert.rule}: ${alert.message}`;
      console.warn(line);
      if (webhook) {
        const http = require('http');
        const https = require('https');
        const mod = webhook.startsWith('https') ? https : http;
        const body = JSON.stringify({ text: line, alert });
        const req = mod.request(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => { r.resume(); });
        req.on('error', () => {});
        req.write(body); req.end();
      }
    }
  });
  console.log('[SECURITY] 🛡️ 异常检测已启用（规则: rapid_failures / many_agents_single_ip / rapid_aid_registration / rapid_key_rotation / audit_tamper）');
  return detector;
}

module.exports = {
  source,
  TrustLevelManager,
  E2EEncryption,
  RateLimiter,
  HandshakeManager,
  SECURITY_LEVEL,
  AnomalyDetector,
  createAuditLogger,
  createAnomalyDetector,
  createHandshakeRouter: require('./security-handshake.js').createHandshakeRouter,
  CompatAuditLogger,
  // middleware 是 A2A HTTP 层概念，保留在本仓库；传入 csb-security 实例即可工作
  createEncryptionMiddleware: require('./a2a-e2e-encryption.js').createEncryptionMiddleware
};
