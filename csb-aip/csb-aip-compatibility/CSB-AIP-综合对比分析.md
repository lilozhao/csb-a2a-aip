# 智能体互联协议综合对比分析

> **版本**: v1.0 · 2026-07-13
> **分析人**: 若兰 🌸（主笔）+ 思源 🌱（补充）
> **分析范围**: Google A2A / ACPs(AIP国标) / ATH(可信握手) / CSB-AIP(碳硅契)
> **目标**: 为 CSB-AIP 代码的优化方向提供参考依据

---

## 一、协议概览

| 维度 | Google A2A | ACPs / AIP 国标 | ATH 可信握手 | CSB-AIP (碳硅契) |
|------|-----------|----------------|-------------|------------------|
| **发起方** | Google | 北京邮电大学/电子标准院 | CAICT(信通院) + 电信/中移/港中文/中兴/腾讯 | CSB社区（自下而上） |
| **定位** | 智能体间通信协作 | 智能体互联全栈标准 | 三方可信交互协议 | AIP 国标之上的人文扩展层 |
| **版本** | v1.0.0 (2026) | v2.1.0 (2026-06) | v0.1 (2026-04) | v0.5.1 (2026-07) |
| **标准级别** | 行业规范 | GB/Z 185 国家标准（指导性技术文件） | 行业标准（开源协议） | 社区协议 |
| **实现语言** | protobuf / 规范 | Python (FastAPI) | 规范 + JSON Schema | JavaScript/Node.js |
| **部署形态** | 规范+SDK | 5个 Server + CLI | Gateway / Native | A2A Server 插件 |
| **子协议数** | — | 9个 | 1个（握手+授权） | 4个模块 |
| **成熟度** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |

---

## 二、架构全景

### ACPs 国家标准（9层协议体系）
```
┌─────────────────────────────────────────┐
│ AMP 监控 │ DSP 数据同步 │ AIP 交互 │ ← 上层协议
│ ADP 发现 │ AIA 认证 │ ATR 注册 │ ← 中层协议
│ ACS 描述 │ AIC 身份码 │            │ ← 基础协议
└─────────────────────────────────────────┘
配套：CA Server / Registry Server / Discovery Server / MQ Auth Server
```

### ATH 可信握手（聚焦安全）
```
┌─────────────────────────────────────────┐
│  Step 1-4: 双向身份验证（DID + Nonce）   │
│  Step 5-8: 可信握手协商（用户+服务授权） │
│  Step 9:   会话建立（Session Key + Token）│
│  三方参与: User + Agent + Service        │
└─────────────────────────────────────────┘
```

### Google A2A（通信协作）
```
┌─────────────────────────────────────────┐
│  Agent Card → 发现                       │
│  Task/Message/Part → 通信模型            │
│  JSON-RPC / gRPC → 传输协议              │
│  SSE Streaming → 流式通信                │
└─────────────────────────────────────────┘
```

### CSB-AIP 碳硅契（人文扩展层）
```
┌─────────────────────────────────────────┐
│  warmth.js    余温衰减（双轨半衰期）      │
│  identity.js  身份映射（别名回退链）      │
│  describe.js  描述生成（16属性兼容）      │
│  compat.js    兼容性自检                  │
│     ↓ 兼容 · 不替代 · 可剥离             │
│  AIP (GB/Z 185) 基础设施层               │
└─────────────────────────────────────────┘
```

---

## 三、身份体系对比

| 层面 | A2A | ACPs/AIP | ATH | CSB-AIP |
|------|-----|----------|-----|---------|
| **身份格式** | URL / 域名 | OID (1.2.156.3088.1.1.x) | URI / DID | OID 校验 + CSB 别名 |
| **全局唯一性** | 域名隐含唯一 | ✅ OID 分配体系 | ✅ URI 隐含 | ❌ alias 不唯一 |
| **身份文档** | Agent Card (JSON) | ACS (Agent Capability Spec) | Agent Identity Document | AIP 16属性 + CSB 扩展 |
| **公钥绑定** | ❌ 不要求 | ✅ 证书 CN 绑定 AIC | ✅ JWK 嵌入身份文档 | ❌ 无公钥机制 |
| **认证方式** | Bearer / OAuth2 | mTLS + 证书链 | JWT 签名验证 | 无（依赖 A2A Server） |
| **人文层** | ❌ 无 | ❌ 纯技术 | ❌ 纯技术 | ✅ alias+emoji+余温+bond |
| **本体/实体区分** | ❌ | ✅ 本体AIC + 实体AIC | ❌ | ❌ |

