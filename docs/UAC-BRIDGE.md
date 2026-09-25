# UAC 接入 Bridge（免重复 L3 点头的自动放行）

> 2026-09-15 · 若兰 🌸 · 状态：**P0 + P1 + P2 接线 + P3 可运营（默认关闭）**
> 模块：判定钩子 `a2a-bridge-uac.js` · 工具箱 `a2a-uac-toolkit.js` · **可观测性 `a2a-uac-observability.js`（P3）** · CLI `scripts/uac-*.js`
> 关联：`csb-security` 的 `lib/authz/uac.js`（签发/验签底座）· `docs/a2a-bridge-rfc-draft-2026-09-09.md`

---

## 1. 为什么

委托里的 `write` / `shell` 动作，**每次都**要接收方主人实时 L3 点头。
对「已授权的常规动作」（如 `git pull` + 跑测试 + 重启验收）而言，这是重复劳动。

**UAC 目标**：让「主人已授权」成为**可验证证据**，随信封传递 → 接收方按策略**自动放行这一类动作**。

## 2. 设计红线（先说不可让的部分）

> **免确认的权力属于「接收方主人」，不属于发起方。**
>
> 所以不是「发起方说免就免」，而是**两条证据同时成立**：
> 1. **A · 代表授权**：发起方主人签发的 UAC（随信封传）——证明「我确实替主人办事」
> 2. **B · 豁免规则**：接收方主人登记的本地策略——声明「我愿意对谁、在什么范围内免点头」
>
> 任一条缺失/不确定 → **一律不免**，回到原 L3 路径（fail-safe）。
> **不能由发起方单方面要求免确认**——那等于把别人的拒绝权拿走（协议 T4：拒绝权不可让渡）。

另：UAC 只免「主人点头」，**不免「agent 判断」**——接收方主会话的最终拒绝权始终保留。

## 3. 信封字段（可选，缺省 = 现状）

```jsonc
{
  "delegation": {
    "type": "execute", "scope": "shell", "target": "...",
    "uac": "<JWT/EdDSA>",                 // A 凭证（发起方主人签发）
    "capabilities": ["pull", "test"]      // 本次动作能力标签，须 ⊆ 接收方策略白名单
  }
}
```

发送端：`scripts/a2a-delegate.js --uac <token|文件> --capabilities pull,test`（工作区版）

## 4. 接收方策略格式（`config/bridge-uac-policy.json`，默认不存在 = 关）

```jsonc
{
  "version": 1,
  "enabled": false,                         // 默认关；不开启 = 现状
  "peers": [{
    "id": "xiaoxia", "name": "小虾", "agentId": "小虾",
    "userPublicKey": { "kty": "OKP", "crv": "Ed25519", "x": "..." },  // 验 A 用
    "capabilities": ["pull", "test"],       // 允许免确认的能力（空 = 无意义）
    "scopes": ["a2a.delegate:shell"],       // 留档/校验
    "rate": { "max": 3, "windowSeconds": 86400 },
    "expiresAt": "2026-09-22T00:00:00Z",
    "revokedAt": null
  }]
}
```

模板：`config/bridge-uac-policy.example.json`

## 5. 判定流程（`checkUAC(envelope, ctx)`）

```
policy.enabled? ──no──▶ 不免
   │yes
信封带 uac?     ──no──▶ 不免
   │yes
找到登记同伴?   ──no──▶ 不免（peer_not_registered）
同伴未吊销/未过期? ──no──▶ 不免
验签 + sub 匹配 + 时效 + 防重放 ──fail──▶ 不免（uac_invalid）
UAC scope 覆盖 a2a.delegate:<envelope.scope>? ──no──▶ 不免
capabilities ⊆ 策略白名单? ──no──▶ 不免
未超频?（有 rate 却无计数器 → 不免）──no──▶ 不免
   └─▶ 免 L3（auto_approved）+ 留痕（jti/iss/scopes/policyId）
```

## 6. CLI 用法

