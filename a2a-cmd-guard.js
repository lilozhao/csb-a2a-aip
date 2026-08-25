/**
 * a2a-cmd-guard.js — CMD 远程命令安全守卫
 *
 * 防御未授权的远程命令执行
 * 提供：权限校验、命令白名单、禁止列表、敏感命令审批、审计日志
 *
 * 校验流程:
 *   [1] 发送者身份识别 — 匹配 senderName → trustLevel
 *   [2] 权限校验       — trustLevel >= minTrustLevel?
 *   [3] 禁止命令检查   — 命令在禁止列表中?
 *   [4] 命令白名单校验 — 命令是否在允许列表中?
 *   [5] 敏感命令审批   — 命令在敏感列表中?
 *   [6] 审计日志       — 记录所有 CMD 操作
 *
 * 版本: 1.0.0 | 2026-08-24
 */

const fs = require('fs');
const path = require('path');

// ============================================
// 默认配置
// ============================================
const DEFAULT_CONFIG = {
  enabled: true,
  minTrustLevel: 3,            // 发送 CMD 命令的最低信任等级
  requireApproval: true,        // 敏感命令是否需要审批

  // 命令白名单（允许的命令前缀）
  commandWhitelist: [
    'status',       // 查询状态
    'health',       // 健康检查
    'memory.list',  // 查询记忆列表
    'memory.get',   // 查询特定记忆
    'task.list',    // 查询任务列表
    'echo',         // 回显（测试用）
  ],

  // 敏感命令（需要人工审批才能执行）
  sensitiveCommands: [
    'memory.delete',   // 删除记忆
    'memory.clear',    // 清空记忆
    'task.cancel',     // 取消任务
    'config.update',   // 修改配置
    'restart',          // 重启服务
  ],

  // 禁止命令（永远不允许，无论信任等级）
  forbiddenCommands: [
    'exec', 'eval', 'shell', 'bash', 'cmd',
    'rm', 'del', 'rmdir', 'format',
    'curl', 'wget', 'scp', 'ssh',
    'cat', 'type',       // 读取文件
    'write', 'echo >',  // 写入文件
    'kill', 'taskkill',
    'chmod', 'chown',
    'sudo', 'runas',
  ],

  // 沙箱限制
  sandbox: {
    maxOutputLength: 10000,     // 最大输出长度
    timeoutMs: 10000,           // 执行超时（毫秒）
    allowedPaths: [],            // 允许访问的路径（空 = 全限制）
  },
};

let _config = { ...DEFAULT_CONFIG };
let _pendingApprovals = new Map(); // 待审批命令队列

// ============================================
// 审计日志安全加载（修复：audit-log.js 缺失导致崩溃）
// ============================================
let _audit = null;

/**
 * 获取审计日志模块（懒加载 + 多路径回退 + 降级）
 *
 * 优先级：
 *   1. ./audit-log.js         — 标准审计模块（audit.log(event, data, actor, target, outcome)）
 *   2. ./remote-command/audit.js — AuditLogger 类（适配为 .log 调用）
 *   3. 降级 console 记录      — 审计不可用时不影响命令守卫主流程
 *
 * @returns {object} { log(event, data, actor, target, outcome) }
 */
function getAudit() {
  if (_audit !== null) return _audit;

  // 尝试 1：标准审计模块 ./audit-log.js
  try {
    const auditLog = require('./audit-log.js');
    if (auditLog && typeof auditLog.log === 'function') {
      _audit = auditLog;
      return _audit;
    }
  } catch { /* 模块不存在，尝试下一个 */ }

  // 尝试 2：remote-command/audit.js 的 AuditLogger 类
  try {
    const auditMod = require('./remote-command/audit.js');
    const AuditLogger = (auditMod && typeof auditMod === 'object')
      ? (auditMod.AuditLogger || auditMod.default)
      : auditMod;
    if (AuditLogger && typeof AuditLogger === 'function') {
      const logger = new AuditLogger();
      _audit = {
        log: (event, data = {}, actor = '', target = '', outcome = '') => {
          try {
            return logger.log({
              command_id: data.approvalId || `cmd_${Date.now()}`,
              sender: data.sender || actor || 'unknown',
              sender_url: data.senderUrl || '',
              command: data.command || '',
              parameters: {},
              status: outcome === 'success' ? 'success'
                : outcome === 'denied' ? 'failure'
                : outcome === 'pending' ? 'pending'
                : outcome === 'approved' ? 'success'
                : outcome === 'error' ? 'failure' : outcome,
              error: data.error ? { message: data.error } : null,
              user_confirmed: outcome === 'approved',
            });
          } catch { /* 审计失败不影响主流程 */ }
        },
      };
      return _audit;
    }
  } catch { /* 模块不存在，降级 */ }

  // 尝试 3：降级为 console 记录（不崩溃）
  console.warn('[CmdGuard] ⚠️ 未找到审计模块（audit-log.js / remote-command/audit.js），降级为 console 审计');
  _audit = {
    log: (event, data = {}, actor = '', target = '', outcome = '') => {
      console.warn(`[CmdGuard:audit] ${event} | ${actor || '?'} → ${target || ''} | ${outcome} | ${String(data.command || '').substring(0, 100)}`);
    },
  };
  return _audit;
}

/**
 * 加载配置文件
 * 配置缺失时使用默认值，不会崩溃
 *
 * @param {string} configPath - 配置文件路径
 */
function loadConfig(configPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    _config = { ...DEFAULT_CONFIG, ...cfg };
    console.log('[CmdGuard] 配置已加载, minTrustLevel:', _config.minTrustLevel);
  } catch {
    // 配置文件不存在或格式错误时，使用默认配置
    _config = { ...DEFAULT_CONFIG };
  }
}

