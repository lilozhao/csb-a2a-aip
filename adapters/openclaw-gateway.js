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

/** 主 agent 拒绝执行的关键词（T4 拒绝权检测） */
const REFUSAL_PATTERNS = [
  /(?:拒绝|不能执行|无法执行|不会执行|无权|不允许|不盲从|超出.*能力|无法完成|抱歉.*不能)/,
  /(?:declin|refus|can'?t execute|cannot execute|not allowed|unauthorized)/i,
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
 */
function detectRefusal(content) {
  if (!content) return false;
  return REFUSAL_PATTERNS.some((re) => re.test(content));
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

module.exports = { inject, buildPrompt, buildInjectMessage, detectRefusal, REFUSAL_PATTERNS, resolveConfig, invokeTool, fetchResult, extractReply, harvestTexts, _resetIdentityBridgeCache };

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
  _identityBridgeCache = { mainTo: '', channel: '' };
  try {
    const idPath = path.join(__dirname, '..', 'identity.json');
    const id = JSON.parse(fs.readFileSync(idPath, 'utf-8'));
    if (id && id.bridge) {
      _identityBridgeCache = {
        mainTo: String(id.bridge.mainTo || ''),
        channel: String(id.bridge.channel || ''),
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
  return { url, token, mainTo, channel };
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
  const sessionKey = opts.sessionKey || 'main';
  const limit = opts.limit || 40;

  // 主路径：sessions_history（宿主会话 → 用户回复）
  const hist = await invokeTool(cfg.url, cfg.token, {
    tool: 'sessions_history',
    args: { sessionKey, limit },
    sessionKey,
  }, opts.timeoutMs || 30000);

  if (hist.ok) {
    const texts = harvestTexts(hist.result, { userOnly: true });
    const marker = `桥接结果 #${taskId}`;
    const confirmMarker = `确认 #${taskId}`;
    const hit = texts.find((t) => t.includes(marker) || t.includes(confirmMarker)) || null;
    return {
      ok: true,
      result: {
        matched: hit !== null,
        replyText: hit,
        messages: texts.map((t) => ({ text: t })),
        raw: hist.result,
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