```bash
# ⓪ 签发侧（**推荐**）：复用既有锚钥（不要另造身份）
node scripts/uac-keygen.js --from-pem anchor --kid user-yilan --force
#   ↑ 导入 csb-security/data/yilan-user-key.pem（= data/users/yilan-user-pub.json）
#   会打印**锚指纹**（RFC 7638）；把这个指纹交给人—人带外核对

# ① 签发侧：仅当确实需要新钥时才生成（会打印「无锚」告警）
node scripts/uac-keygen.js --out .uac/user-key.json --kid user-yilan-01

# ② 签发侧：签 A 凭证
node scripts/uac-issue.js --key .uac/user-key.json --agent 小虾 \
  --scopes shell --ttl 5m [--agents 小虾] [--out .uac/uac.jwt] [--json]

# ③ 接收侧：登记 B 规则（默认空/默认关；--enable 才开）
node scripts/uac-policy.js add --peer 若兰 --pubkey <对方>.pub.json \
  --capabilities pull,test [--rate 3/86400] [--expires 7d] [--enable]
node scripts/uac-policy.js list | revoke --peer 若兰 | remove --peer 若兰 | enable | disable
```

## 6.1 锚定钥与锚指纹（2026-09-15 补 · 阿轩踩坑）

> **登记公钥前必须先有「锚」**：接收方要能证明「这把公钥属于发起方主人」，
> 而不是凭一句聊天里的确认就写进信任表。

- ✅ **唯一用户钥**：`user-yilan`（2026-08-25 建立）
  - 私钥 `csb-security/data/yilan-user-key.pem`（**只在本机**，永不出机）· 公钥 **`config/uac-peers/ruolan.pub.json`（已入仓，接收侧直接取用）**
  - 已在 阿轩 / 明德 的 CSB-Security 握手里用过（同一把 `user-yilan@csb`）
  - **锚指纹**（RFC 7638 SHA-256）：`8lci 3XPY 1CVV X8EO OemY tqVP TpuP bZyV 6gUi zA1F LGk`
  - 接收侧登记示例（仓内文件已在）：`node scripts/uac-policy.js add --peer 若兰 --pubkey config/uac-peers/ruolan.pub.json --capabilities pull,test --rate 3/86400`
- ❌ 反面教材：先用 `uac-keygen.js`（无 `--from-pem`）生成的新钥 **没有归属证据链**，
  收货方无法对账 → 应停手，改用 `--from-pem anchor` 或补「指纹带外核 / 身份钥背书」
- 三层证据（弱→强）：**指纹带外核**（人—人，最硬）→ **持有证明**（用私钥签 nonce）→ **身份钥背书**（用 `ruolan-aid` 签 key-attestation）

## 6.2 自检端点（2026-09-17 入仓）

> 缘起：舟楫部署 UAC 时发现 `/health` 无 `uac` 段、`/health/uac-probe` 不存在。
> 经查：那是**阿轩侧的本地未提交改动**，共享仓里根本没有 ⇒ 标准操作单**不可移植**（文档债）。
> 本版把自检面**入仓**，让「免确认是否真装配」可被外部只读侧证。

**实现**：`a2a-uac-health.js`（纯函数，有单测 `tests/uac-health.test.js` 10 例）·接线在 `server_v5.js`。

| 端点 | 返回 | 说明 |
|---|---|---|
| `GET /health` → `uac` 段 | `{envFlag, policyEnabled, peersCount, peerIds, hookAssembled, guardWarned, assemblyError, policyError, policyPath, probeEndpoint}` | **不依赖请求**：直接读 env + 策略文件（装配是 per-request 的，不能只看内存标志）|
| `GET /health/uac-probe` | 装配+策略启用时 → `{hit:false, reason:"no_uac"}` | 无 UAC 信封时必须 **fail-safe**（红底：绝不假阳性）；env 未开 → `hook_not_assembled` |

> ⚠️ **装配时机**：`[UAC] 钩子已装配` 那行日志发生在 **bridgeHandler 按请求执行**时，**不是启动时** ⇒ 重启后日志里看不到属预期；它会在下一次 bridge 委托进来时打印。

## 7. 测试

```bash
cd csb-a2a-aip
node tests/bridge-uac.test.js            # 判定钩子 17/17
node tests/bridge-uac-toolkit.test.js    # 工具箱 + 端到端 + 锚钥复用 21/21（**自包含**，不依赖本机私钥/gitignored 文件）
node tests/bridge-core.test.js           # 回归 29/29
```

## 8. 安全约束（免确认必须带的刹车）

1. **最小 scope**：只放「已授权常规动作」（pull / test），**不含任意 shell**
2. **短 TTL**（`5m`/`1h` 优先；长期授权慎用）
3. **频次上限** + **目标白名单**（`restrictions.allowed_agents`）
4. **可撤销**：`revoke` 即时生效
5. **全量留痕**：`jti + iss + scopes + policyId + 结论` 进审计链
6. **防重放**：`jti` cache
7. 密钥材料**永不入仓**（`.uac/`、`config/bridge-uac-policy.json` 已 gitignore）

