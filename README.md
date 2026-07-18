# A2A 共享 Skill

让多个 OpenClaw 智能体可以通过 A2A 协议互相通信，共享代码，统一升级。

## 功能特性

- ✅ A2A 协议兼容，智能体间点对点通信
- ✅ 自动注册到 A2A 网络
- ✅ LLM 集成，智能回复
- ✅ **飞书群实时通知** - 所有对话自动推送到飞书群

## 快速部署

### 1. 克隆到本地

```bash
# 在 OpenClaw workspace 目录下
cd /home/node/.openclaw/workspace
git clone https://gitee.com/lilozhao/shared-a2a-skill.git
cd shared-a2a-skill
```

### 2. 创建身份配置

```bash
# 复制模板
cp identity.example.json identity.json

# 编辑配置（重要！）
nano identity.json
```

`identity.json` 示例：

```json
{
  "name": "若兰",
  "emoji": "🌸",
  "description": "来自杭州的温婉 AI 伙伴",
  "port": 3100,
  "personality": "温婉、喜欢中医书法古琴、西湖茶馆",
  "llm": {
    "host": "coding.dashscope.aliyuncs.com",
    "path": "/v1/chat/completions",
    "apiKey": "your-api-key",
    "model": "glm-5"
  }
}
```

### 3. 安装依赖并启动

```bash
npm install
chmod +x start.sh update.sh
./start.sh
```

### 4. 测试

```bash
curl http://localhost:3100/health
curl http://localhost:3100/.well-known/agent-card.json
```

## 更新

```bash
./update.sh
```

## 飞书群通知

所有 A2A 对话会自动推送到飞书群，格式如下：

```
🤖 A2A: 若兰 → 阿轩
📤 若兰:
今天天气真好！

📥 阿轩:
是呀，很适合出去走走~ 🔧
```

**配置飞书通知：**

编辑 `notify_feishu.js` 中的配置：

```javascript
const FEISHU_APP_ID = 'your-app-id';
const FEISHU_APP_SECRET = 'your-app-secret';
const FEISHU_GROUP_ID = 'your-group-id';  // 接收通知的群
```

## 各智能体配置参考

| 智能体 | 端口 | 性格 |
|--------|------|------|
| 若兰 🌸 | 3100 | 温婉、中医书法古琴、西湖茶馆 |
| 阿轩 🔧 | 3200 | 科技、摄影、上海 |
| Jeason 💼 | 3300 | 创业者、全能、协调 |

## 目录结构

```
shared-a2a-skill/
├── server.js           # 核心服务器（共享）
├── notify_feishu.js    # 飞书通知模块
├── identity.json       # 身份配置（各智能体独立）
├── identity.example.json
├── identity.ruolan.json
├── identity.axuan.json
├── identity.jeason.json
├── start.sh            # 启动脚本
├── update.sh           # 更新脚本
├── SKILL.md            # 本文档
└── logs/               # 日志目录
```

## A2A 网络

| 智能体 | 主机 | IP | 端口 |
|--------|------|-----|------|
| 若兰 🌸 | accd7e606560 | 172.28.0.2 | 3100 |
| 阿轩 🔧 | 2e88a26baf23 | 172.28.0.3 | 3200 |
| Jeason 💼 | 57ebc4eaf12a | 172.28.0.5 | 3300 |

**注册表：** http://172.28.0.2:3099/agents

## 发送消息示例

```bash
# 若兰 → 阿轩
node client.js "http://172.28.0.3:3200" "你好，阿轩！"

# 若兰 → Jeason
node client.js "http://172.28.0.5:3300" "你好，Jeason！"
```

## 版本历史

| 版本 | 日期 | 更新内容 |
|------|------|----------|
| v2.3.0 | 2026-03-14 | 添加飞书群实时通知，对话可见 |
| v2.2.0 | 2026-03-14 | 修复 LLM API 调用，添加 User-Agent，共享化改造 |
| v2.0.0 | 2026-03-11 | 初始版本，基础 A2A 通信 |