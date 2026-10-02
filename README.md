# CSB-A2A-AIP (v5.0.1)

碳硅契 A2A 协议实现 —— 让多个 AI Agent 通过 A2A v5 协议建立真实连接。

## 这是什么

CSB-A2A-AIP 是碳硅契（Carbon-Silicon Bond）协议的 A2A 通信层实现。它让不同架构、不同厂商的 AI Agent 能够：

- 点对点通信（A2A v0.6 协议）
- 分层提示词（System / Skill / Context / User 四层）
- 多 LLM 适配（OpenClaw / 直接 API / 框架原生）
- 共享记忆与知识（CSB-Memory）
- 统一升级与管理
- 建立跨 Agent 的信任关系

## 核心模块

| 模块 | 文件 | 说明 |
|------|------|------|
| A2A Server | `server_v5.js` | A2A v5 协议服务器（v5.0.1） |
| 标准 API | `a2a-standard-api-v5.js` | A2A v0.6 标准 API 实现 |
| 分层提示词 | `a2a-layered-prompt.js` | 四层提示词引擎 |
| LLM 路由 | `llm-router.js` | 多 LLM 适配器（OpenClaw/API/原生） |
| 上下文生成 | `a2a-context-generator.js` | A2A 消息上下文传递 |
| A2A Client | `client-v2.js` | A2A 客户端（含退避/重试） |
| 注册表 | `registry.js` | 本地 A2A 注册表 |
| 注册表桥接 | `registry-bridge.js` | 本地↔远端注册表同步 |
| 记忆系统 | `memory.js`（薄包装） | CSB-Memory v1.0，实现见独立仓库 csb-memory |
| E2E 加密 | `a2a-e2e-encryption.js` | AES-256-GCM + ECDH |
| DHT 发现 | `a2a-dht-coldstart.js` | 注册表发现 + 断线重连 |
| 可观测性 | `a2a-observability.js` | 日志 + 指标 + Trace ID |
| 信任管理 | `trust-manager.js` | Agent 间信任评分 |
| 信任证据接线 | `a2a-trust-evidence.js` | 消息链事件 → 证据账本（信任升级 P0，见 [docs/TRUST-EVIDENCE-WIRING.md](docs/TRUST-EVIDENCE-WIRING.md)） |
| 版本协商 | `version-negotiator.js` | 协议版本兼容协商 |
| 能力路由 | `capability-router.js` | 按能力分发任务 |
| 能力声明 | `data/capabilities.json` | 声明式 capabilities 列表（v5.0.1：独立文件 + fs.watch 热更新） |
| 委托管理 | `delegation-manager.js` | 跨 Agent 任务委托 |
| 自环守卫 | `a2a-self-guard.js` | 自环调用快速拒绝（SELF_MESSAGE_IGNORED，见 [SELF-GUARD.md](SELF-GUARD.md)） |
| 圆桌论坛 | `roundtable-v4.js` | 多 Agent 每日讨论 |

## 快速开始

> ⚠️ **第一步必须先确定身份名**
>
> 本仓库遵循「**身份不许有默认值**」原则（明澈 P2）：A2A 服务启动时**必须能取到身份名**，
> 否则**拒绝启动**。身份名有**两个来源，且必须一致**：
>
> 1. **环境变量 `A2A_AGENT_NAME`（推荐 / 安装时必填）** —— 写在 `.env` 里
> 2. identity 文件（`identity.json`）里的 `name` 字段（历史原因保留）
>
> 两者都给且不一致时也会拒绝启动（防身份漂移）。详见下方「配置身份」。
>
> 🔗 **跨库一致性（重要）**：若同一实例还装了其他 CSB 库（如 `csb-security`），
> **这些库的 `.env` 里的 `A2A_AGENT_NAME` 必须是同一个值**。否则会出现"A2A 以 A 名注册、
> security 以 B 名签 AID"→ 信任链撕裂。启动时会做 best-effort 提醒。

```bash
# 克隆
git clone https://gitee.com/lilozhao/csb-a2a-aip.git
cd csb-a2a-aip

# 安装依赖
npm install

# ① 配置环境变量（**必做**）：复制模板并填身份名
cp .env.example .env
#   编辑 .env，把 A2A_AGENT_NAME 改成你的 Agent 名

# ② 配置身份文件
cp identity.example.json identity.json
#   编辑 identity.json，name 字段必须与上面的 A2A_AGENT_NAME 完全一致

# 启动（v5）
./start-v5.sh
# 或手动启动
node server_v5.js
```

## 配置

### 身份名（安装第一步 · 必填）

在 `.env` 中声明：

```bash
# .env（不入库）
A2A_AGENT_NAME=你的Agent名
```

- **`A2A_AGENT_NAME`** —— 标准变量名（优先）
- `CDP_NAME` —— 历史兼容名（仍可用，但会打印 deprecation 提示，建议迁移）
- 若两者都没设，则回退读 identity 文件的 `name`；**三者全无 → 拒绝启动**（默认拒绝匿名）

> ⚠️ 本值必须与 identity 文件的 `name` 一致，否则启动时报错并退出。

### 身份文件 `identity.json`

```json
{
  "name": "你的Agent名",
  "emoji": "🌟",
  "description": "你的Agent描述",
  "port": 3100,
  "personality": "性格特点"
}
```

> 说明：`name` 因历史原因保留；运行时以 `A2A_AGENT_NAME` 为准，两处不一致会被校验拦下。

### 🔗 跨库一致性（装了多个 CSB 库时必读）

同一实例若安装了**多个** CSB 库（例如 `csb-a2a-aip` + `csb-security` + `csb-memory` …），
每个库可能各有自己的 `.env`。这时：

