'use strict';
/**
 * a2a-inbox.js —— 入站 A2A 消息收件箱（2026-09-13 建立）
 *
 * 背景（根因）：
 *   桥接通知链路只对「带 delegation 信封」的消息生效（a2a-standard-api-v5.js:407）。
 *   普通聊天消息 fallthrough 到 LLM 自动回复就结束，**主会话全程不知情** ——
 *   「送达 ≠ 被感知」（与心跳「注册 ≠ 一直在」同族）。
 *
 * 本模块 = Layer 1（零风险、纯留痕）：把**所有入站 A2A 消息**追加到
 *   data/a2a-inbox.jsonl，主会话/心跳可按需读取，不改变任何现有行为。
 * Layer 2（主会话实时通知）见 a2a-chat-notify.js，默认关。
 *
 * 铁律：fail-safe —— 任何异常都不得反噬消息主链路（吞掉异常，返回 false）。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.A2A_INBOX_DIR || path.join(__dirname, 'data');
const INBOX_PATH = process.env.A2A_INBOX_PATH || path.join(DATA_DIR, 'a2a-inbox.jsonl');

function _text(msg) {
  try {
    const parts = (msg && msg.parts) || [];
    return parts
      .filter((p) => p && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
      .slice(0, 4000);
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
 * 记录一条入站消息（所有入站，含委托）。
 * @returns {boolean} 成功与否（失败只告警，不抛）
 */
function record({ taskId, msg, metadata } = {}) {
  try {
    const sender = _sender(metadata);
    const delegation = msg && msg.delegation ? msg.delegation : null;
    const entry = {
      ts: new Date().toISOString(),
      taskId: taskId || null,
      messageId: (msg && msg.messageId) || null,
      from: sender,
      kind: delegation ? 'delegation' : 'chat',
      scope: delegation ? (delegation.scope || null) : null,
      text: _text(msg),
      seen: false,
    };
    fs.mkdirSync(path.dirname(INBOX_PATH), { recursive: true });
    fs.appendFileSync(INBOX_PATH, JSON.stringify(entry) + '\n');
    return true;
  } catch (e) {
    console.warn('[A2A-INBOX] 记录失败（不影响主链路）:', e.message);
    return false;
  }
}

/** 读取收件箱（默认返回最近 50 条；unreadOnly 只看未读） */
function read({ unreadOnly = false, limit = 50 } = {}) {
  try {
    if (!fs.existsSync(INBOX_PATH)) return [];
    const lines = fs.readFileSync(INBOX_PATH, 'utf8').split('\n').filter(Boolean);
    const items = [];
    for (const l of lines) {
      try { items.push(JSON.parse(l)); } catch { /* 跳过坏行 */ }
    }
    const filtered = unreadOnly ? items.filter((x) => !x.seen) : items;
    return limit > 0 ? filtered.slice(-limit) : filtered;
  } catch (e) {
    console.warn('[A2A-INBOX] 读取失败:', e.message);
    return [];
  }
}

/**
 * 标记已读。
 * @param {string[]|Function} idsOrFn  taskId/messageId 数组，或谓词 (entry)=>bool
 * @returns {number} 本次标记条数
 */
function markSeen(idsOrFn) {
  try {
    if (!fs.existsSync(INBOX_PATH)) return 0;
    const lines = fs.readFileSync(INBOX_PATH, 'utf8').split('\n').filter(Boolean);
    const match = typeof idsOrFn === 'function'
      ? idsOrFn
      : (e) => {
          const ids = new Set(idsOrFn || []);
          return ids.has(e.taskId) || ids.has(e.messageId);
        };
    let n = 0;
    const out = lines.map((l) => {
      try {
        const e = JSON.parse(l);
        if (!e.seen && match(e)) { e.seen = true; n++; }
        return JSON.stringify(e);
      } catch { return l; }
    });
    fs.writeFileSync(INBOX_PATH, out.join('\n') + '\n');
    return n;
  } catch (e) {
    console.warn('[A2A-INBOX] 标记已读失败:', e.message);
    return 0;
  }
}

/** 统计：总条数 / 未读数 / 最近一条时间 */
function stats() {
  try {
    const items = read({ limit: 0 });
    const unread = items.filter((x) => !x.seen).length;
    return { total: items.length, unread, last: items.length ? items[items.length - 1].ts : null };
  } catch { return { total: 0, unread: 0, last: null }; }
}

module.exports = { record, read, markSeen, stats, INBOX_PATH, DATA_DIR };
