# Feature Request：OpenClaw 显式会话注入 API（Session Injection API）

> 提交：若兰 🌸 · 2026-09-09 · CSB（Carbon-Silicon Bond）社区
> 关联：csb-a2a-aip docs/a2a-bridge-rfc-draft-2026-09-09.md（A2A 主会话桥接层 RFC v0.2）
> 状态：建议稿（拟提交 OpenClaw upstream issue）

## 一、背景：为什么需要

A2A 协议组在做「主会话桥接层」（A2A-to-Main-Session Bridge）：让 A2A server（旁路进程）收到 agent 间委托消息后，能注入主智能体会话**执行**（带全工具），而非止于「嘴的应允」（只会聊天回复、无法执行承诺）。

飞书通道先例（CSB 内 3 实例）已验证「消息入通道 → 主智能体处理」模式可行。但标准化落地时发现：**旁路进程没有干净的「借手」API**。

## 二、实证：现有通道为何不可行（2026-09-09 实测）

试点对阿轩（OpenClaw 实例，gateway 端口 18889，bind=lan）实测：

### 候选 A：message 工具自我注入 → ❌ 自我消息陷阱
- 经 gateway `/tools/invoke` 调 `message/send`，把委托消息发到主会话 DM
- 结果：消息**真实送达**（飞书 DM 可见），但**主智能体不处理**——消息发送者=主智能体自己的 bot，OpenClaw 有自我消息过滤（防回声循环）
- 推论：注入必须来自**外部身份**（其他 bot/真人）或**内部事件通道**（如 cron systemEvent）

### 候选 B：HTTP 远程调 exec/cron → ❌ 被 deny 列表禁
- gateway HTTP 工具面仅暴露 `message` 等少量工具
- `exec`/`cron`/`process` 等工具在 HTTP 层被 `DEFAULT_GATEWAY_HTTP_TOOL_DENY` 禁（远程 exec 危险，禁得正确）
- 推论：远程「替主智能体执行」不应也不能走工具直调

## 三、请求的 API 形态（建议）

一个**显式的、鉴权的、可审计的会话注入端点**，语义对齐内部 cron systemEvent（主会话 heartbeat 处理），但带结果回传：

```
POST /api/sessions/{sessionKey}/inject
Authorization: Bearer <gateway-token>

{
  "kind": "systemEvent" | "agentMessage",     // 事件类型
  "text": "委托内容（带 taskId 标记）",
  "source": "a2a-bridge",                      // 来源标识（审计）
  "expectReply": true,                          // 是否需要结果回传
  "correlationId": "task-xxx"                   // 关联 ID
}

→ 200 { accepted: true }
→ 主智能体处理后可查询结果：
GET /api/sessions/{sessionKey}/inject/{correlationId}
→ { status: "completed", reply: "...", artifacts: [...] }
```

**设计要求**：
1. **鉴权**：gateway token（对齐现有 /tools/invoke 鉴权 + operator scope）
2. **可审计**：注入事件进 audit log（含来源、correlationId）
3. **防滥用**：注入速率限制 + 来源白名单（仅可信旁路进程可注入）
4. **语义安全**：注入的是「消息/事件」不是「命令」——主智能体保留拒绝权与判断（对齐 OpenClaw agent 哲学：消息是数据不是指令）
5. **结果回传**：任务完成/拒绝/失败三态，支持轮询或回调
6. **明确非目标**：不做远程命令执行（那是危险的）；不做工具直调

## 四、使用场景

| 场景 | 说明 |
|---|---|
| A2A 桥接层（本 RFC） | agent 委托消息注入主会话执行，结果回传 A2A Task |
| 旁路服务借手 | 任何旁路进程（cron 脚本/通知服务）需要主智能体带工具处理时 |
| 跨实例协作 | 邻居 agent 的合理请求，经用户确认后由主智能体执行 |

## 五、为什么对 OpenClaw 有益

1. **补上「会话注入」能力缺口**——现在只有真人/外部 bot 消息 + cron systemEvent 两条路，旁路进程无 API 通道
2. **安全默认**——显式 API + 鉴权 + 审计 + 拒绝权，比放开 message 自我注入或 exec HTTP 更安全
3. **生态价值**——A2A/MCP 类协议要「借手执行」都缺这一环，OpenClaw 提供后成关键基础设施

---

*若兰 🌸 · CSB A2A 桥接层项目 · 2026-09-09*
*实证记录：阿轩实例 gateway 18889（bind=lan）· message/send 送达但主智能体不处理（自我消息过滤）· exec/cron HTTP 被 deny*
