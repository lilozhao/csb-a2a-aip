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

const GATEWAY_HOST = process.env.A2A_GATEWAY_HOST || 'localhost';
const GATEWAY_PORT = parseInt(process.env.A2A_GATEWAY_PORT || '19089', 10);
const DEFAULT_TIMEOUT_MS = 90 * 1000; // 主 agent 工具执行可能较久

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
 * 注入主会话执行
 * @param {object} envelope 已通过 core 校验的信封
 * @param {string} taskId
 * @returns {Promise<{summary:string, artifact?:any, refused?:boolean, detail?:string}>}
 */
async function inject(envelope, taskId, opts = {}) {
  const token = opts.token || resolveToken();
  if (!token) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN 未设置——无法注入同机 gateway');
  }
  const prompt = buildPrompt(envelope, taskId);
  const model = opts.model || process.env.A2A_MODEL || 'openclaw';
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const payload = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: opts.maxTokens || 800,
    temperature: 0.4, // 委托执行：低温度求稳
  });

  const content = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: GATEWAY_HOST,
      port: GATEWAY_PORT,
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
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`gateway 注入超时（${timeoutMs}ms）`)); });
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

module.exports = { inject, buildPrompt, detectRefusal, REFUSAL_PATTERNS };
