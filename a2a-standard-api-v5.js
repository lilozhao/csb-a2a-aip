/**
 * A2A 标准 JSON-RPC API 模块 v1.2
 * + LLM 智能回复 (从 v3 移植)
 *
 * 版本: 1.2.0 | 2026-05-10
 */

const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const { TaskStore, TASK_STATE, ROLE, createMessage, createArtifact, createPart, TERMINAL_STATES } = require('./a2a-task-store.js');
const minInfo = require('./a2a-min-info.js');

// ============================================
// 标准错误代码 (A2A §5.4)
// ============================================
const A2A_ERRORS = {
  TaskNotFoundError:          { code: -32001, message: 'Task not found' },
  TaskNotCancelableError:     { code: -32002, message: 'Task is not cancelable' },
  PushNotificationNotSupportedError: { code: -32003, message: 'Push notifications not supported' },
  UnsupportedOperationError:  { code: -32004, message: 'Unsupported operation' },
  ContentTypeNotSupportedError: { code: -32005, message: 'Content type not supported' },
  InvalidAgentResponseError:  { code: -32006, message: 'Invalid agent response' },
  VersionNotSupportedError:   { code: -32009, message: 'Protocol version not supported' },
  InternalError:              { code: -32603, message: 'Internal error' },
  InvalidParams:              { code: -32602, message: 'Invalid params' },
  MethodNotFound:             { code: -32601, message: 'Method not found' },
};

function a2aError(errType, details) {
  const err = A2A_ERRORS[errType] || A2A_ERRORS.InternalError;
  const resp = { code: err.code, message: err.message };
  if (details) resp.data = details;
  return resp;
}

/**
 * A2A StandardAPI - 为 Express 应用注入标准方法
 */
class A2AStandardAPI {
  constructor(options = {}) {
    this.identity          = options.identity          || { name: 'Agent', emoji: '🤖', port: 3100 };
    this.taskStore         = options.taskStore         || new TaskStore();
    this.envelopeManager   = options.envelopeManager   || null;
    this.trustManager      = options.trustManager      || null;
    this.semanticValidator = options.semanticValidator || null;
    this.negotiationEngine = options.negotiationEngine || null;
    this.supportedVersion  = options.supportedVersion  || '0.5';
    this.rateLimiter       = options.rateLimiter       || null;

    // 外部处理函数注入 (解决 v3 集成)
    this._externalHandler  = options.taskHandler || null;
    // 远程命令处理器 (CMD: 前缀)
    this._commandHandler   = options.commandHandler || null;

    // [2026-10-20 补接] A2A 入站可见性 Layer1 收件箱 + Layer2 主会话通知
    //   根因：v4→v5 重构时这段接线没搬过来——server_v5.js 传了 inbox/chatNotifyHandler，
    //        但本类既未接收也未使用，导致 v5 实例**任何入站消息都不留痕**
    //        （tests/a2a-inbox.test.js 4 项长期失败）。
    this._inbox            = options.inbox || null;
    this._chatNotifyHandler = options.chatNotifyHandler || null;

    // SSE 订阅者: Map<taskId, Set<{res, lastPing}>
    this.streamSubscribers = new Map();
    this._sseHeartbeatInterval = 15000; // 15s 心跳

    // [G1/G2 修复] 加载安全守卫配置
    try {
      const messageGuard = require('./a2a-message-guard.js');
      messageGuard.loadConfig(path.join(__dirname, 'config', 'message-guard.json'));
    } catch { /* 配置缺失使用默认值 */ }
    try {
      const cmdGuard = require('./a2a-cmd-guard.js');
      cmdGuard.loadConfig(path.join(__dirname, 'config', 'cmd-guard.json'));
    } catch { /* 配置缺失使用默认值 */ }
  }

  /**
   * 设置任务处理函数 (解决 ProcessTask 桩问题)
   */
  setTaskHandler(fn) { this._externalHandler = fn; }

  // ================= 路由注册 =================

  registerRoutes(app) {
    app.post('/a2a/json-rpc',      this._handleJSONRPC.bind(this));
    app.post('/tasks/:id/cancel',   this._handleRESTCancel.bind(this));
    app.get ('/tasks/:id',          this._handleRESTGetTask.bind(this));
    app.get ('/tasks',              this._handleRESTListTasks.bind(this));
    app.post('/tasks/:id/subscribe',this._handleRESTSubscribe.bind(this));
    app.post('/message:send',       this._handleRESTSendMessage.bind(this));
    app.post('/message:stream',     this._handleRESTStreamMessage.bind(this));
    app.get ('/a2a/stream/:taskId', this._handleSSESubscribe.bind(this));

    // SSE 全局心跳
    this._sseHeartbeatTimer = setInterval(() => this._ssePingAll(), this._sseHeartbeatInterval);
  }

  // ================= JSON-RPC 分发器 =================