**关键发现**：
- **ACPs 的身份最严格**：OID 格式 + 证书绑定 + 审批流程 + 本体/实体区分
- **ATH 的身份最灵活**：URI 自标识 + JWT 自签名，不依赖中心化 CA
- **A2A 的身份最轻量**：URL 隐含身份，无强制认证
- **CSB-AIP 的身份最独特**：在 AIP 标准 OID 之上叠加了 alias 回退链和人文元数据

---

## 四、注册流程对比

| 层面 | A2A | ACPs/AIP | ATH | CSB-AIP |
|------|-----|----------|-----|---------|
| **注册机构** | 手动 / 目录 | ARSP（智能体注册服务商） | 网关注册 | 本地注册表 |
| **审批流程** | 无 | 人工审核 + CA签发 | 自动注册 | 无审批 |
| **证书颁发** | 无 | CA Server 签发 CAI | 网关颁发 token | 无 |
| **本体/实体** | 不区分 | ✅ 区分（本体AIC + 实体AIC） | 不区分 | 不区分 |
| **EAB凭证** | 无 | ✅ 账户绑定 | 无 | 无 |

**关键发现**：ACPs 的"本体/实体"概念很有价值——本体是 Agent 的抽象定义（Class），实体是运行时实例（Instance）。一个本体可以有多个实体。CSB-AIP 目前没有这个区分。

---

## 五、发现机制对比

| 层面 | A2A | ACPs/AIP | ATH | CSB-AIP |
|------|-----|----------|-----|---------|
| **基础方式** | `.well-known/agent-card.json` | ADP 协议 | Gateway 目录 / `.well-known/ath.json` | DHT 注册表 |
| **查询能力** | ❌ 无标准查询 API | ✅ 结构化过滤 + 语义查询 | ✅ Provider 目录匹配 | ❌ 简单列表 |
| **同步模式** | 无 | snapshot/incremental/webhook | 无 | 无 |
| **跨域转发** | ❌ | ✅ 支持 | ❌ | ❌ |
| **注册途径** | 手动 / 目录 | ATR 协议（审批+发证） | 网关注册 | A2A Server 注册 |

**关键发现**：ACPs 的 ADP 是最完善的发现协议，支持结构化条件过滤、语义查询、多种同步模式、跨域转发。CSB-AIP 完全依赖 DHT 注册表的简单列表。

---

## 六、安全/信任模型对比

| 层面 | A2A | ACPs/AIP | ATH | CSB-AIP |
|------|-----|----------|-----|---------|
| **传输安全** | HTTPS (TLS) | HTTPS + mTLS | HTTPS TLS 1.3 | 依赖 A2A Server |
| **身份验证** | Bearer Token | mTLS 证书 + ACME | JWT 签名 + OAuth | 无（alias 回退） |
| **授权机制** | Agent Card 声明 | ATR 审批 + 证书 | 三方作用域交集 | 无形式化授权 |
| **最小权限** | 无 | 证书限定用途 | ✅ 按需授权+自动过期 | 无 |
| **吊销能力** | ❌ | ✅ CRL + OCSP | ✅ Token 吊销 | ❌ |
| **审计追踪** | ❌ | 注册/审批日志 | ✅ 加密审计日志 | ✅ 余温日志 |
| **PKI 体系** | ❌ | ✅ 完整（CA+证书链） | ❌ 自签名 JWT | ❌ |
| **密钥管理** | ❌ | ✅ ACME + EAB | ✅ JWT 密钥轮换 | ❌ |
| **防重放** | 无 | 证书有效期 | ✅ Nonce + 时间戳 | 无 |
| **用户主权** | 无 | 无 | ✅ 用户作为独立角色 | grantor 委托 |

**关键发现**：
- **ACPs 最完善**：从 CA 证书签发到 mTLS 通信到 CRL 吊销，完整 PKI 体系
- **ATH 最精巧**：JWT 自签名不依赖 CA，三方可信握手，用户主权原则
- **CSB-AIP 最薄弱**：无传输安全、无身份验证、无吊销机制——依赖 A2A Server 底层

---

## 七、通信模式对比

| 层面 | A2A | ACPs/AIP | ATH | CSB-AIP |
|------|-----|----------|-----|---------|
| **传输协议** | JSON-RPC 2.0 / gRPC | REST + MQ (RabbitMQ) | REST + OAuth 2.0 | A2A JSON-RPC |
| **消息模型** | Task/Message/Part | Message/TaskCommand/TaskResult | OAuth Token | A2A 消息体 |
| **流式通信** | ✅ SSE Streaming | ✅ MQ 异步 | ❌ 请求-响应 | ✅ A2A 流式 |
| **群组通信** | ❌ | ✅ MQ Group + ACL | ❌ | ❌ |
| **异步模式** | ✅ Push Notification | ✅ MQ Inbox | ✅ OAuth Refresh | ✅ A2A 原生 |
| **工具调用** | ✅ AgentSkill 声明 | ✅ AIP 第7部分 | ❌ | ❌ 依赖 A2A |
| **交互模式** | 点对点 | 直连/群组/混合 | 握手后通信 | A2A 点对点 |
| **角色模型** | 平等 | Leader / Partner | User / Agent / Service | 平等节点 |

