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
 * 温暖拒绝出口（CSB Open Protocol v1.2 §2.1）：
 * 拒绝不能只回「不行」——至少要说清「为什么不行」和「怎么才行」。
 * 这里保持既有 { ok:false, error, message } 形状不变，只追加 next_step。
 */
const rejectBody = (error, message, next_step) => ({ ok: false, error, message, next_step });

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
 *   - onSession: 可选，会话建立后回调（注册到 trust-bridge）
 * @returns {Function} Express router
 */
function createHandshakeRouter({
  handshakeManager, calleeAID, calleePrivateKey,
  calleeAllowedScopes = ['a2a:send'],
  userConfirm = null, userPublicKey = null, trustManager = null,
  onSession = null,          // [B 批 · 2026-11-21] 此前没有这个形参 →
} = {}) {                   //   下面 `options.onSession` 必然 ReferenceError，
                            //   握手 complete 恒 400，trust-bridge 会话表恒空。
  const router = require('express').Router();
  // callee 侧状态: callerId -> { initMsg, challengeMsg }（proof 阶段需要 challenge）
  const pending = new Map();

  // ══════════════════════════════════════════════════════════════════
  // [B 批 · 2026-11-21] 会话令牌（把「握手过」变成「这条消息确实来自那个会话」）
  //
  // 为什么必须有：此前 trust-bridge 只能靠 metadata.sender.url 的 host 去锚定
  // 会话，而 url 是自述字段、邻居 host:port 在公网注册表里对全网可见 ——
  // 一旦握手真的接通，任何人写个 sender.url 就能顶替刚握过手的邻居。
  // 协议里本来就发了 access_token（handshake.js:179），但全仓零消费。
  // 这里补上「签发→回传→核对」一环。
  //
  // L1（LIGHT）握手在 proof 阶段就成立、没有 complete 往返，故由本端点自签令牌；
  // L2+ 由 processProof 生成 access_token，调用方须在 complete 时原样回传。
  // ══════════════════════════════════════════════════════════════════
  const issuedTokens = new Map(); // session_id -> { token, callerId, expiresAt, level }
  const TOKEN_TTL_MS = 3600 * 1000;

  function newToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  function safeEqualToken(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ba = Buffer.from(a), bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  }

  function registerSession(session, token) {
    if (typeof onSession !== 'function' || !session) return;
    try {
      onSession({ ...session, access_token: token });
    } catch (e) {
      console.warn('[HANDSHAKE] onSession 回调失败:', e.message);
    }
  }

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

          // L1：会话在 proof 阶段即成立（协议无 complete 往返）→ 自签令牌并立即注册
          if (proofResult && proofResult.session) {
            const token = newToken();
            const ttlMs = (proofResult.session.ttl ?? 300) * 1000;
            issuedTokens.set(proofResult.session.session_id, {
              token,
              callerId: proofResult.session.caller_id,
              expiresAt: Date.now() + ttlMs,
              level: proofResult.session.security_level,
            });
            registerSession(proofResult.session, token);
            return res.json({ ok: true, message: { ...proofResult, session_token: token } });
          }

          // L2+：令牌已随 complete 消息发给调用方，先把「该会话应对应哪个令牌」记下
          if (proofResult && proofResult.complete && proofResult.complete.access_token) {
            issuedTokens.set(proofResult.complete.session_id, {
              token: proofResult.complete.access_token,
              callerId: message.caller_id,
              expiresAt: Date.now() + TOKEN_TTL_MS,
              level: proofResult.complete.level,
            });
          }
          return res.json({ ok: true, message: proofResult });
        }

        case 'complete': {
          // [B 批] 先核令牌：complete 里回传的 access_token 必须等于我们签发的那一个。
          const sid = message?.session_id;
          const rec = sid ? issuedTokens.get(sid) : null;
          if (!rec) {
            return res.status(400).json({ ok: false, error: 'session_token_unknown', message: '该会话没有已签发的令牌，请从 proof 开始' });
          }
          if (Date.now() > rec.expiresAt) {
            issuedTokens.delete(sid);
            return res.status(401).json(rejectBody('session_token_expired', '会话令牌已过期', '重新从 action=proof 发起握手以获取新令牌（令牌 TTL 有限，过期需重走一轮）后重试 complete'));
          }
          if (!safeEqualToken(message?.access_token, rec.token)) {
            return res.status(401).json(rejectBody('session_token_mismatch', 'access_token 与签发的令牌不符', '把 proof 阶段收到的 access_token 原样回传（勿截断/加引号空格）；若已丢失，请从 action=proof 重新发起握手'));
          }
          const result = handshakeManager.processComplete(req.body.approval_msg, message);
          issuedTokens.delete(sid);
          // [TrustBridge] 握手完成 → 回调（注册信任会话 + 令牌）
          registerSession(result.session, rec.token);
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
      // [B 批 · 2026-11-21] 此前直接回 caller_id 列表（无鉴权泄露谁在握手）。
      //   改为只回条数；排查需要具体 id 时查本机日志。
      pendingHandshakes: pending.size,
      issuedSessions: issuedTokens.size,
      securityLevels: { NONE: 0, LIGHT: 1, FULL: 2, USER_CONFIRM: 3 }
    });
  });

  return router;
}

module.exports = { createHandshakeRouter };
