#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════
 * delegation-handler.js — 委托消息处理器（补齐 server_v5 预留钩子）
 * ═══════════════════════════════════════════════════════════
 * server_v5.js commandHandler 中的 require('./delegation-handler.js')
 * 此前不存在（try/catch 静默跳过），本文件补齐该钩子。2026-09-18 若辰。
 *
 * 职责（CSB 开放协议 v0.8 DEL-001~003）:
 *   1. delegation.* 管理命令（status/list/issue/revoke）
 *   2. 普通命令附带 authority 委托头时的验证（DEL-002/003）
 *
 * 调用契约（server_v5.js commandHandler）:
 *   const delResult = await delegationHandler.handleDelegationCommand(cmdJson, metadata);
 *   - 返回 null  → 不是委托消息，继续走 CommandDispatcher
 *   - 返回对象   → 作为 DELEGATION_RESULT 直接回复，不再执行命令
 *
 * 安全设计（与私钥红线一脉相承）:
 *   - execute/override 级证书必须由 grantor 在宿主机本地签发，
 *     A2A 网络内 issue 一律拒绝——授权由节点主人决定，不由网络里的 agent 决定
 *   - 高危命令（agent.update/restart/configure）除 dispatcher 白名单外，
 *     还须有效 execute 级委托证书
 *   - 全部决策写入哈希链审计日志（与 csb-security AuditLog / GDI 同构）
 *
 * 依赖: ./delegation-manager.js（若兰，纯 Node.js）
 * ═══════════════════════════════════════════════════════════
 */

const path = require('path');

const { DelegationManager, LEVEL_WEIGHT } = require('./delegation-manager.js');

// ===== 节点信任表（独立文件，避免覆盖仓内 delegations.json 模板）=====
const STORE_PATH = process.env.A2A_DELEGATION_STORE
  || path.join(__dirname, 'delegations.local.json');

const dm = new DelegationManager({
  storePath: STORE_PATH,
  defaultLevel: 'request',
});
try {
  dm.loadFromFile(STORE_PATH);
} catch (e) {
  console.warn('[DELEGATION] 信任表尚未创建（execute 证书须由 grantor 本地签发）');
}

// ===== 高危命令清单（须 execute/override 证书，叠加在 dispatcher 白名单之上）=====
const HIGH_RISK_COMMANDS = new Set(['agent.configure', 'agent.update', 'agent.restart']);

function senderName(metadata) {
  const s = metadata && metadata.sender;
  if (typeof s === 'string') return s;
  return (s && s.name) || 'unknown';
}

function extractAuthority(cmd, metadata) {
  return cmd.authority
    || (metadata && metadata.authority)
    || null;
}

// ── delegation.* 管理命令 ──
function handleDelegationOp(cmd, metadata) {
  const caller = senderName(metadata);
  const op = cmd.type;
  const grantor = cmd.grantor;
  const grantee = cmd.grantee;
  const delegationId = cmd.id || cmd.delegationId;

  switch (op) {
    case 'delegation.status':
    case 'delegation.list': {
      // 只读：返回本节点信任表概况（不含任何密钥材料）
      const trusts = dm.getTrusts().map(t => ({
        id: t.id, grantor: t.grantor, grantee: t.grantee,
        scope: t.scope, level: t.level,
        grantedAt: t.grantedAt, expiresAt: t.expiresAt,
      }));
      return {
        success: true,
        operation: op,
        node: 'ruochen-3200',
        trusts,
        total: trusts.length,
        note: 'execute/override 证书须由 grantor（知音在野）在宿主机本地签发，A2A 网络内不受理签发',
      };
    }

    case 'delegation.issue': {
      // 红线：授权由节点主人决定。A2A 网络内一律拒绝签发。
      dmAudit('delegation_issue_refused', { caller, reason: 'REMOTE_ISSUANCE_FORBIDDEN' });
      return {
        success: false,
        operation: op,
        code: -32003,
        message: '委托证书不接受网络内签发。请 grantor（节点主人）在宿主机本地执行签发。',
        hint: 'node -e "const {DelegationManager}=require(\'./delegation-manager.js\');const dm=new DelegationManager({storePath:\'./delegations.local.json\'});dm.loadFromFile(\'./delegations.local.json\');dm.addTrust(\'<grantor>\',\'<grantee>\',{scope:[\'*\'],level:\'execute\'})"',
      };
    }

    case 'delegation.revoke': {
      // 撤销须验明撤销者身份 = 原 grantor，且携带有效 override/execute 委托
      const v = dm.validateMessage({ authority: extractAuthority(cmd, metadata) });
      const selfRevoke = grantor && caller === grantor;
      if (!selfRevoke || !v.valid || LEVEL_WEIGHT[v.effectiveLevel] < LEVEL_WEIGHT.execute) {
        dmAudit('delegation_revoke_denied', { caller, delegationId, reason: 'INSUFFICIENT_AUTHORITY' });
        return {
          success: false, operation: op, code: -32003,
          message: '撤销被拒绝：须 grantor 本人发起并携带有效 execute/override 级委托',
          authority_check: { valid: v.valid, level: v.effectiveLevel, reason: v.reason },
        };
      }
      const ok = dm.revokeTrust(delegationId);
      dmAudit(ok ? 'delegation_revoked' : 'delegation_revoke_failed', { caller, delegationId });
      return { success: ok, operation: op, delegationId };
    }

    default:
      return null; // 不是 delegation.* 命令
  }
}

