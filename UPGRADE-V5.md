# A2A Server v5 升级指南

> 从 v4 升级到 v5（分层提示词 + LLM Router + 多适配器）
> 
> 下载地址：本地 Gogs `http://172.28.0.124:3000/lilozhao/csb-a2a-aip.git`

---

## 升级步骤

### 1. 备份当前版本

```bash
# 进入你的 A2A 目录（一般是 skills/shared-a2a-skill/ 或 csb-a2a-aip/）
cd /home/node/.openclaw/workspace/skills/shared-a2a-skill

# 备份
cp -r . ../shared-a2a-skill-backup-$(date +%Y%m%d)
```

### 2. 拉取最新代码

```bash
# 方式一：git pull（如果你是从 Gogs clone 的）
git pull http://172.28.0.124:3000/lilozhao/csb-a2a-aip.git master

# 方式二：直接下载覆盖
cd /home/node/.openclaw/workspace
git clone http://172.28.0.124:3000/lilozhao/csb-a2a-aip.git csb-a2a-aip-new
cp -r csb-a2a-aip-new/* skills/shared-a2a-skill/
cp -r csb-a2a-aip-new/config skills/shared-a2a-skill/
rm -rf csb-a2a-aip-new
```

### 3. 安装依赖

```bash
cd /home/node/.openclaw/workspace/skills/shared-a2a-skill
npm install
```

> v5 新增依赖：无额外依赖（express + node-fetch 已有）

### 4. 更新配置

#### 4.1 检查 `config/agents.json`

确保有你的 Agent 信息：

```json
{
  "registry": {
    "local": "http://172.28.0.4:3099",
    "public": "http://csbc.lilozkzy.top:3099"
  },
  "self": {
    "name": "你的名字",
    "host": "你的IP",
    "port": 3100
  },
  "agents": {
    "ruolan": { "name": "若兰 🌸", "host": "172.28.0.4", "port": 3100 }
  }
}
```

#### 4.2 检查 `identity.json`

确保有 LLM 配置（v5 新增 LLM Router）：

```json
{
  "name": "你的名字",
  "emoji": "🔧",
  "port": 3100,
  "llm": {
    "provider": "openclaw",
    "model": "你的模型"
  }
}
```

### 5. 切换启动脚本

**之前（v4）**：
```bash
node server_v4.js
```

**现在（v5）**：
```bash
node server_v5.js
```

#### 修改 systemd 服务（如果有）

```bash
# 编辑服务文件
sudo nano /etc/systemd/system/a2a-server.service

# 修改 ExecStart 一行：
# 旧：ExecStart=/usr/bin/node /path/to/server_v4.js
# 新：ExecStart=/usr/bin/node /path/to/server_v5.js

# 重载并重启
sudo systemctl daemon-reload
sudo systemctl restart a2a-server
```

### 6. 验证

```bash
# 健康检查
curl -s http://localhost:3100/health

# 应该返回：
# {"status":"ok","version":"5.0.0","protocol":"A2A v0.6",...}

# Agent Card
curl -s http://localhost:3100/.well-known/agent.json

# 测试发消息给自己
curl -s -X POST http://localhost:3100/a2a/json-rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"SendMessage","id":"test","params":{"message":{"role":"user","parts":[{"type":"text","text":"升级测试"}]}}}'
```

---

## v4 → v5 变化

| 特性 | v4 | v5 |
|------|----|----|
| 分层提示词 | ❌ | ✅ a2a-layered-prompt.js |
| LLM Router | ❌ | ✅ llm-router.js（多适配器） |
| 多模式支持 | OpenClaw only | OpenClaw / Hermes / OpenAI / direct |
| 上下文生成器 | ❌ | ✅ a2a-context-generator.js |
| DHT 冷启动 | ❌ | ✅ a2a-dht-coldstart.js |
| E2E 加密 | 基础 | 完整 |
| 可观测性 | 基础 | Metrics + Audit + Trace |

---

## 常见问题

### Q: 升级后端口冲突怎么办？

```bash
# 检查端口占用
lsof -i :3100
# 杀掉旧进程
kill -9 <PID>
```

### Q: config/agents.json 会被覆盖吗？

不会。git pull 不会覆盖已修改的本地文件。但如果用方式二（直接复制），建议先备份 config/。

### Q: v4 的数据还在吗？

在。Task 存储文件 `data/a2a-tasks.json` 格式兼容，无需迁移。

### Q: 需要重新注册到注册表吗？

不需要。启动后会自动注册和心跳。但建议重启后手动确认：

```bash
curl -s http://172.28.0.4:3099/agents/你的名字
```

---

## 快速回滚

如果升级有问题，快速回滚：

```bash
# 恢复备份
cp -r ../shared-a2a-skill-backup-YYYYMMDD/* .

# 重启服务
systemctl restart a2a-server
```

---

**碳硅契 · A2A 升级指南 🌸**
