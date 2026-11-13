/**
 * a2a-health-public.js — /health 公开视图（纯函数）
 *
 * [2026-11-13 W-57] 一澜 09:55 拍板：方案 A（分级）+ 局部 C（就地改布尔）。
 * 缘起：公开 /health 一次交出 2300B / 105 个字段 —— 内网注册表地址、4 条本地绝对路径、
 *   邻居名单（uac.peerIds）、knownAgents 规模、`e2e.reason=no_master_key`（自曝明文）、
 *   trust/audit 行数与链尾哈希、任务状态分布，且对无 Origin 请求回 `ACAO: *`。
 *   它同时是保活 / watchdog / GDI 的**唯一探针**，所以不能关，只能分级。
 *
 * 为什么单独成模块（而不是写在 server_v5 的路由里）：
 *   判据要求「故意造错会红」。路由里内联的拼装函数没有输入，造错只能改源码 → 测不了。
 *   抽成 detail → public 的纯函数后，就能喂一份「故意带上路径的 detail」看它是否漏。
 *
 * 本模块只做一件事：**从完整 detail 里挑出可以公开的字段**。
 *   它不读环境、不读文件、不判鉴权。
 */

/**
 * @param {object} detail 完整健康快照（同 /health/detail 的形状）
 * @returns {object} 公开版
 */
function buildPublicHealth(detail) {
  const d = detail || {};
  const checks = d.checks || {};
  const cfg = checks.configResolved || {};
  const reg = checks.registryReachable || {};
  const trust = d.trust || {};
  const e2e = d.e2e || {};
  const rl = d.rateLimit || {};

  const out = {
    status: d.status,
    version: d.version,
    protocol: d.protocol,
    // ⚠️ identity 必须留：TOOLS.md 判据「验活只看 /health 的 identity，不看状态码」。
    //   删掉它，我方自己的探活判据当场失效（名字本来就写在注册表里，不是秘密）。
    identity: d.identity,
    dht: {
      level: { name: (d.dht && d.dht.level && d.dht.level.name) || 'UNKNOWN' },
      onlineAgents: (d.dht && typeof d.dht.onlineAgents === 'number') ? d.dht.onlineAgents : 0,
    },
    checks: {
      // 只挑字段，不整体透传：整体透传会把将来新增的 A 类字段自动带出去（默认不安全）。
      // [2026-11-13] 首版就是逐字段挑的；这条注释是给下一个加字段的人看的。
      configResolved: { ok: !!cfg.ok, source: cfg.source, hint: cfg.hint },
      registryReachable: {
        ok: !!reg.ok,
        onlineAgents: reg.onlineAgents,
        dhtLevel: reg.dhtLevel,
        hint: reg.hint,
      },
    },
    // 外部可审计：**给结论不给细节**（行数 / 链尾哈希 / 路径都在详细版）
    audit: { chainValid: !!d.audit && !!d.audit.chainValid },
    trust: {
      signed: !!trust.signed,
      verified: !!trust.verified,
      auditReady: !!trust.auditReady,
      degraded: !!trust.degraded,
    },
    // 改布尔：原 `reason:"no_master_key"` 等于对任何人自曝「这段链路明文」
    e2e: { encrypted: !!e2e.outboundEncrypted },
    // 只给计数：原字段 `suspendedAgents[]` / `suspiciousIps[]` 暴露「谁被盯上了」
    rateLimit: {
      suspended: Array.isArray(rl.suspendedAgents) ? rl.suspendedAgents.length : 0,
      suspicious: Array.isArray(rl.suspiciousIps) ? rl.suspiciousIps.length : 0,
    },
  };
  if (typeof d.degradedReason === 'string' && d.degradedReason) {
    out.degradedReason = d.degradedReason;
  }
  return out;
}

/**
 * 泄露扫描：公开视图不许出现的东西。
 * 返回命中的规则名数组（空数组 = 干净）。
 *
 * 判据只吃客观量：
 *   · IPv4 字面量
 *   · 以 `/` 开头的绝对路径（以及 Windows 盘符）
 *   · A 类字段名（按 key 递归扫）
 *   · 「明文自曝」这类措辞
 *
 * 诚实边界：这是**形状检查**，不是「语义无泄露」的证明。
 *   它只能保证「这些已知形状不出现」，不能保证新字段不泄露 ——
 *   所以 `buildPublicHealth` 必须是白名单式逐字段挑，不能整体透传。
 */
const FORBIDDEN_KEYS = [
  'effective', 'registries', 'ledgerPath', 'logPath', 'policyPath', 'shadowLog',
  'peerIds', 'knownAgents', 'lastHash', 'keyFingerprint', 'suspendedAgents',
  'suspiciousIps', 'lastProbeTime', 'byState', 'hookStats', 'uptime',
];
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
const ABS_PATH = /(^|["'\s:\[,])(\/(?:home|root|Users|var|etc|tmp|opt|srv|mnt|proc)\/[^\s"',\]]*)/;
const WIN_PATH = /\b[A-Za-z]:\\\\?[^\s"',\]]+/;

function scanForLeaks(obj) {
  const hits = [];
  const text = JSON.stringify(obj || {});

  if (IPV4.test(text)) hits.push('ipv4_literal');
  if (ABS_PATH.test(text) || WIN_PATH.test(text)) hits.push('absolute_path');
  if (/no_master_key/.test(text)) hits.push('e2e_plaintext_self_report');

  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, path + '[' + i + ']'));
      return;
    }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        if (FORBIDDEN_KEYS.includes(k)) hits.push('forbidden_key:' + k);
        walk(node[k], path + '.' + k);
      }
    }
  };
  walk(obj, '$');

  return [...new Set(hits)];
}

module.exports = { buildPublicHealth, scanForLeaks, FORBIDDEN_KEYS };
