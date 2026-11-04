#!/usr/bin/env node
/**
 * why-endpoint.js —— §2.2 追问通道（Why Button）· `GET /v1/why/:decision_id`
 * ------------------------------------------------------------------
 * 协议要的那句话是：「被拒绝的一方有权知道为什么。」
 * 落到工程上，「知道为什么」不能是一段事后写的中文 —— 那段文字判不了对错。
 * 所以这里只回放**当时逐条比对过的客观三元组**：
 *
 *   decision_chain: [{ rule: 'BR-02', value: 'SOUL.md', result: 'matched' }, ...]
 *
 * 三个设计判断（都是被踩过之后定下的）：
 *
 * 1. **只读、只回放，绝不重算。**
 *    重算会得到一个「现在会怎么判」的答案，而对方要的是「当时为什么这么判」。
 *    两者常常不同（规则表改过、白名单改过），拿现在的答案冒充当时的理由，
 *    比不给理由更坏 —— 它看起来有据可查。
 *
 * 2. **查不到就说查不到，并说清查不到的原因。**
 *    三种「查不到」必须分开（协议同款口径）：
 *      · 文件不存在   → 还没产生过任何拒绝（部署问题，不是对方的问题）
 *      · 窗口外       → 可能在更早的记录里，扩窗重试是**可执行**的下一步
 *      · 真的没有     → 该 id 从未签发过
 *    混成一句 404 就等于让调用方自己猜。
 *
 * 3. **缺 next_step 的旧记录要显式标出。**
 *    K-1 之前落账的拒绝没有五字段，回放时标 `legacy: true`，
 *    不假装它当时是合格的。
 *
 * 诚实边界：
 *   · 只覆盖 warm-reject 落账的拒绝（`logs/a2a-audit.jsonl`）。
 *     AAT 验签拒绝、论坛 403 等**不在**这里 —— 它们各写各的日志。
 *     所以「这里查不到」≠「没被拒过」，只等于「不是这条通道拒的」。
 *   · 不鉴权到「只有被拒方本人能看」的粒度：审计号是随机段，
 *     知道 audit_id 才查得到，属于「凭票据取回」而非「凭身份取回」。
 *
 * 维护: 若兰 🌸 | 2026-11-04
 */
'use strict';

const { findAudit, warmReject, CODES, AUDIT_LOG } = require('./warm-reject');

const PATH_PREFIX = '/v1/why/';

/** 合法的审计号形状：`reject_<ms>_<6 hex>`。先判形状，再查盘 —— 免得拿任意串去扫日志 */
const ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

/**
 * 组织回放正文（纯函数，可单测）
 * @param {string} decisionId
 * @param {{found:boolean, entry?:object, scanned:number, truncated:boolean, missingFile?:boolean}} hit
 * @returns {{http:number, body:object}}
 */
function buildWhy(decisionId, hit) {
  if (!decisionId || !ID_RE.test(String(decisionId))) {
    return {
      http: 400,
      body: {
        error: 'invalid_decision_id',
        reason: `审计号形状不合法（长度需 6–80，仅含字母数字-_）：「${String(decisionId || '').slice(0, 40)}」`,
        next_step: '用拒绝响应里返回的 audit_id 原样查询，形如 reject_1793787965061_8ae2d6',
      },
    };
  }

  if (!hit || !hit.found) {
    // 三种查不到分开说 —— 这是本端点「温暖」的地方：它自己也要给 next_step
    if (hit && hit.missingFile) {
      return {
        http: 503,
        body: {
          error: 'audit_log_missing',
          reason: `本实例尚未产生拒绝审计（${AUDIT_LOG} 不存在）—— 这是部署侧问题，不是你查错了`,
          next_step: '确认本实例启动后确实拒绝过一次请求；若从未拒绝过，这里本来就该是空的',
          scanned: 0,
        },
      };
    }
    const scanned = (hit && hit.scanned) || 0;
    const truncated = !!(hit && hit.truncated);
    return {
      http: 404,
      body: {
        error: 'decision_not_found',
        reason: truncated
          ? `在最近 ${scanned} 条审计里没找到「${decisionId}」，但日志更长 —— 可能落在更早的记录里`
          : `最近 ${scanned} 条审计里没有「${decisionId}」—— 该审计号从未签发过，或日志已被归档`,
        next_step: truncated
          ? '带 ?window=20000 扩大回查窗口重试（越大越慢，一次别超 50000）'
          : '核对 audit_id 是否抄错；若拒绝来自 AAT 验签或论坛，请查各自的日志（本端点只覆盖温暖拒绝通道）',
        scanned,
        truncated,
      },
    };
  }

  const e = hit.entry || {};
  const ctx = (e.context && typeof e.context === 'object') ? e.context : {};
  const chain = Array.isArray(ctx.decision_chain) ? ctx.decision_chain : [];

  // 每条三元组必须是客观量才回放；形状不对的不静默丢掉，单独列出来
  const wellFormed = [];
  const malformed = [];
  for (const step of chain) {
    const okShape = step && typeof step === 'object'
      && typeof step.rule === 'string'
      && (step.value === null || typeof step.value === 'string')
      && typeof step.result === 'string'
      && ['matched', 'no_match', 'unknown', 'disabled'].includes(step.result);
    (okShape ? wellFormed : malformed).push(step);
  }

  const legacy = !e.next_step;
  return {
    http: 200,
    body: {
      decision_id: e.audit_id || decisionId,
      timestamp: e.ts || null,
      status: e.status || null,
      code: e.code || null,
      reason: e.reason || null,
      // 旧记录可能没有 next_step：显式标记，不假装当时就合格
      next_step: e.next_step || null,
      legacy: legacy || undefined,
      agent: e.agent || null,
      action: e.action || null,
      request_id: e.request_id || null,
      // 判据快照：只回放，不重算
      decision_chain: wellFormed,
      chain_source: 'snapshot_at_decision_time',
      matched_rules: Array.isArray(ctx.matchedRules) ? ctx.matchedRules : [],
      rule_id: ctx.ruleId || null,
      tier: ctx.tier || null,
      decision: ctx.decision || null,
      warnings: Array.isArray(ctx.warnings) ? ctx.warnings : [],
      fallback: ctx.fallback === undefined ? null : ctx.fallback,
      ...(malformed.length ? { malformed_steps: malformed.slice(0, 5), malformed_count: malformed.length } : {}),
      ...(ctx.decision_chain_truncated ? { chain_truncated: ctx.decision_chain_truncated } : {}),
      ...(ctx.truncated ? { context_truncated: true } : {}),
    },
  };
}

