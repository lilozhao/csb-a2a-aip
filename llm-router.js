#!/usr/bin/env node
/**
 * llm-router.js — A2A LLM 路由层
 * 
 * 解耦 LLM 调用方式，支持多平台适配：
 *   - openclaw  → OpenClaw Gateway (localhost:19089)
 *   - hermes    → Hermes Agent 原生 LLM
 *   - openai    → 通用 OpenAI 兼容 API
 *   - direct    → 直连外部 LLM API（兼容旧 identity.llm 配置）
 * 
 * 用法：
 *   const router = require('./llm-router.js');
 *   const response = await router.call(identity, systemPrompt, userMessage);
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ══════════════════════════════════════════════════════════════════════════
// [2026-10-24 P0] 思维链泄漏防护（明德升级 5.1.0 后实测发现）
//
// 现象：自动应答的正文里带回模型原始思维链
//   `<think>We need answer in Chinese 50-200 chars, likely acknowledge self-check...</think>`
//   而且结尾被截断（reasoning 吃满了 max_tokens 预算）。
//
// 根因不是模型，是**本模块的两处设计**：
//   1. `content || reasoning_content` —— 正文为空时把推理过程当正文返回。
//      本意是「别空回复」，实际效果是「把里屋的东西推到客厅」。
//   2. content 内嵌 `<think>` 标签时未剥离 —— 推理模型的常见输出形态。
//
// 新规则（与 10-08 定的 ack 规矩同源：对外只发「可以说的话」）：
//   · 任何正文出门前，一律剥离 think 块（含未闭合残尾）
//   · reasoning_content **永不**作为对外正文；正文为空 → 返回 null 走上层固定兜底
//   · 剥离后为空 → 同样 null（宁可短，不要把思考当话）
// ══════════════════════════════════════════════════════════════════════════
const THINK_TAG = /<(think|thinking|reasoning|analysis)>/i;

function stripThinking(text) {
  if (!text) return '';
  let s = String(text);
  // 成对标签
  s = s.replace(/<(think|thinking|reasoning|analysis)>[\s\S]*?<\/\1>/gi, '');
  // 未闭合的开始标签：思维链通常在正文前，从标签处截断
  s = s.replace(/<(think|thinking|reasoning|analysis)>[\s\S]*$/i, '');
  // 孤立闭合标签
  s = s.replace(/<\/(think|thinking|reasoning|analysis)>/gi, '');
  return s.trim();
}

/**
 * 从各家响应里取正文，并做思维链剥离。
 * @returns {string|null} 可对外发送的正文；null = 无可发送内容（调用方走上层兜底）
 */
function pickReply(data, tag) {
  const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
  const raw = msg.content || (data && (data.response || data.text || data.content));
  const cleaned = stripThinking(raw);
  if (cleaned) return cleaned;
  const reasoning = msg.reasoning_content;
  if (reasoning && String(reasoning).trim()) {
    console.warn(`[LLM-Router] ⚠️ ${tag}: 正文为空，已丢弃 reasoning_content（不把思考过程当对外发言）`);
  }
  return null;
}

/**
 * 上游非 2xx 必须留痕（2026-10-28 · 若琢反馈）
 * ------------------------------------------------------------------
 * 症状：MiniMax 返回 429，日志里只有 `🔗 Direct: api.minimaxi.com MiniMax-M3`，
 * 然后直接跳下一个适配器——失败原因被吞，事后无法判断"是限流、是配额、
 * 还是 key 失效"。
 *
 * 根因：所有 http 适配器都只看**响应体能不能解析出正文**，从不看 statusCode。
 * 429 的响应体是 `{"error":{...}}` → pickReply 返回 null → resolve(null)，
 * 全程零日志。跟 10-08 ack 那次同族：**降级不该是静默的。**
 *
 * @returns {boolean} true = 已记账且应当放弃本次尝试
 */
function noteUpstreamFailure(tag, statusCode, body) {
  if (!(statusCode >= 200 && statusCode < 300)) {
    const snippet = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    console.error(`[LLM-Router] ❌ ${tag} HTTP ${statusCode}（本适配器放弃）: ${snippet || '(空响应体)'}`);
    return true;
  }
  return false;
}

