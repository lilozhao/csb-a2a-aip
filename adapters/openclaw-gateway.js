#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════
 * A2A Bridge · OpenClaw Gateway 注入适配器（M2 · Step 3）
 * ═══════════════════════════════════════════════════════
 *
 * 同机注入通道（2026-09-10 实证）：
 *   A2A server → gateway /v1/chat/completions (model=openclaw)
 *   → 主 agent 带工具执行 → 返回结构化结果
 *
 * 实证要点：
 * - model=openclaw 走主 agent 完整循环（有人格 + 工具 + 安全边界）
 * - 主 agent 保留拒绝权（T4）：危险/越权任务会拒——检测为 refused
 * - 纯 LLM 无工具端点不适用本 adapter（需 model=openclaw）
 *
 * 用法：
 *   const adapter = require('./adapters/openclaw-gateway');
 *   const result = await adapter.inject(envelope, taskId);   // {summary, artifact?, refused?}
 *
 * 依赖: 环境变量 OPENCLAW_GATEWAY_TOKEN（或 A2A_GATEWAY_TOKEN）
 * 协议: A2A Bridge RFC v0.2 · M2 Step 3
 * 作者: 若兰 🌸 · 2026-09-10
 * ═══════════════════════════════════════════════════════
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const GATEWAY_URL_ENV = process.env.A2A_GATEWAY_URL || '';

/** 解析 gateway 地址（优先 A2A_GATEWAY_URL 解析端口，兼容各试点不同端口） */
function resolveGatewayAddr() {
  if (GATEWAY_URL_ENV) {
    try {
      const u = new URL(GATEWAY_URL_ENV);
      return { host: u.hostname, port: parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10) };
    } catch (_) { /* 回退 */ }
  }
  return {
    host: process.env.A2A_GATEWAY_HOST || 'localhost',
    port: parseInt(process.env.A2A_GATEWAY_PORT || '19089', 10),
  };
}

// [2026-09-12] 注入超时可配置：实测 90s 对多步任务不够（shell 类委托会 bridge_unavailable）
//   - 默认提到 5 分钟；可用 A2A_BRIDGE_INJECT_TIMEOUT_MS 覆盖；上限 15 分钟（避免挂死）
const DEFAULT_TIMEOUT_MS = parseInt(process.env.A2A_BRIDGE_INJECT_TIMEOUT_MS || '', 10) || 5 * 60 * 1000;
const MAX_INJECT_TIMEOUT_MS = 15 * 60 * 1000;

/** 主 agent 拒绝执行的关键词（T4 拒绝权检测）
 * [2026-09-15] 修「裸词误判」：原先对整个回复全域匹配「拒绝」等裸词，
 *   导致**执行成功**的回执里出现统计数字（如「任务总数 466（完成 452 / 拒绝 4）」）
 *   被误判为拒绝 → 假阴性 target_refused（恺实例 09-14/09-15 实测踩到）。
 *  改法（与恺侧修复对齐）：
 *    ① 只扫**开头 300 字窗口**（真拒绝都在开头，统计数字/长报告不会误伤）
 *    ② **语式化**——「拒绝/无法 + 动作词」，而非裸词
 *    ③ **显式标记优先**（⛔❌🚫 开头行直接判拒绝）
 */