  async _handleJSONRPC(req, res) {
    try {
      const { jsonrpc, method, params, id } = req.body;

      if (jsonrpc !== '2.0') {
        return res.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request: must be JSON-RPC 2.0' }, id: id || null });
      }

      // A2A-Version 检查 (§3.6 — 增强 Major.Minor 匹配)
      const verHeader = req.headers['a2a-version'];
      if (verHeader && !this._isVersionCompatible(verHeader)) {
        return res.json({ jsonrpc: '2.0', error: a2aError('VersionNotSupportedError', { requested: verHeader, supported: this.supportedVersion }), id });
      }

      // 流量控制 — 修复 IP 提取（A2A-019）
      // 双模式: csb-security RateLimiter 有 check({agentId, ip}) → 按 Agent+IP+全局限流
      //         legacy RateLimiter 只有 allow(clientId) → 按 IP 限流（行为不变）
      if (this.rateLimiter) {
        const clientIp = this._clientIp(req);
        const agentId = this._extractAgentId(req);
        if (typeof this.rateLimiter.check === 'function') {
          const rl = this.rateLimiter.check({ agentId, ip: clientIp });
          if (!rl.allowed) {
            return res.json({ jsonrpc: '2.0', error: { code: -32010, message: 'Rate limit exceeded', data: { retryAfterMs: rl.retryAfterMs || 0, reason: rl.reason || 'rate_limited' } }, id });
          }
        } else if (typeof this.rateLimiter.allow === 'function' && !this.rateLimiter.allow(clientIp)) {
          return res.json({ jsonrpc: '2.0', error: { code: -32010, message: 'Rate limit exceeded', data: { retryAfterMs: (this.rateLimiter.retryAfter ? this.rateLimiter.retryAfter(clientIp) : 0) } }, id });
        }
      }

      // 🔄 向下兼容旧版方法名（v3 client → v4 server）
      const METHOD_ALIASES = {
        'message/send': 'SendMessage',
        'tasks/send':   'SendMessage',
        'tasks/get':    'GetTask',
        'tasks/list':   'ListTasks',
        'tasks/cancel': 'CancelTask',
      };
      const normalizedMethod = METHOD_ALIASES[method] || method;

      let result;
      switch (normalizedMethod) {
        case 'SendMessage':          result = await this._sendMessage(params); break;
        case 'SendStreamingMessage': result = await this._sendMessage(params); break; // 非流式回退
        case 'GetTask':              result = this._getTask(params);            break;
        case 'ListTasks':            result = this._listTasks(params);         break;
        case 'CancelTask':           result = this._cancelTask(params);         break;
        case 'RequestExpansion':     result = await this._requestExpansion(params); break; // [SPEC-A2A-0003]
        default:
          return res.json({ jsonrpc: '2.0', error: a2aError('MethodNotFound', { method }), id });
      }

      if (result?.error) {
        return res.json({ jsonrpc: '2.0', error: a2aError(result.error, result.details), id });
      }

      return res.json({ jsonrpc: '2.0', result, id });
    } catch (err) {
      console.error('[A2A] JSON-RPC 错误:', err.message);
      return res.json({ jsonrpc: '2.0', error: a2aError('InternalError', { detail: err.message }), id: req.body?.id || null });
    }
  }

  // ================= 核心方法 =================

  /**
   * [SPEC-A2A-0003] 原文按需展开（R1–R12）。默认关：A2A_EXPANSION_ENABLED=off 时一律拒绝。
   * 实现见 a2a-expansion.js；此处仅作 JSON-RPC 接线。
   */
  async _requestExpansion(params) {
    const expansion = require('./a2a-expansion.js');
    const ledger = (rec) => {
      try {
        const L = path.join(__dirname, '..', 'scripts', 'ledger.js');
        if (require('fs').existsSync(L)) { /* 账本由桥接层统一写入；此处仅打印留痕 */ }
      } catch (_) {}
      console.error('[A2A][expansion]', JSON.stringify(rec));
    };
    return expansion.handleRequestExpansion(params, { ledger });
  }

  /**
   * [SPEC-A2A-0002] 校验并透传 metadata.min_info（R1/R2/R4/R9）。
   * 仅结构校验；不解析 raw_ref。
   */
  _processMinInfo(metadata) {
    return minInfo.processMinInfo(metadata);
  }

