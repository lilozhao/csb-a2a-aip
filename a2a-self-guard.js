/**
 * A2A 自环调用守卫（Self-Call Guard）
 * -----------------------------------
 * 背景：Agent 把消息发给自己（sender = 自己，或从本机回环地址、未带 sender 的裸调用）
 *       没有任何语义价值，却会走完 LLM 处理链路 —— 自己等自己，
 *       表现为「请求挂起直到超时」（俗称自我消息陷阱）。
 *
 * 本模块在 JSON-RPC 入口做**快速拒绝**：命中自环特征时立即返回
 * 终态 REJECTED + SELF_MESSAGE_IGNORED，不再进入处理链路。
 *
 * 三条判定规则（任一命中即视为自环）：
 *   R1 sender_name           ：sender 的 name 与自身 identity.name 相同（忽略大小写/空白）
 *   R2 sender_url            ：sender 的 url 指向「本机地址 + 自身端口」
 *   R3 loopback_no_sender    ：没有 sender 信息，且请求来自回环地址 / 本机地址
 *                              （这是裸 curl 自测的典型形态；可用 A2A_SELF_GUARD_ALLOW_LOCAL=true 关闭）
 *
 * 配置（环境变量）：
 *   A2A_SELF_GUARD=true|false              总开关，默认 true
 *   A2A_SELF_GUARD_ALLOW_LOCAL=true|false  默认 false；true 时放行 R3（仅按显式身份判自环）
 *   A2A_SELF_GUARD_RESPONSE=<text>         拒绝时返回的文本，默认 SELF_MESSAGE_IGNORED
 *
 * 版本: 1.0.0 | 2026-09-11
 */

'use strict';

const os = require('os');
const { URL } = require('url');

const REASON = {
  SENDER_NAME: 'sender_name',
  SENDER_URL: 'sender_url',
  LOOPBACK_NO_SENDER: 'loopback_no_sender',
};

const DEFAULT_RESPONSE_TEXT = 'SELF_MESSAGE_IGNORED';

// 本机地址缓存（进程内基本不变）
let _localAddrsCache = null;

/**
 * 收集本机所有地址（含回环），用于判定「来自本机」
 */
function localAddresses() {
  if (_localAddrsCache) return _localAddrsCache;
  const addrs = new Set(['127.0.0.1', '::1', 'localhost']);
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni && ni.address) addrs.add(normalizeIp(ni.address));
      }
    }
  } catch { /* 取不到就只用回环 */ }
  if (process.env.A2A_HOST) addrs.add(normalizeIp(process.env.A2A_HOST));
  try { addrs.add(normalizeIp(os.hostname())); } catch { /* ignore */ }
  _localAddrsCache = addrs;
  return addrs;
}

/** 清空本机地址缓存（测试用） */
function _resetLocalAddresses() { _localAddrsCache = null; }

/**
 * IPv6 映射地址归一化：::ffff:127.0.0.1 → 127.0.0.1；::1 → 127.0.0.1
 */
function normalizeIp(ip) {
  if (ip === undefined || ip === null) return '';
  let s = String(ip).trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (s === '::1') s = '127.0.0.1';
  return s;
}

/**
 * 解析 endpoint（可能是 'http://host:port/path' 或裸 'host:port'）
 * @returns {{host:string, port:number|null}|null}
 */
function parseEndpoint(ep) {
  if (!ep || typeof ep !== 'string') return null;
  const raw = ep.trim();
  if (!raw) return null;
  try {
    const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    const u = new URL(withProto);
    return {
      host: normalizeIp(u.hostname),
      port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
    };
  } catch {
    return null;
  }
}

/**
 * 提取 sender 名称与 url（兼容字符串 / 对象两种形态）
 */
