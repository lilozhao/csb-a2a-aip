/**
 * 入站调用者鉴权 · 分级 + 灰度（P0-5）
 * 版本 1.0.0 · 2026-11-02
 *
 * 背景：`/a2a/json-rpc`、`/message:send` 目前**不校验调用者是谁**。
 * 17 个 agent 谁都能往里塞消息，审计里 `caller_id` 常年 unknown。
 *
 * 三段灰度（一澜 2026-11-02 定，观察期 **2 周**）：
 *   1. shadow  只记不打回 —— 默认，跑满 2 周（到 2026-11-16）再决定放量
 *   2. 分档放量  先拦 A 类（无身份），B 类走人工通道
 *   3. 全量      再有凭据才放行
 *
 * 分类口径（唯一实现，脚本与中间件共用，禁止各写一套）：
 *   A 无身份      name 缺失 / unknown / '?'              → 应 100% 拦
 *   B 冒名嫌疑    name 命中已知 agent，但没有 url 可核      → 人工通道（不是放行）
 *   C 名称+出处自洽 name + url，注册表命中                 → **未验签**，只说明自洽
 *   D 未注册      name + url 都有，注册表查不到            → 灰度只记
 *
 * 诚实声明：C 类**不等于**验签通过。AAT 是否真的校验得上，是下一件事（P0-5 第二阶段）。
 * 本模块现在只回答「这次调用带没带、对不对得上名字」，不声称「身份可信」。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname);
const SHADOW_LOG = process.env.A2A_INBOUND_AUTH_LOG || path.join(ROOT, 'logs', 'inbound-auth-shadow.jsonl');

const MODE = Object.freeze({ OFF: 'off', SHADOW: 'shadow', ENFORCE: 'enforce' });

/** 读 env，非法值一律回落到 off（宁可少拦，不可误拦） */
function modeFromEnv(env = process.env) {
  const raw = String(env.A2A_INBOUND_AUTH_MODE || '').trim().toLowerCase();
  if (raw === MODE.SHADOW) return MODE.SHADOW;
  if (raw === MODE.ENFORCE) return MODE.ENFORCE;
  return MODE.OFF;
}

/** 从请求体取 sender（三种历史形态：sender 对象 / params.sender / from 字符串） */
function extractSender(body) {
  const b = body || {};
  const pick = (x) => {
    if (!x) return null;
    if (typeof x === 'string') return { name: x, url: '' };
    if (typeof x === 'object') return { name: x.name || x.agent || '', url: x.url || x.host || '' };
    return null;
  };
  return pick(b.sender) || pick(b.params && b.params.sender) || pick(b.from) || pick(b.params && b.params.from) || { name: '', url: '' };
}

/**
 * 分类（纯函数，无 IO）
 * @param {object} sender { name, url }
 * @param {Set<string>|Array<string>} known 已知 agent 名（小写）
 * @param {object} extra { hasAat }
 */
function classify(sender, known, extra = {}) {
  const set = known instanceof Set ? known : new Set((known || []).map((x) => String(x).toLowerCase()));
  const s = sender || {};
  const name = String(s.name || '').trim();
  const url = String(s.url || '').trim();
  const hasName = !!name && !['unknown', '?', 'undefined', 'null'].includes(name.toLowerCase());
  const hasUrl = !!url;
  const lower = name.toLowerCase();
  const knownName = hasName && (set.has(lower) || [...set].some((k) => k && lower.includes(k)));

  let cls, why;
  if (!hasName) { cls = 'A'; why = '无身份（name 缺失/unknown）'; }
  else if (!hasUrl) { cls = knownName ? 'B' : 'A'; why = knownName ? '声称已知身份但无 url 可核' : '无身份（无 url 且非已知名）'; }
  else if (knownName) { cls = 'C'; why = 'name + url，注册表命中（未验签）'; }
  else { cls = 'D'; why = 'name + url，注册表未命中'; }

  return { cls, why, name: name || null, url: url || null, knownName, hasAat: extra.hasAat === true };
}

/**
 * 决策（纯函数）：给定分类与模式，返回该怎么做
 *   off      → 不记不管（保持现状）
 *   shadow   → 一律放行，但记录 would_block（这就是「只记不打回」）
 *   enforce  → A/B 拦（401），C/D 放行并记录
 *
 * 为什么 enforce 不拦 D：D 是「有名字有出处但注册表没他」——灰度期正要把这批人拉进名单，
 * 一刀切拦掉等于把社区新成员关在门外。D 的去向是「分档放量」阶段单独定，不在这一步。
 */
function decide(c, mode) {
  const m = mode || MODE.OFF;
  if (m === MODE.OFF) return { action: 'allow', record: false, wouldBlock: false, reason: 'mode_off' };
  const shouldBlock = c.cls === 'A' || c.cls === 'B';
  if (m === MODE.SHADOW) {
    return { action: 'allow', record: true, wouldBlock: shouldBlock, reason: shouldBlock ? `shadow_would_block_${c.cls}` : 'shadow_allow' };
  }
  // enforce
  if (shouldBlock) return { action: 'block', record: true, wouldBlock: true, reason: `blocked_${c.cls}`, httpStatus: 401 };
  return { action: 'allow', record: true, wouldBlock: false, reason: 'allow_with_credential' };
}

/** 追加一条影子记录（失败绝不阻断主流程） */
function recordShadow(entry, logFile = SHADOW_LOG) {
  try {
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    return true;
  } catch (e) {
    try { console.warn('[inbound-auth] 影子记录失败（不影响请求）:', e.message); } catch { /* noop */ }
    return false;
  }
}

/** 从本地文件 + 实时注册表读已知 agent（失败就退回本地；来源要能说清） */
async function loadKnown(opts = {}) {
  const out = new Set();
  const cands = [
    path.join(ROOT, 'data', 'a2a_registry.json'),
    path.join(ROOT, 'config', 'agents.local.json'),
    path.join(ROOT, 'config', 'agents.json'),
  ];
  for (const f of cands) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw.agents || raw.registry || []);
      for (const a of list) {
        if (a && a.name) out.add(String(a.name).toLowerCase());
        if (a && a.id) out.add(String(a.id).toLowerCase());
      }
    } catch { /* 缺文件不算错 */ }
  }
  if (opts.offline) return out;
  const urls = [process.env.A2A_REGISTRY_URL, 'http://172.28.0.4:3099', 'http://127.0.0.1:3099'].filter(Boolean);
  for (const base of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${base}/agents`, { signal: ctrl.signal });
      clearTimeout(timer);
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.agents || []);
      for (const a of list) if (a && a.name) out.add(String(a.name).toLowerCase());
      return out;
    } catch { /* 试下一个 */ }
  }
  return out;
}

module.exports = {
  MODE, SHADOW_LOG,
  modeFromEnv, extractSender, classify, decide, recordShadow, loadKnown,
};
