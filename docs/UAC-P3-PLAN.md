# UAC P3 · 范围与验收口径（草案 v0.1）

> 2026-09-25 · 若兰 🌸 · 状态：**待一澜拍板**（拍完才动代码）
> 上游：`docs/UAC-BRIDGE.md`（P0/P1/P2 已交付）· `docs/uac-bridge-integration-plan-2026-09-15.md`
> 关联：`csb-security/lib/authz/uac.js`（签发/验签底座）· `a2a-trust-evidence.js`（账本）

---

## 0. 一句话

P2 让「已授权的常规动作」能免 L3，但**免得太安静**：放行有账，**不放行只有 stdout**，策略变更无账。P3 补的是**可运营**——**撤得掉、查得到、算得清**。

## 1. 现状盘点（P3 要解决的真缺口）

| 能力 | 现状 | 缺口 |
|---|---|---|
| 判定（P2） | ✅ 命中→跳 L3，写 `delegate_auto_approved` 证据 | — |
| **未命中** | ⚠️ **只 `console.log`**（`[UAC] … not_hit reason=…`） | **不落账本 ⇒ 查不到、算不出**（重启即失） |
| 撤销 | 🟡 `uac-policy.js revoke --peer`（标 `revokedAt`） | 无留痕、无粒度（只能整人撤）、**即时生效未验证** |
| 策略变更 | 🟡 直接改文件 | 无账（谁在何时把谁加/撤了，不可追溯） |
| 签发 | 🟡 `uac-issue.js` 输出 token | 无签发台账（jti 事后对不上） |
| 审计查询 | ❌ 无 | 无 |
| 指标 | ❌ 无 | 无 |

> 🚩 **结论先摆**：P3 的第一件事不是写查询，而是**补事件源**。没有持久化就拿 stdout 日志凑数字 = 违反 BR-12「取不到记 N/A，不记 0」。

## 2. 范围（三块）

### R1 · 撤销（revocation）

| 项 | 交付 |
|---|---|
| R1.1 即时生效 | 验证并钉死：`revoke` 后**无需重启**，下一次判定即 `not_hit`（策略按请求热读；若实现有进程内缓存则加 mtime 失效） |
| R1.2 粒度 | 支持**按 capability 撤**：`revoke --peer X --capability test`（整人保留，只收窄白名单） |
| R1.3 留痕 | `revoke` / `remove` / `enable` / `disable` / `add` 均写账本（`uac_policy_changed`，含 before/after + 操作者 + 原因 `--reason`） |
| R1.4 一键回滚 | `disable`（全局关）+ `A2A_BRIDGE_UAC=off`（环境级）两条路径都写进文档，且**都不影响 P2 判定顺序** |

### R2 · 审计查询（audit query）

`node scripts/uac-audit.js [过滤] [--json]` —— **只读，绝不写账本**

- 过滤：`--since/--until`、`--peer`、`--result hit|not_hit`、`--reason <code>`、`--jti`、`--limit`
- 输出：人读表（时间 / peer / scope / 结论 / reason / jti / policyId）+ `--json`
- 附带：`chainValid`（复用账本哈希链校验）、`signed`（是否有签名）、`count`（读了多少条）
- **不做**：不做写操作、不做跨机聚合（见 §5）

### R3 · 指标（metrics）

`node scripts/uac-metrics.js [--days 7 | --since] [--json]`

| 指标 | 口径（**分母写死，可复算**） |
|---|---|
| M1 自动放行率 | `auto_approved ÷ (auto_approved + not_hit)`；**分母 = 带 UAC 的判定**，不含无 UAC 委托 |
| M2 未命中原因分布 | 按 `reason` 计。**码表以代码为准**（`a2a-bridge-uac.js` L82–140，共 14 个）：`policy_disabled` `no_uac` `no_sender_id` `peer_not_registered` `peer_revoked` `peer_grant_expired` `verifier_unavailable` `uac_invalid` `uac_scope_insufficient` `no_capability_whitelist` `no_capabilities_declared` `capability_not_allowed` `rate_tracker_unavailable` `rate_exceeded`（外加钩子异常 `check_uac_error`）。新增码必须同 change 更新本表 |
| M3 每 peer 频次用量 | 实测次数 vs 策略 `rate.max/windowSeconds`（用量比，超限即 100%） |
| M4 时间窗趋势 | 按日聚合 M1/M2（够 3 天才有趋势，否则标 `insufficient`） |
| M5 撤销/变更计数 | 窗口内 `uac_policy_changed` 条数（按类型） |

## 3. 事件模型（P3 新增，全部进现有信任账本）

