/**
 * a2a-uac-health.js —— UAC 自检视图（供 /health 与 /health/uac-probe）
 *
 * 2026-09-17 · 若兰 🌸 · 缘起：舟楫部署 UAC 时发现「/health 无 uac 段、/health/uac-probe 不存在」
 *   —— 阿轩侧是**本地未提交改动**，共享仓里根本没有这两个自检面 ⇒ 标准操作单不可移植（文档债）。
 *   本模块把该能力**入仓 + 可测**，让「免确认是否真装配」能被外部只读侧证。
 *
 * 设计要点：
 *   - **不依赖请求**：装配是 bridgeHandler 按请求执行的（非启动时），所以自检必须直接读
 *     env + 策略文件，而不是只看内存标志。
 *   - **fail-safe**：无 UAC 信封的探针一律 hit:false（reason=no_uac），绝不假阳性。
 *   - 纯函数 + 可注入 env/policy 路径 ⇒ 单测不需要起服务、不需要真实策略。
 */

'use strict';

const fs = require('fs');
const path = require('path');

function defaultPolicyPath(env) {
  const e = env || process.env;
  return e.A2A_BRIDGE_UAC_POLICY || path.join(__dirname, 'config', 'bridge-uac-policy.json');
}

function envFlagOn(env) {
  return String((env || process.env).A2A_BRIDGE_UAC || '').toLowerCase() === 'on';
}

function readPolicy(policyPath) {
  try {
    return { ok: true, policy: JSON.parse(fs.readFileSync(policyPath, 'utf8')) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * /health 的 `uac` 段。
 * @param {object} [env]     环境（默认 process.env）
 * @param {object} [runtime] 运行态：{ assembled:boolean, error:string|null, guardWarned:boolean }
 */
function uacHealthSnapshot(env, runtime) {
  const policyPath = defaultPolicyPath(env);
  const r = readPolicy(policyPath);
  const policy = r.ok ? r.policy : null;
  const peers = (policy && Array.isArray(policy.peers)) ? policy.peers : [];
  return {
    envFlag: envFlagOn(env),
    policyPath,
    policyEnabled: !!(policy && policy.enabled === true),
    peersCount: peers.length,
    peerIds: peers.map((x) => (x && (x.id || x.name || x.agentId)) || '').filter(Boolean),
    hookAssembled: !!(runtime && runtime.assembled),
    guardWarned: !!(runtime && runtime.guardWarned),
    assemblyError: (runtime && runtime.error) || null,
    policyError: r.ok ? null : r.error,
    probeEndpoint: '/health/uac-probe',
  };
}

/**
 * /health/uac-probe：无 UAC 信封时的 fail-safe 探针。
 * 期望（装配 + 策略已启用）：{ hit:false, reason:'no_uac' }
 */
function uacProbe(env, opts) {
  const e = env || process.env;
  if (!envFlagOn(e)) return { hit: false, reason: 'hook_not_assembled', envFlag: false };
  const policyPath = defaultPolicyPath(e);
  const r = readPolicy(policyPath);
  if (!r.ok) return { hit: false, reason: 'policy_unreadable', error: r.error };

  let bridge;
  try { bridge = require('./a2a-bridge-uac'); }
  catch (err) { return { hit: false, reason: 'hook_module_missing', error: err.message }; }

  try {
    const check = bridge.checkUAC({ scope: 'shell' }, {
      policy: r.policy,
      sender: { name: '__uac_probe__', url: 'http://127.0.0.1' },
      now: (opts && opts.now) || Date.now(),
      jtiCache: new Set(),
      rateCheck: () => ({ ok: true }),
    });
    return {
      hit: !!(check && check.hit),
      reason: (check && check.reason) || 'unknown',
      detail: (check && check.detail) || null,
      envFlag: true,
      policyEnabled: !!(r.policy && r.policy.enabled === true),
      peersCount: (r.policy && r.policy.peers && r.policy.peers.length) || 0,
    };
  } catch (err) {
    return { hit: false, reason: 'probe_error', error: err.message };
  }
}

module.exports = { uacHealthSnapshot, uacProbe, defaultPolicyPath, envFlagOn, readPolicy };
