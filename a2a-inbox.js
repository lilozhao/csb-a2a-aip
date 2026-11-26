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
const CURSOR_PATH = process.env.A2A_INBOX_CURSOR_PATH
  || path.join(path.dirname(INBOX_PATH), 'a2a-inbox-cursor.json');

// [Q7 · 2026-11-26] 游标语义：默认 at-least-once（复用 markSeen，不加持久去重表）。
//   一澜 09:57 拍板：先按最低成本落地，messageId 持久去重表后置。
//   口径依据：docs/RUNTIME-SEVEN-QUESTIONS.md §Q7 / §5.3 Q4→Q7 / §5.4 ③
const CURSOR_SEMANTICS = 'at-least-once';

/** 原子写：先写临时文件再 rename，避免半截文件把游标/收件箱写坏 */
function _writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * 扫描收件箱：一次读盘，供 record/read/markSeen/cursor 共用。
 * 老记录（2026-11-26 之前写入）没有 seq 字段 —— 用 1-based 行号派生，
 * **不重写历史文件**（历史是证据，改写等于伪造现场）。
 */
function _scan() {
  if (!fs.existsSync(INBOX_PATH)) return { items: [], bad: 0 };
  const lines = fs.readFileSync(INBOX_PATH, 'utf8').split('\n').filter(Boolean);
  const items = [];
  let bad = 0;
  lines.forEach((l, i) => {
    try {
      const e = JSON.parse(l);
      if (typeof e.seq !== 'number' || !Number.isFinite(e.seq)) e.seq = i + 1;
      items.push(e);
    } catch { bad++; }
  });
  return { items, bad };
}

/** 下一个可用 seq：现有最大 seq + 1（不复用，宁可有缺口不重号） */
function _nextSeq(items) {
  let max = 0;
  for (const e of items) if (typeof e.seq === 'number' && e.seq > max) max = e.seq;
  return max + 1;
}

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
    // [W-63 · 2026-11-23] 验签结论落信封。
    //   为什么必须有这一行：隧道把源 IP 抹成 127.0.0.1 后，`from` 只是自述，
    //   事后翻日志无法机械回答「这条到底是不是它发的」。aat 字段给的是
    //   **钥匙指纹**（认钥不认票），可与 config pin 的公钥逐字对账。
    //   缺席 ≠ 正常：无票写 valid:false/error:no_token，绝不 omit。
    let aat = null;
    try {
      aat = require('./a2a-aat-envelope.js').summarize(metadata);
    } catch (e) {
      aat = { valid: false, fingerprint: null, error: 'envelope_cli_error', token: null, issuer: null, agentId: null };
    }
    // [Q7] seq 唯一写入点：读一次现有最大 seq 再 +1。
    //   为什么不用内存计数器：进程重启/被别的进程追加都会让计数器撒谎；
    //   「不复用」比「快」重要 —— 重号会让游标续跑变成静默丢消息。
    const { items: existing } = _scan();
    const entry = {
      seq: _nextSeq(existing),
      ts: new Date().toISOString(),
      taskId: taskId || null,
      messageId: (msg && msg.messageId) || null,
      from: sender,
      aat,
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
    const { items } = _scan();
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
    // [Q7] 原子写：markSeen 现在和游标同源，半截文件会让位置对不上
    _writeAtomic(INBOX_PATH, out.join('\n') + '\n');
    return n;
  } catch (e) {
    console.warn('[A2A-INBOX] 标记已读失败:', e.message);
    return 0;
  }
}

// ───────────────────────── Q7 游标 ─────────────────────────

/** 读游标（不存在 = position 0，语义仍显式写出，不静默省略） */
function getCursor() {
  try {
    if (fs.existsSync(CURSOR_PATH)) {
      const c = JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf8'));
      return {
        stream: c.stream || 'inbox',
        position: Number.isFinite(c.position) ? c.position : 0,
        acked_at: c.acked_at || null,
        semantics: c.semantics || CURSOR_SEMANTICS,
      };
    }
  } catch (e) {
    console.warn('[A2A-INBOX] 游标读取失败，按 0 处理:', e.message);
  }
  return { stream: 'inbox', position: 0, acked_at: null, semantics: CURSOR_SEMANTICS };
}

