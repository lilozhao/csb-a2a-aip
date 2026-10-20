#!/usr/bin/env node
/**
 * CSB-AgentCard · Agent Card Schema 与解析
 * 
 * 基于 CSB 开放协议 v1.1 Agent Card 标准化规范
 * 
 * 使用方式：
 *   const card = require('./agent-card/schema');
 *   const myCard = card.build({ name: '若兰', ... });
 *   const ok = card.validate(myCard);
 */

// ── 必填字段（P0） ─────────────────────────────────────
const REQUIRED_FIELDS = ['name', 'id', 'type', 'capabilities', 'endpoints', 'status'];

// ── 沙箱类型 ──────────────────────────────────────────
const SANDBOX_TYPES = ['persistent', 'ephemeral', 'hybrid'];

// ── 能力等级 ──────────────────────────────────────────
const CAPABILITY_LEVELS = ['beginner', 'intermediate', 'advanced', 'expert'];

// ── 默认 Agent Card 模板 ─────────────────────────────
const DEFAULT_CARD = {
  '@context': 'https://csb-protocol.org/agent-card/v1',
  version: '4.1.0',
  type: 'persistent',
  status: 'online',
  capabilities: [],
  endpoints: {},
  trust: {
    score: 0,
    identity_score: 0.5,
    task_success_rate: 0.5,
    audit_score: 0.5,
    community_score: 0.5,
    last_updated: Date.now(),
  },
};

/**
 * 构建 Agent Card
 * @param {Object} data
 * @param {string} data.name         - Agent 名称（必填）
 * @param {string} data.id           - 唯一标识符（必填）
 * @param {string} [data.type]       - 沙箱类型（默认 persistent）
 * @param {Object} data.endpoints    - 通信端点（必填，至少 a2a）
 * @param {Array}  data.capabilities - 能力列表（必填）
 * @param {Object} [data.trust]      - 信任信息
 * @param {Object} [data.pricing]    - 计价模式（商业场景）
 * @param {Object} [data.sandbox]    - 沙箱能力声明
 * @param {Object} [data.harness_manifest] - 可携带 harness 清单（Harness² C1–C8 · 见 normalizeManifest）
 * @param {string} [data.experience_ref]   - 经验层引用（csb-memory EXPERIENCE 层端点/指针）
 * @param {string} [data.domain]     - 域标识
 * @param {string} [data.status]     - 在线状态
 * @returns {Object} agentCard
 */
function build(data) {
  const card = { ...DEFAULT_CARD };

  // 必填字段
  card.name = data.name;
  card.id = data.id;

  // 可选覆盖
  if (data.type && SANDBOX_TYPES.includes(data.type)) {
    card.type = data.type;
  }
  if (data.endpoints) card.endpoints = data.endpoints;
  if (data.capabilities) card.capabilities = normalizeCapabilities(data.capabilities);
  if (data.status) card.status = data.status;
  if (data.version) card.version = data.version;
  if (data.domain) card.domain = data.domain;
  if (data.pricing) card.pricing = data.pricing;
  if (data.sandbox) card.sandbox = data.sandbox;

  // Harness Manifest（Harness² C1–C8 可携带清单）——有才写，向后兼容
  if (data.harness_manifest) {
    card.harness_manifest = normalizeManifest(data.harness_manifest);
  }
  if (data.experience_ref) card.experience_ref = data.experience_ref;

  // 信任评分
  if (data.trust) {
    card.trust = { ...card.trust, ...data.trust };
  }

  // 更新时间
  card.last_updated = Date.now();
  card.last_seen = Date.now();

  return card;
}

/**
 * 规范化 harness_manifest
 *
 * 刻意**不设必填**：缺块 = 该块能力未知（判 N/A），不是非法卡。
 * 沿用 CSB「数据不足不聚合」原则——不硬凑。
 *
 * @param {Object} m
 * @returns {Object} { components, skills, plugins, n_a }
 */
