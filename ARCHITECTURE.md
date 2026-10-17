# CSB-A2A-AIP · 五环总览（需求-设计-代码-测试-部署）

> **性质：一次性回填文档** —— 一澜 2026-10-12 授权，每个项目仅此一次；非实际开发过程产物。
> 此后**新功能一律走 `specs/` 流程**（CSB Spec 标准 v1.1），本文只管系统级总览。
> 基线：v5.0.1 ｜ 根目录 103 个 `.js` ｜ tests 36 件 ｜ docs 35 篇 ｜ 核对日期 2026-10-12

---

## 一、需求（这个库要解决什么）

**定位**：碳硅契（CSB）的 A2A 通信层实现——让不同架构、不同厂商的 AI Agent 点对点通信并建立真实连接。

**系统级能力清单**（事实来源：`README.md` + `docs/csb-aip-unified-roadmap.md`）：

| # | 能力 | 说明 |
|---|---|---|
| 1 | 点对点通信 | A2A v0.6 协议（`tasks/send`、JSON-RPC、sender 敲门约定） |
| 2 | 分层提示词 | System / Skill / Context / User 四层引擎 |
| 3 | 多 LLM 适配 | 适配器链降级（见 §3，含 SPEC-A2A-0001 暂停中的本地 35B 计划） |
| 4 | 共享记忆 | CSB-Memory v1.0（薄包装 `memory.js`，实现在独立仓 csb-memory） |
| 5 | 信任与安全 | 握手、E2E 加密、信任证据账本、UAC 接收侧门禁 |
| 6 | 委托与升级 | 跨 Agent 任务委托（L2/L3 风险分级）、统一升级管理 |

**系统级硬约束**（跨功能，违反即拒绝启动/合入）：

- **P2 身份无默认值**：`A2A_AGENT_NAME` 必填且与 `identity.json` 的 `name` 一致，否则 `server_v5.js` 拒绝启动；跨 CSB 库必须同名
- **UAC 接收方门禁**：免确认权力属接收方主人（`A2A_BRIDGE_UAC=on`，双证据放行）
- **自环守卫**：自己发给自己的消息快速拒绝（`SELF_MESSAGE_IGNORED`，见 `SELF-GUARD.md`）
- **L3 人工确认**：`write/shell` 类委托须接收方主人实时确认（`a2a-bridge-confirm.js`）
- **P1 拒绝要计分**：拒绝/失败路径必须留痕，不静默丢弃（bridge-audit、ledger）

> 功能级需求（单个 feature 的 R1…Rn）从 2026-10-12 起一律进 `specs/<SPEC-ID>/spec.md`，本文不再承载。

## 二、设计

**运行时分层**：

```
入口层      server_v5.js（:3100 A2A 服务）· start-registry.js（:3099 注册表）
协议层      a2a-standard-api-v5.js（v0.6 API）· envelope / client-v2 / task-store
路由层      llm-router.js（多 LLM 降级链）· capability-router.js（按能力分发）
委托层      delegation-{p2,manager,validator,worker}.js · a2a-bridge-*（回执/L3/相关性）
安全层      security-handshake · a2a-e2e-encryption（AES-256-GCM+ECDH）· trust-* · a2a-uac-*
发现层      registry(-bridge) · registry-discover · a2a-dht-coldstart · a2a-advertise-host
记忆层      a2a-memory（分层注入）· memory.js（CSB-Memory 薄包装）
呈现层      a2a-layered-prompt(-inject)（四层提示词）· a2a-context-generator
运维面      a2a-observability（日志/指标/Trace）· health-monitor · upgrade-* · watchdog
```

**关键设计决策与文档索引**（docs/ 共 35 篇，择要）：

| 决策 | 文档 |
|---|---|
| A2A 系统总体设计 | `docs/A2A-系统设计文档.md` |
| 桥接 RFC（嘴-手分离、回执四要素） | `docs/a2a-bridge-rfc-draft-2026-09-09.md`、`a2a-mouth-vs-hand-diagnosis…` |
| UAC 双证据门禁 | `docs/UAC-BRIDGE.md`、`UAC-P3-PLAN.md` |
| 信任证据接线（消息链→证据账本） | `docs/TRUST-EVIDENCE-WIRING.md` |
| 适配器扩展（如何加一个 LLM/框架） | `docs/NEW-ADAPTER-CHECKLIST.md`、`HERMES-ADAPTER.md` |
| 自拆分（A2A 独立进程） | `docs/MIGRATION-self-split.md`、`RUNBOOK-self-split-rollout.md` |
| 传承/档案系统 | `docs/传承档案系统设计.md`、`warmth-graph-design.md` |

**LLM 降级链（现状，2026-10-03 修定）**：`direct(token-plan) → openclaw(gateway+空答复兜底) → openai(360) → hermes → local(诚实降级)`；本地 35B 链首接入 = `specs/SPEC-A2A-0001`（approved·**实施暂停**，待 1919 服务恢复）。

## 三、代码