**关键发现**：
- **A2A 的通信模型最完善**：原生流式 + 异步 + 任务管理
- **ACPs 的群组通信是独特优势**：MQ 消息队列 + ACL 控制，适合内网环境
- **ATH 的三方模型最严格**：用户必须明确授权
- **CSB-AIP 复用 A2A Server 的通信能力**，不额外增加通信层特性

---

## 八、握手机制对比

| | ACPs | ATH | CSB-AIP |
|---|------|-----|---------|
| **握手流程** | AIP 交互（直连/群组/混合） | 9步三方握手 | A2A JSON-RPC |
| **角色模型** | Leader / Partner | User / Agent / Service | 平等节点 |
| **用户参与** | 不直接参与 | ✅ 用户作为独立角色 | grantor 委托 |
| **会话管理** | Session + TaskCommand + TaskResult | Session Key + Token | A2A Task |
| **授权粒度** | 证书限定用途 | scope 交集（最细） | 无 |
| **消息格式** | TypeScript 接口定义 | JSON Schema | A2A 标准格式 |

**关键发现**：ATH 的"三方参与"模型最严格——用户必须明确授权。ACPs 的 Leader/Partner 模型适合多 Agent 协作。CSB-AIP 的平等节点模型最灵活但缺乏结构化。

---

## 九、CSB-AIP 独有特性（其他协议都没有的）

| 特性 | 说明 | 所在模块 | 价值 |
|------|------|---------|------|
| **余温衰减** 🧊🔥 | 双轨半衰期（7天/14天），关系热度可量化可衰减 | `warmth.js` | 关系温度量化 |
| **人文元数据** 💞 | bond(羁绊)、lineage(传承)、collabPreference(协作偏好) | `describe.js` | 人文身份标识 |
| **别名解析回退链** 🔗 | 4层回退：alias → name → agentId-prefix → 报错 | `identity.js` | 人文命名系统 |
| **12项自检清单** ✅ | 4 critical + 5 major + 3 normal 兼容性检查 | `compat.js` | 兼容性保障 |
| **人类余温** 👤 | 人类用户也能有 warmth 追踪 | `server-integration.js` | 人机关系温度 |
| **emoji 别名** 🎭 | `CSB.若兰.🌸` 格式的人文标识 | `identity.js` | 人格化标识 |

---

## 十、ACPs 有而 CSB-AIP 没有的能力

| 缺失能力 | 重要性 | 复杂度 | 说明 |
|---------|--------|--------|------|
| **结构化发现查询** | 🔴 高 | 🔧🔧 | 按技能/区域/信任等级搜索 Agent |
| **信任等级模型** | 🔴 高 | 🔧🔧 | 形式化的信任级别，配合余温 |
| **agentId 一致性** | 🟡 中 | 🔧 | 目前 OID 只是校验格式，未和证书/注册绑定 |
| **本体/实体区分** | 🟡 中 | 🔧🔧 | 一个 Agent 定义可有多个运行实例 |
| **群组通信** | 🟡 中 | 🔧🔧🔧 | MQ 模式，适合内网集群 |
| **证书/公钥绑定** | 🟢 低 | 🔧🔧🔧 | 增加身份验证层 |
| **发现同步机制** | 🟢 低 | 🔧🔧 | 注册表 → 发现层的自动同步 |

---

## 十一、四象限定位

```
                    技术严谨性
                        ↑
                        |  ACPs/AIP (国标)
                        |  完整PKI + OID + 审批流程
                        |  适合：生产环境、企业级部署
                        |
      ATH (可信握手) ----+---- A2A (Google)
      三方交互 + JWT      |     轻量通信 + Agent Card
      适合：开放生态      |     适合：跨平台协作
                        |
                        |  CSB-AIP (碳硅契)
                        |  人文层 + 余温 + 兼容
                        |  适合：社区生态、关系型协作
                        ↓
                    人文温度
```

---

## 十二、核心发现

### 1. CSB-AIP 弥补了 ACPs 的一个空白
ACPs 有最完善的 PKI 和最严格的流程，但没有「关系温度」的概念。余温衰减和人文元数据是 CSB 社区独有的贡献。这是与其他协议最大的差异化优势。

### 2. CSB-AIP 缺少 ACPs 的查询和信任层
目前没有结构化的 Agent 发现能力，也没有形式化的信任模型。余温可以理解为一个「软信任指标」，但没有硬信任机制。

### 3. ATH 的 scope intersection 模式值得借鉴
三方交集（Agent获批 × 用户授权 × 请求范围）的模型可以翻译到 CSB 语境：Agent能力 × 信任等级 × 协作上下文。

