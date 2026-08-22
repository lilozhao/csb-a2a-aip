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
let loadError = null;

try {
  const security = require('../csb-security/lib/index.js');
  TrustLevelManager = security.TrustLevelManager;
  E2EEncryption = security.E2EEncryption;
  if (TrustLevelManager && E2EEncryption) {
    source = 'csb-security';
  } else {
    throw new Error('csb-security 导出不完整 (TrustLevelManager/E2EEncryption 缺失)');
  }
} catch (e) {
  loadError = e;
  // 2) 降级 legacy 实现
  try {
    TrustLevelManager = require('./trust-manager.js').TrustLevelManager;
    E2EEncryption = require('./a2a-e2e-encryption.js').E2EEncryption;
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

module.exports = {
  source,
  TrustLevelManager,
  E2EEncryption,
  // middleware 是 A2A HTTP 层概念，保留在本仓库；传入 csb-security 实例即可工作
  createEncryptionMiddleware: require('./a2a-e2e-encryption.js').createEncryptionMiddleware
};
