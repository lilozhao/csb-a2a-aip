# SPEC-A2A-0003 · design.md（L 级设计）

> 配套：`spec.md`（R1–R8 / A1–A8）· `tasks.md`（任务 + 追溯矩阵 + 实现对照表）

## 部署、兼容与回滚

- **env**：`A2A_EXPANSION_ENABLED`（默认 `off`——不设即一期行为，零风险）· `A2A_EXPANSION_CONFIRM_TIMEOUT_MS`（默认 300000）
- **组件**：A2A 服务需重启；数据侧（csb-memory 若承担 `raw_ref` 解析）各按其部署
- **回滚一步**：关 `A2A_EXPANSION_ENABLED` → 立即回一期「只存不析、零出站」行为
- **兼容**：不改一期消息 schema；未开开关时，含 `raw_ref` 的消息与一期完全一致

## 方案（选型对比 + 结论 + 不选理由）

**选型 A · 拉取式（pull，接收方主动请求）** ← **选**
- 请求方显式发起 `RequestExpansion`，数据侧判定授权后返回。方向清晰、可审计、易拒绝计分。
- 与一期「零出站」默认不冲突：默认仍是零出站，拉取是**显式例外**。

**选型 B · 推送式（push，发送方预判并附原文）** ← **不选**
- 理由：与一期「原文留数据侧」的初衷正面冲突；无法做到「默认最小」；暴露面在传输前就放大。

**选型 C · 指针即原文（解引用透明化）** ← **不选**
- 理由：等于取消 LIP L1，回到「整段互传」；且无授权闸门，安全不可控。

**选型 D · 契约预授权为主** ← **不选（作为可选补充）**
- 理由：预授权面难收敛、易导致「一次授权长期可拉」；起步用**逐次显式授权**更稳，预授权作为可选（Q2）。

**结论**：拉取式 + 逐次显式授权起步 + 契约预授权可选（默认关）。

## 接口与数据（协议字段 / API / 存储 schema）

**展开请求（A2A JSON-RPC method `RequestExpansion`）**
```json
{
  "method": "RequestExpansion",
  "params": {
    "raw_ref": { "kind": "memory-event", "pointer": "csb://mem/event/12345" },
    "requester": { "name": "<A2A 标准身份名>", "url": "<端点>" },   // R2 必填
    "scope": { "granularity": "single-ref", "ttl_s": 86400 },        // R5 授权粒度
    "purpose": "<一句话用途>",
    "sender": { "name": "...", "url": "..." },
    "configuration": { "metadata": { "sender": { "name": "...", "url": "..." } } }
  }
}
```

**展开响应（三态）**
| 状态 | 返回 | 对应 |
|---|---|---|
| 授权通过 | `{ state: "granted", view: <受限视图>, retention: "delete-after-use" }` | R3/R5 |
| 待确认 | `{ state: "expansion_pending", confirm_by: "<deadline>" }` | R4 |
| 拒绝/超时 | `{ state: "denied", code: "<…>", reason: "<…>" }` | R2/R6 |

**拒绝码**：`EXPANSION_IDENTITY_REQUIRED` · `EXPANSION_NOT_AUTHORIZED` · `EXPANSION_TIMEOUT` · `EXPANSION_SCOPE_EXCEEDED` · `EXPANSION_BREACH`（R8 安全例外）

**存储**：不新增持久化原文副本；仅在账本追加 `expansion.*` 事件（哈希链）。留存声明记于事件 `retention` 字段。

## 兼容与回滚

- 开关 off = 一期行为（见上）；开关 on 也只对「显式发起 `RequestExpansion`」生效，被动收消息不受影响。
- 老客户端不发 `RequestExpansion` 即无感。

## 安全与信任（身份、密钥、边界判据 BR-xx；答「无影响」也要写）

- **身份**：申请人与被申请人**均需 A2A 标准身份名**（P2 身份无默认值）；缺名即 `EXPANSION_IDENTITY_REQUIRED`（R2）。复用现有 UAC / trust-evidence，不新增信任根。
- **授权**：默认拒绝（fail-safe，同 UAC 先例）；逐次显式授权走数据侧主人 L3 确认窗口（R4）。
- **边界判据（BR）**：本 spec 触 **BR-11（L3 人工确认）** 与 **BR-02（受保护动作需确认）**；安全事件走 **R8 例外通道**（同 BID v3.3），不受授权链限制。
- **密钥**：不引入新密钥机制；账本沿哈希链 + 既有签名。
- **拒绝计分**：所有拒绝/超时写账本（P1），不做静默。