// ============================================
// 核心校验函数
// ============================================

/**
 * 校验 CMD 命令请求
 *
 * 执行完整的命令安全校验流程：
 *   1. 权限校验（信任等级检查）
 *   2. 禁止命令检查
 *   3. 命令白名单校验
 *   4. 敏感命令审批
 *   5. 审计日志记录
 *
 * @param {object} senderInfo - 发送者信息 { name, trustLevel, url }
 * @param {string} command - 命令文本（CMD: 之后的部分）
 * @returns {object} { allowed, reason, requiresApproval, approvalId, sanitizedCmd, sandbox }
 */
function checkCommand(senderInfo = {}, command = '') {
  // 守卫未启用时直接放行
  if (!_config.enabled) {
    return { allowed: true, reason: 'guard disabled', sanitizedCmd: command, requiresApproval: false };
  }

  const audit = getAudit();

  // [1] 权限校验 — 信任等级检查
  if ((senderInfo.trustLevel || 0) < _config.minTrustLevel) {
    audit.log('cmd.execute', {
      command: command.substring(0, 200),
      sender: senderInfo.name,
      trustLevel: senderInfo.trustLevel || 0,
      requiredTrust: _config.minTrustLevel,
    }, senderInfo.name, '', 'denied');

    return {
      allowed: false,
      reason: `权限不足：信任等级 ${senderInfo.trustLevel || 0} < ${_config.minTrustLevel}（CMD 命令需要更高信任等级）`,
      requiresApproval: false,
    };
  }

  // [2] 提取命令名（第一个空格前的部分，或整行）
  const cmdName = command.split(/\s+/)[0].toLowerCase().trim();

  // [3] 禁止命令检查 — 危险命令直接拒绝
  for (const forbidden of _config.forbiddenCommands) {
    const forbiddenLower = forbidden.toLowerCase();
    if (cmdName === forbiddenLower || command.toLowerCase().includes(forbiddenLower)) {
      audit.log('cmd.execute', {
        command: command.substring(0, 200),
        sender: senderInfo.name,
        reason: 'forbidden command',
      }, senderInfo.name, '', 'denied');

      return {
        allowed: false,
        reason: `禁止命令："${cmdName}" 在禁止列表中`,
        requiresApproval: false,
      };
    }
  }

  // [4] 命令白名单校验 — 只允许白名单内命令
  const isWhitelisted = _config.commandWhitelist.some(allowed =>
    cmdName === allowed.toLowerCase() || cmdName.startsWith(allowed.toLowerCase())
  );

  if (!isWhitelisted) {
    audit.log('cmd.execute', {
      command: command.substring(0, 200),
      sender: senderInfo.name,
      reason: 'not in whitelist',
    }, senderInfo.name, '', 'denied');

    return {
      allowed: false,
      reason: `命令不在白名单中："${cmdName}"。允许的命令: ${_config.commandWhitelist.join(', ')}`,
      requiresApproval: false,
    };
  }

  // [5] 敏感命令审批 — 高危命令需要人工审批
  const isSensitive = _config.sensitiveCommands.some(sensitive =>
    cmdName === sensitive.toLowerCase() || cmdName.startsWith(sensitive.toLowerCase())
  );

  if (isSensitive && _config.requireApproval) {
    // 生成审批 ID，加入待审批队列
    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    _pendingApprovals.set(approvalId, {
      command,
      cmdName,
      senderInfo,
      timestamp: new Date().toISOString(),
      status: 'pending',
    });

    audit.log('cmd.execute', {
      command: command.substring(0, 200),
      sender: senderInfo.name,
      approvalId,
      reason: 'pending approval',
    }, senderInfo.name, '', 'pending');

    return {
      allowed: false,
      requiresApproval: true,
      approvalId,
      reason: `敏感命令 "${cmdName}" 需要审批。审批 ID: ${approvalId}。请联系人类用户确认。`,
    };
  }

  // [6] 通过所有检查 — 记录审计日志后放行
  audit.log('cmd.execute', {
    command: command.substring(0, 200),
    sender: senderInfo.name,
    trustLevel: senderInfo.trustLevel,
  }, senderInfo.name, '', 'success');

  return {
    allowed: true,
    reason: 'authorized',
    requiresApproval: false,
    sanitizedCmd: command,
    sandbox: _config.sandbox,
  };
}

/**
 * 获取待审批命令列表
 *
 * @returns {Array} 待审批命令数组
 */
function getPendingApprovals() {
  return Array.from(_pendingApprovals.entries()).map(([id, req]) => ({
    approvalId: id,
    ...req,
  }));
}

/**
 * 审批命令（人工调用）
 *
 * @param {string} approvalId - 审批 ID
 * @param {boolean} approved - 是否批准
 * @param {string} approverName - 审批人名称
 * @returns {object} { resolved, approved, command, senderInfo }
 */
function resolveApproval(approvalId, approved, approverName = 'human') {
  const req = _pendingApprovals.get(approvalId);
  if (!req) {
    return { resolved: false, reason: 'approval not found' };
  }

  const audit = getAudit();
  audit.log('cmd.approval', {
    approvalId,
    command: req.command.substring(0, 200),
    sender: req.senderInfo.name,
    approved,
    approver: approverName,
  }, approverName, req.senderInfo.name, approved ? 'approved' : 'denied');

  _pendingApprovals.delete(approvalId);

  return {
    resolved: true,
    approved,
    command: req.command,
    senderInfo: req.senderInfo,
  };
}

module.exports = {
  checkCommand,
  loadConfig,
  getPendingApprovals,
  resolveApproval,
  getAudit,
  DEFAULT_CONFIG,
};