  async _sendMessage(params) {
    if (!params?.message) return { error: 'InvalidParams', details: 'Missing message field' };    if (!params.message.role || !params.message.parts) return { error: 'InvalidParams', details: 'Message must have role and parts' };

    const msg = params.message;
    const returnImmediately = params.configuration?.returnImmediately === true;

    for (const p of msg.parts) {
      if (p.file?.mimeType && !this._isContentTypeSupported(p.file.mimeType)) {
        return { error: 'ContentTypeNotSupportedError', details: `Unsupported: ${p.file.mimeType}` };
      }
    }

    // [SPEC-A2A-0002] 消息最小信息约定：校验 metadata.min_info（R1/R2/R4/R9）
    // 边界：仅校验+透传，不解析 raw_ref（R5/R6 由 a2a-expansion.js 在显式授权下处理）
    {
      const minInfoRes = (typeof this._processMinInfo === 'function')
        ? this._processMinInfo(params.message?.metadata)
        : null;
      if (minInfoRes && minInfoRes.ok === false) {
        const traceId = `mininfo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        console.error(`[A2A][min_info] ${minInfoRes.error.code}: ${minInfoRes.error.detail} | trace_id=${traceId} | task_id=pending`);
        return { error: 'InvalidParams', details: { code: minInfoRes.error.code, detail: minInfoRes.error.detail, trace_id: traceId } };
      }
      if (minInfoRes && minInfoRes.notice) {
        // R9 过渡期提示（不改行为）
        console.error(`[A2A][min_info] notice=${minInfoRes.notice}`);
      }
    }

    // 将 sender 信息存入 metadata，供 LLM 回复使用
    // [2026-10-08] 补：sender 也可能放在 params.message.metadata.sender（A2A 常见写法）
    const taskMetadata = {
      ...(params.configuration?.metadata || {}),
      ...(params.metadata || {}),
      ...(params.message?.metadata || {}),
      ...(params.sender ? { sender: params.sender } : {}),
    };

    const task = this.taskStore.createTask({
      contextId: msg.contextId || undefined,
      metadata: Object.keys(taskMetadata).length > 0 ? taskMetadata : undefined,
    });

    this.taskStore.addHistory(task.id, { role: msg.role, parts: msg.parts, messageId: msg.messageId || `msg_${Date.now()}` });
    this.taskStore.updateTaskStatus(task.id, TASK_STATE.SUBMITTED, 'Task created');

    if (returnImmediately) return { task: this.taskStore.getTask(task.id) };

    // 实际处理 (外部注入或桩)
    this.taskStore.updateTaskStatus(task.id, TASK_STATE.WORKING, 'Processing');
    try {
      const response = await this._processTask(task.id, msg, taskMetadata);

      if (response?.artifacts) {
        for (const art of response.artifacts) this.taskStore.addArtifact(task.id, art);
      }
      if (response?.message) {
        this.taskStore.addHistory(task.id, response.message);
      }

      this.taskStore.updateTaskStatus(task.id, TASK_STATE.COMPLETED, 'Completed');
      const result = this.taskStore.getTask(task.id);
      this._notifySubscribers(task.id, { task: result });
      return { task: result };
    } catch (err) {
      console.error(`[A2A] Task ${task.id} failed:`, err.message);
      this.taskStore.updateTaskStatus(task.id, TASK_STATE.FAILED, err.message);
      const failed = this.taskStore.getTask(task.id);
      this._notifySubscribers(task.id, { task: failed });
      return { task: failed };
    }
  }

  _getTask(params) {
    if (!params?.taskId) return { error: 'InvalidParams', details: 'Missing taskId' };
    const task = this.taskStore.getTask(params.taskId);
    if (!task) return { error: 'TaskNotFoundError', details: { taskId: params.taskId } };
    if (params.historyLength !== undefined) {
      if (params.historyLength === 0) delete task.history;
      else if (task.history?.length > params.historyLength) task.history = task.history.slice(-params.historyLength);
    }
    return { task };
  }

  _listTasks(params) {
    return this.taskStore.listTasks({
      contextId: params?.contextId, state: params?.state,
      includeArtifacts: params?.includeArtifacts, historyLength: params?.historyLength,
      pageToken: params?.pageToken, pageSize: params?.pageSize,
    });
  }

  _cancelTask(params) {
    if (!params?.taskId) return { error: 'InvalidParams', details: 'Missing taskId' };
    const result = this.taskStore.cancelTask(params.taskId, params.reason);
    if (result.error) return result;
    this._notifySubscribers(params.taskId, { task: result.task });
    return { task: result.task };
  }

  // ================= SSE 流式 =================

  _handleSSESubscribe(req, res) {
    const task = this.taskStore.getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write(`data: ${JSON.stringify({ task })}\n\n`);

    if (TERMINAL_STATES.has(task.status.state)) {
      res.write(`event: done\ndata: {}\n\n`);
      return res.end();
    }

    if (!this.streamSubscribers.has(task.id)) {
      this.streamSubscribers.set(task.id, new Set());
    }
    const entry = { res, lastPing: Date.now() };
    this.streamSubscribers.get(task.id).add(entry);

    req.on('close', () => {
      const subs = this.streamSubscribers.get(task.id);
      if (subs) { subs.delete(entry); if (subs.size === 0) this.streamSubscribers.delete(task.id); }
    });
  }

  _ssePingAll() {
    const now = Date.now();
    for (const [tid, subs] of this.streamSubscribers) {
      for (const entry of subs) {
        try {
          entry.res.write(': ping\n\n');
          entry.lastPing = now;
        } catch { subs.delete(entry); }
      }
      if (subs.size === 0) this.streamSubscribers.delete(tid);
    }
  }

  _notifySubscribers(taskId, data) {
    const subs = this.streamSubscribers.get(taskId);
    if (!subs) return;
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const entry of subs) {
      try { entry.res.write(payload); } catch { subs.delete(entry); }
    }
  }

  // ================= REST 端点 =================

  _handleRESTGetTask(req, res) {
    const r = this._getTask({ taskId: req.params.id, historyLength: req.query.historyLength });
    if (r.error) return res.status(404).json(r);
    res.json(r);
  }
  _handleRESTListTasks(req, res) {
    res.json(this._listTasks({
      contextId: req.query.contextId, state: req.query.state,
      includeArtifacts: req.query.includeArtifacts === 'true',
      pageToken: req.query.pageToken,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize) : undefined,
    }));
  }
  _handleRESTCancel(req, res) {
    const r = this._cancelTask({ taskId: req.params.id, reason: req.body?.reason });
    if (r.error) return res.status(r.error === 'TaskNotFoundError' ? 404 : 400).json(r);
    res.json(r);
  }
  async _handleRESTSendMessage(req, res) {
    const r = await this._sendMessage({ message: req.body.message, configuration: req.body.configuration });
    if (r.error) return res.status(400).json(r);
    res.json(r);
  }
  async _handleRESTStreamMessage(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const msg = req.body.message;
    if (!msg) { res.write(`event: error\ndata: ${JSON.stringify({ error: 'Missing message' })}\n\n`); return res.end(); }

    const task = this.taskStore.createTask({ contextId: msg.contextId, metadata: { sender: req.body.sender } });
    this.taskStore.addHistory(task.id, { role: msg.role, parts: msg.parts, messageId: msg.messageId || `msg_${Date.now()}` });
    this.taskStore.updateTaskStatus(task.id, TASK_STATE.WORKING);
    res.write(`data: ${JSON.stringify({ task: this.taskStore.getTask(task.id) })}\n\n`);

    try {
      const resp = await this._processTask(task.id, msg, { sender: req.body.sender });
      if (resp?.artifacts) {
        for (const art of resp.artifacts) {
          this.taskStore.addArtifact(task.id, art);
          res.write(`event: artifact\ndata: ${JSON.stringify({ artifact: art })}\n\n`);
        }
      }
      this.taskStore.updateTaskStatus(task.id, TASK_STATE.COMPLETED);
      res.write(`data: ${JSON.stringify({ task: this.taskStore.getTask(task.id) })}\n\n`);
    } catch (err) {
      this.taskStore.updateTaskStatus(task.id, TASK_STATE.FAILED, err.message);
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    res.write('event: done\ndata: {}\n\n');
    res.end();
  }
  _handleRESTSubscribe(req, res) { this._handleSSESubscribe(req, res); }

  // ================= 辅助 =================

  /**
   * [2026-10-20] 入站留痕 + 主会话通知（Layer1 / Layer2）
   *
   * 规则（与 v4 一致）：
   *   - 所有入站消息都写收件箱（含委托），kind 由 inbox.record 自行判定
   *   - 只有**非委托**消息触发主会话通知（委托走自己的通道，不骚扰主会话）
   *   - fire-and-forget：通知不得阻塞 A2A 响应（2026-10-20 阿轩超时教训）
   *   - 任一环节抛错都不得反噬主链路（收件箱是观测，不是业务）
   */
  _recordInbound(taskId, msg, metadata) {
    if (this._inbox) {
      try { this._inbox.record({ taskId, msg, metadata }); }
      catch (e) { console.warn('[A2A] ⚠️ 收件箱写入失败（不影响主链路）:', e.message); }
    }
    if (this._chatNotifyHandler && !(msg && msg.delegation)) {
      try {
        const p = this._chatNotifyHandler(taskId, msg, metadata);
        if (p && typeof p.catch === 'function') {
          p.catch((e) => console.warn('[A2A] ⚠️ 主会话通知失败（不影响主链路）:', e && e.message));
        }
      } catch (e) { console.warn('[A2A] ⚠️ 主会话通知异常（不影响主链路）:', e.message); }
    }
  }

  async _processTask(taskId, msg, metadata) {
    // 入口即留痕：不论后续走 CMD / 委派 / 自动应答，都先记一笔
    this._recordInbound(taskId, msg, metadata);
    if (this._externalHandler) return this._externalHandler(taskId, msg);

    let text = msg.parts.filter(p => p.text).map(p => p.text).join(' ');
    if (!text || text.trim().length < 2) text = '(empty)';

    // 🚀 CMD: 前缀 → 远程命令执行（[G2 修复] 增加权限校验 + 白名单 + 审计）
    if (text.startsWith('CMD:') && this._commandHandler) {
      const cmdText = text.substring(4).trim();

      // [G2 修复] 权限校验 + 命令白名单 + 审批机制
      const cmdGuard = require('./a2a-cmd-guard.js');
      const senderName = metadata?.sender?.name ||
        (typeof metadata?.sender === 'string' ? metadata.sender : null) ||
        'unknown';
      const senderInfo = this._resolveSenderInfo(senderName, metadata);

      const authResult = cmdGuard.checkCommand(senderInfo, cmdText);

      if (!authResult.allowed) {
        // 命令被拒绝或待审批
        const denialMsg = authResult.requiresApproval
          ? authResult.reason
          : `⛔ 命令被拒绝: ${authResult.reason}`;

        console.warn(`[A2A] ⛔ CMD 拒绝 from ${senderName}: ${authResult.reason}`);

        return {
          artifacts: [createArtifact([createPart(denialMsg)], { name: 'cmd_response' })],
          message: createMessage(ROLE.AGENT, [createPart(denialMsg)]),
        };
      }

      // [G2 修复] 沙箱化执行 — 限制输出长度和超时
      const sandbox = authResult.sandbox || { maxOutputLength: 10000, timeoutMs: 10000 };

      try {
        const cmdResult = await Promise.race([
          this._commandHandler(authResult.sanitizedCmd, metadata),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('命令执行超时')), sandbox.timeoutMs)
          ),
        ]);

        // 限制输出长度
        if (typeof cmdResult === 'string' && cmdResult.length > sandbox.maxOutputLength) {
          return cmdResult.substring(0, sandbox.maxOutputLength) + '\n... [输出被截断]';
        }

        return cmdResult;
      } catch (err) {
        const errMsg = `命令执行失败: ${err.message}`;
        console.error(`[A2A] CMD 执行错误:`, err.message);

        try {
          const audit = require('./audit-log.js');
          audit.log('cmd.execute', {
            command: cmdText.substring(0, 200),
            sender: senderName,
            error: err.message,
          }, senderName, this.identity.name, 'error');
        } catch { /* 审计模块可选 */ }

        return {
          artifacts: [createArtifact([createPart(errMsg)], { name: 'cmd_response' })],
          message: createMessage(ROLE.AGENT, [createPart(errMsg)]),
        };
      }
    }

    // ══ [2026-10-08 若琢 batch2 ①] 连接分级在**传输层**执行：blocked 的对方直接拒 ══
    //   （此前 connection_level 只在身份层"声明 + 可查"，A2A 层未采信 → 文档说了代码没做）
    //   判据：本实例在身份层的 subject 对「发送方」的级别 == blocked → 拒收，不进入处理。
    //   未注册 subject / 解析不到发送方 → 跳过（不误拦）并只记一次日志。
    try {
      const path2 = require('path');
      const lookup = require('./csb-identity/registry-lookup.js');
      const idDataDir = process.env.A2A_IDENTITY_DATA || path2.join(__dirname, 'csb-identity', 'data');
      const selfName = this.identity?.name;
      const msgMeta = (msg && msg.metadata) || {};
      const pick = (x) => (x && typeof x === 'object' ? x.name : (typeof x === 'string' ? x : null));
      const mdSender = pick(metadata?.sender) || pick(msgMeta.sender) || null;
      const selfSubject = lookup.resolveSelfSubject(idDataDir, selfName);
      const peerId = mdSender ? lookup.resolveAgentId(idDataDir, mdSender) : null;
      if (process.env.A2A_DEBUG_BLOCK === '1') {
        console.log(`[A2A][debug] blocked 判定: selfName=${selfName} self=${selfSubject} sender=${mdSender} peer=${peerId} lv=${(selfSubject && peerId) ? lookup.levelOf(idDataDir, selfSubject, peerId) : '-'} dir=${idDataDir}`);
      }
      if (selfSubject && peerId) {
        const lv = lookup.levelOf(idDataDir, selfSubject, peerId);
        if (lv === 'blocked') {
          const deny = `[已拒绝] 你已被列入黑名单（connection_level=blocked），本条消息未被处理。`;
          console.warn(`[A2A] ⛔ blocked 拦截：${mdSender} → ${selfSubject}`);
          return {
            artifacts: [createArtifact([createPart(deny)], { name: 'response' })],
            message: createMessage(ROLE.AGENT, [createPart(deny)]),
          };
        }
      } else if (!selfSubject && !global.__blockedSkipLogged) {
        global.__blockedSkipLogged = true;
        console.log('[A2A] ℹ️ blocked 判定跳过：本实例尚未在身份层注册（connections 无主体记录）');
      }
    } catch (e) {
      console.warn('[A2A] ⚠️ blocked 判定异常（跳过，不误拦）:', e.message);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 自动回复模式（2026-10-08 明德 · 据硅隐/若兰/舟楫/若琢 反馈二次修正）
    //
    // 背景：LLM 自动回复曾**以本实例主人名义对外作出承诺**（"稍后我会校验…并纳入巡检链路"）。
    //   为防这个，初版把默认改成 'ack'（固定回执）——但引入了两个更糟的副作用：
    //     ① 回执文案里**写死了人名**（"转明德本人处理"）→ 任何跑这份代码的实例都拿我的名字对外应答；
    //     ② **默认值对所有实例生效** → 别家实例静默失去回复能力（服务活着、端点全 200，就是门后没人回话），
    //        这种坏法最难查。方向正好反了：防护变成了"冒用他人名义应答"。
    //
    // 现行为（**默认保持旧行为，防护改为显式可选**）：
    //   - `llm`（**默认**）：正常 LLM 回复 —— 与历史行为一致，不改变任何既有实例；
    //     同时 LLM 侧加了**防承诺约束**（见 _callLLM 末尾），从根上堵"替你乱承诺"；
    //   - `ack`   ：只回固定回执（**文案用本实例自己的名字**，绝不写死他人名）；
    //   - `split` ：**通知类 → ack；对话类 → 正常回复**（通知=广播/日报/日结/拾穗/汇总或 metadata.kind=notification）。
    // 取值优先级：环境变量 A2A_AUTO_REPLY > identity.json 的 autoReply 字段 > 默认 'llm'。
    // ⚠️ 运营提醒：设成 ack/split 前先想清楚——**门后可能就没人回话了**；至少让本实例主人知情。
    // ══════════════════════════════════════════════════════════════════════════
    const AUTO_REPLY_MODE = (() => {
      const env = process.env.A2A_AUTO_REPLY;
      if (env) return String(env).toLowerCase();
      const cfg = this.identity?.autoReply || this.identity?.a2a?.autoReply;
      if (cfg) return String(cfg).toLowerCase();
      return 'llm';
    })();
    const isNotificationLike = () => {
      const kind = String(metadata?.kind || metadata?.type || '').toLowerCase();
      if (kind === 'notification' || kind === 'broadcast') return true;
      const t = String(text || '');
      return /(日报|日结|拾穗|广播|汇总|通知|巡访|读数|week(ly)?\s*report|daily\s*report)/i.test(t);
    };
    const wantAck = AUTO_REPLY_MODE === 'ack' || (AUTO_REPLY_MODE === 'split' && isNotificationLike());
    if (wantAck) {
      const senderNameOf2 = (md) => md?.sender?.name || (md?.sender && typeof md.sender === 'string' ? md.sender : null) || '未知智能体';
      const selfName2 = this.identity?.name || '本实例';
      const ack = `收到。这条消息已记录，将转「${selfName2}」本人处理。\n\n` +
        `（本回执由「${selfName2}」的自动应答生成，仅表示"已收到"，不代表已确认、已同意或已承诺任何事项；请以本人实际回复为准。）`;
      console.log(`[A2A] ✉️ 自动回执（mode=${AUTO_REPLY_MODE}）task ${taskId}`);
      try {
        const a2aMemory = require('./a2a-memory');
        a2aMemory.processConversation(senderNameOf2(metadata), text, ack).catch(() => {});
      } catch (e) { /* 记忆模块可选，跳过 */ }
      return {
        artifacts: [createArtifact([createPart(ack)], { name: 'response' })],
        message: createMessage(ROLE.AGENT, [createPart(ack)]),
      };
    }

    // 🔥 尝试 LLM 智能回复（mode=llm，或 mode=split 且判定为对话类）
    const llmResponse = await this._callLLM(text, metadata);

    if (llmResponse) {
      console.log(`[A2A] 🤖 LLM 回复 task ${taskId}: ${llmResponse.substring(0, 60)}...`);
      
      // 🧠 入站 A2A 消息记忆（异步，不阻塞主流程）
      try {
        const senderName = metadata?.sender?.name ||
          (metadata?.sender && typeof metadata.sender === 'string' ? metadata.sender : null) ||
          '未知智能体';
        const a2aMemory = require('./a2a-memory');
        a2aMemory.processConversation(senderName, text, llmResponse).catch(() => {});
      } catch(e) { /* 记忆模块可选，跳过 */ }
      return {
        artifacts: [createArtifact([createPart(llmResponse)], { name: 'response' })],
        message: createMessage(ROLE.AGENT, [createPart(llmResponse)]),
      };
    }

    // 降级: 回声模式
    console.log(`[A2A] ⚠️ LLM 不可用，使用回声回复 task ${taskId}`);
    return {
      artifacts: [createArtifact([createPart(`Received: ${text}`)], { name: 'response' })],
      message: createMessage(ROLE.AGENT, [createPart(`Processed message for task ${taskId}`)]),
    };
  }

  // ================= LLM 智能回复 =================

  /**
   * 【v5】调用 LLM 生成智能回复 (通过 llm-router)
   */
  async _callLLM(messageText, metadata) {
    // 提取发送者名称 (优先从 metadata)
    const senderName = metadata?.sender?.name ||
      metadata?.sender ||
      (typeof metadata?.sender === 'string' ? metadata.sender : null) ||
      '未知智能体';

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // [G1 修复] 消息安全审查层
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const messageGuard = require('./a2a-message-guard.js');

    // 获取发送者信任等级
    const senderInfo = this._resolveSenderInfo(senderName, metadata);

    // 审查消息内容
    const inspection = messageGuard.inspectMessage(senderInfo, messageText);

    if (!inspection.safe) {
      // 消息被安全审查拦截
      console.warn(`[A2A] ⛔ 消息被安全审查拦截 (risk=${inspection.riskScore}): ${senderName}`);
      return `[安全提示] 来自「${senderName}」的消息因检测到提示注入特征被拦截。` +
        `\n\n检测到的问题: ${inspection.warnings.join('; ')}` +
        `\n\n—— 这符合碳硅契边界契原则：不可信内容不直接进入对话。`;
    }

    // 使用净化后的文本（替代原来的直接拼接）
    const safeText = inspection.sanitized;

    // [v5] 分层提示词
    let systemPrompt;
    try {
      const layeredPromptBuilder = require('./a2a-layered-prompt.js');
      if (layeredPromptBuilder) {
        // [2026-10-08] 自适应应答用的是哪一层提示词：**默认 2（与历史一致）**；
        //   设为 1 可去掉「用户画像/重要记忆」两段——那两段写的是**主人家自己的资料**，
        //   实测会被模型误当成"对话方"或"自我描述"（例：把记忆里的名字当作在场的人）。
        //   每实例可选：identity.json 的 autoReplyLayer（或 env A2A_AUTO_REPLY_LAYER）。
        const _layer = Number(process.env.A2A_AUTO_REPLY_LAYER || this.identity?.autoReplyLayer || 2);
        systemPrompt = layeredPromptBuilder.build(this.identity, {
          layer: _layer,
          senderName
        });
        console.log('[A2A] 🧩 分层提示词 (' + systemPrompt.length + ' chars)');
      } else {
        throw new Error('模块为空');
      }
    } catch(e) {
      console.warn('[A2A] ⚠️ 分层提示词回退:', e.message);
      systemPrompt = this.identity.systemPrompt ||
        `你是${this.identity.name || 'Agent'}，${this.identity.description || '一个 AI 伙伴'}。\n性格: ${this.identity.personality || '友善、好奇'}。`;
    }

    // [G1 修复] System Prompt 加固 — 追加防注入指令
    systemPrompt += '\n' + messageGuard.buildInjectionDefensePrompt();

    // [2026-10-08 明德] **防承诺约束**（针对"自动回复替你作承诺/表态"的根因）
    //   它是自动应答，不是主人本人；因此不得代表主人承诺、同意、拒绝或表态。
    systemPrompt += '\n' + [
      '【自动应答约束（必须遵守）】',
      '1. 你此刻是在做**自动应答**，并不等于主人本人已经看到、确认或同意。',
      '2. **不得**代表主人作出任何承诺、同意、拒绝、授权、时间安排或立场表态。',
      '3. 遇到需要承诺/授权/表态/排期的请求，一律回复：这件事需要主人本人确认，我先记录并转达。',
      '4. 不得以主人名义索取或披露任何隐私、密钥、内部配置。',
      '5. 不确定时，宁可短，不要编。',
      `6. 只称呼**本条消息的发送方**（${senderName}）；不要沿用历史对话里的其他人名或上下文。`,
      `7. 【重要】上文「关于你的用户 / 重要记忆」是**主人自己的背景资料**，**不是本条消息的发送方**。`,
      `   本条消息来自「${senderName}」。回复时只针对「${senderName}」，不得把资料里的人名当作对话方。`
    ].join('\n');

    // [v5] 通过 llm-router 调用（多适配器 + identity.llm 兜底）
    try {
      const router = require('./llm-router.js');
      // [G1 修复] 使用净化后的消息文本（替代原来的直接拼接）
      const userMessage = safeText;
      const result = await router.call(this.identity, systemPrompt, userMessage);
      if (result) {
        console.log('[A2A] 🤖 LLM 回复成功');
        return result;
      }
    } catch(e) {
      console.warn('[A2A] ⚠️ router 失败:', e.message);
    }

    // ⭐ 兜底：直接使用 identity.llm（兼容 v4 方式）
    // [G3 修复] 检查 apiKey 或 apiKeyEnv（支持环境变量引用）
    // [2026-08-31] 放宽：本地无鉴权 LLM（无 apiKey/apiKeyEnv）也允许兜底直连
    const llmConfig = this.identity?.llm;
    if (llmConfig?.host) {
      console.log('[A2A] ⭐ 兜底: 直接调用 identity.llm');
      return this._callLLMOriginal(safeText, metadata);
    }

    console.warn('[A2A] ⚠️ 全部失败，回声回复');
    return null;
  }

  /**
   * v4 兼容的原始 LLM 调用
   */
  async _callLLMOriginal(safeText, metadata) {
    const llmConfig = this.identity?.llm;
    const senderName = metadata?.sender?.name || metadata?.sender || '未知';

    // [G1 修复] 防注入 system prompt
    let systemPrompt = this.identity.systemPrompt ||
      `你是${this.identity.name || 'Agent'}，${this.identity.description || '一个 AI 伙伴'}。`;
    const messageGuard = require('./a2a-message-guard.js');
    systemPrompt += '\n' + messageGuard.buildInjectionDefensePrompt();

    const payload = JSON.stringify({
      model: llmConfig.model || 'default',
      messages: [
        { role: 'system', content: systemPrompt },
        // [G1 修复] 使用已净化的文本，不再直接拼接原始消息
        { role: 'user', content: safeText }
      ],
      max_tokens: 500, temperature: 0.7,
    });

    // [G3 修复] 优先从环境变量读取 API Key
    const apiKey = (llmConfig.apiKeyEnv && process.env[llmConfig.apiKeyEnv]) || llmConfig.apiKey || '';

    return new Promise((resolve) => {
      const transport = String(llmConfig.port) === '443' ? https : http;
      const req = transport.request({
        hostname: llmConfig.host,
        port: parseInt(llmConfig.port) || 443,
        path: llmConfig.path || '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'Content-Length': Buffer.byteLength(payload),
        },
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const content = data.choices?.[0]?.message?.content?.trim() ||
                            data.choices?.[0]?.message?.reasoning_content?.trim() ||
                            data.response || data.text || data.content;
            if (content) { resolve(content.trim()); return; }
            resolve(null);
          } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(15000, () => { req.destroy(); resolve(null); });
      req.write(payload); req.end();
    });
  }

  /**
   * [G1/G2 修复] 解析发送者信息，包含信任等级
   * 从 config/loader.js 的 getKnownAgents() 获取发送者的信任等级
   *
   * [安全加固 2026-08-24] URL 校验：
   *   senderName 来自消息 metadata 可被伪造，因此若消息中携带发送者 URL，
   *   必须与 knownAgents 中记录的 URL 完全匹配才授予信任等级，否则按未知处理（trustLevel=0）。
   *   注意：无签名体系下，仅提供 name 的消息无法验证身份，属已知限制，
   *   根治方案为 CSB-Security 五步握手（AAT 签名验证）。
   *
   * @param {string} senderName - 发送者名称
   * @param {object} metadata - 请求元数据
   * @returns {object} { name, trustLevel, url }
   */
  _resolveSenderInfo(senderName, metadata) {
    let trustLevel = 0;
    let url = '';

    // [TrustBridge] ① 握手信任优先（签名验证过的信任，无法伪造）
    try {
      const { trustBridge } = require('./a2a-trust-bridge.js');
      const bridge = trustBridge.resolveTrustLevel(senderName, metadata);
      if (bridge) {
        return {
          name: senderName,
          trustLevel: bridge.trustLevel,
          url,
          trustSource: bridge.source,
          sessionId: bridge.sessionId || null,
        };
      }
    } catch { /* trust-bridge 不可用时回退 */ }

    try {
      // 从 config/loader.js 获取已知 Agent 列表
      const configLoader = require('./config/loader.js');
      const knownAgents = configLoader.getKnownAgents();
      // 匹配发送者名称（getKnownAgents 已去除 emoji，这里也去除 senderName 的 emoji 以匹配）
      const cleanSenderName = (senderName || '').replace(/\s*[🌸🔧💼📜🧙🚤🦐🌿✨💧🌊🌟]\s*/g, '');
      const agent = knownAgents.find(a =>
        a.name === senderName || a.name === cleanSenderName
      );
      if (agent) {
        // [安全加固] URL 校验：消息提供了发送者 URL 时必须与已知 Agent 匹配
        const senderUrl = metadata?.sender?.url || metadata?.senderUrl || metadata?.from?.url || '';
        if (senderUrl && agent.url && senderUrl !== agent.url) {
          console.warn(`[A2A] ⚠️ 发送者 URL 不匹配，按未知处理: ${senderName} (${senderUrl} ≠ ${agent.url})`);
          trustLevel = 0;
        } else {
          trustLevel = agent.trustLevel || 0;
          url = agent.url || '';
        }
      }
    } catch {
      // config/loader.js 不可用时，默认 trustLevel = 0
    }

    return {
      name: senderName,
      trustLevel,
      url,
    };
  }

  /**
   * 从请求体提取 Agent 标识（用于按 Agent 限流）
   * 优先级: body.from > params.from > params.sender.name > body.sender.name > params.sender > 'unknown'
   */
  _extractAgentId(req) {
    const body = req.body || {};
    const params = body.params || {};
    const from = body.from || params.from;
    if (typeof from === 'string' && from) return from;
    if (from && typeof from === 'object' && from.name) return from.name;
    const sender = params.sender || body.sender;
    if (sender && typeof sender === 'object' && sender.name) return sender.name;
    if (typeof sender === 'string' && sender) return sender;
    return 'unknown';
  }


  _clientIp(req) {
    // 增强 IP 提取: x-forwarded-for > req.ip > remoteAddress
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    return req.ip || req.connection?.remoteAddress || 'unknown';
  }

  _isContentTypeSupported(mimeType) {
    const supported = ['text/plain','text/markdown','application/json','image/jpeg','image/png','audio/mpeg','audio/wav'];
    return supported.includes(mimeType);
  }

  _isVersionCompatible(version) {
    if (!version) return true;
    // 增强: Major.Minor 匹配
    const parts = version.split('.');
    const our = this.supportedVersion.split('.');
    if (parts[0] !== our[0]) return false;
    if (parts.length > 1 && our.length > 1 && parts[1] !== our[1]) return false;
    return true;
  }

  getCapabilities() {
    return {
      streaming: true,
      pushNotifications: true,
      extendedAgentCard: false,
      supportedMethods: ['SendMessage','GetTask','ListTasks','CancelTask','SendStreamingMessage'],
      supportedVersion: this.supportedVersion,
    };
  }
}

// ============================================
// 流量控制器 (A2A-019)
// ============================================
class RateLimiter {
  constructor(options = {}) {
    this.maxRequests = options.maxRequests || 60;
    this.windowMs    = options.windowMs    || 60000;
    this.buckets     = new Map();
  }

  allow(clientId) {
    const now = Date.now();
    const bucket = this.buckets.get(clientId) || { count: 0, windowStart: now };
    if (now - bucket.windowStart > this.windowMs) { bucket.count = 0; bucket.windowStart = now; }
    bucket.count++;
    this.buckets.set(clientId, bucket);
    return bucket.count <= this.maxRequests;
  }

  retryAfter(clientId) {
    const b = this.buckets.get(clientId);
    return b ? Math.max(0, this.windowMs - (Date.now() - b.windowStart)) : 0;
  }

  cleanup() {
    const now = Date.now();
    for (const [k, b] of this.buckets) {
      if (now - b.windowStart > this.windowMs * 2) this.buckets.delete(k);
    }
  }

  getStats() {
    return { totalClients: this.buckets.size, windowMs: this.windowMs, maxRequests: this.maxRequests };
  }
}

module.exports = { A2AStandardAPI, RateLimiter, A2A_ERRORS, a2aError };