function extractSender({ sender, senderUrl } = {}) {
  let name = '';
  let url = senderUrl || '';
  if (typeof sender === 'string') {
    name = sender;
  } else if (sender && typeof sender === 'object') {
    name = sender.name || sender.id || '';
    url = url || sender.url || sender.senderUrl || '';
  }
  return { name: String(name || '').trim(), url: String(url || '').trim() };
}

/** 从环境变量读取配置 */
function loadConfig(env = process.env) {
  const bool = (v, dflt) => (v === undefined || v === null || v === ''
    ? dflt
    : !['false', '0', 'no', 'off'].includes(String(v).trim().toLowerCase()));
  return {
    enabled: bool(env.A2A_SELF_GUARD, true),
    allowLocalWithoutSender: bool(env.A2A_SELF_GUARD_ALLOW_LOCAL, false),
    responseText: (env.A2A_SELF_GUARD_RESPONSE || DEFAULT_RESPONSE_TEXT),
  };
}

/**
 * 判定是否自环调用
 * @param {object} opts
 * @param {string|object} [opts.sender]        发送方（字符串或 {name,url}）
 * @param {string}        [opts.senderUrl]     发送方 endpoint
 * @param {object}        [opts.identity]      自身身份 {name, port, host, url}
 * @param {string}        [opts.remoteAddr]    请求来源地址（socket）
 * @param {string}        [opts.forwardedFor]  x-forwarded-for 首段（可选）
 * @param {object}        [opts.config]        loadConfig() 结果
 * @returns {{self:boolean, reason:string|null, detail:object}}
 */
function isSelfCall(opts = {}) {
  const cfg = opts.config || loadConfig();
  if (!cfg.enabled) return { self: false, reason: null, detail: { skipped: 'disabled' } };

  const { name, url } = extractSender(opts);
  const identity = opts.identity || {};
  const selfName = String(identity.name || '').trim();
  const ownPort = identity.port ? Number(identity.port) : parseEndpoint(identity.url)?.port ?? null;
  const locals = localAddresses();

  // R1: 名字就是自己
  if (name && selfName && name.toLowerCase() === selfName.toLowerCase()) {
    return {
      self: true,
      reason: REASON.SENDER_NAME,
      detail: { senderName: name, selfName, rule: 'R1' },
    };
  }

  // R2: 发送方 URL 指向「本机地址 + 自身端口」
  const ep = parseEndpoint(url);
  if (ep && ep.host) {
    const hostIsLocal = locals.has(ep.host);
    const portIsSelf = !ownPort || !ep.port || Number(ep.port) === Number(ownPort);
    // host 为自己身份里的名字（如 hostname）也算
    const hostIsSelfHost = identity.host && normalizeIp(identity.host) === ep.host;
    if ((hostIsLocal || hostIsSelfHost) && portIsSelf) {
      return {
        self: true,
        reason: REASON.SENDER_URL,
        detail: { senderUrl: url, host: ep.host, port: ep.port, selfPort: ownPort, rule: 'R2' },
      };
    }
  }

  // R3: 无 sender 信息 + 请求来自本机（回环或本机地址）→ 裸自环调用
  if (!cfg.allowLocalWithoutSender && !name && !url) {
    const remote = normalizeIp(opts.remoteAddr);
    const fwd = normalizeIp(String(opts.forwardedFor || '').split(',')[0]);
    const fromLocal = (remote && (locals.has(remote) || remote.startsWith('127.')))
      || (fwd && (locals.has(fwd) || fwd.startsWith('127.')));
    if (fromLocal) {
      return {
        self: true,
        reason: REASON.LOOPBACK_NO_SENDER,
        detail: { remoteAddr: remote || null, forwardedFor: fwd || null, rule: 'R3' },
      };
    }
  }

  return { self: false, reason: null, detail: { senderName: name || null, senderUrl: url || null } };
}

module.exports = {
  REASON,
  DEFAULT_RESPONSE_TEXT,
  isSelfCall,
  loadConfig,
  extractSender,
  parseEndpoint,
  normalizeIp,
  localAddresses,
  _resetLocalAddresses,
};