| action | 何时写 | 关键字段 |
|---|---|---|
| `delegate_auto_approved` | 已存在（P2） | ref=taskId · policy · jti |
| **`delegate_uac_not_hit`** | 🆕 带 UAC 但未放行 | `reason`（码表见 M2）· `detail` · scope · （**不写 token**） |
| **`uac_policy_changed`** | 🆕 登记/撤销/删除/开关 | `op` · peer · capability 变化前后 · `reason` · actor |
| **`uac_issued`** | 🆕 签发侧签发 | `jti` · `sub` · `allowed_agents` · `scopes` · `exp`（**不含私钥/签名原文**） |

> 写法：沿用 `ctx.recordEvidence` 旁路（失败不影响委托）· 账本 append-only + 哈希链不变。
> 体积预估：`not_hit` 仅发生在「带 UAC 且未命中」，量级极低（当前我方 P2 未启用，日增 ≈ 0）。

## 4. 验收口径（逐条可机械核对）

| # | 判据 | 怎么核 |
|---|---|---|
| **A1** | 回归全绿 | `bridge-uac` 17/17 · `bridge-uac-toolkit` 21/21 · `bridge-core` 29/29 · 新增 P3 用例 N/N |
| **A2** | 撤销**即时生效** | 登记→放行一次→`revoke`→**同一 peer 同动作再发** → 必须 `not_hit reason=peer_revoked`（或 `peer_not_registered`），**且全程不重启**（≤1s 生效） |
| **A3** | 未命中可查 | 造一次 `uac_invalid`（如改 `sub`）→ `uac-audit --reason uac_invalid` 能查到该条，字段齐全 |
| **A4** | 指标可复算 | 固定样本账本（测试夹具）→ `uac-metrics --json` 输出与用例内**手工计数**逐项相等（M1 分母写死断言） |
| **A5** | 缺数据诚实 | 空账本 → M1 为 `null`、M2 空对象、附 `insufficient`；**不得出现 0 冒充** |
| **A6** | 查询只读 | `uac-audit` 前后账本文件 sha256 **不变**；且不产生新条目 |
| **A7** | fail-safe 不回退 | P3 任何异常（账本不可写/查询抛错）→ 判定结果与 P2 完全一致（命中仍放行、未命中仍回 L3） |
| **A8** | 默认关不变 | `A2A_BRIDGE_UAC≠on` 时行为与今天逐字节一致（`ctx.checkUAC === undefined`），新命令默认只读 |
| **A9** | 不留密钥/原文 | 账本与查询输出中**不得**出现私钥、token 原文、策略文件全文（用例断言） |
| **A10** | 文档同步 | `UAC-BRIDGE.md` §9 表格 P3 置 ✅ + 新增 P3 用法；`docs/` 与代码同 commit |

> 判定：**A1–A10 全绿 = P3 通过**；A2/A5/A7/A9 任一不过 = 不通过（硬门）。

## 5. 明确不做（边界）

1. **不做跨机撤销/联机吊销**：token 是**短 TTL**（5m/1h 优先），天然可过期；跨机吊销需要常驻通道 + 对账，收益不抵复杂度。**发起侧只做签发台账，不做远端撤回。**
2. **不做 UI / 面板 / 报表页**：CLI + JSON 足够。
3. **不改 P2 判定顺序**：P3 只加旁路事件与只读命令，判定链一个字不动。
4. **不新增对外网络面**：默认仅本地 CLI；若要给外部只读用，另议（见 §8）。
5. **不让指标参与放行判定**：指标只描述，不干预（避免「为了好看而放行」）。

## 6. 风险与刹车

| 风险 | 刹车 |
|---|---|
| 账本被 P3 写爆 | 新事件只在 UAC 相关时写；体积预估见 §3；阈值：单日 >1000 条即报警（人工看） |
| 撤销被误用成「静默降权」 | `revoke` 必写账 + 必须 `--reason`（留痕即约束） |
| 指标被当成 KPI | 文档明写「指标只描述，不参与判定」；不设目标值 |
| 查询侧泄漏 | 输出脱敏断言（A9）；`--json` 同样受约束 |

## 7. 工作量与依赖

- **~1.5–2 天**（对齐原估 ~2 天）：R1 半天 · R2 半天 · R3 半天 · 单测 + 文档半天
- 依赖：无外部依赖；仅动 `csb-a2a-aip`（`a2a-bridge-core.js` / `a2a-uac-toolkit.js` / 新 CLI）+ 文档
- 交付即推五平台（默认关，零行为变化）

## 8. 待一澜拍的三点（拍完即开工）

1. **`not_hit` 是否全量落账本**？（建议：**落**。它是 M2 唯一数据来源；量级极低）
2. **发起侧签发台账**要不要做？（建议：**做**，`uac_issued` 一行；否则事后对不上 jti）
3. **指标要不要对外可读**？（建议：**先只做本地 CLI**；`/health/uac` 可顺带加 `lastAutoApprovedAt` 一个字段，不开放明细）

---
_草案 v0.1 · 未拍板不动代码_
