'use strict';
/**
 * a2a-chat-notify.js —— Layer 2：非委托入站消息 → 主会话实时通知（2026-09-13 建立）
 *
 * 定位：与 Layer 1（a2a-inbox.js，纯留痕）配套。Layer 1 保证「可查」，本模块保证「实时可见」。
 *
 * ⚠️ 默认关：需显式 env `A2A_NOTIFY_CHAT=true` 才启用。
 *    原因：每条入站消息注入主会话 = 一次主 agent 循环（有成本、可能被"消息风暴/agent 互唤醒"放大）。
 *
 * 护栏（全部内建，不可绕过）：
 *   1. 开关（env A2A_NOTIFY_CHAT=true）
 *   2. 主会话目标（identity.bridge.mainTo / A2A_BRIDGE_MAIN_TO）——缺则只落件箱
 *   3. 自环跳过（a2a-self-guard）
 *   4. 跳过 CMD: 前缀（命令走 CMD 通道，不重复通知）
 *   5. 去重（messageId/taskId，内存 LRU）
 *   6. 限流（env A2A_NOTIFY_CHAT_MAX_PER_MIN，默认 5）
 *
 * 工厂模式：注入 inject/identity，便于独立单测（不依赖真实 gateway）。
 */
const selfGuard = require('./a2a-self-guard.js');

function _text(msg) {
  try {
    return ((msg && msg.parts) || [])
      .filter((p) => p && typeof p.text === 'string')
      .map((p) => p.text).join(' ').trim();
  } catch { return ''; }
}

function _sender(metadata) {
  try {
    const s = metadata && metadata.sender;
    if (!s) return { name: 'unknown', url: '' };
    if (typeof s === 'string') return { name: s, url: (metadata && metadata.senderUrl) || '' };
    return { name: s.name || s.id || 'unknown', url: s.url || s.senderUrl || '' };
  } catch { return { name: 'unknown', url: '' }; }
}

/**
 * @param {object} deps
 * @param {object} deps.identity  实例身份（含 bridge.mainTo / name / port / url）
 * @param {Function} deps.inject  (frame, opts) => Promise<{ok,error,...}>  —— 通常是 gatewayAdapter.inject
 * @param {object} [deps.logger]  console
 * @param {object} [deps.env]     便于测试注入（默认 process.env）
 */
function makeChatNotifyHandler({ identity = {}, inject, logger = console, env = process.env } = {}) {
  const seen = new Set();
  const times = [];

  const enabled = () => env.A2A_NOTIFY_CHAT === 'true';
  const mainTo = () => (identity && identity.bridge && identity.bridge.mainTo) || env.A2A_BRIDGE_MAIN_TO || '';
  const maxPerMin = () => {
    const n = parseInt(env.A2A_NOTIFY_CHAT_MAX_PER_MIN || '5', 10);
    return Number.isFinite(n) && n > 0 ? n : 5;
  };

  return async function chatNotifyHandler(taskId, msg, metadata) {
    try {
      if (!enabled()) return null;
      const to = mainTo();
      if (!to) return null; // 未配主会话目标 → 只落件箱（Layer 1）

      const sender = _sender(metadata);

      // 3. 自环跳过
      let self = false;
      try {
        const chk = selfGuard.isSelfCall({ sender: sender.name, senderUrl: sender.url, identity });
        self = !!(chk && chk.self);
      } catch { self = false; }
      if (self) return null;

      const text = _text(msg);
      if (!text) return null;
      if (text.startsWith('CMD:')) return null; // 4. 命令走 CMD 通道

      // 5. 去重
      const key = (msg && msg.messageId) || taskId || `${sender.name}:${text.slice(0, 60)}`;
      if (seen.has(key)) return null;
      seen.add(key);
      if (seen.size > 1000) { // 简单上限，防内存膨胀
        const it = seen.values();
        for (let i = 0; i < 500; i++) { const v = it.next(); if (v.done) break; seen.delete(v.value); }
      }

      // 6. 限流
      const now = Date.now();
      while (times.length && now - times[0] > 60000) times.shift();
      if (times.length >= maxPerMin()) {
        logger.warn(`[A2A-NOTIFY] 限流命中（${maxPerMin()}/min），本条只落件箱`);
        return null;
      }
      times.push(now);

      // 注入主会话（当作 notify 信封；走主 agent 完整循环）
      const senderLabel = `${sender.name}${sender.url ? ' (' + sender.url + ')' : ''}`;
      const envelope = {
        type: 'notify',
        scope: 'notify',
        target: text,
        task: text,
        delegationId: key,
        id: key,
        delegator: senderLabel,
      };
      const r = await inject({ taskId, delegatorLabel: senderLabel, envelope }, { to });
      if (r && r.ok) logger.log(`[A2A-NOTIFY] ✅ 已通知主会话: ${senderLabel} → ${text.slice(0, 40)}`);
      else logger.warn(`[A2A-NOTIFY] ⚠️ 通知失败: ${(r && r.error) || 'unknown'}`);
      return r;
    } catch (e) {
      logger.warn('[A2A-NOTIFY] 异常（不影响回复）:', e.message);
      return null;
    }
  };
}

module.exports = { makeChatNotifyHandler };
