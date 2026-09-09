#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════
 * A2A Bridge · OpenClaw Gateway 注入适配器（M2 最小实现 · Step 3）
 * ═══════════════════════════════════════════════════════
 *
 * Session Injector 的 OpenClaw 实现：把委托消息注入主智能体会话
 *
 * 通道原理（2026-09-09 实测验证）：
 *   OpenClaw gateway 提供 /tools/invoke HTTP 端点（Bearer token 鉴权 + agent scope）
 *   → tool: 'message', action: 'send' → 消息经飞书/webchat 通道进入主会话
 *   → 主 agent（带全工具）在主会话处理该消息 —— 与飞书通道先例（澈/鲸歌/思源）同构
 *
 * 实测：POST /tools/invoke {tool:'message', action:'channel-list'} → 飞书频道列表 ✅
 *
 * 闭环（结果回收）：
 *   委托消息带 taskId 标记 → 主 agent 执行并回复（同通道）
 *   → fetchResult() 用 message/read 读最近消息，按 taskId 标记匹配主 agent 回复
 *   → 结果交给 Task Correlator 回传发起方
 *
 * 配置（env）：
 *   A2A_GATEWAY_URL         gateway 地址，默认 http://localhost:19089（各试点本机）
 *   OPENCLAW_GATEWAY_TOKEN  gateway token（或 A2A_GATEWAY_TOKEN）
 *   A2A_BRIDGE_MAIN_TO      主会话宿主目标（飞书 ou_xxx 用户 / oc_xxx 群），必配
 *
 * 依赖: node 内置 https/http；可插拔接口 inject(frame) → result
 * 协议: A2A Bridge RFC v0.2 · M2 草案 §3.2
 * 作者: 若兰 🌸 · 2026-09-09
 * ═══════════════════════════════════════════════════════
 */

'use strict';

const http = require('http');
const https = require('https');

// ============================================
// 配置
// ============================================

function resolveConfig() {
  const url = process.env.A2A_GATEWAY_URL || 'http://localhost:19089';
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.A2A_GATEWAY_TOKEN;
  const mainTo = process.env.A2A_BRIDGE_MAIN_TO || '';
  return { url, token, mainTo };
}

// ============================================
// 内部：gateway /tools/invoke 调用
// ============================================

/**
 * 调用 gateway /tools/invoke
 * @param {string} gatewayUrl
 * @param {string} token
 * @param {object} body {tool, action?, args?, sessionKey?}
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
function invokeTool(gatewayUrl, token, body, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const u = new URL(gatewayUrl);
    const mod = u.protocol === 'https:' ? https : http;
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

// ============================================
// 委托消息组装
// ============================================

/**
 * 把委托帧组装成注入主会话的消息文本
 * 格式：桥接标记 + taskId + 委托说明（主 agent 据此识别为桥接委托而非普通消息）
 * @param {object} frame {taskId, envelope, requestId, delegatorLabel}
 * @returns {string}
 */
function buildInjectMessage(frame) {
  const env = frame.envelope || {};
  const delegator = frame.delegatorLabel || '未知发起方';
  const lines = [
    `【A2A 桥接委托 #${frame.taskId}】`,
    `- 委托方：${delegator}`,
    `- 类型：${env.type} / 范围：${env.scope}`,
    `- 委托内容：${env.target || '(空)'}`,
    `- 时限：${env.timeoutMs ? Math.round(env.timeoutMs / 60000) + ' 分钟' : '30 分钟'}`,
    ``,
    `你是被委托方主会话。请执行上述委托，回复以「桥接结果 #${frame.taskId}」开头 + 执行摘要（成功/拒绝+原因）。`,
    `拒绝权在你：无法执行请明确说「拒绝」并给原因（T4：委托不是命令）。`,
  ];
  return lines.join('\n');
}

// ============================================
// 注入主会话（Session Injector 核心）
// ============================================

/**
 * 把委托帧注入主会话
 * @param {object} frame {taskId, envelope, requestId, delegatorLabel}
 * @param {object} opts 覆盖配置 {gatewayUrl?, token?, to?}
 * @returns {Promise<{ok: boolean, result?: object, error?: string}>}
 *   result = {sent: true, messageId?, to}
 */
async function inject(frame, opts = {}) {
  const cfg = { ...resolveConfig(), ...opts };
  if (!cfg.token) return { ok: false, error: '缺少 gateway token（OPENCLAW_GATEWAY_TOKEN / A2A_GATEWAY_TOKEN）' };
  const to = cfg.to || cfg.mainTo;
  if (!to) return { ok: false, error: '缺少主会话目标（A2A_BRIDGE_MAIN_TO：飞书 ou_xxx 或 oc_xxx）' };

  const text = buildInjectMessage(frame);
  const resp = await invokeTool(cfg.url, cfg.token, {
    tool: 'message',
    action: 'send',
    args: { to, message: text },
    sessionKey: 'main',
  }, opts.timeoutMs || 30000);

  if (!resp.ok) return resp;
  return {
    ok: true,
    result: {
      sent: true,
      messageId: resp.result?.messageId || resp.result?.id || null,
      to,
      taskId: frame.taskId,
    },
  };
}

// ============================================
// 结果回收（主 agent 回复 → 按 taskId 匹配）
// ============================================

/**
 * 读取主会话通道最近消息，按「桥接结果 #taskId」标记匹配主 agent 回复
 * @param {string} taskId
 * @param {object} opts {gatewayUrl?, token?, to?, limit?}
 * @returns {Promise<{ok: boolean, result?: object, error?: string}>}
 *   result = {matched: boolean, replyText?, raw?}
 */
async function fetchResult(taskId, opts = {}) {
  const cfg = { ...resolveConfig(), ...opts };
  if (!cfg.token) return { ok: false, error: '缺少 gateway token' };
  const to = cfg.to || cfg.mainTo;

  const resp = await invokeTool(cfg.url, cfg.token, {
    tool: 'message',
    action: 'read',
    args: { target: to, limit: opts.limit || 20 },
    sessionKey: 'main',
  }, opts.timeoutMs || 30000);

  if (!resp.ok) return resp;
  const raw = resp.result;
  const text = JSON.stringify(raw);
  const marker = `桥接结果 #${taskId}`;
  const matched = text.includes(marker);
  return {
    ok: true,
    result: { matched, replyText: matched ? extractReply(raw, taskId) : null, raw },
  };
}

/**
 * 从 read 结果中提取匹配 taskId 的回复文本（尽力而为）
 */
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

// ============================================
// 导出
// ============================================

module.exports = {
  resolveConfig,
  invokeTool,
  buildInjectMessage,
  inject,
  fetchResult,
  extractReply,
};