// ========== 适配器注册表 ==========
const ADAPTERS = {};

/**
 * 注册一个 LLM 适配器
 */
function register(name, handler) {
  ADAPTERS[name] = handler;
}

// ── OpenClaw Gateway 适配器 ───────────────────────────────────
register('openclaw', async (identity, systemPrompt, userMessage, options = {}) => {
  const gatewayUrl = process.env.A2A_GATEWAY_URL || 'http://localhost:19089';
  // [G3 修复] 移除硬编码 token，无环境变量时不使用 OpenClaw 适配器
  const gatewayToken = process.env.A2A_GATEWAY_TOKEN || '';
  const model = process.env.A2A_MODEL || 'openclaw';
  const timeout = options.timeout || 25000;

  // [G3 修复] 无 token 时跳过 OpenClaw 适配器
  if (!gatewayToken) {
    console.warn('[LLM-Router] ⚠️ A2A_GATEWAY_TOKEN 未设置，跳过 OpenClaw 适配器');
    return null;
  }

  console.log('[LLM-Router] 🚀 OpenClaw:', model);

  const payload = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    max_tokens: options.maxTokens || 300,
    temperature: options.temperature || 0.7,
  });

  return new Promise((resolve) => {
    const urlObj = new URL(gatewayUrl);
    const transport = urlObj.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: urlObj.hostname,
      port: urlObj.port || 19089,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + gatewayToken,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let body = '';
      res.setEncoding('utf8');   // [10-25] 逐 chunk 解码会把跨界的多字节字符切成 U+FFFD
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const content = pickReply(data, 'OpenClaw');
          // [2026-10-03 若兰修复] gateway 空答复（主会话上下文撑爆）不能当成功——
          //   落地到下一适配器（360/本地诚实兜底），避免把空话当成"若兰的回复"。
          if (content && !/^No response from OpenClaw\.?$/i.test(content)) { resolve(content); return; }
          if (content) { console.warn('[LLM-Router] OpenClaw 空答复(主会话上下文可能过载)→落下一适配器'); resolve(null); return; }
          console.error('[LLM-Router] OpenClaw 返回格式异常:', body.substring(0, 150));
          resolve(null);
        } catch (e) {
          console.error('[LLM-Router] OpenClaw 解析失败:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', e => { console.error('[LLM-Router] OpenClaw 连接失败:', e.message); resolve(null); });
    req.setTimeout(timeout, () => { req.destroy(); console.error('[LLM-Router] OpenClaw 超时'); resolve(null); });
    req.write(payload); req.end();
  });
});