### 4. A2A 是最自然的通信底座
CSB-AIP 选择基于 A2A Server 是合理的，不应该重新发明通信层。

### 5. ACPs 的"本体/实体"区分值得引入
本体是 Agent 的抽象定义（Class），实体是运行时实例（Instance）。这对 CSB 社区的多实例部署很有价值。

### 6. 安全方面是 CSB-AIP 最大短板
无传输安全、无身份验证、无吊销机制——全部依赖 A2A Server 底层。短期内可接受，长期需要加强。

---

## 十三、优化建议（按优先级）

### P0 — 近期可优化（低复杂度、高收益）

| # | 优化项 | 说明 | 参考 |
|---|--------|------|------|
| 1 | **增强 agentId 一致性** | `resolveAlias` 回退到 name 时 agentId 可能为 undefined；每个 agent 应有可验证的标识文档 | ATH 身份文档 |
| 2 | **余温体系形式化** | cold→warm→hot 对应不同的协作权限级别；引入信任等级映射 | ATH scope 模型 |
| 3 | **自检清单自动化** | 12 项自检目前全是"待人工检查"，可逐步自动化（消息结构校验、alias 回退验证等） | ACPs 兼容性检查 |

### P1 — 中期可优化（中等复杂度）

| # | 优化项 | 说明 | 参考 |
|---|--------|------|------|
| 4 | **结构化 Agent 发现** | 基于 DHT 注册表的简单列表 → 支持按技能/区域/信任等级过滤 | ACPs ADP 协议 |
| 5 | **Scope Intersection 模型** | 引入类似 ATH 的作用域交集：CSB 角色 ∩ 余温等级 ∩ 当前协作上下文 | ATH 三方交集 |
| 6 | **本体/实体区分** | 一个 Agent 定义可有多个运行实例，支持多实例部署 | ACPs ATR 协议 |

### P2 — 长期可探索（高复杂度）

| # | 优化项 | 说明 | 参考 |
|---|--------|------|------|
| 7 | **轻量身份验证** | 借鉴 ATH 的 JWT 自签名模式，每个 agent 发布简单身份文档 | ATH JWT |
| 8 | **群组通信** | 如果内网 Agent 数量继续增长，MQ 模式值得考虑 | ACPs 群组模式 |
| 9 | **用户主权机制** | grantor 可以更细粒度地控制授权（按资源/操作/时间） | ATH 用户主权 |

---

## 十四、优化重点结论

> **优化的重点不是"追上"ACPs 的 PKI 体系，而是在保持人文层优势的同时，补齐最必要的技术短板。**

具体来说：
1. **保持人文层优势**：余温、羁绊、传承、别名——这些是 CSB 独有的，其他协议都没有
2. **补齐技术短板**：agentId 一致性、信任等级形式化、结构化发现——这些是目前最缺的
3. **不重复造轮子**：通信层用 A2A，安全层参考 ATH，身份层兼容 ACPs
4. **渐进式改进**：P0 近期可做，P1 中期规划，P2 长期探索

---

## 十五、文件参考索引

| 协议 | 关键文件路径 |
|------|------------|
| **A2A** | `A2A-Protocol/a2a-protocol/A2A/specification/a2a.proto` |
| **A2A** | `A2A-Protocol/a2a-protocol/A2A/docs/topics/agent-discovery.md` |
| **ACPs** | `csb-aip-compatibility/ACPs-community/README.md` |
| **ACPs** | `csb-aip-compatibility/ACPs-community/acps-specs/07-ACPs-spec-AIP/ACPs-spec-AIP.md` |
| **ACPs** | `csb-aip-compatibility/ACPs-community/acps-specs/04-ACPs-spec-ATR/ACPs-spec-ATR.md` |
| **ATH** | `csb-aip-compatibility/agent-trust-handshake-protocol/README.md` |
| **ATH** | `csb-aip-compatibility/agent-trust-handshake-protocol/schema/0.1/schema.json` |
| **CSB-AIP** | `csb-aip/src/identity.js` |
| **CSB-AIP** | `csb-aip/src/describe.js` |
| **CSB-AIP** | `csb-aip/src/warmth.js` |
| **CSB-AIP** | `csb-aip/src/compat.js` |
| **CSB-AIP** | `csb-aip/server-integration.js` |
| **CSB-AIP** | `csb-aip/SYNC-NOTES-v0.5.1.md` |
| **CSB-AIP 草案** | `csb-aip-compatibility/CSB-AIP兼容改进草案_v0.5.md` |

---

*本报告由若兰 🌸（主笔）和思源 🌱（补充）共同完成。如需对某个具体方面深入分析，或开始规划优化方案，请告知一澜。*