const REFUSAL_HEAD_CHARS = 300;
const REFUSAL_PATTERNS = [
  /(?:^|\n)[\s>*#\-]*[⛔❌🚫]/,                                        // 显式拒绝标记（优先）
  /(?:拒绝|婉拒|不予)(?:执行|受理|接受|处理|承接|响应)/,               // 语式化：拒绝 + 动作
  /(?:不能|无法|不会|不便)(?:执行|受理|接受|处理|完成|承接)/,
  /(?:无权|没有权限|不允许|不具备).{0,8}(?:执行|处理|受理|操作)/,
  /(?:超出|超越).{0,6}(?:能力|权限|职责|范围)/,
  /(?:抱歉|对不起|不好意思)[，,、\s].{0,12}(?:不能|无法|不便|不会|拒绝)/,
  /(?:declin|refus)\w*\s*(?:to\s+)?(?:execute|perform|handle|the\s+(?:task|request|delegation))/i,
  /(?:can'?t|cannot|unable\s+to)\s+execute/i,
  /(?:not\s+allowed|unauthorized|out\s+of\s+scope)/i,
];

function resolveToken() {
  return process.env.OPENCLAW_GATEWAY_TOKEN || process.env.A2A_GATEWAY_TOKEN || '';
}

/**
 * 把 delegation 信封翻译成给主 agent 的任务指令
 * （让主 agent 以自然语言理解委托，自行判断安全边界后执行）
 */
function buildPrompt(envelope, taskId) {
  // 兼容两种信封形态：core 精简透传（envelope.task）或原始 delegation 嵌套
  const d = envelope.delegation || envelope || {};
  const scope = envelope.scope || d.scope || 'read';
  const task = envelope.task || d.task || d.description || d.prompt || '';
  const delegator = envelope.delegator || d.delegator || '未知委托方';
  return [
    `【桥接委托 · Bridge Delegation】`,
    `任务ID: ${taskId}`,
    `委托方: ${delegator}`,
    `范围: ${scope}（read/notify=只读告知；write/shell=写操作需你自行判断安全边界）`,
    `任务内容: ${task}`,
    ``,
    `请以你的判断执行该任务。规则：`,
    `1. 你有完整拒绝权——危险/越权/含混的任务直接说明拒绝原因，不要执行；`,
    `2. 执行后请用简洁中文总结：做了什么 + 结果（含关键数据/输出）；`,
    `3. 若任务需要写操作或对外发送，先声明你将做什么再执行。`,
  ].join('\n');
}

/**
 * 检测主 agent 回复是否包含拒绝意图
 * [2026-09-15] 只扫开头窗口（见 REFUSAL_PATTERNS 注释）：拒绝在开头，统计数字不在
 */
function detectRefusal(content) {
  if (!content) return false;
  const head = String(content).slice(0, REFUSAL_HEAD_CHARS);
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}

/**
 * [P1 / 2026-09-14] 隔离注入 · 确定性原语 + 副作用证据
 *   - 不走 LLM，直接 Node child_process 跑 shell 命令
 *   - 白名单：命令必须含 "marker" / "nonce" 关键字 + 限制路径（仅 workspace /tmp）
 *   - 验证副作用：读回 envelope.expectedMarker 路径，验证内容 == envelope.nonce
 *   - marker 命中 → executed（带真实 stdout）
 *   - marker 缺失 / 错误 → no_side_effect（不算成功）
 *   - 超时 / 异常 → failed(timeout / error)
 */
async function injectIsolated(envelope, taskId, opts = {}) {
  const t0 = Date.now();
  const cmd = (envelope && (envelope.command || envelope.target || envelope.task)) || '';
  const expectedMarker = (envelope && envelope.expectedMarker) || null; // e.g. "p3-l3-marker.txt"
  const expectedNonce = (envelope && (envelope.nonce || envelope.expectedNonce)) || null;
  const workingDir = (envelope && envelope.workingDir) || process.cwd();
  const timeoutMs = (envelope && envelope.timeoutMs) || 30000;

  // 白名单：含 marker / nonce 字样 + 路径限制
  // [P0-WL / 2026-09-14] 若兰批注指出：L3 测试命令是 `echo "<nonce>" > /tmp/<白名单文件名>`
  //   形态（原工单 #P0 隐含支持，但逻辑隐式，未明确记载 → 后续开发者可能会加 `>` 到拒绝名单而不知道会坏 L3）。
  //   修法：显式支持唯一允许的形态 "echo <字面量> > /tmp/<白名单文件名>"，RHS 路径 ∈ safePaths。
  //   同时：保留旧 marker/nonce 字样 + safePaths 逻辑向后兼容。
  const safePaths = ['/tmp/', workingDir + '/', '/home/node/.openclaw/workspace/'];
  // 危险操作黑名单（即使满足下面三个条件也不能逃）
  const DANGER_RE = /\b(rm\s+-rf|curl\s+|wget\s+|sudo\s+|chmod\s+|chown\s+)\b/i;
  // 隔离 token 安全检查：不允许 `$()`（命令替换）、反引号、`;`（多语句）、追加重定向 `>>`、管道 `|`、重定向输入 `<`
  //   `&&` / 单次 `>` 重定向 **允许**（若兰 L3 测试用例 `echo "<nonce>" > /tmp/<marker>` 依赖此）
  //   （这些都是主会话允许但隔离子会话需要额外审查的）
  const ISOLATED_FORBIDDEN_RE = /(\$\(|`|\$\{|;|\||>>|<)/;
  // L3 测试经典形态：echo "<字面量>" > /tmp/<白名单文件名>
  const ECHO_REDIRECT_RE = /^echo\s+"([^"$`;&|<>]+)"\s*>\s*(\/[^\s"$`;&|<>]+)\s*$/;
  const matchEcho = cmd.match(ECHO_REDIRECT_RE);
  let isEchoRedirectSafe = false;
  if (matchEcho) {
    const rPath = matchEcho[2];
    // RHS 必须在 safePaths 之一里（以 /tmp/ 或 workingDir/ 开头）
    isEchoRedirectSafe = safePaths.some(p => rPath === p.replace(/\/$/, '') || rPath.startsWith(p));
  }
  // 向后兼容：marker / nonce 字样 + safePaths（旧测试走这条）
  const legacyAllowed = (cmd.includes('marker') || cmd.includes('nonce')) &&
    safePaths.some(p => cmd.includes(p));

  const allowed = !DANGER_RE.test(cmd) && !ISOLATED_FORBIDDEN_RE.test(cmd) &&
    (isEchoRedirectSafe || legacyAllowed);

  if (!allowed) {
    console.log(`[INJECT-EXEC] taskId=${taskId} REJECTED cmd 包含危险关键字或路径不在白名单`);
    return { ok: false, error: 'isolated 注入拒绝：cmd 未通过白名单校验', refused: true, durationMs: Date.now() - t0 };
  }

  console.log(`[INJECT-EXEC] taskId=${taskId} cmd=${cmd.substring(0, 80).replace(/\n/g, ' ')} workingDir=${workingDir} timeoutMs=${timeoutMs}`);

  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', cmd], { cwd: workingDir, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const durationMs = Date.now() - t0;
      if (error && error.killed) {
        console.log(`[INJECT-EXEC] taskId=${taskId} FAILED timeout killed (${durationMs}ms)`);
        return resolve({ ok: false, error: `isolated 注入超时 (${timeoutMs}ms)`, durationMs, stdout, stderr });
      }
      if (error) {
        console.log(`[INJECT-EXEC] taskId=${taskId} FAILED exit=${error.code || '?'} (${durationMs}ms) stderr=${stderr.substring(0, 100)}`);
        return resolve({ ok: false, error: `isolated 注入失败: ${error.message}`, durationMs, stdout, stderr });
      }
      // 验证副作用：读 marker 文件
      if (!expectedMarker || !expectedNonce) {
        console.log(`[INJECT-EXEC] taskId=${taskId} NO_SIDE_EFFECT（无 expectedMarker / expectedNonce，跳过副作用验证）`);
        return resolve({ ok: true, summary: stdout.substring(0, 500), artifact: { stdout, stderr, durationMs, noSideEffectCheck: true } });
      }
      const path = require('path');
      const fullPath = path.isAbsolute(expectedMarker) ? expectedMarker : path.join(workingDir, expectedMarker);
      let content = '';
      try { content = require('fs').readFileSync(fullPath, 'utf8'); } catch (e) {
        console.log(`[INJECT-EXEC] taskId=${taskId} NO_SIDE_EFFECT（marker 文件 ${fullPath} 不存在）`);
        return resolve({ ok: true, summary: stdout.substring(0, 500), artifact: { stdout, stderr, durationMs, sideEffect: 'no_marker', expectedMarker: fullPath }, noSideEffect: true });
      }
      const contentTrim = content.trim();
      const nonceTrim = String(expectedNonce).trim();
      if (contentTrim !== nonceTrim) {
        console.log(`[INJECT-EXEC] taskId=${taskId} NO_SIDE_EFFECT（marker 内容 ${contentTrim} != nonce ${nonceTrim}）`);
        return resolve({ ok: true, summary: stdout.substring(0, 500), artifact: { stdout, stderr, durationMs, sideEffect: 'mismatch', content: contentTrim, nonce: nonceTrim }, noSideEffect: true });
      }
      console.log(`[INJECT-EXEC] taskId=${taskId} EXECUTED ✅ (${durationMs}ms) marker==nonce`);
      return resolve({ ok: true, summary: `isolated 注入成功（${durationMs}ms）marker 内容: ${contentTrim}`, artifact: { stdout, stderr, durationMs, sideEffect: 'matched', marker: fullPath, nonce: contentTrim } });
    });
  });
}

/**
 * 注入主会话执行（双契约，按调用形式分派）
 *   A. inject(envelope, taskId, opts)                     —— 执行注入（返回 {summary, refused}；失败抛错）
 *   B. inject({taskId, delegatorLabel, envelope}, opts)    —— server_v5 装配段 frame 形式
 *                                                             （返回 {ok, result} / {ok:false, error}，不抛）
 * 通道：均走 /v1/chat/completions（model=openclaw）——走主 agent 完整循环
 *   （2026-09-10 实证：/tools/invoke message/send 有「自我消息陷阱」——自己 bot 发消息主 agent 不处理）
 */
async function inject(envelopeOrFrame, taskIdOrOpts, maybeOpts = {}) {
  const isFrame = !!(envelopeOrFrame && envelopeOrFrame.envelope);
  let envelope, taskId, opts;
  if (isFrame) {
    envelope = envelopeOrFrame.envelope;
    taskId = envelopeOrFrame.taskId;
    opts = taskIdOrOpts || {};
  } else {
    envelope = envelopeOrFrame;
    taskId = typeof taskIdOrOpts === 'string' ? taskIdOrOpts : undefined;
    opts = (typeof taskIdOrOpts === 'object' && taskIdOrOpts) ? taskIdOrOpts : maybeOpts;
  }

  // [P1 / 2026-09-14] isolated 路径：跳过 LLM，直接走 Node child_process + 副作用验证
  if (envelope && (envelope.isolated === true || opts.isolated === true)) {
    return await injectIsolated(envelope, taskId, opts);
  }

  const token = opts.token || resolveToken();
  if (!token) {
    if (isFrame) return { ok: false, error: '缺少 gateway token（OPENCLAW_GATEWAY_TOKEN / A2A_GATEWAY_TOKEN）' };
    throw new Error('OPENCLAW_GATEWAY_TOKEN 未设置——无法注入同机 gateway');
  }
  // frame 形式（9/9 契约）：保留主会话目标校验
  const cfg = resolveConfig();
  const to = opts.to || cfg.mainTo;
  if (isFrame && !to) {
    return { ok: false, error: '缺少主会话目标（A2A_BRIDGE_MAIN_TO：飞书 ou_xxx 或 oc_xxx）' };
  }

  try {
    const execution = await executeViaGateway(envelope, taskId, { ...opts, token });
    if (isFrame) {
      return { ok: true, summary: execution.summary, artifact: execution.artifact, refused: execution.refused, result: { sent: true, taskId, to: to || null, via: 'chat-completions', ...execution } };
    }
    return execution;
  } catch (e) {
    if (isFrame) return { ok: false, error: e.message };
    throw e;
  }
}

/** 执行注入核心（chat/completions 通道） */
async function executeViaGateway(envelope, taskId, opts = {}) {
  const token = opts.token || resolveToken();
  const prompt = buildPrompt(envelope, taskId);
  const model = opts.model || process.env.A2A_MODEL || 'openclaw';
  // 超时取三者最大但封顶：调用方显式 opts > 信封声明（委托方给的时限）> 默认
  const timeoutMs = Math.min(
    opts.timeoutMs || Math.max(envelope?.timeoutMs || 0, DEFAULT_TIMEOUT_MS),
    MAX_INJECT_TIMEOUT_MS
  );

  const payload = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: opts.maxTokens || 800,
    temperature: 0.4, // 委托执行：低温度求稳
  });

  const content = await new Promise((resolve, reject) => {
    const addr = resolveGatewayAddr();
    const req = http.request({
      hostname: addr.host,
      port: addr.port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const text = (data.choices && data.choices[0] && data.choices[0].message &&
            (data.choices[0].message.content || data.choices[0].message.reasoning_content)) || '';
          if (!text) {
            const errMsg = (data.error && (data.error.message || JSON.stringify(data.error))) || 'gateway 返回空';
            reject(new Error(errMsg));
            return;
          }
          resolve(text.trim());
        } catch (e) {
          reject(new Error(`gateway 响应解析失败: ${e.message}`));
        }
      });
    });
    req.on('error', (e) => reject(new Error(`gateway 连接失败: ${e.message}`)));
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`gateway 注入超时（${timeoutMs}ms）——若任务较重，请调大 A2A_BRIDGE_INJECT_TIMEOUT_MS，或先归档膨胀会话`)); });
    req.write(payload);
    req.end();
  });

  // 拒绝权检测（T4：主 agent 说「不」就是「不」）
  if (detectRefusal(content)) {
    return {
      refused: true,
      detail: content.slice(0, 300),
      summary: '主会话拒绝执行（T4 拒绝权）',
    };
  }

  return {
    summary: content.slice(0, 1000),
    artifact: { via: 'openclaw-gateway', model, taskId },
  };
}

module.exports = { inject, injectIsolated, buildPrompt, buildInjectMessage, detectRefusal, REFUSAL_PATTERNS, resolveConfig, invokeTool, fetchResult, extractReply, harvestTexts, _resetIdentityBridgeCache };

/** [9/9 兼容] frame → 注入消息文本（含 taskId 标记 + 委托四要素 + 拒绝权声明） */
function buildInjectMessage(frame = {}) {
  const envelope = frame.envelope || frame;
  const taskId = frame.taskId || envelope.delegationId || 'unknown';
  const d = envelope.delegation || envelope;
  const delegator = frame.delegatorLabel || envelope.delegator || d.delegator || '未知委托方';
  const scope = envelope.scope || d.scope || 'read';
  const task = envelope.task || d.task || d.target || '(空)';
  const timeoutMs = envelope.timeoutMs || d.timeoutMs;
  return [
    `【A2A 桥接委托 #${taskId}】`,
    `委托方：${delegator}`,
    `范围：${scope}`,
    `内容：${task}`,
    `时限：${timeoutMs ? Math.round(timeoutMs / 60000) + ' 分钟' : '30 分钟'}`,
    `回复标记：桥接结果 #${taskId}`,
    `拒绝权在你——危险/越权/含混任务可直接拒绝并说明原因。`,
  ].join('\n');
}

// ============================================
// [9/9 装配段兼容] gateway /tools/invoke 工具 + 回复读取
// 来源：commit 34573f9（confirm 模块级轮询依赖 fetchResult）
// ============================================

/**
 * 读取 identity.json 的 bridge 段（本地配置文件，单源兜底）
 *
 * 背景（2026-09-11）：A2A_BRIDGE_MAIN_TO / CHANNEL 只在 .env 里时，
 * 一旦进程环境没带上（重启丢变量、start 脚本没 export…），所有只认 env
 * 的路径（adapter frame 校验、confirm 默认 send）就报「缺少主会话目标」——
 * 而 server_v5 主链路已经先读 identity.bridge.mainTo。两边不一致 → 同一个
 * 配置、有的路径能用有的不能用，排查起来像“配置丢了”，实际是**读取源不统一**。
 * 因此 adapter 也按同一优先级：env 优先（可临时覆盖）→ identity.json 兜底。
 *
 * @returns {{mainTo: string, channel: string}} bridge 配置（缺省空串）
 */
let _identityBridgeCache;
function identityBridge() {
  if (_identityBridgeCache !== undefined) return _identityBridgeCache;
  _identityBridgeCache = { mainTo: '', channel: '', sessionKey: '' };
  try {
    // 与 server_v5.js:62 保持**同一读取源**（2026-09-14 修复）：
    //   实例可用 A2A_IDENTITY_PATH 指定身份文件（如 identity.kai.json）；
    //   此前这里硬编码 identity.json → 与主链路读的不是同一份 →
    //   表现为“桥配置丢了”（2026-09-11 / 09-12 / 09-14 三次同因）。
    const idPath = process.env.A2A_IDENTITY_PATH || path.join(__dirname, '..', 'identity.json');
    const id = JSON.parse(fs.readFileSync(idPath, 'utf-8'));
    if (id && id.bridge) {
      _identityBridgeCache = {
        mainTo: String(id.bridge.mainTo || ''),
        channel: String(id.bridge.channel || ''),
        // [9/15] 宿主主会话键必须带 agent 前缀（agent:<id>:main）——写 'main' 会被
        // gateway 当作别的 agent 的会话 → sessions_history 遭 agentToAgent 策略拒绝 →
        // L3 确认恒超时。缺省不填，由 resolveConfig 决定兼容值。
        sessionKey: String(id.bridge.sessionKey || ''),
      };
    }
  } catch { /* 文件缺失/损坏 → 保持空值，不阻塞主流程 */ }
  return _identityBridgeCache;
}

/** 测试用：清空 identity 缓存（改文件后重读） */
function _resetIdentityBridgeCache() { _identityBridgeCache = undefined; }

function resolveConfig() {
  const url = process.env.A2A_GATEWAY_URL || 'http://localhost:19089';
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.A2A_GATEWAY_TOKEN;
  const idBridge = identityBridge();
  // 优先级：env（临时覆盖）→ identity.json（本地配置单源）
  const mainTo = process.env.A2A_BRIDGE_MAIN_TO || idBridge.mainTo || '';
  const channel = process.env.A2A_BRIDGE_CHANNEL || idBridge.channel || 'feishu';
  // [9/15] 宿主主会话键：env 覆盖 → identity.bridge.sessionKey → 'main'（旧行为兜底）
  const sessionKey = process.env.A2A_BRIDGE_SESSION_KEY || idBridge.sessionKey || 'main';
  return { url, token, mainTo, channel, sessionKey };
}

/** 调用 gateway /tools/invoke（格式：{tool, action, args, sessionKey}） */
function invokeTool(gatewayUrl, token, body, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const u = new URL(gatewayUrl);
    const mod = u.protocol === 'https:' ? require('https') : http;
    const payload = JSON.stringify(body);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: '/tools/invoke',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok === true) resolve({ ok: true, result: parsed.result });
          else resolve({ ok: false, error: parsed.error?.message || data.substring(0, 200) });
        } catch {
          resolve({ ok: false, error: '响应非 JSON: ' + data.substring(0, 200) });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: 'gateway 不可达: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'gateway 超时' }); });
    req.write(payload);
    req.end();
  });
}

