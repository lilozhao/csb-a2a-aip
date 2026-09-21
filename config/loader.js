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
  // [2026-09-21] 环境差异显式化：env 优先，配置文件只做兜底。
  //   三场景（一澜 2026-09-21 定）：
  //     ① Docker 内网 → http://172.28.0.4:3099
  //     ② 公网      → http://csbc.lilozkzy.top:3099
  //     ③ 宿主机    → http://localhost:3099（宿主机自带注册表）
  //   各自在自己的启动点注入 A2A_REGISTRY_URL；未注入时才回落 agents.json。
  //   严格增量：不动兜底值、不改任何实例行为（未设 env 时路径与旧版完全一致）。
  if (type === 'local') {
    const envUrl = (process.env.A2A_REGISTRY_URL || '').trim();
    if (envUrl) return envUrl.replace(/\/+$/, '');
  }
  const cfg = load();
  return type === 'public' ? cfg.registry.public : cfg.registry.local;
}

/** 获取 Skill 服务器地址 */
function getSkillServer() {
  return load().skillServer;
}

/** 获取本机配置 */
function getSelf() {
  return load().self;
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