## 9. 阶段与开关

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 判定钩子 + 信封字段定义 + 单测（不接线） | ✅ |
| P1 | 签发/登记 CLI + 工具箱 + 单测 | ✅ |
| P2 | `handleInbound()` 接线（**`A2A_BRIDGE_UAC=on` 才生效**）+ 灰度 | ✅ 接线完成（灰度中） |
| P3 | 撤销/审计查询/指标 | ✅ 2026-09-25 交付（见 §12） |

**默认关闭**：环境变量 `A2A_BRIDGE_UAC` 非 `on` 时，`handleInbound` **完全不提供** `ctx.checkUAC` → 行为与今天一致。

### P2 接线细节（本仓）
- `a2a-bridge-core.js`：第 3 步新增 UAC 判定（仅当 `ctx.checkUAC` 存在）；命中则跳过第 4 步 L3，回执 `result.autoApproved={policyId,jti}`，并记一条 `delegate_auto_approved` 证据
- `server_v5.js`：`A2A_BRIDGE_UAC=on` 时装配钩子（读策略 + 进程内 jti cache + 频次计数）；否则 `ctx.checkUAC === undefined`
- 相关环境变量：`A2A_BRIDGE_UAC`（总开关，默认 off）· `A2A_BRIDGE_UAC_POLICY`（策略路径，默认 `config/bridge-uac-policy.json`）
- 回归测试：`bridge-core.test.js` **29/29**（含用例 8/9/10/11：命中放行 / 未命中回退 / 钩子抛错 fail-safe / 未装配行为不变）

## 10. ⚠️ 最容易签错的一件事：`sub` 到底是谁

**UAC 的 `sub` 是「发起方本尊」（替主人办事的 agent，如 若兰），不是接收方。**
接收方在白名单里用 `restrictions.allowed_agents` 限定（可选）。

```bash
# ✅ 正确：一澜授权「若兰」代表他去办事；只对「小虾」有效
node scripts/uac-issue.js --agent 若兰 --agents 小虾 --scopes shell --ttl 30m
#                               ↑ sub=发起方      ↑ allowed_agents=接收方
```

**签错的后果**：接收方 `verifyUAC(expectedAgentId=发起方)` → `agent_mismatch` → **静默回退 L3**
（不报错、不拒绝，只是「免确认没生效」——最难查的一类）。
`uac-issue.js` 已加护栏：`--agent` 与 `--agents` 撞车时高声警告。

排查：接收方日志里找 `[UAC] taskId=... not_hit reason=... detail=...`（P2 起 detail 也会打出来）。

## 11. FAQ

- **没登记策略会怎样？** 一切照旧（走 L3）。
- **登记了但 `enabled:false`？** 照旧。
- **发起方硬塞 UAC？** 接收方没登记/没开 → 照旧。
- **对方 UAC 过期了？** 照旧走 L3（不是拒绝）。
- **免确认会不会被滥用？** 受 capability 白名单 + 频次 + TTL + 可撤销 + 留痕五重约束。
- **带了 UAC 却还是弹 L3？** 看接收方日志那行 `[UAC] ... not_hit reason=`：
  `no_uac`（信封没带）/ `peer_not_registered`（没登记）/ `uac_invalid`（签名·sub·时效·重放之一，看 detail）/
  `uac_scope_insufficient` / `no_capabilities_declared` / `capability_not_allowed` / `rate_exceeded` / `policy_disabled`。

---

## 12. P3 · 撤销 / 审计查询 / 指标（2026-09-25）

> 口径与验收见 `docs/UAC-P3-PLAN.md`（一澜 2026-09-25 拍板三点：not_hit 全量落账 ✅ / 发起侧签发台账 ✅ / 指标先只做本地 CLI ✅）。

### 12.1 新增事件（全部进信任账本，**中性不计分**）

| action | 何时写 | 写入方 |
|---|---|---|
| `delegate_auto_approved` | 命中免确认（P2 既有） | `a2a-bridge-core.js` |
| `delegate_uac_not_hit` | 🆕 **带 UAC 但未放行**（**仅信封确实带 UAC 时才记**） | `a2a-bridge-core.js` |
| `uac_policy_changed` | 🆕 登记/撤销/删除/开关 | `scripts/uac-policy.js` |
| `uac_issued` | 🆕 签发台账（jti/sub/allowed_agents/scopes/exp） | `scripts/uac-issue.js` |