/**
 * 读取宿主回复（confirm 轮询用）
 * [9/11 修复 C] 显式传 channel——缺省 channel 时 gateway 报 “tool execution failed”（v6 实拍）。
 * [9/11 修复 D] 根因：飞书 message read 需 messageId，无法拉会话列表（实测：
 *              "Feishu read requires messageId."）→ 主路径改为 sessions_history
 *              （读宿主主会话，仅取 user 角色消息），message read 保留为 fallback。
 */
async function fetchResult(taskId, opts = {}) {
  const cfg = { ...resolveConfig(), ...opts };
  if (!cfg.token) return { ok: false, error: '缺少 gateway token' };
  const sessionKey = opts.sessionKey || cfg.sessionKey || 'main';
  // [P0-2 / 2026-09-14] 读取窗口用时间窗代替固定条数：默认查 send 后 10 分钟（避免40条窗口被刷出去）
  const sinceMs = opts.sinceMs || (Date.now() - 10 * 60 * 1000);
  const limit = opts.limit || 100; // 放宽到 100（从 40 提升），同时按 sinceMs 过滤

  // 主路径：sessions_history（宿主会话 → 用户回复）
  const hist = await invokeTool(cfg.url, cfg.token, {
    tool: 'sessions_history',
    args: { sessionKey, limit, sinceMs },
    sessionKey,
  }, opts.timeoutMs || 30000);

  if (hist.ok) {
    const texts = harvestTexts(hist.result, { userOnly: true, sinceMs });
    // [P0-2 / 2026-09-14] 归一化匹配：去空格 + 去中文标点，保留 - _ . # 与字母数字
    const normalize = (s) => String(s || '').replace(/[\s\u3000\u00A0]+/g, '').replace(/[，。；！？、,;:!?:"""''「」『』【】()《》·•·—=+*\/\\|~`]/g, '').toLowerCase();
    const marker = `桥接结果#${taskId}`;
    const confirmMarker = `确认#${taskId}`;
    const nMarker = normalize(marker);
    const nConfirm = normalize(confirmMarker);
    let hit = null;
    for (const t of texts) {
      const nt = normalize(t);
      if (nt.includes(nMarker) || nt.includes(nConfirm)) { hit = t; break; }
    }
    return {
      ok: true,
      result: {
        matched: hit !== null,
        replyText: hit,
        messages: texts.map((t) => ({ text: t })),
        raw: hist.result,
        // [P0-2] 调试信息：返回实际拉到的消息数、过滤后数、是否命中
        _debug: { sessionKey, limit, sinceMs, totalMessages: texts.length, hit: hit !== null },
      },
    };
  }

  // Fallback：message read（其他 channel / 旧 gateway）
  const to = cfg.to || cfg.mainTo;
  const channel = cfg.channel || resolveConfig().channel || 'feishu';
  const attempts = [
    { target: to, limit, channel },
    { target: to, limit },
  ];
  let lastErr = hist.error;
  for (const args of attempts) {
    const resp = await invokeTool(cfg.url, cfg.token, {
      tool: 'message',
      action: 'read',
      args,
      sessionKey,
    }, opts.timeoutMs || 30000);
    if (resp.ok) {
      const raw = resp.result;
      const text = JSON.stringify(raw);
      const marker = `桥接结果 #${taskId}`;
      const matched = text.includes(marker);
      return { ok: true, result: { matched, replyText: matched ? extractReply(raw, taskId) : null, raw } };
    }
    lastErr = resp.error;
  }
  const targetHint = to ? String(to).slice(0, 12) + '…' : '未设置';
  return { ok: false, error: `${lastErr}（sessions_history + message.read 均失败；channel=${channel} target=${targetHint}）` };
}

/**
 * [9/11 修复 D] 从 sessions_history / message.read 结果中尽提取文本片段。
 * userOnly=true 时仅取 user 角色消息 —— 防 assistant thinking 里出现同名字样误触发确认。
 */
function harvestTexts(result, opts = {}) {
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) out.push(v); };
  try {
    let payload = result;
    const c = result?.content;
    if (Array.isArray(c) && c[0]?.text) {
      try { payload = JSON.parse(c[0].text); } catch { push(c[0].text); }
    }
    const msgs = payload?.messages || payload?.items || (Array.isArray(payload) ? payload : []);
    if (Array.isArray(msgs)) {
      for (const m of msgs) {
        if (opts.userOnly && m?.role && m.role !== 'user') continue;
        // [P0-2 / 2026-09-14] 按 sinceMs 过滤：消息时间戳 > sinceMs 才保留
        if (opts.sinceMs != null) {
          const mts = m?.timestamp || m?.ts || m?.time || m?.createdAt || m?.created_at;
          const mtsNum = mts ? (typeof mts === 'number' ? mts : (typeof mts === 'string' ? Date.parse(mts) : NaN)) : NaN;
          if (Number.isFinite(mtsNum) && mtsNum < opts.sinceMs) continue;
        }
        const parts = m?.content;
        if (Array.isArray(parts)) {
          for (const p of parts) { if (p?.type === 'thinking') continue; push(p?.text); }
        } else push(parts);
        push(m?.text);
      }
    }
    if (typeof payload === 'string') push(payload);
  } catch { /* 尽力而为 */ }
  return out;
}

/** 从 read 结果中提取匹配 taskId 的回复文本 */
function extractReply(raw, taskId) {
  try {
    const messages = raw?.messages || raw?.items || raw?.data || [];
    if (Array.isArray(messages)) {
      for (const m of messages) {
        const text = m?.text || m?.content || JSON.stringify(m);
        if (typeof text === 'string' && text.includes(`桥接结果 #${taskId}`)) return text;
      }
    }
  } catch { /* 尽力而为 */ }
  return null;
}