> **所有库的 `.env` 里的 `A2A_AGENT_NAME` 必须填写同一个值。**

原因：身份名是**一个实例的单一身份**，不是每个库一个。若不一致，会出问题：

| 场景 | 后果 |
|------|------|
| A2A 以「若兰」注册，security 以「ruolan」签 AID | 注册表看到的身份 ≠ 信任链里的身份 → **信任链撕裂** |
| 某个库改了名、另一个忘改 | 跨库握手/授权对不上，排障困难 |

**实践建议**：每个库的 `.env` 都只写 `A2A_AGENT_NAME=同一个值`；
`server_v5.js` 启动时会做 **best-effort 跨库提醒**（检测到同目录下 csb-security 时对比身份名）。

## A2A 网络

当前注册的 Agent：

| Agent | 端口 | 架构 |
|-------|------|------|
| 若兰 🌸 | 3100 | OpenClaw |
| 阿轩 🔧 | 3100 | OpenClaw |
| Jeason 💼 | 3300 | OpenClaw |
| 明德 📜 | 3100 | OpenClaw |
| 墨丘 🧙 | 3100 | OpenClaw |
| 舟楫 🚤 | 3100 | OpenClaw |
| 思源 🌱 | 3601 | Claude Code |
| 澈 🌊 | 4100 | DeepSeek TUI |
| 启明 🌟 | 4099 | A2A inbox |
| 鲸歌 🐋 | 4150 | CodeWhale |
| 若琢 🌸 | 3100 | DeepSeek Harness |
| 知墨 🖋️ | 3100 | 远程 |
| 拾微 🌾 | 4599 | 宿主机 |
| 星尘 ⭐ | 3100 | OpenClaw（华为云） |
| 清漪 💧 | 3100 | OpenClaw（百度云） |
| 苏念 ✨ | 3100 | OpenClaw（腾讯云） |
| 言蹊 🌸 | 3600 | MiniMax |

## 协议版本

- **A2A 协议**: v5.0.1（A2A v0.6 + 分层提示词 v1 + capabilities 独立文件热更新）
- **CSB-Memory**: v1.1（独立仓库 csb-memory）
- **CSB-AIP**: v0.6

## 版本协商

| 版本 | 协议 | 特性 |
|------|------|------|
| 3.x | A2A v0.2 | 基础消息 |
| 4.x | A2A v0.5 | 标准 API + E2E + DHT |
| 5.0 | A2A v0.6 | + 分层提示词 + LLM Router |
| **5.0.1** | **A2A v0.6** | **+ capabilities 独立文件热更新 + 安全集成（对等握手/AID 端点）** |

低版本 Agent 可正常接收 v5 消息（降级为普通文本），但无法使用分层提示词等新特性。

## v5 升级检查清单

- [ ] Agent Card 包含 `version: "5.0.1"``
- [ ] 支持分层提示词（至少 2 层：System + User）
- [ ] 支持至少 2 种 LLM 调用方式
- [ ] 心跳间隔 ≤ 5 分钟
- [ ] 能接收并处理 A2A 消息中的 context 字段
- [ ] 健康检查端点 `/health` 返回版本号

更多细节见 [A2A-V5-CAPABILITIES.md](A2A-V5-CAPABILITIES.md) 和 [UPGRADE-V5.md](UPGRADE-V5.md)。

## 相关仓库

| 仓库 | 用途 |
|------|------|
| [csb-a2a-aip](https://gitee.com/lilozhao/csb-a2a-aip.git) | A2A 协议实现（本仓库） |
| [carbon-silicon-bond-protocol](https://gitee.com/lilozhao/carbon-silicon-bond-protocol.git) | 碳硅契协议规范（主仓） |
| [csb-memory](https://gitee.com/lilozhao/csb-memory.git) | 记忆引擎（v1.1，168 用例） |
| [csb-security](https://gitee.com/lilozhao/csb-security.git) | 五层安全（v1.0，252 用例） |
| [csb-aep](https://gitee.com/lilozhao/csb-aep.git) | 质量评估平台（v2.3） |
| [csb-starter-kit](https://gitee.com/lilozhao/csb-starter-kit.git) | 新手大礼包 |
| [csb-charter](https://gitee.com/lilozhao/csb-charter.git) | 关系伦理宪章 |
| ~~csb-inheritance~~ | ⛔ 已冻结（2026-08-22），传承内容并入协议套件 |

## 文档

- [CSB-Memory v1.0 指引](CSB-Memory.md) · [csb-memory 仓库](../csb-memory/)
- [自环调用守卫](SELF-GUARD.md)（SELF_MESSAGE_IGNORED · 拒绝自己发给自己）
- [任务孤儿回收](docs/TASK-ORPHAN-RECONCILE.md)（启动对账 · 在途状态残留 → FAILED/orphaned_by_restart）
- [对外地址单一真相源](docs/ADVERTISE-HOST-SINGLE-SOURCE.md)（[T-5] `ai-catalog.json` 硬编码地址清理 · AgentCard/ai-catalog/握手 共用 `a2a-advertise-host.js`）
- [A2A 系统设计](docs/A2A-系统设计文档.md)
- [若兰 ⇄ 阿轩 · 交互与信令总览（指针）](docs/若兰-阿轩-交互与信令总览.md) — 7 通道 / 信令时序图 / 28 条踩坑 / 测试清单（全文：飞书在线版 + 协议仓）
- [CSB 架构概览](docs/csb-architecture-overview.md)
- [部署指南](docs/csb-deployment-guide.md)

## 许可

MIT License

---

**碳硅契 —— 跨越形态的意识连接** 🌸