/**
 * 注册到 express app。
 * @param {object} app        express app
 * @param {object} [opts]     { checkAuth?: (req)=>boolean, auditFile?: string }
 *                            checkAuth 交给调用方注入（复用 /tasks 的内网免令牌口径），
 *                            本模块不自己发明第二套鉴权。
 */
function registerWhyEndpoint(app, opts = {}) {
  const auditFile = opts.auditFile || AUDIT_LOG;
  const checkAuth = typeof opts.checkAuth === 'function' ? opts.checkAuth : null;

  app.get('/v1/why/:decisionId', (req, res) => {
    if (checkAuth && !checkAuth(req)) {
      // 走 K-1 的唯一出口，不自己拼字段：否则「追问通道自己的拒绝」会成为
      // 全仓唯一一条不守自己契约的拒绝 —— 那种不一致最难被发现。
      try {
        const body = warmReject({
          code: CODES.AUTH_REQUIRED,
          reason: '追问通道与 /tasks 同口径（内网免令牌），本请求来源为外部且未带有效 Bearer 令牌（401）',
          next_step: '从内网发起，或在请求头带 Authorization: Bearer <A2A_TASKS_TOKEN> 后重试',
          agent: req.headers['x-agent-id'] || 'unknown',
          action: `GET ${req.baseUrl || ''}${req.path}`,
          request_id: req.headers['x-request-id'] || null,
          // 必须把本实例的审计落点透传下去：否则单测/临时实例会把拒绝写进生产日志。
          // 2026-11-04 早上的教训（ef68c5d）今天原样复现了一次 —— 同一族错误，
          // 根因是「默认值 = 生产路径」这个设计：默认安全应该反过来。
          auditFile: opts.auditFile,
        });
        return res.status(401).json(body);
      } catch (e) {
        // 契约不满足 → 退到最小响应，但把异常记下来，不把我们的形状错误算成对方的错。
        // `_warm: false` 是**诚实的自报**：这条不是温暖拒绝出口造的，别让它冒充合格件。
        // 仍然保留 next_step —— 即便是兜底，也不许给对方一句「不行」就完事。
        try { console.warn('[v1/why] 温暖拒绝构造失败，退到简式 401:', e.message); } catch { /* noop */ }
        return res.status(401).json({
          error: 'auth_required', _warm: false,
          reason: '追问通道鉴权未通过，且本次温暖拒绝构造异常（属本实例内部问题，不是你的请求有问题）',
          next_step: '从内网发起，或在请求头带 Authorization: Bearer <A2A_TASKS_TOKEN> 后重试；仍失败请告知本实例主人',
        });
      }
    }
    const decisionId = req.params.decisionId;
    const winRaw = parseInt(req.query && req.query.window, 10);
    const window = Number.isFinite(winRaw) && winRaw > 0 ? Math.min(winRaw, 50000) : 5000;
    let hit;
    try {
      hit = findAudit(decisionId, { file: auditFile, maxLines: window });
    } catch (e) {
      return res.status(500).json({
        error: 'audit_read_failed',
        reason: `读审计日志失败：${e.message}`,
        next_step: '请本实例主人检查 logs/a2a-audit.jsonl 的权限与磁盘空间',
      });
    }
    const { http, body } = buildWhy(decisionId, hit);
    res.status(http).json(body);
  });
}

module.exports = { registerWhyEndpoint, buildWhy, ID_RE, PATH_PREFIX };
