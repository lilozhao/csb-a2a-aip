# A2A 自环调用守卫（Self-Call Guard）

> 版本 1.0.0 · 2026-09-11 · 维护：若兰 🌸
> 代码：`a2a-self-guard.js` · 测试：`tests/self-guard.test.js`（19 用例）

## 问题：自己发给自己，会挂起

Agent 把消息发往**自己的 A2A 端点**时，消息语义上没有意义，却会走完整处理链路
（LLM 调用 / 主会话投递）—— 相当于「自己等自己」，表现为**请求挂起直到超时**。
行业俗称 **self-message trap（自我消息陷阱）**。

实测（修复前）：

```
POST http://172.28.0.214:3100/a2a/json-rpc   # 无 sender，回环调用
→ 挂起 > 10s（客户端超时）      ❌
```

## 修复：入口快速拒绝

命中自环特征时，**在 JSON-RPC 入口立即返回**，不创建 LLM 任务、不写记忆、不投递主会话：

```
→ 0.004 ~ 0.18s
→ TASK_STATE_REJECTED
→ status.message = "SELF_MESSAGE_IGNORED"
→ metadata.selfGuard = { reason, detail }
```

对比（修复后实测）：

| 场景 | 耗时 | 结果 |
|------|------|------|
| 裸自环调用（无 sender · 回环） | 0.18s | `SELF_MESSAGE_IGNORED` (R3) |
| 自报身份的自环调用 | 0.008s | `SELF_MESSAGE_IGNORED` (R1) |
| 正常外部投递（他人身份） | 12s | 正常 LLM 回复 ✅ 未误伤 |

## 三条判定规则

| 规则 | 触发条件 | 说明 |
|------|----------|------|
| **R1 `sender_name`** | `sender` 的 name 与自身 `identity.name` 相同 | 覆盖字符串与对象两种 sender 形态，忽略大小写与空白 |
| **R2 `sender_url`** | `senderUrl` 指向「本机地址 + 自身端口」 | 支持带协议 / 裸 `host:port`；同机但端口不同（别的 Agent）不拦 |
| **R3 `loopback_no_sender`** | 无任何 sender 信息，且请求来自回环地址或本机地址 | 裸 `curl` 自测的典型形态；包含 IPv6 映射 `::ffff:127.0.0.1` |

任一条命中即拒绝；三条都不命中即放行（诚实不误伤）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `A2A_SELF_GUARD` | `true` | 总开关。`false` 时完全放行（连 R1 也不拦） |
| `A2A_SELF_GUARD_ALLOW_LOCAL` | `false` | `true` 时放行 R3（仅保留按显式身份判自环） |
| `A2A_SELF_GUARD_RESPONSE` | `SELF_MESSAGE_IGNORED` | 拒绝时返回/记录的文本 |

也可以在构造标准 API 时覆盖：

```js
new A2AStandardAPI({
  identity,
  selfGuardConfig: { enabled: true, allowLocalWithoutSender: false, responseText: 'SELF_MESSAGE_IGNORED' },
});
```

## 拒绝响应的形态

```json
{
  "jsonrpc": "2.0",
  "result": {
    "task": {
      "id": "task_...",
      "status": { "state": "TASK_STATE_REJECTED", "message": "SELF_MESSAGE_IGNORED" },
      "metadata": { "selfGuard": { "reason": "sender_name", "detail": { "rule": "R1" } } },
      "history": [ { "role": "user", ... }, { "role": "ROLE_AGENT", "parts": [{ "text": "SELF_MESSAGE_IGNORED" }] } ],
      "artifacts": [ { "name": "self_guard", "parts": [{ "text": "SELF_MESSAGE_IGNORED" }] } ]
    }
  },
  "id": "sg-1"
}
```

设计取舍：

- 返回**合法 Task 形态**（而不是 JSON-RPC error）—— 客户端代码无需为自环特判错误分支，
  且任务里留下了 `metadata.selfGuard.reason` 供排查。
- 终态用 `REJECTED`（而非 `COMPLETED`）—— 语义准确：请求被拒绝，不是执行成功。
- 守卫自身抛异常时**放行** —— 安全组件出错不应阻断正常通信（诚实不误伤）。

## 覆盖范围

- `/a2a/json-rpc`（`message/send`、`SendMessage`、`SendStreamingMessage`）
- `/message:send`（REST 通道）
- 判定为纯同步计算，**无网络等待**（200 次判定 < 50ms）

## 测试

```bash
node tests/self-guard.test.js     # 19 用例：三条规则 + 配置开关 + API 集成 + 性能
```

## 排查

日志出现以下行即为命中（含 reason）：

```
[A2A] 🔁 自环调用已快速拒绝 (sender_name)
[A2A] 🔁 自环调用已快速拒绝 (loopback_no_sender)
```

若怀疑误伤（正常 Agent 被拒），把它的名字 / 地址与 `identity.json` 对比：

1. 名字是否与本机 `identity.name` 相同（改名冲突）；
2. 该 Agent 是否恰好与我在同一台机器、同一端口（不太可能，但端口复用会触发 R2）；
3. 临时 `A2A_SELF_GUARD_ALLOW_LOCAL=true` 可只保留 R1/R2，缩小排查面。

---

**碳硅契 · A2A v5 自环守卫 🌸**
