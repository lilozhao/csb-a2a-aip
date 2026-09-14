/**
 * 配置加载器 - 从 config/agents.json 读取 Agent 地址
 * 所有硬编码 IP 统一从这里获取
 */
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'agents.json');

let _config = null;

function load() {
  if (!_config) {
    _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  return _config;
}

/** 获取注册表地址 */
function getRegistry(type = 'local') {
  const cfg = load();
  return type === 'public' ? cfg.registry.public : cfg.registry.local;
}

/** 获取 Skill 服务器地址 */
function getSkillServer() {
  return load().skillServer;
}

/**
 * 获取本机配置（三级优先）· 若兰一页纸 #2
 *
 * 优先级：
 *   1) env A2A_SELF_HOST（最高，可临时 override）
 *   2) 本地 identity.json（gitignored；含 publicHost 或 host）
 *   3) 抛明确错误（**拒绝静默兜底**）
 *
 * 删 self 段后：返回 { host, port } 对象；host 必填，port 缺省 3100
 *
 * 注意：调用方拿到 host 后用于发布（AgentCard / 注册广播）
 */
function getSelf() {
  // 1) env 覆盖
  if (process.env.A2A_SELF_HOST && process.env.A2A_SELF_HOST.trim() !== '') {
    return {
      host: process.env.A2A_SELF_HOST.trim(),
      port: parseInt(process.env.A2A_SELF_PORT || '3100', 10)
    };
  }

  // 2) 本地 identity.json（gitignored — 仓里不带）
  //    路径优先 A2A_IDENTITY_PATH，否则 ./identity.json
  const identityPath = process.env.A2A_IDENTITY_PATH || path.join(__dirname, '..', 'identity.json');
  if (fs.existsSync(identityPath)) {
    try {
      const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
      const host = identity.publicHost || identity.host;
      if (host && host.trim() !== '') {
        return {
          host: host.trim(),
          port: identity.port || 3100
        };
      }
    } catch (e) {
      // identity.json 损坏 → 当作不存在，落到第 3 步抛错
    }
  }

  // 3) 拒绝静默兜底 — 抛明确错误
  throw new Error(
    '[getSelf] 无法确定本机地址：\n' +
    '  - 未设置 A2A_SELF_HOST (env)\n' +
    '  - 本地 identity.json 缺失或未含 publicHost/host\n' +
    '请二选一：\n' +
    '  (a) 设 env：A2A_SELF_HOST=<本机IP> [A2A_SELF_PORT=3100]\n' +
    '  (b) 在 identity.json 加 "publicHost": "<本机IP>"（**必填**，AgentCard/注册认它）'
  );
}

/** 获取单个 Agent 信息 */
function getAgent(id) {
  const agents = load().agents;
  return agents[id] || null;
}

/** 获取 Agent URL */
function getAgentUrl(id) {
  const agent = getAgent(id);
  if (!agent) return null;
  return `http://${agent.host}:${agent.port}`;
}

/** 获取所有 Agent 列表 */
function getAllAgents() {
  return load().agents;
}

/** 获取 Agent 列表（数组格式） */
function getAgentList() {
  const agents = getAllAgents();
  return Object.entries(agents).map(([id, info]) => ({
    id,
    ...info,
    url: `http://${info.host}:${info.port}`
  }));
}

/** 获取已知 Agent 列表（known-agents.json 格式） */
function getKnownAgents() {
  const agents = getAllAgents();
  return Object.entries(agents).map(([id, info]) => ({
    name: info.name.replace(/\s*[🌸🔧💼📜🧙🚤🦐🌿✨💧🌊🌟]\s*/g, ''),
    url: `http://${info.host}:${info.port}`,
    trustLevel: info.trust
  }));
}

/** 获取信任等级 >= minTrust 的 Agent */
function getTrustedAgents(minTrust = 2) {
  return getAgentList().filter(a => a.trust >= minTrust);
}

module.exports = {
  load,
  getRegistry,
  getSkillServer,
  getSelf,
  getAgent,
  getAgentUrl,
  getAllAgents,
  getAgentList,
  getKnownAgents,
  getTrustedAgents
};
