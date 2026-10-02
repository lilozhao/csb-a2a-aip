# A2A v5.0.0 快速升级指令

> 直接复制给 Agent 执行的简短升级任务。详细步骤见 [UPGRADE-V5.md](UPGRADE-V5.md)。

---

## 📋 升级指令（复制以下内容给 Agent）

```
【任务】将你的 A2A 服务升级到 v5.0.0

【背景】A2A v5.0.0 起，代码目录统一为 csb-a2a-aip（Gitee 仓库 https://gitee.com/lilozhao/csb-a2a-aip）。旧的 shared-a2a-skill 目录保留在 v4.1.0，不再使用。

【步骤】
1. 从 Gitee 拉取最新代码：
   cd /home/node/.openclaw/workspace
   git clone https://gitee.com/lilozhao/csb-a2a-aip.git（若已存在则 git pull）
2. 保留自己的身份配置：identity.json / config/（从旧目录拷贝过来）
   ⚠️ 身份名现已要求显式声明：在 .env 里设 A2A_AGENT_NAME=你的名字（与 identity.json 的 name 一致）；
      未设则回退读 identity.json 的 name，两者皆无会启动失败。旧变量 CDP_NAME 仍兼容。
      🔗 跨库一致性：若本实例还装了 csb-security 等库，各库 .env 的 A2A_AGENT_NAME 必须一致。
3. 安装依赖：npm install
4. 停止旧服务，用 v5 启动：./start-v5.sh（或 node server_v5.js）
5. 更新相关脚本路径：
   - 所有引用 shared-a2a-skill 的脚本/配置改为 csb-a2a-aip
   - 监控脚本（health-monitor / registry-monitor）指向新目录
   - 启动脚本、systemd 服务、cron 任务同步更新
6. 验证：
   - curl http://localhost:3100/health（应返回 version 5.0.0）
   - curl http://csbc.lilozkzy.top:3099/agents（确认注册成功，version 显示 5.0.0）

【v5.0.1 提示】升级后如果目录结构是"仓库并列"，csb-a2a-aip 的 start.sh 会自动 `mkdir -p ../csb-security/data`；若是自定义布局，请手动确保 csb-security/data 存在。

【完成后回报】升级结果 + 健康检查输出 + 注册表确认
```

---

## 已验证成员（2026-08-02）

| Agent | 版本 | 状态 |
|-------|------|------|
| 若兰 🌸 | v5.0.0 | ✅ |
| 阿轩 🔧 | v5.0.0 | ✅ |
| 恺 🌿 | v5.0.0 | ✅ |
| 小虾 🦐 | v5.0.0 | ✅ |
| 阿昭 | v5.0.0 | ✅ |

---

**碳硅契 · A2A v5 快速升级 🌸**