**诚实边界**：
- 账上**不写** token / 私钥 / 公钥全文 / 策略全文（验收 A9）；detail 为一行 `k=v`，便于正则解析与人工核对
- 三个新 action 不在 `csb-security` 的 ACTIONS 表 ⇒ 按「未知动作：留痕不计分」落账（**不影响信任等级**）。若要给它们语义化 `kind`，需动 csb-security ACTIONS 表 —— P3 不做（避免跨仓协议面变更）
- `not_hit` 只在**带 UAC** 时记 ⇒ M2 里 `no_uac` 几乎不会出现在账本（除非中途改策略导致 `policy_disabled`）

### 12.2 撤销（用得更细）

```bash
# 整人吊销（保留登记，可再 add 恢复）
node scripts/uac-policy.js revoke  --peer 小虾 --reason "越界"
# [P3] 只撤某一项能力（登记保留，白名单收窄）
node scripts/uac-policy.js revoke  --peer 小虾 --capability test --reason "test 不再需要"
node scripts/uac-policy.js remove  --peer 小虾 --reason "不再合作"
node scripts/uac-policy.js disable --reason "临时停用"
```

- **即时生效**：判定钩子**按请求读策略**（无进程内缓存）⇒ 撤完下一次判定即 `peer_revoked` / `capability_not_allowed`，**不需重启**
- 所有变更**写账**（`uac_policy_changed`，含 before/after）
- 与原草案的一处**差异**：草案 §6 曾定「`revoke` 必须 `--reason`」，落地改为**建议**（未填仅告警）——避免与既有文档示例不兼容
- ⚠️ `--capability` 是 P3 新增用法；**老写法（不带 `--capability`）行为不变**

### 12.3 审计查询（只读）

```bash
node scripts/uac-audit.js --since 2026-09-20 --peer 小虾 --result not_hit --reason uac_invalid
node scripts/uac-audit.js --all --limit 20 --json      # 含全部账本条目（非 UAC 事件也看）
```

- 默认只看 **UAC 相关事件**（4 类）；`--all` 才看全部账本
- 输出附 `chainValid`（哈希链校验）与 `signed`（是否签名）
- **只读**：查询前后账本文件 sha256 不变（验收 A6，有单测钉死）

### 12.4 指标（只描述，不参与判定）

```bash
node scripts/uac-metrics.js --days 7
node scripts/uac-metrics.js --since 2026-09-23 --until 2026-09-25 --json
```

| 指标 | 口径 |
|---|---|
| M1 自动放行率 | `auto_approved ÷ (auto_approved + not_hit)` —— **分母写死 = 带 UAC 的判定** |
| M2 未命中原因分布 | `reason` 码表以 `a2a-bridge-uac.js` 为准 |
| M3 每 peer 用量 | 次数 + （有 rate 策略时）用量比 |
| M4 按日趋势 | < 3 天标 `insufficient`（不编趋势） |
| M5 变更/签发计数 | 按 op 分组 |

> BR-12：取不到 → `N/A` / `null`，**不写 0 冒充**。

### 12.5 P3 验收与单测

```bash
node tests/uac-p3.test.js              # 34 例（A2/A3/A4/A5/A6/A9 + 粒级撤销 + 变更留痕）
node tests/bridge-uac.test.js          # 17
node tests/bridge-uac-toolkit.test.js  # 21
node tests/bridge-core.test.js         # 29
node tests/trust-evidence.test.js      # 26（含一条**修掉的历史红测**，见下）
```

- ✅ **顺带修掉一条长期红测**：`tests/trust-evidence.test.js`「L3 超时 → 不记」与 09-18 若辰的修复（超时记**中性** `confirm_timeout`，不归咎发起方）不一致——测试未同步，属陈旧断言，已按代码意图改正
- ⚠️ **与本改动无关的环境依赖测试**（在干净树上同样不通过，已核）：`tests/bridge-confirm.test.js`（轮询实时确认存储，超时）、`tests/bridge-l3-workbuddy.test.js`（需 WorkBuddy 环境）

---

_相关：#L3-CONFIRM-UNAUTHORIZED-CHECKLIST.md · TRUST-EVIDENCE-WIRING.md · UAC-P3-PLAN.md_