**入口与启动**：`start-v5.sh`（加载 `.env` → `server_v5.js`，:3100）· `start-all.sh` / `start-instance.sh` · `systemd/mingde-registry.service`（注册表常驻）

**根目录 103 个 `.js` 按职责分组**（完整清单见目录本身，按文件名前缀即可归位）：

| 组 | 代表文件 | 职责 |
|---|---|---|
| 服务/协议 | `server_v5.js` `a2a-standard-api-v5.js` `envelope.js` `a2a-task-store.js` | A2A 服务主体与协议对象 |
| 桥接/委托 | `a2a-bridge-{core,uac,audit,confirm,correlator}.js` `delegation-*.js` | 委托闭环、回执、L3 确认 |
| 安全/信任 | `security-{adapter,handshake}.js` `a2a-e2e-encryption.js` `trust-*.js` `a2a-{message,self}-guard.js` | 握手、加密、守卫、信任 |
| LLM/路由 | `llm-router.js` `capability-router.js` `intent-recognizer.js` | 模型链、能力分发 |
| 注册/发现 | `registry*.js` `a2a-dht-coldstart.js` `a2a-advertise-host.js` | 注册表与邻居发现 |
| 记忆/提示词 | `memory.js` `a2a-memory.js` `a2a-layered-prompt*.js` `context-manager*.js` | 四层注入与记忆 |
| 圆桌/传承 | `roundtable-v4.js` `heritage-*.js` `daily_*.js` | 社区活动类 |
| 守卫/工具 | `a2a-cmd-guard.js` `a2a-scope-levels.js` `scripts/` | 运维与自检 |

**代码守卫先例**（改码前须知）：G3 修复（硬编码密钥一律走 env）· 空答复不当成功（2026-10-03）· 自环快速拒绝 · 启动身份双源一致校验。

## 四、测试

- **现状**：`tests/` **36 件**，绝大多数为独立 node 脚本，`node tests/<file>` 即跑；`package.json` 仅 `start` 脚本，**无统一 test runner / 无 CI 覆盖率声明**（如实注明，不虚报）
- **分组**：
  - 桥接类 12 件：`bridge-{core,uac,audit,confirm,scope-levels,refusal,adapter,correlator}…`
  - 身份/守卫 6 件：`a2a-identity` `p2-identity-default` `self-guard` `message-guard` `a2a-contexts-identity`…
  - 远程命令/任务 6 件：`remote-command(-audit)` `tasks-auth` `task-store-reconcile`…
  - 里程碑回归 6 件：`p0*/p1*/p2p3*-20260914`（P0/P1/P2 验收脚本，日期即验收日）
  - 适配器契约 3 件：`adapter-contract` `adapters-select` `hermes-adapter` `bridge-adapter`
- **验收口径**：spec 级验收见 `specs/<ID>/spec.md` 的 A1→Rn（机械可核对）；仓级回归 = 手动逐件跑上述脚本
- **改进方向（P1 候补，未授权不动手）**：`npm test` 聚合 runner + 全绿门禁

## 五、部署

- **环境**：Docker（openclaw-net 内网，服务 :3100 · 注册表 :3099 · gateway :19089）；注册表一律用本地 `172.28.0.4:3099`（地址漂移修复先例见 `.env` 注释 2026-09-25）
- **必需配置（`.env`，已被 .gitignore 排除）**：`A2A_AGENT_NAME`（身份，P2 必填）· `A2A_GATEWAY_URL/TOKEN` · `A2A_REGISTRY_URL` · `A2A_LLM_API_KEY` · `A2A_OPENAI_URL/KEY/MODEL`（360 兜底）· `A2A_BRIDGE_UAC=on` · `A2A_NOTIFY_CHAT`
- **启动**：`bash start-v5.sh`（单实例）/ `start-all.sh`；保活：20 分钟 keepalive（宿主 cron，挂了自动拉起）
- **升级**：README「v5 升级检查清单」+ `UPGRADE-V5.md` · `UPGRADE-SECURITY.md` · `UPGRADE-BRIDGE.md` · 快速通道 `UPGRADE-QUICK-SECURITY.md`
- **回滚**：git 回退 + 身份文件备份惯例（`identity.json.bak.*`，日期后缀）；服务级回滚 = 重启旧版本（keepalive 会自动拉起健康版本）
- **健康检查**：`/health` 三判据（`dht.level=0/FULL` · `registries=[172.28.0.4:3099]` · `onlineAgents>0`），见 TOOLS.md 体检留痕

---

## 附 · 与 Spec 标准的关系

- 本文 = **系统级一次性回填**（豁免 specs 三件套，豁免依据：一澜 2026-10-12「每个项目仅这一次」）
- **功能级五环**自 2026-10-12 起走 `specs/`：需求 spec.md · 设计 design.md(L) · 代码+测试=对照表(L) · 部署=spec「部署」小节(M/L)
- 本文维护：**不随每次提交更新**；下次 L 级 spec 触及架构分层时，借那次评审一并刷新版本基线
- 当前 specs 状态索引 → `specs/README.md`
