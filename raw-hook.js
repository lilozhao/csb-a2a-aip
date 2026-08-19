/**
 * raw-hook.js — A2A 消息 → 底仓流水（可选 hook，CSB-Memory v1.1）
 *
 * 目的：A2A server 收到消息时，把原始对话写入底仓（写入端笨，不筛选）。
 * 协议依据：MEM-012 13.4（写入端可以挑，但挑了就不删）+ 13.8 试点判据。
 *
 * 用法（在 server 的 SendMessage 处理处调用）：
 *
 *   const rawHook = require('./raw-hook');
 *   // 收到消息后：
 *   rawHook.hookMessage(message, { sender: '明德', type: 'conversation' });
 *
 * 依赖：csb-memory 仓库（与 csb-a2a-aip 平级，或 npm install csb-memory）。
 * 未找到 csb-memory 时静默降级（返回 { hooked: false }），不影响 A2A 主流程。
 */

const path = require('path');
const fs = require('fs');

// 加载 csb-memory 的 raw 模块（双场景：npm 包 / workspace 平级目录）
function loadRaw() {
  try {
    const pkg = require('csb-memory');
    if (pkg && pkg.raw) return pkg.raw;
  } catch (e) { /* 尝试平级目录 */ }
  const local = path.join(__dirname, '..', 'csb-memory', 'lib', 'raw', 'raw.js');
  if (fs.existsSync(local)) {
    return require(local);
  }
  return null;
}

const raw = loadRaw();

// 从 A2A 消息中提取文本（兼容多种消息形态）
function extractText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const parts = message.parts || [];
  for (const part of parts) {
    if (part && part.type === 'text' && part.text) return part.text;
  }
  return message.text || message.content || '';
}

/**
 * 把 A2A 消息写入底仓
 * @param {object} message A2A 消息对象
 * @param {object} opts { sender, type, session, threadId, important }
 * @returns {{hooked: boolean, id?: string, reason?: string}}
 */
function hookMessage(message, opts = {}) {
  if (!raw) {
    return { hooked: false, reason: 'csb-memory 未找到（需与 csb-a2a-aip 平级或 npm 安装）' };
  }
  const text = extractText(message);
  if (!text) {
    return { hooked: false, reason: '消息无文本内容' };
  }
  // 试点判据（13.8）：important=true（拍板/决策类）或含工具结果摘要
  const type = opts.type || (opts.important ? 'decision' : 'conversation');
  try {
    const record = raw.append({
      session: opts.session || 'a2a',
      type,
      content: text.slice(0, 2000), // 底仓不加工，仅截断防超长
      meta: {
        sender: opts.sender || '',
        threadId: opts.threadId || '',
        messageId: message.messageId || '',
        important: opts.important || false,
      },
    });
    return { hooked: true, id: record.id };
  } catch (e) {
    return { hooked: false, reason: e.message };
  }
}

module.exports = { hookMessage, loadRaw, extractText };
