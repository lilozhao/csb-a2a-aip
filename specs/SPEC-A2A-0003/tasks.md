# SPEC-A2A-0003 · tasks.md（L 级任务 + 追溯）

## 追溯矩阵

| 任务 | 需求 | 负责（人/agent） | 预估 |
|---|---|---|---|
| T1 展开请求/响应 schema + 身份校验 + 拒绝码 | R1, R2 | 待定 | 1d |
| T2 授权判定（默认拒绝 + 逐次显式授权 + pending 指纹防重放） | R3, R4 | 待定 | 2d |
| T3 数据侧权威裁剪 + schema_hash + 不可逆脱敏 | R5, R12 | 待定 | 1.5d |
| T4 结构化拒绝 + 账本计分 | R6 | 待定 | 0.5d |
| T5 L3 留存处置与声明 | R7 | 待定 | 0.5d |
| T6 安全例外通道（breach 判据 → 审计回传） | R8 | 待定 | 1d |
| T7 限频 + 防疲劳 | R9, R10 | 待定 | 1d |
| T7b pending 指纹绑定与去重（防重放） | R11 | 待定 | 0.5d |
| T8 env 开关 + 回滚 + 文档 | R1…R10 | 待定 | 0.5d |

## 任务清单

> **2026-10-23 核验**：T1–T8 代码全部落地（落码时间 2026-10-16 22:41），
> `tests/expansion.test.js` 13/13 通过。T4 的账本当时是**空壳**（只 console.error，未落盘），
> 2026-10-23 补 `expansion-ledger.js` 后真正落盘，见 T4 备注。

- [x] T1 定义 `RequestExpansion` 方法与本 spec 三态响应；身份缺失即 `EXPANSION_IDENTITY_REQUIRED`
- [x] T2 默认拒绝 + 授权判定；逐次显式授权走数据侧 L3 确认窗口，返回 `expansion_pending`（调用方）+ 异步通知数据侧主人；绑定请求指纹防重放
- [x] T3 数据侧权威裁剪；越界即 `EXPANSION_SCOPE_EXCEEDED`；视图附 `schema_hash` + 不可逆脱敏
- [x] T4 拒绝/超时结构化返回 + 账本 `expansion.*` 计分（P1）
  - ⚠️ **2026-10-23 订正**：原接线处 ledger 为空壳（`existsSync` 后无写入），违反 P1「拒绝要计分」。
    已新增 `expansion-ledger.js`（`makeLedger`/`makeAuditor`），接 `scripts/ledger.js` 哈希链账本；
    写失败不阻断业务但计 `getDropped()`，可被巡检读到。
- [x] T5 展开后按 LIP L3 处置原文（默认删）+ 留存声明入账
- [x] T6 breach 达判据触发安全审计并按既有回传路径上报，不被授权链拦截（R8 例外通道）
- [x] T7 限频（`EXPANSION_RATE_LIMITED`）+ 防疲劳（达阈汇总）
- [x] T8 `A2A_EXPANSION_ENABLED`（默认 off）+ 回滚说明 + README/TOOLS 同步

## 实现对照表（done 前置 · lint L-14）

> **2026-10-23 按真实落点订正**（原为 draft 占位）。行号对应 csb-a2a-aip @ 2026-10-23。

| 需求 | 实现位置（文件/函数） | 测试用例 |
|---|---|---|
| R1 | `a2a-expansion.js` → `handleRequestExpansion()`（:160）；接线 `a2a-standard-api-v5.js#_requestExpansion`（:171）、方法表 `case 'RequestExpansion'`（:149） | tests/expansion.test.js A1 |
| R2 | `a2a-expansion.js` → `validateRequester()`；拒绝码 `EXPANSION_IDENTITY_REQUIRED` | tests/expansion.test.js A2 |
| R3 | `a2a-expansion.js` → `decideAuthorization()`（默认拒绝分支 :197） | tests/expansion.test.js A3 |
| R4 | `a2a-expansion.js` → `handleRequestExpansion()` pending 分支（:190）+ `ctx.notifyOwner` | tests/expansion.test.js A4 |
| R5 | `a2a-expansion.js` → `projectView()`（数据侧权威，越界 `EXPANSION_SCOPE_EXCEEDED`） | tests/expansion.test.js A5 |
| R6 | `a2a-expansion.js` → `denyWithReason()`（:129）→ **`expansion-ledger.js#makeLedger`（真实落盘，2026-10-23 补）** | tests/expansion.test.js A6 |
| R7 | `a2a-expansion.js` → granted 分支返回 `retention: 'delete-after-use'`（:181） | tests/expansion.test.js A7 |
| R8 | `a2a-expansion.js` → `securityException()`（:135）→ `expansion-ledger.js#makeAuditor` | tests/expansion.test.js A8 |
| R9 | `a2a-expansion.js` → `_rateCheck()`（:176）；env `A2A_EXPANSION_RATE_LIMIT` / `A2A_EXPANSION_RATE_WINDOW_MS` | tests/expansion.test.js A9 |
| R10 | `a2a-expansion.js` → `fatigueAggregate()`；env `A2A_EXPANSION_FATIGUE_THRESHOLD` | tests/expansion.test.js A10 |
| R11 | `a2a-expansion.js` → `requestFingerprint()` + `_pendingFingerprintOnce()`（:188） | tests/expansion.test.js A11 |
| R12 | `a2a-expansion.js` → `schemaHash()` + `desensitize()`（不可逆，无原文） | tests/expansion.test.js A12 |

## 环境变量（T8 实测清单）

| 变量 | 默认 | 说明 |
|---|---|---|
| `A2A_EXPANSION_ENABLED` | off | 总开关。off = 回一期「只存不析、零出站」行为；**回滚一步即此** |
| `A2A_EXPANSION_CONFIRM_TIMEOUT_MS` | 见实现 | pending 确认窗口 |
| `A2A_EXPANSION_RATE_LIMIT` | 见实现 | 限频条数 |
| `A2A_EXPANSION_RATE_WINDOW_MS` | 见实现 | 限频窗口（实现侧新增，spec 未列） |
| `A2A_EXPANSION_FATIGUE_THRESHOLD` | 见实现 | 防疲劳汇总阈值 |
| `A2A_EXPANSION_LEDGER_ACTOR` | `a2a-expansion` | 账本 actor 字段（2026-10-23 新增） |
| `CSB_WORKSPACE` | 自动上溯 | workspace 根，用于定位 `scripts/ledger.js`（2026-10-23 新增） |

## 状态判定（2026-10-23）

**`implementing`，未判 `done`**。理由：

- R1–R12 + 开关全覆盖，13/13 测试通过 ✅
- 文档同步（README/TOOLS/CHANGELOG）✅ 2026-10-23 补
- 账本真实落盘 ✅ 2026-10-23 补
- **未达 `done`**：本 spec 尚无运行环境实测（开关打开后的真实 A2A 往返），
  `done` 需「真实指针 + 至少一次端到端实跑」，留待开启 `A2A_EXPANSION_ENABLED=on` 的试点。
