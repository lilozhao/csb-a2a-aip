/**
 * security-handshake.js — /a2a/handshake 对等握手端点（Phase 3）
 *
 * 协议: CSB-Security v1.0 §7 五步握手
 * 流程（callee 侧视角）:
 *   POST /a2a/handshake  { action: 'init',     message: initMsg }      → handshake_challenge
 *   POST /a2a/handshake  { action: 'proof',    message: proofMsg }     → handshake_approval（或直接完成）
 *   POST /a2a/handshake  { action: 'complete', message: completeMsg }  → { ok, session }
 *
 * 启用条件（密钥就绪才暴露端点，零默认风险）:
 *   - A2A_SECURITY_HANDSHAKE_AID: callee 的 AID 文档 JSON（含 agent_id/endpoint/public_key）
 *   - A2A_SECURITY_HANDSHAKE_KEY: callee 的 Ed25519 私钥 PEM（或 JWK JSON）
 *   未配置 → 端点不注册，启动日志提示
 *
 * L3 (USER_CONFIRM) 处理:
 *   - 默认拒绝（requires_user_confirmation），避免无人工确认自动放行
 *   - 可注入 userConfirm 回调（如接飞书审批）
 *
 * 维护者: 若兰 🌸
 * 日期: 2026-08-22 (M5 Phase 3)
 */

const crypto = require('crypto');

/**
 * 创建握手路由
 * @param {Object} options
 *   - handshakeManager: csb-security HandshakeManager 实例
 *   - calleeAID: AID 文档对象
 *   - calleePrivateKey: KeyObject 或 PEM 字符串
 *   - calleeAllowedScopes: 本 Agent 允许授予的 scope 列表（默认 ['a2a:send']）
 *   - userConfirm: async (proofMsg) => boolean，L3 人工确认回调（默认拒绝）
 *   - userPublicKey: 用户公钥 JWK（验证 UAC 用；未配置时 L1+ 握手无法验证 UAC）
 *   - trustManager: 可选，握手成功后记录正向交互（信任升级）
 * @returns {Function} Express router
 */
function createHandshakeRouter({ handshakeManager, calleeAID, calleePrivateKey, calleeAllowedScopes = ['a2a:send'], userConfirm = null, userPublicKey = null, trustManager = null } = {}) {
  const router = require('express').Router();
  // callee 侧状态: callerId -> { initMsg, challengeMsg }（proof 阶段需要 challenge）
  const pending = new Map();

  // 归一化私钥
  let key = calleePrivateKey;
  if (typeof key === 'string') {
    try {
      key = crypto.createPrivateKey(key.includes('PRIVATE KEY') ? key : JSON.stringify(JSON.parse(key)));
    } catch (e) {
      console.error('[HANDSHAKE] ⚠️ 私钥解析失败:', e.message);
      key = null;
    }
  }

  router.post('/', (req, res) => {
    try {
      const { action, message } = req.body || {};
      if (!action || !message) {
        return res.status(400).json({ ok: false, error: 'bad_request', message: 'action 和 message 必填' });
      }

      switch (action) {
        case 'init': {
          const challenge = handshakeManager.processInit(message, {
            calleePrivateKey: key,
            calleeAID,
            callerAID: req.body.caller_aid, // caller 的 AID（验证其 AAT 用）
            calleeAllowedScopes
          });
          if (challenge.directSession) {
            return res.json({ ok: true, directSession: challenge.directSession });
          }
          pending.set(message.caller_id, { initMsg: message, challengeMsg: challenge });
          return res.json({ ok: true, message: challenge });
        }

        case 'proof': {
          const state = pending.get(message.caller_id);
          if (!state) {
            return res.status(409).json({ ok: false, error: 'no_pending_handshake', message: '无进行中的握手，请先 init' });
          }
          const proofResult = handshakeManager.processProof(state.challengeMsg, message, {
            callerAID: req.body.caller_aid,
            userPublicKey,
            calleeAllowedScopes,
            userConfirm: async (p) => {
              if (userConfirm) return userConfirm(p);
              return false; // 默认拒绝 L3
            }
          });
          pending.delete(message.caller_id);
          if (trustManager) {
            trustManager.recordInteraction(message.caller_id, true, { event: 'handshake', level: proofResult.level });
          }
          return res.json({ ok: true, message: proofResult });
        }

        case 'complete': {
          const result = handshakeManager.processComplete(req.body.approval_msg, message);
          return res.json({ ok: true, session: result.session });
        }

        default:
          return res.status(400).json({ ok: false, error: 'bad_action', message: `未知 action: ${action}` });
      }
    } catch (e) {
      const code = e.code || 'handshake_error';
      const status = (code === 'caller_aat_invalid' || code === 'bad_message' || code === 'callee_mismatch' || code === 'nonce_replay' || code === 'time_drift') ? 401 : 400;
      return res.status(status).json({ ok: false, error: code, message: e.message });
    }
  });

  // 状态查询（调试用）
  router.get('/status', (req, res) => {
    res.json({
      enabled: true,
      callee: calleeAID.agent_id,
      allowedScopes: calleeAllowedScopes,
      pendingHandshakes: [...pending.keys()],
      securityLevels: { NONE: 0, LIGHT: 1, FULL: 2, USER_CONFIRM: 3 }
    });
  });

  return router;
}

module.exports = { createHandshakeRouter };