// ── 审计（复用 DelegationManager 的哈希链，落同一份 JSONL）──
function dmAudit(eventType, detail) {
  try { dm._appendAudit({ event_type: eventType, node: 'ruochen-3200', ...detail }); } catch (e) { /* fail-safe */ }
}

/**
 * 主入口 — server_v5.js commandHandler 钩子
 * @param {string|Object} cmdJson - CMD 命令（JSON 字符串或对象）
 * @param {Object} metadata - { sender, senderUrl, ... }
 * @returns {Promise<Object|null>} null = 非委托消息，放行走 dispatcher
 */
async function handleDelegationCommand(cmdJson, metadata) {
  let cmd;
  try {
    cmd = typeof cmdJson === 'string' ? JSON.parse(cmdJson) : cmdJson;
  } catch (e) {
    return null; // 解析失败交回原流程处理
  }
  if (!cmd || typeof cmd !== 'object') return null;

  const caller = senderName(metadata);
  const type = cmd.type || cmd.command || '';

  // 1) delegation.* 管理命名空间
  if (typeof type === 'string' && type.startsWith('delegation.')) {
    const result = handleDelegationOp(cmd, metadata);
    if (result) return result;
  }

  // 2) 普通命令附带 authority → DEL-002/003 验证
  const authority = extractAuthority(cmd, metadata);
  if (authority) {
    const v = dm.validateMessage({ authority });
    console.log(`[DELEGATION] authority 验证 ${caller}: valid=${v.valid} level=${v.effectiveLevel} (${v.reason})`);

    if (!v.valid) {
      // 无效证书 + execute/override 意图 → 拒绝整条命令，不得执行
      dmAudit('authority_rejected', { caller, command: type, level: authority.level, reason: v.reason });
      return {
        success: false,
        operation: 'authority.validate',
        code: -32003,
        message: '委托验证失败，本命令按普通数据处理，不作为指令执行',
        reason: v.reason,
      };
    }
    dmAudit('authority_accepted', { caller, command: type, level: v.effectiveLevel });
    // 有效委托 → 放行（dispatcher 白名单仍然生效，双重把关）
    return null;
  }

  // 3) 高危命令无证书 → 拒绝（叠加于 dispatcher 白名单的第三道闸）
  if (HIGH_RISK_COMMANDS.has(type)) {
    const v = dm.validateMessage({}); // 无 authority，必无效——此处仅为取 reason
    dmAudit('cmd_highrisk_denied', { caller, command: type, reason: 'NO_DELEGATION_CERT' });
    return {
      success: false,
      operation: 'highrisk.gate',
      code: -32003,
      message: `高危命令 ${type} 需要 execute 级授权委托证书（grantor 须由节点主人本地签发）`,
      authority_check: { valid: false, level: 'inform', reason: '消息未携带 authority 委托头' },
      note: 'L3 确认流启用前，即使有证书也仅放行至确认流程，不直接执行',
    };
  }

  return null; // 其余情况：放行走 dispatcher（白名单 + 限流 + 审计照旧）
}

module.exports = { handleDelegationCommand };
