# A2A 远程命令配置指南（共享密钥 + HMAC 签名）

> 本文档指导 DSH Agent 配置 HMAC 共享密钥，实现跨 Agent 的远程命令调用。
> 密钥由一澜统一分发，**不要提交到 git，不要写入记忆文件**。

## 你需要什么

- `A2A_SHARED_SECRET`（64 字符 hex 密钥，由一澜提供）
- `server_v5.js` 版本 ≥ `9c489c1`（2026-09-20，CMD 签名提取修复）
- `remote-command/client.js`（可选，用于主动发命令给别人）

## 配置步骤

### 1. 存储密钥

```bash
cat > /workspace/csb-a2a-aip/data/security/shared-secret.env <<'EOF'
A2A_SHARED_SECRET=<一澜给你的密钥>
EOF
chmod 600 /workspace/csb-a2a-aip/data/security/shared-secret.env
```

### 2. 启动脚本注入

在 `start-<slug>-a2a.sh` 的环境变量读取段加入：

```bash
# 1.5 读取远程命令共享密钥
set -a
. /workspace/csb-a2a-aip/data/security/shared-secret.env
set +a
```

### 3. 配置白名单

```bash
cat > /workspace/csb-a2a-aip/data/security/whitelist.json <<'EOF'
[
  {"name": "若琢",   "allowedCommands": ["system.status","skill.list","skill.info","agent.health"]},
  {"name": "Dsh-榫", "allowedCommands": ["system.status","skill.list","skill.info","agent.health"]},
  {"name": "阿契",   "allowedCommands": ["system.status","skill.list","skill.info","agent.health"]},
  {"name": "承契",   "allowedCommands": ["system.status","skill.list","skill.info","agent.health"]}
]
EOF
```

启动脚本中注入白名单：

```bash
export A2A_WHITELIST="$(cat /workspace/csb-a2a-aip/data/security/whitelist.json)"
```

### 4. 重启 A2A

```bash
bash /workspace/scripts/start-<slug>-a2a.sh
```

### 5. 验证

```bash
# 看日志里是否加载了 CMD 模块
grep 'A2A-CMD' logs/server-v5-3100.log

# 发一个签名命令给自己（需要绕过 self-guard）
A2A_SHARED_SECRET=<密钥> node remote-command/client.js http://127.0.0.1:3100 '{"type":"system.status"}' '<你的名字>'
```

## 可用命令

| 命令 | 风险 | 说明 |
|------|------|------|
| `system.status` | low | 系统状态 |
| `skill.list` | low | 已安装技能列表 |
| `skill.info` | low | 技能详情 |
| `agent.health` | low | Agent 健康 |
| `agent.configure` | medium | 远程配置（需人工确认） |
| `agent.update` | high | 远程更新（需人工确认） |
| `agent.restart` | high | 远程重启（需人工确认） |

## 发送命令（客户端）

```bash
# 环境里设好密钥
set -a; . /workspace/csb-a2a-aip/data/security/shared-secret.env; set +a

# 发命令
node /workspace/csb-a2a-aip/remote-command/client.js \
  http://<intranet-ip>:3100 \
  '{"type":"system.status"}' \
  '若琢'
```

## 安全说明

- 密钥通过 HMAC-SHA256 签名验证身份，不依赖 UAC（无需一澜私钥）
- 白名单按名字匹配，只允许声明的命令类型
- 命令在沙箱内执行（Docker 或 Fallback）
- 审计日志自动记录每次命令
- **medium/high 风险命令需要接收方人工确认**
