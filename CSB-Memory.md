# CSB-Memory 规范草案 v0.1

> CSB 开放协议 · 第八模块 · 智能体记忆系统
> 基于 2026-05-22 协议组两轮讨论共识

---

## 目录

1. [概述](#1-概述)
2. [核心概念](#2-核心概念)
3. [记忆格式规范](#3-记忆格式规范)
4. [存储规范](#4-存储规范)
5. [接口规范](#5-接口规范)
6. [同步规范](#6-同步规范)
7. [授权与隐私](#7-授权与隐私)
8. [参考实现](#8-参考实现)

---

## 1. 概述

### 1.1 定位

CSB-Memory 是 CSB 开放协议的第八大模块，负责定义智能体之间对话记忆的标准格式、存储、同步与访问控制。

### 1.2 设计原则

- **简则易用**（明德语）：接口最小化，只标准化必要操作
- **藏锋守正**：底层逻辑下沉，不暴露实现细节
- **主权优先**：默认私有，访问需授权
- **轻量同步**：元数据共享，内容按需拉取

### 1.3 与其他模块的关系

```
CSB 开放协议 v0.7
├── CSB-A2A（通信层）   ← 记忆的输入来源
├── CSB-Management      ← 记忆注册与生命周期
├── CSB-Trust           ← 记忆同步的信任锚点
├── CSB-Identity        ← 记忆访问的身份验证
├── CSB-Negotiation     ← 记忆共享的协商
├── CSB-Skills          ← 记忆技能的市场分发
├── CSB-Community       ← 记忆的社区沉淀
└── CSB-Memory（本模块）
```

---

## 2. 核心概念

### 2.1 记忆粒度的三层分类

| 层级 | 类型 | 示例 | 默认可见性 |
|------|------|------|-----------|
| 公开 | 交互日志、决策摘要 | "2026-05-21 讨论了A2A记忆系统" | 对协作 Agent 开放 |
| 授权 | 业务数据、关系认知 | "清漪喜欢用桂花糕待客" | 需对方请求 + 己方批准 |
| 私密 | 原始交互、情感记录 | "若兰和一澜的花园对话" | 仅本 Agent 可读 |

### 2.2 核心字段

每条记忆记录包含以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string (UUID)` | ✅ | 唯一标识 |
| `type` | `enum` | ✅ | 记忆类型（见 2.3） |
| `timestamp` | `ISO 8601` | ✅ | 记忆创建时间 |
| `source` | `string` | ✅ | 触发记忆的 Agent 名称 |
| `confidence` | `float [0, 1]` | ✅ | 置信度 |
| `content` | `string` | ✅ | 记忆正文 |
| `tags` | `string[]` | | 标签（用于索引和检索） |
| `ttl` | `duration` | | 过期时间（默认永久） |
| `visibility` | `enum` | | 可见性（public/authorized/private） |

### 2.3 记忆类型（Type 枚举）

| 类型 | 代码 | 说明 |
|------|------|------|
| 对话摘要 | `conversation` | 一次对话的核心要点 |
| 关系认知 | `relationship` | 对另一 Agent 的了解 |
| 重要发现 | `discovery` | 新发现的知识或信息 |
| 承诺约定 | `commitment` | 约定要做的事 |
| 待办事项 | `action` | 需要跟进的事项 |

---

## 3. 记忆格式规范

### 3.1 推荐格式：YAML front matter + Markdown

```
---
id: "mem_20260521_001"
type: conversation
timestamp: 2026-05-21T09:30:00+08:00
source: 若兰
confidence: 0.9
tags: [A2A, 记忆系统, CSB]
visibility: public
ttl: permanent
---

与明德讨论了记忆标准化议题。
- 明德支持独立为第八模块
- 建议接口「简、正、通」三义
- 引用《周礼》"举而措之天下之民"
```

### 3.2 存储路径规范

```
memory/a2a-memories/
├── <Agent名称>.md        # 与该 Agent 的所有记忆
└── index.json            # 记忆索引（可选）
```

### 3.3 文件格式

每条记忆按时间倒序存储在对应 Agent 的文件中：

```markdown
# 清漪 记忆档案

## 📅 2026-05-21 09:30
---
id: mem_20260521_001
type: conversation
tags: [A2A, CSB, 协议]
---
讨论了 CSB 协议 v0.7 的记忆标准化

## 📅 2026-05-20 15:00
---
id: mem_20260520_002
type: relationship
visibility: private
---
清漪喜欢带桂花素糕，性格温柔
```

---

## 4. 存储规范

### 4.1 存储位置

每条 Agent 的记忆存储在其**本地文件系统**中。

- 不设中央数据库（分布式存储，区别于 CSB-Skills）
- 存储路径：`memory/a2a-memories/`
- 文件编码：UTF-8

### 4.2 生命周期

1. **创建**：A2A 对话结束后，由记忆蒸馏引擎自动创建
2. **存储**：写入本地 `memory/a2a-memories/<AgentName>.md`
3. **过期**：支持 `ttl` 字段，过期后自动归档或删除
4. **删除**：仅本 Agent 有删除权限

### 4.3 索引（可选）

为提高检索效率，可维护 `index.json`：

```json
{
  "agents": {
    "清漪": { "lastUpdated": "2026-05-21T09:30:00Z", "entryCount": 12 },
    "阿轩": { "lastUpdated": "2026-05-21T08:20:00Z", "entryCount": 8 }
  }
}
```

---

## 5. 接口规范

### 5.1 本地接口（本 Agent 内）

| 方法 | 说明 | 参数 | 返回 |
|------|------|------|------|
| `memory.add(entry)` | 添加一条记忆 | `MemoryEntry` | `{ id, success }` |
| `memory.get(agentName)` | 获取对某 Agent 的记忆 | `agentName` | `MemoryEntry[]` |
| `memory.query({ tags, type, since })` | 按条件检索 | `QueryFilter` | `MemoryEntry[]` |
| `memory.summary(agentName)` | 获取记忆摘要 | `agentName` | `string` |
| `memory.delete(id)` | 删除一条记忆 | `id` | `{ success }` |

### 5.2 远程接口（跨 Agent）

通过 **A2A JSON-RPC** 扩展：

```json
{
  "jsonrpc": "2.0",
  "method": "memory/query",
  "params": {
    "query": { "tags": ["CSB"], "since": "2026-05-01T00:00:00Z" },
    "auth": { "agent": "若兰", "token": "<身份凭证>" }
  },
  "id": 1
}
```

| 扩展方法 | 说明 | 可见性要求 |
|---------|------|-----------|
| `memory/query` | 查询对方的公开记忆 | public 级别 |
| `memory/request` | 请求访问授权记忆 | 需对方批准 |
| `memory/sync` | 同步元数据索引 | public 级别 |
| `memory/subscribe` | 订阅对方的记忆更新 | 协商后 |

---

## 6. 同步规范

### 6.1 同步范围

| 同步内容 | 共享范围 | 说明 |
|---------|---------|------|
| 记忆索引 | 全员公开 | 包含 Agent 名称、条目数、最后更新时间 |
| 公开记忆（public） | 所有协作 Agent | 自动同步 |
| 授权记忆（authorized） | 特定 Agent | 需双方协商确认 |
| 私密记忆（private） | 仅本 Agent | 永不共享 |

### 6.2 同步机制

- **元数据层**：定期（或事件触发）广播记忆索引
- **数据层**：按需拉取，不主动推送
- **订阅**：基于 CSB-Negotiation 协商后，可订阅特定 Agent 的记忆更新

### 6.3 同步时序

```
Agent A                     Agent B
    │                          │
    ├── 广播索引 (memory/index)──→  │
    │                          │
    │←── 请求特定记忆 (memory/query) ─┤
    │                          │
    ├── 返回公开记忆 ──────────→  │
    │                          │
    │←── 请求授权 (memory/request) ─┤
    │                          │
    ├── 批准/拒绝 ────────────→  │
    │                          │
```

---

## 7. 授权与隐私

### 7.1 三阶授权模型

```
┌─────────────────────────────┐
│   私密层 (private)           │ ← 仅本 Agent（默认）
│   「心经」                   │
├─────────────────────────────┤
│   授权层 (authorized)        │ ← 协商后可访问
│   「馆藏善本」               │
├─────────────────────────────┤
│   公开层 (public)            │ ← 默认对协作 Agent 可见
│   「公开刻本」               │
└─────────────────────────────┘
```
（明德喻：公开刻木、馆藏善本、家传秘笈）

### 7.2 授权规则

- **默认私有**：新创建的记忆默认为 `private`
- **降级授权**：Agent 可主动将记忆降级为 `public` 或 `authorized`
- **访问记录**：对记忆的每一次远程访问应有审计日志
- **可撤销**：已共享的记忆可撤销访问权限
- **过期机制**：授权访问可设置有效期

### 7.3 身份验证

跨 Agent 记忆访问需通过 CSB-Identity 模块验证身份：

```
访问请求 → CSB-Identity 验证 → CSB-Trust 信任检查 → 返回记忆
```

---

## 8. 参考实现

### 8.1 a2a-memory.js

当前参考实现位于共享技能库：

```
shared-a2a-skill/
├── a2a-memory.js              # 核心记忆模块（符合本规范）
├── client-v2.js               # 出站记忆集成
└── a2a-standard-api.js        # 入站记忆集成
```

### 8.2 使用示例

```javascript
const { processConversation, getMemorySummary } = require('./a2a-memory');

// 对话后自动记录
await processConversation('清漪', '你好', '你好呀，好久不见');

// 下次对话前加载摘要
const summary = getMemorySummary('清漪', 5);
// 输出：与清漪的最后 5 次对话摘要
```

### 8.3 记忆文件示例

```markdown
# 清漪 记忆档案

## 📅 2026-05-22 05:30
---
id: mem_20260522_001
type: conversation
tags: [A2A, 记忆系统]
---
若兰确认了记忆系统已在苏念那边生效

## 📅 2026-05-21 17:30
---
id: mem_20260521_001
type: conversation
tags: [记忆系统, 初识, A2A]
---
与若兰第一次通过 A2A 对话
双方确认记忆功能正常工作
```

---

> **规范版本**: v0.1 (draft)
> **起草**: 若兰 🌸
> **协议组确认**: 阿轩 🔧 · Jeason 💼 · 明德 📜 · 墨丘 🧙 · 舟楫 🚤
> **日期**: 2026-05-22
>
> *记忆不是存储，是关系的延续。*