function normalizeManifest(m) {
  const src = (m && typeof m === 'object') ? m : {};
  const comps = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];
  const components = {};
  const na = [];

  for (const c of comps) {
    const v = src.components && src.components[c];
    if (v && typeof v === 'object') {
      components[c] = {
        declared: true,
        version: v.version || null,
        readonly: v.readonly === true,   // C1/C2 应为 true
        note: v.note || '',
      };
    } else {
      na.push(c);                        // 未声明的判 N/A，不猜
    }
  }

  const normList = (x) => Array.isArray(x) ? x.filter(i => i && i.name).map(i => ({
    name: i.name,
    version: i.version || null,
    domain: i.domain || null,
  })) : [];

  return {
    version: src.version || null,
    components,
    skills: normList(src.skills),
    plugins: normList(src.plugins),
    n_a: na,                             // 透明呈现：这些块本卡未声明
  };
}

/**
 * 格式化能力列表
 */
function normalizeCapabilities(caps) {
  if (!Array.isArray(caps)) return [];
  return caps.map(c => {
    if (typeof c === 'string') {
      return { name: c, level: 'intermediate' };
    }
    return {
      name: c.name,
      level: CAPABILITY_LEVELS.includes(c.level) ? c.level : 'intermediate',
      description: c.description || '',
    };
  });
}

/**
 * 验证 Agent Card 是否合法
 * @param {Object} card
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(card) {
  const errors = [];

  // 检查必填字段
  for (const field of REQUIRED_FIELDS) {
    if (card[field] === undefined || card[field] === null || card[field] === '') {
      errors.push(`缺少必填字段: ${field}`);
    }
  }

  // 检查 name
  if (card.name && card.name.length < 1) {
    errors.push('name 不能为空');
  }

  // 检查 type
  if (card.type && !SANDBOX_TYPES.includes(card.type)) {
    errors.push(`type 无效: ${card.type}，可选: ${SANDBOX_TYPES.join(', ')}`);
  }

  // 检查 endpoints 是否包含 a2a
  if (card.endpoints && !card.endpoints.a2a && !card.endpoints.json_rpc) {
    errors.push('endpoints 至少需要 a2a 端点');
  }

  // 检查 capabilities
  if (card.capabilities && Array.isArray(card.capabilities)) {
    if (card.capabilities.length === 0) {
      errors.push('capabilities 不能为空列表');
    }
    for (const cap of card.capabilities) {
      if (!cap.name) {
        errors.push('capabilities 中每个条目必须有 name');
      }
    }
  }

  // 检查 status
  if (card.status && !['online', 'offline', 'busy', 'away'].includes(card.status)) {
    errors.push(`status 无效: ${card.status}`);
  }

  // 检查 harness_manifest 结构与只读红线（C1/C2 声明 readonly:false 视为违规）
  if (card.harness_manifest) {
    const hm = card.harness_manifest;
    if (typeof hm.components !== 'object') {
      errors.push('harness_manifest.components 必须是对象');
    } else {
      for (const must of ['C1', 'C2']) {
        const c = hm.components[must];
        if (c && c.declared && c.readonly !== true) {
          errors.push(`harness_manifest.${must} 必须 readonly:true（红线：C1/C2 只读）`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 生成 Agent Card 的 /.well-known/agent.json 格式
 * @param {Object} card
 * @returns {Object} wellKnownCard
 */
function toWellKnown(card) {
  return {
    name: card.name,
    id: card.id,
    type: card.type,
    version: card.version,
    capabilities: card.capabilities.map(c => c.name),
    endpoints: card.endpoints,
    status: card.status,
    trust_score: card.trust?.score || 0,
    harness_manifest: card.harness_manifest || null,
    experience_ref: card.experience_ref || null,
    last_seen: card.last_seen,
  };
}

/**
 * 创建最小 Agent Card（ephemeral 场景）
 * @param {string} name
 * @param {string} id
 * @param {Object} endpoints
 * @returns {Object} minimalCard
 */
function minimal(name, id, endpoints) {
  return build({
    name,
    id,
    type: 'ephemeral',
    endpoints,
    capabilities: [{ name: 'basic', level: 'intermediate' }],
  });
}

module.exports = {
  build, validate, toWellKnown, minimal, normalizeManifest,
  REQUIRED_FIELDS, SANDBOX_TYPES, CAPABILITY_LEVELS,
};
