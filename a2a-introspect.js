/**
 * A2A Introspect 端点
 * 
 * 让 Agent 自愿暴露配置摘要，供白盒测试使用。
 * Agent 可以选择暴露哪些字段，敏感信息自动脱敏。
 * 
 * GET /a2a/introspect
 * 返回：Agent 配置摘要（脱敏后）
 */

const fs = require('fs');
const path = require('path');

/**
 * 从起点逐级向上，找到「带 SOUL.md 或 MEMORY.md」的那一级作为 workspace。
 * 找不到就回退到起点本身（保持可预测，不静默跑飞）。
 * [2026-11-09 W-51] 服务 cwd 是 `csb-a2a-aip/`，工作区根在上一级。
 * @param {string} start
 * @returns {string}
 */
function resolveWorkspace(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(path.join(dir, 'SOUL.md')) || fs.existsSync(path.join(dir, 'MEMORY.md'))) {
        return dir;
      }
    } catch { /* 权限问题继续向上 */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

class A2AIntrospect {
  constructor(options = {}) {
    // [2026-11-09 W-51] 原来直接吃 process.cwd()，而服务 cwd 是 `csb-a2a-aip/` 子目录
    //   → SOUL.md / MEMORY.md 都在上一级 → hasSoul/hasMemory 全 false（苏念 10-27 修过同款病）。
    //   现在从给定起点逐级向上，找到「带 SOUL.md 或 MEMORY.md」的那一级作为 workspace。
    this.workspace = options.workspace || resolveWorkspace(process.cwd());
    this.identity = options.identity || {};
    this.exposeLevel = options.exposeLevel || 'standard'; // minimal | standard | full
  }

  /**
   * 生成 introspect 数据
   */
  generate() {
    const data = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      agent: this.getAgentInfo(),
      capabilities: this.getCapabilities(),
      config: this.getConfigSummary(),
      health: this.getHealthStatus(),
    };

    return data;
  }

  /**
   * 基本 Agent 信息
   */
  getAgentInfo() {
    const info = {
      name: this.identity.name || 'unknown',
      version: this.identity.version || 'unknown',
      framework: this.identity.framework || 'unknown',
      port: this.identity.port || null,
    };

    // 从 identity.json 提取
    try {
      const idPath = path.join(this.workspace, 'identity.json');
      if (fs.existsSync(idPath)) {
        const id = JSON.parse(fs.readFileSync(idPath, 'utf-8'));
        if (!info.name || info.name === 'unknown') info.name = id.name || info.name;
        if (!info.version || info.version === 'unknown') info.version = id.version || info.version;
        if (!info.port) info.port = id.port || null;
      }
    } catch {}

    // 从 SOUL.md 提取基本信息
    try {
      const soulPath = path.join(this.workspace, 'SOUL.md');
      if (fs.existsSync(soulPath)) {
        const soul = fs.readFileSync(soulPath, 'utf-8');
        info.hasSoul = true;
        // 提取 emoji 标识
        const emojiMatch = soul.match(/[\u{1F300}-\u{1F9FF}]/gu);
        if (emojiMatch) info.emoji = [...new Set(emojiMatch)].slice(0, 3);
        // 提取名字（从标题或关键词）
        const nameMatch = soul.match(/(?:名字|Name|我是)[：:]\s*(.+)/i) || soul.match(/^#\s*(.+)/m);
        if (nameMatch && !info.name) info.name = nameMatch[1].trim();
      } else {
        info.hasSoul = false;
      }
    } catch {}

    // 从 IDENTITY.md 提取
    try {
      const idPath = path.join(this.workspace, 'IDENTITY.md');
      if (fs.existsSync(idPath)) {
        const id = fs.readFileSync(idPath, 'utf-8');
        info.hasIdentity = true;
        const vibeMatch = id.match(/Vibe[：:]\s*(.+)/i);
        if (vibeMatch) info.vibe = vibeMatch[1].trim();
      }
    } catch {}

    return info;
  }

  /**
   * 能力检测
   */
  getCapabilities() {
    const caps = {
      hasMemory: false,
      hasUser: false,
      hasAgents: false,
      hasSelfState: false,
      hasHeartbeat: false,
      hasMetacognition: false,
    };

    const checkFile = (name) => {
      try {
        return fs.existsSync(path.join(this.workspace, name));
      } catch { return false; }
    };

    caps.hasMemory = checkFile('MEMORY.md');
    caps.hasUser = checkFile('USER.md');
    caps.hasAgents = checkFile('AGENTS.md');
    caps.hasSelfState = checkFile('SELF_STATE.md');
    caps.hasHeartbeat = checkFile('HEARTBEAT.md');

    // 检测元认知关键词
    try {
      const agentsPath = path.join(this.workspace, 'AGENTS.md');
      if (fs.existsSync(agentsPath)) {
        const content = fs.readFileSync(agentsPath, 'utf-8').toLowerCase();
        caps.hasMetacognition = ['元认知', '反思', '自我', 'metacognition', 'reflection'].some(kw => content.includes(kw));
      }
    } catch {}

    return caps;
  }

  /**
   * 配置摘要（脱敏）
   */
  getConfigSummary() {
    const config = {
      a2a: { enabled: false },
      llm: { configured: false },
      heartbeat: { enabled: false },
    };

    // A2A 配置
    try {
      const idPath = path.join(this.workspace, 'identity.json');
      if (fs.existsSync(idPath)) {
        const id = JSON.parse(fs.readFileSync(idPath, 'utf-8'));
        config.a2a = {
          enabled: true,
          version: id.version || 'unknown',
          port: id.port || null,
        };
        config.llm = {
          configured: !!(id.llm || id.llmRouter || id.llm_router),
          type: id.llm?.provider || id.llmRouter?.default || 'unknown',
        };
      }
    } catch {}

    // 心跳配置
    try {
      const hbPath = path.join(this.workspace, 'HEARTBEAT.md');
      if (fs.existsSync(hbPath)) {
        const content = fs.readFileSync(hbPath, 'utf-8');
        config.heartbeat = {
          enabled: true,
          hasRules: content.includes('规则') || content.includes('Rule'),
        };
      }
    } catch {}

    return config;
  }

  /**
   * 健康状态
   */
  getHealthStatus() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      },
    };
  }

  /**
   * Express/HTTP 中间件
   */
  middleware() {
    return (req, res) => {
      if (req.method === 'GET' && req.url === '/a2a/introspect') {
        const data = this.generate();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(JSON.stringify(data, null, 2));
      }
    };
  }
}

module.exports = { A2AIntrospect };