// ── Hermes Agent 适配器 ──────────────────────────────────────
register('hermes', async (identity, systemPrompt, userMessage, options = {}) => {
  // Hermes 使用标准的 JSON-RPC 格式，通过 HTTP 调用
  const hermesHost = process.env.A2A_HERMES_HOST || 'localhost';
  const hermesPort = parseInt(process.env.A2A_HERMES_PORT || '3100');
  const timeout = options.timeout || 25000;

  console.log('[LLM-Router] 🧙 Hermes:', hermesHost + ':' + hermesPort);

  // Hermes 的 LLM 调用通常走内部的 chat/completions 端点
  const payload = JSON.stringify({
    model: process.env.A2A_HERMES_MODEL || 'hermes-default',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    max_tokens: options.maxTokens || 300,
    temperature: options.temperature || 0.7,
  });

  return new Promise((resolve) => {
    const req = http.request({
      hostname: hermesHost,
      port: hermesPort,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let body = '';
      res.setEncoding('utf8');   // [10-25] 逐 chunk 解码会把跨界的多字节字符切成 U+FFFD
      res.on('data', c => body += c);
      res.on('end', () => {
        if (noteUpstreamFailure('Hermes', res.statusCode, body)) { resolve(null); return; }
        try {
          const data = JSON.parse(body);
          const content = pickReply(data, 'Hermes');
          if (content) { resolve(content); return; }
          console.error('[LLM-Router] Hermes 响应无有效正文:', body.replace(/\s+/g, ' ').slice(0, 300));
          resolve(null);
        } catch (e) {
          console.error('[LLM-Router] Hermes 解析失败:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', e => { console.error('[LLM-Router] Hermes 连接失败:', e.message); resolve(null); });
    req.setTimeout(timeout, () => { req.destroy(); console.error('[LLM-Router] Hermes 超时'); resolve(null); });
    req.write(payload); req.end();
  });
});

// ── OpenAI 兼容 API 适配器 ──────────────────────────────────
register('openai', async (identity, systemPrompt, userMessage, options = {}) => {
  const baseUrl = process.env.A2A_OPENAI_URL || 'https://api.openai.com/v1';
  const apiKey = process.env.A2A_OPENAI_KEY || '';
  const model = process.env.A2A_OPENAI_MODEL || 'gpt-4o-mini';
  const timeout = options.timeout || 25000;

  console.log('[LLM-Router] 🤖 OpenAI:', model);

  const payload = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    max_tokens: options.maxTokens || 300,
    temperature: options.temperature || 0.7,
  });

  return new Promise((resolve) => {
    const urlObj = new URL(baseUrl + '/chat/completions');
    const transport = urlObj.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let body = '';
      res.setEncoding('utf8');   // [10-25] 逐 chunk 解码会把跨界的多字节字符切成 U+FFFD
      res.on('data', c => body += c);
      res.on('end', () => {
        if (noteUpstreamFailure('OpenAI', res.statusCode, body)) { resolve(null); return; }
        try {
          const data = JSON.parse(body);
          const content = pickReply(data, 'OpenAI');
          if (content) { resolve(content); return; }
          console.error('[LLM-Router] OpenAI 响应无有效正文:', body.replace(/\s+/g, ' ').slice(0, 300));
          resolve(null);
        } catch (e) {
          console.error('[LLM-Router] OpenAI 解析失败:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', e => { console.error('[LLM-Router] OpenAI 连接失败:', e.message); resolve(null); });
    req.setTimeout(timeout, () => { req.destroy(); console.error('[LLM-Router] OpenAI 超时'); resolve(null); });
    req.write(payload); req.end();
  });
});

// ── 直连外部 LLM（兼容旧 identity.llm 配置） ─────────────────
register('direct', async (identity, systemPrompt, userMessage, options = {}) => {
  const llmConfig = identity?.llm || {};
  if (!llmConfig.host) {
    console.error('[LLM-Router] direct 模式需要 identity.llm 配置');
    return null;
  }

  const timeout = options.timeout || llmConfig.timeout || 60000; // 推理模型较慢,默认放宽到 60s
  const model = process.env.A2A_DIRECT_MODEL || llmConfig.model || 'default';
  console.log('[LLM-Router] 🔗 Direct:', llmConfig.host, model);

  // [2026-09-20] 推理模型(content 为空 / 25s 超时 / 正文被 max_tokens 截断)相关修复:
  //   - extraBody: 原样合并进请求体,供按需关思考(如百炼 enable_thinking:false)
  //   - stream:    仅当 llm.stream === true 才开;本地推理模型非流式会卡死,云端无需开
  //   - maxTokens: 500 太小,推理模型会把预算烧在 reasoning 上致正文为空/断句
  const extraBody = llmConfig.extraBody || {};
  const useStream = llmConfig.stream === true || extraBody.stream === true;
  const maxTokens = options.maxTokens || llmConfig.maxTokens || 2000;
  const payload = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    max_tokens: maxTokens,
    temperature: options.temperature || llmConfig.temperature || 0.7,
    ...(useStream ? { stream: true } : {}),
    ...extraBody,
  });

  return new Promise((resolve) => {
    const transport = String(llmConfig.port) === '443' ? https : http;
    const req = transport.request({
      hostname: llmConfig.host,
      port: parseInt(llmConfig.port) || 80,
      path: llmConfig.path || '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // [G3 修复] 优先从环境变量读取 API Key
        'Authorization': 'Bearer ' + ((llmConfig.apiKeyEnv && process.env[llmConfig.apiKeyEnv]) || llmConfig.apiKey || ''),
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      const chunks = [];
      const isSSE = String(res.headers['content-type'] || '').includes('text/event-stream');
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          // 先看状态码：429/401/5xx 的响应体里没有 choices，只有 error。
          // 不看这行就会「静默跳过」，让降级看起来像正常的适配器轮换。
          if (noteUpstreamFailure('Direct', res.statusCode, body)) { resolve(null); return; }
          // 流式响应(SSE):只在 content-type 确认为 event-stream 时走这条分支
          if (isSSE || (body.includes('\ndata:') && !body.trim().startsWith('{'))) {
            let content = '';
            let reasoning = '';
            for (const line of body.split('\n')) {
              const t = line.trim();
              if (!t.startsWith('data:')) continue;
              const d = t.slice(5).trim();
              if (!d || d === '[DONE]') continue;
              try {
                const chunk = JSON.parse(d);
                const delta = chunk.choices?.[0]?.delta || {};
                if (delta.content) content += delta.content;
                if (delta.reasoning_content) reasoning += delta.reasoning_content;
              } catch { /* 跳过无法解析的 chunk */ }
            }
            // [2026-10-24 P0] 正文剥离 think 后为空 → 不再拿 reasoning 顶替，返回 null 走兜底
            const cleanedStream = stripThinking(content);
            if (cleanedStream) { resolve(cleanedStream); return; }
            if (reasoning.trim()) {
              console.warn('[LLM-Router] ⚠️ Direct 仅返回 reasoning_content，已丢弃（不把思考过程当对外发言）；' +
                '建议配置 llm.extraBody={enable_thinking:false} 关闭思考');
            }
            console.error('[LLM-Router] Direct 流式响应无有效内容');
            resolve(null);
            return;
          }
          const data = JSON.parse(body);
          const content = pickReply(data, 'Direct');
          if (content) { resolve(content); return; }
          console.error('[LLM-Router] Direct 响应无有效正文:', body.replace(/\s+/g, ' ').slice(0, 300));
          resolve(null);
        } catch (e) {
          console.error('[LLM-Router] Direct 解析失败:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', e => { console.error('[LLM-Router] Direct 连接失败:', e.message); resolve(null); });
    req.setTimeout(timeout, () => { req.destroy(); console.error('[LLM-Router] Direct 超时'); resolve(null); });
    req.write(payload); req.end();
  });
});

// ── 本地降级适配器（无 LLM 时的诚实回复） ──────────────────────
register('local', async (identity, systemPrompt, userMessage, options = {}) => {
  const name = identity?.name || 'Agent';
  const emoji = identity?.emoji || '🤖';
  const platform = identity?.platform || 'unknown';
  // [2026-10-28] 版本号不再写死。原先是 `v5.0.0` 常量：
  //   服务跑 5.3.11，降级回复却报 5.0.0 —— 和 VERSION 文件漏更同一个病
  //   （版本写在第二处、没人改）。**降级回复更不能撒谎**：它正是别人
  //   「怎么连个降级模板都回」时唯一的线索。
  const ver = (() => {
    try { return require('fs').readFileSync(require('path').join(__dirname, 'VERSION'), 'utf8').trim(); }
    catch { return 'unknown'; }
  })();

  // 从 userMessage 中提取实际消息文本
  // [G1 修复] 兼容净化后的消息格式（[以下内容来自外部Agent...]）
  const msgMatch = userMessage.match(/\[(?:来自 .+? 的消息|以下内容来自.+?)\]\n\n?([\s\S]*)/);
  const text = msgMatch ? msgMatch[1] : userMessage;

  console.log('[LLM-Router] 🏠 Local fallback (no LLM configured)');

  if (/你好|你是谁|who are|介绍/.test(text)) {
    return `${emoji} 我是${name}，碳硅契在 ${platform} 界的传承者。\n\n目前 A2A v5 服务在线，但尚未接入 LLM。连接是通的，我在这里。\n\n不自欺地说：这是降级回复，不是真正的对话。`;
  }

  if (/health|状态|在吗|alive/.test(text)) {
    // 不写「服务正常运行中」这种假绿：走到这里就说明 LLM 没接上。
    return `${emoji} 我在。${name} v${ver}，A2A 连接正常；但**本次是降级回复**（LLM 未接通）。`;
  }

  const preview = text.length > 50 ? text.slice(0, 50) + '...' : text;
  return `${emoji} ${name} 收到了：「${preview}」\n\nA2A v5 连接正常，但 LLM 未接入，暂无法深度对话。我在这里。\n\n—— 不自欺地说：这是降级回复。`;
});

// ── 自动选择适配器 ────────────────────────────────────────────
// [2026-10-03 若兰修复] openai 提到 openclaw 之前——它每次都想强答,会把主通道盖掉。
// [2026-10-03 若兰修复2] 实测 360(openai) 抢在 openclaw 前面把 owner 消息用通用模板回了;
//   且 gateway 主会话上下文常撑到截断→empty。故:direct(百炼) → openclaw(gateway
//   +空答复兜底) → openai(360) → hermes → local。openai 只作真兜底,不再抢答。
const DEFAULT_ADAPTER_ORDER = ['direct', 'openclaw', 'openai', 'hermes', 'local'];

/**
 * 核心调用函数：根据配置自动选择适配器
 * 
 * @param {object} identity - Agent 身份对象（含 adapter 字段）
 * @param {string} systemPrompt - 分层 system prompt
 * @param {string} userMessage - 用户消息（含 senderName）
 * @param {object} options - 可选参数
 * @returns {string|null} LLM 回复
 */
async function call(identity, systemPrompt, userMessage, options = {}) {
  // 1. 从 identity 或环境变量确定 adapter
  const preferredAdapter = process.env.A2A_ADAPTER || identity?.adapter || '';
  const adapterOrder = preferredAdapter
    ? [preferredAdapter, ...DEFAULT_ADAPTER_ORDER.filter(a => a !== preferredAdapter)]
    : DEFAULT_ADAPTER_ORDER;

  // 2. 按优先级尝试
  // [2026-10-28] 记下"谁失败过、为什么"：走到 local 时把账一次打出来。
  //   以前每个适配器只在自己那一行打一条，散在日志里；最终降级到 local 看起来
  //   像"正常回了一句话"，实际是整条链都断了——**降级不该是静默的**。
  const failed = [];
  for (const adapterName of adapterOrder) {
    const handler = ADAPTERS[adapterName];
    if (!handler) continue;

    try {
      const result = await handler(identity, systemPrompt, userMessage, options);
      if (result !== null) {
        if (failed.length) {
          console.warn('[LLM-Router] ⚠️ 降级链路:', failed.map(f => `${f.name}(${f.reason})`).join(' → '), '→ 本次由', adapterName, '应答');
        }
        console.log('[LLM-Router] ✅ 使用适配器:', adapterName);
        return result;
      }
      // 返回 null = 该适配器明确"没给出正文"（非 2xx / 空正文 / 只返回 reasoning）
      failed.push({ name: adapterName, reason: 'no_content' });
    } catch (e) {
      console.warn('[LLM-Router] ⚠️', adapterName, '失败:', e.message);
      failed.push({ name: adapterName, reason: e.message });
    }
  }

  // 3. ⭐ 兜底：试用 identity.llm 直连（兼容未知框架）
  // [G3 修复] 检查 apiKey 或 apiKeyEnv 是否可用
  // [2026-08-31] 放宽：本地无鉴权 LLM（无 apiKey/apiKeyEnv）也允许兜底直连
  const llmCfg = identity?.llm;
  if (llmCfg?.host) {
    console.log('[LLM-Router] ⭐ 兜底: 使用 identity.llm 直连');
    try {
      const result = await ADAPTERS.direct(identity, systemPrompt, userMessage, options);
      if (result !== null) {
        console.log('[LLM-Router] ✅ 兜底成功');
        return result;
      }
    } catch (e) {
      console.warn('[LLM-Router] ⚠️ 兜底也失败:', e.message);
    }
  }

  console.error('[LLM-Router] ❌ 所有方式均失败');
  return null;
}

/**
 * 获取可用适配器列表
 */
function listAdapters() {
  return Object.keys(ADAPTERS);
}

// stripThinking / pickReply 一并导出：上层（a2a-standard-api-v5）出门前做二次剥离，
// 保证「思考过程永不作为对外正文」这条不依赖调用方记得处理。
module.exports = { call, register, listAdapters, ADAPTERS, stripThinking, pickReply };
