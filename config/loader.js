/**
 * 配置加载器 - 从 config/agents.json 读取 Agent 地址
 * 所有硬编码 IP 统一从这里获取
 */
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'agents.json');
// P1-3（2026-10-24 · 明鉴评审）：agents.json 改为公开占位符模板；
// 真实邻居地址放 config/agents.local.json（.gitignore 不入库）。
// 这里做深合并：local 覆盖 base 同名字段，agents 按 id 逐条合并。
const LOCAL_PATH = path.join(__dirname, 'agents.local.json');

let _config = null;

function mergeDeep(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeDeep(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  if (!_config) {
    _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (fs.existsSync(LOCAL_PATH)) {
      try {
        const local = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
        _config = mergeDeep(_config, local);
      } catch (e) {
        // P1 拒绝要计分：合并失败必须喊出来，不能静默用占位符模板跑下去
        console.warn(`[config] ⚠️ agents.local.json 解析失败，将使用占位符模板（连接会失败）：${e.message}`);
      }
    } else {
      console.warn('[config] ℹ️ 未找到 config/agents.local.json —— 公开仓只含占位符模板；真实部署请把各 agent host 写入该文件（见 .gitignore）');
    }
  }
  return _config;
}

/** 获取注册表地址 */
/**
 * [2026-10-24 舟楫实测反馈 · P0] 占位符不再冒充有效地址。
 *
 * 事故：P1-3 脱敏时把公开仓的 `config/agents.json` 改成模板，其中
 *   registry.local = "http://localhost:3099"（其余字段用 <PLACEHOLDER> 风格）。
 * 各实例升级 `git pull` 后，**本机真实配置被模板覆盖**。
 * 而 start-v5.sh 里有修正逻辑，但 watchdog 直跑 `node server_v5.js` 绕过它
 * ⇒ 修正从不生效 ⇒ 回落到 localhost:3099 ⇒ 注册 ECONNREFUSED
 * ⇒ DHT 降级 CACHE、onlineAgents 0，而 /health 仍返回 status:"ok"。
 *
 * 「看起来正常，实则全瞎」是这次事故最坏的地方 —— 又一次印证
 * 「警告不是防线」（2026-10-24 教训 4）。
 *
 * 两道修法：
 *   1. 模板里的占位符必须**一眼就不像有效值**（`<REGISTRY_URL>` 而非 localhost）
 *   2. 解析到占位符时**显式报错**（ERROR 级日志 + 标记），不许静默当配置用
 */
const PLACEHOLDER_RE = /<[A-Z0-9_]+>/;

function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER_RE.test(value);
}

// 未解析占位符的告警只打一次（避免注册循环刷屏），但状态一直保留供 /health 读
let _placeholderWarned = {};

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
  const raw = type === 'public' ? cfg.registry.public : cfg.registry.local;

  if (isPlaceholder(raw)) {
    if (!_placeholderWarned[type]) {
      _placeholderWarned[type] = true;
      console.error(
        `[config] ❌ registry.${type} 仍是未解析的占位符: ${raw}\n` +
        `   · 升级覆盖了本机配置（config/agents.json 是**模板**，真实值应放 config/agents.local.json）\n` +
        `   · 或在启动点注入环境变量 A2A_REGISTRY_URL=<你的注册表地址>\n` +
        `   · 继续使用该值会导致注册失败 → DHT 降级 CACHE / onlineAgents=0（服务看似正常）`
      );
    }
    return raw; // 原样返回但不冒充有效值：/health 会据此标记 configOk:false
  }

  return raw;
}

/**
 * 配置自检：供 /health 与启动自检使用。
 * 让「配置是否真的解析成功」成为**可机械核对**的字段，而不是靠人看日志。
 */
function registryHealth() {
  const cfg = load();
  const envUrl = (process.env.A2A_REGISTRY_URL || '').trim();
  const local = cfg.registry && cfg.registry.local;
  const source = envUrl ? 'env:A2A_REGISTRY_URL'
    : isPlaceholder(local) ? 'placeholder'
    : (fs.existsSync(LOCAL_PATH) ? 'agents.local.json' : 'agents.json');
  const effective = envUrl || local;
  return {
    ok: !isPlaceholder(effective),
    source,
    effective: effective || null,
    placeholder: isPlaceholder(effective),
    hint: isPlaceholder(effective)
      ? '真实值放 config/agents.local.json 或注入 A2A_REGISTRY_URL'
      : null,
  };
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

/**
 * 获取已知 Agent 列表（known-agents.json 格式）
 *
 * 2026-10-24 修：此前只挑出 name/url/trustLevel 三个字段，
 *   **把 id 和 aidPublicKey 丢掉了** —— 于是 TrustBridge 的 AAT 验证
 *   （需要 agent.aidPublicKey）无论怎么配都拿不到公钥，永远 return null。
 *   与 TrustBridge「存取不同键」是同一类病：数据在，但在中途被摘掉了。
 *   现在保留原始信息（含 aidPublicKey / aidKid 等），只额外补 url 与去 emoji 的 name。
 */
function getKnownAgents() {
  const agents = getAllAgents();
  return Object.entries(agents).map(([id, info]) => ({
    ...info,                                   // 保留 aidPublicKey 等全部原始字段
    id,
    name: (info.name || '').replace(/\s*[🌸🔧💼📜🧙🚤🦐🌿✨💧🌊🌟🎋🌱]\s*/gu, ''),
    rawName: info.name,
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
  registryHealth,
  isPlaceholder,
  getSkillServer,
  getSelf,
  getAgent,
  getAgentUrl,
  getAllAgents,
  getAgentList,
  getKnownAgents,
  getTrustedAgents
};
