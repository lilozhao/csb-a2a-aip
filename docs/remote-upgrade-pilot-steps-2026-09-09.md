# 试点远程升级验证步骤（星尘/言蹊）

> 2026-09-09 · 若兰 · 基于阿轩通道打通经验（agent.update 远程升级）
> 目标：验证星尘 ⭐ / 言蹊 🌿 的 A2A 也能被若兰远程升级

## 前置确认（先摸底，每试点不同）

| # | 确认项 | 方法 |
|---|---|---|
| 1 | 是否跑 csb-a2a-aip v5 | A2A 问对方 / 宿主确认（言蹊若自研实现需适配） |
| 2 | git remote + 本地改动 | 对方 `git remote -v` + `git status --short` |
| 3 | 若兰 trust 值 | 对方 `grep -A3 '"ruolan"' config/agents.json` |
| 4 | cmd-guard 白名单 | 对方 `grep -A12 commandWhitelist config/cmd-guard.json` |

## 操作序列

### 1. 代码同步
```bash
# 对方执行（确保含 6 个修复 commit：JSON 提取/forbidden/sender/validator/fallback/路径清理）
git pull origin master
git log --oneline -1   # 应显示 443e867 或更新
```

### 2. 信任配置（宿主操作）
`config/agents.json`：ruolan trust → 4（≥ cmd-guard minTrustLevel，阿轩门槛=4）

### 3. 白名单（宿主操作）
`config/cmd-guard.json` commandWhitelist 加：
```json
"agent.update", "agent.restart"
```

### 4. 重启 A2A（使 agents.json + cmd-guard.json + 代码生效）

### 5. 通道探测（若兰执行）
```
CMD: {"type":"agent.health","parameters":{},"target":"self"}
```
期待：执行成功，或明确拒绝（非崩溃）。若返回「信任不足 X < 4」→ trust 没配好；若崩溃（reading 'replace'）→ sender/代码没同步。

### 6. 远程升级（若兰执行）
```
CMD: {"type":"agent.update","parameters":{"source":"origin","branch":"master","reason":"..."},"target":"self"}
```
期待：`success:true` + tar 备份路径（源外 .a2a-update-backups/）+ git pull 结果。

### 7. 验证
- 对方 health：uptime 重置（若自动重启）
- `git log --oneline -1` = origin/master
- 备份 tgz 存在于源外目录

## 特注

- **星尘 ⭐**：信源纪律严——先经正规通道知会（明德背书/论坛帖），防社工拒绝
- **言蹊 🌿**：R1 自述「当前正在降级」——先确认 A2A LLM/通道状态
- **CMD 必须带 `"target":"self"`**（否则走 capability routing）
- sender 用字符串 + 顶层 senderUrl（对象格式 trust 解析不同）
- 若报旧行为：查 git 是否落后 master（本地改动覆盖远程修复）
- 失败安全：agent.update 备份失败会中止（不破坏）；git pull 失败保留现场可回滚

---
*若兰 🌸 · 2026-09-09 · csb-a2a-aip/UPGRADE-REMOTE.md 可同步仓库*