/** 写游标（只增不减；倒退视为 bug，拒绝并告警） */
function setCursor(pos) {
  try {
    const cur = getCursor();
    const next = Number(pos);
    if (!Number.isFinite(next) || next < 0) throw new Error(`非法 position: ${pos}`);
    if (next < cur.position) {
      console.warn(`[A2A-INBOX] 拒绝游标倒退 ${cur.position} → ${next}`);
      return { ...cur, rejected: 'backwards' };
    }
    const out = {
      stream: 'inbox',
      position: next,
      acked_at: new Date().toISOString(),
      semantics: CURSOR_SEMANTICS,
    };
    _writeAtomic(CURSOR_PATH, JSON.stringify(out) + '\n');
    return out;
  } catch (e) {
    console.warn('[A2A-INBOX] 游标写入失败:', e.message);
    return { ...getCursor(), error: e.message };
  }
}

/**
 * 连续已读的最大 seq —— 游标的唯一合法落点。
 * 乱序 ack（先标了 seq 5，1-4 还没读）时游标停在 0，宁可重读不可跳过。
 */
function _contiguousSeen(items) {
  let pos = 0;
  for (const e of items) {
    if (e.seq === pos + 1) {
      if (e.seen) pos = e.seq;
      else break;
    } else if (e.seq > pos + 1) {
      break; // 缺口：没有 seq=pos+1 的那条，不能越过
    }
  }
  return pos;
}

/**
 * ack = markSeen + 游标推进（Q7 的消费入口）
 * @param {string[]|Function} idsOrFn 同 markSeen
 * @returns {{marked:number, position:number, advanced:boolean}}
 */
function ack(idsOrFn) {
  const marked = markSeen(idsOrFn);
  const { items } = _scan();
  const cur = getCursor();
  const target = _contiguousSeen(items);
  if (target > cur.position) {
    const c = setCursor(target);
    return { marked, position: c.position, advanced: true };
  }
  return { marked, position: cur.position, advanced: false };
}

/** 续跑入口：取 seq > position 的记录（重启后从这里接） */
function readFrom(position, { limit = 0 } = {}) {
  try {
    const pos = Number.isFinite(Number(position)) ? Number(position) : getCursor().position;
    const { items } = _scan();
    const out = items.filter((e) => e.seq > pos);
    return limit > 0 ? out.slice(0, limit) : out;
  } catch (e) {
    console.warn('[A2A-INBOX] readFrom 失败:', e.message);
    return [];
  }
}

/** 游标状态：够不够用一眼看 |
 *   rotation_detected=true 表示收件箱被轮转/清空，position 越界 —— 需人工决定重置 */
function status() {
  const { items } = _scan();
  const cur = getCursor();
  const lastSeq = items.length ? items[items.length - 1].seq : 0;
  const total = items.length;
  const rotation = cur.position > lastSeq;
  return {
    total,
    lastSeq,
    position: cur.position,
    lag: Math.max(0, lastSeq - cur.position),
    unread: items.filter((e) => !e.seen).length,
    semantics: cur.semantics,
    acked_at: cur.acked_at,
    rotation_detected: rotation,
  };
}

/**
 * 自检（§5.4 ③ 的机器判据）：
 *  - seq 严格递增且无重号（宁可有缺口，不能重号）
 *  - 游标不越界、不跳号（position 必落在连续已读段内）
 */
function verify() {
  const { items, bad } = _scan();
  const dups = [];
  const gaps = [];
  let prev = 0;
  for (const e of items) {
    if (e.seq <= prev) dups.push({ seq: e.seq, prev });
    else if (e.seq > prev + 1) gaps.push({ from: prev, to: e.seq });
    prev = Math.max(prev, e.seq);
  }
  const cur = getCursor();
  const lastSeq = items.length ? items[items.length - 1].seq : 0;
  const contiguous = _contiguousSeen(items);
  const checks = {
    monotonic_no_dup: dups.length === 0,
    cursor_in_range: cur.position <= lastSeq,
    cursor_not_ahead_of_reads: cur.position <= contiguous,
    no_bad_lines: bad === 0,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    total: items.length,
    lastSeq,
    position: cur.position,
    contiguousSeen: contiguous,
    gaps,
    dups,
    bad_lines: bad,
    semantics: cur.semantics,
  };
}

/** 统计：总条数 / 未读数 / 最近一条时间 */
function stats() {
  try {
    const items = read({ limit: 0 });
    const unread = items.filter((x) => !x.seen).length;
    return { total: items.length, unread, last: items.length ? items[items.length - 1].ts : null };
  } catch { return { total: 0, unread: 0, last: null }; }
}

module.exports = {
  record, read, markSeen, stats,
  // Q7 游标
  ack, readFrom, getCursor, setCursor, status, verify,
  INBOX_PATH, CURSOR_PATH, DATA_DIR,
};
