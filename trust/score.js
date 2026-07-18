#!/usr/bin/env node
/**
 * CSB-Trust · 信任评分模块
 * 
 * 基于 CSB 开放协议 v1.0 §2.2 信任评分公式：
 *   T(agent) = 0.3 × I + 0.3 × H + 0.2 × A + 0.2 × C
 * 
 * 使用方式：
 *   const trust = require('./trust/score');
 *   const score = trust.calc({ identity: 0.9, history: 0.8, audit: 0.7, community: 0.6 });
 *   // → { score: 0.78, level: 'high', label: '🔵 高信任' }
 */

// ── 信任评分权重（可配置） ─────────────────────────────
const DEFAULT_WEIGHTS = {
  identity:  0.3,   // 身份验证通过度
  history:   0.3,   // 历史委托/任务完成率
  audit:     0.2,   // 审计日志完整度
  community: 0.2,   // 社区信任网络加权
};

// ── 信任等级映射 ─────────────────────────────────────
const LEVELS = [
  { min: 0.90, level: 'complete',  label: '🟣 完全信任', default_perm: 'full' },
  { min: 0.75, level: 'high',      label: '🔵 高信任',   default_perm: 'execute' },
  { min: 0.50, level: 'medium',    label: '🟢 中等信任', default_perm: 'request' },
  { min: 0.25, level: 'low',       label: '🟡 低信任',   default_perm: 'inform' },
  { min: 0.00, level: 'untrusted', label: '❌ 不可信',   default_perm: 'deny' },
];

// ── 信任衰减参数 ─────────────────────────────────────
const DECAY_DEFAULT_LAMBDA = 0.01;  // 约 100 天衰减至 37%
const DECAY_MIN_THRESHOLD = 0.20;   // 最低阈值 20%

/**
 * 计算信任评分
 * @param {Object} dims - 各维度评分 (0~1)
 * @param {number} dims.identity   - 身份验证通过度
 * @param {number} dims.history    - 历史任务完成率
 * @param {number} dims.audit      - 审计日志完整度
 * @param {number} dims.community  - 社区信任网络加权
 * @param {Object} [weights]       - 自定义权重（可选）
 * @returns {{ score: number, level: string, label: string, default_perm: string }}
 */
function calc(dims, weights) {
  const w = weights || DEFAULT_WEIGHTS;
  const score = (
    (dims.identity  || 0) * w.identity +
    (dims.history   || 0) * w.history +
    (dims.audit     || 0) * w.audit +
    (dims.community || 0) * w.community
  );

  // 限幅 [0, 1]
  const clamped = Math.max(0, Math.min(1, score));

  // 查找等级
  const level = LEVELS.find(l => clamped >= l.min) || LEVELS[LEVELS.length - 1];

  return {
    score: Math.round(clamped * 100) / 100,
    level: level.level,
    label: level.label,
    default_perm: level.default_perm,
  };
}

/**
 * 信任衰减计算
 * @param {number} baseScore      - 原始信任评分 (0~1)
 * @param {number} daysSinceActive - 距离上次活跃的天数
 * @param {Object} [opts]
 * @param {number} [opts.lambda]  - 衰减系数（默认 0.01）
 * @param {number} [opts.threshold] - 最低阈值（默认 0.2）
 * @returns {{ effective: number, decayed: boolean }}
 */
function decay(baseScore, daysSinceActive, opts) {
  const λ = opts?.lambda ?? DECAY_DEFAULT_LAMBDA;
  const threshold = opts?.threshold ?? DECAY_MIN_THRESHOLD;

  if (daysSinceActive <= 0) {
    return { effective: baseScore, decayed: false };
  }

  const factor = Math.exp(-λ * daysSinceActive);
  const effective = Math.max(baseScore * factor, threshold);

  return {
    effective: Math.round(effective * 100) / 100,
    decayed: effective < baseScore,
  };
}

/**
 * 从 Agent Card 对象计算信任评分
 * @param {Object} agentCard
 * @returns {{ score, level, label, decay_info }}
 */
function fromAgentCard(agentCard) {
  if (!agentCard || !agentCard.trust) {
    return calc({ identity: 0, history: 0, audit: 0, community: 0 });
  }

  const t = agentCard.trust;
  const dims = {
    identity:  t.identity_score  ?? 0.5,
    history:   t.task_success_rate ?? 0.5,
    audit:     t.audit_score     ?? 0.5,
    community: t.community_score ?? 0.5,
  };

  const result = calc(dims);

  // 如果有衰减信息
  if (agentCard.last_seen) {
    const days = (Date.now() - new Date(agentCard.last_seen).getTime()) / 86400000;
    const decayResult = decay(result.score, days);
    return { ...result, decay_info: decayResult };
  }

  return result;
}

module.exports = { calc, decay, fromAgentCard, LEVELS, DEFAULT_WEIGHTS };
