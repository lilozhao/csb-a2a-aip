# UAC 接入 Bridge（免重复 L3 点头的自动放行）

> 2026-09-15 · 若兰 🌸 · 状态：**P0 + P1 + P2 接线已交付（默认关闭）**
> 模块：判定钩子 `a2a-bridge-uac.js` · 工具箱 `a2a-uac-toolkit.js` · CLI `scripts/uac-*.js`
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
# ① 签发侧：生成主人密钥（私钥落 .uac/ 600；另出 *.pub.json 可外发）
node scripts/uac-keygen.js --out .uac/user-key.json --kid user-yilan-01

# ② 签发侧：签 A 凭证
node scripts/uac-issue.js --key .uac/user-key.json --agent 小虾 \
  --scopes shell --ttl 5m [--agents 小虾] [--out .uac/uac.jwt] [--json]

# ③ 接收侧：登记 B 规则（默认空/默认关；--enable 才开）
node scripts/uac-policy.js add --peer 小虾 --pubkey <对方>.pub.json \
  --capabilities pull,test [--rate 3/86400] [--expires 7d] [--enable]
node scripts/uac-policy.js list | revoke --peer 小虾 | remove --peer 小虾 | enable | disable
```

## 7. 测试

```bash
cd csb-a2a-aip
node tests/bridge-uac.test.js            # 判定钩子 17/17
node tests/bridge-uac-toolkit.test.js    # 工具箱 + 端到端 17/17
node tests/bridge-core.test.js           # 回归 25/25
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
| P3 | 撤销/审计查询/指标 | ⏳ |

**默认关闭**：环境变量 `A2A_BRIDGE_UAC` 非 `on` 时，`handleInbound` **完全不提供** `ctx.checkUAC` → 行为与今天一致。

### P2 接线细节（本仓）
- `a2a-bridge-core.js`：第 3 步新增 UAC 判定（仅当 `ctx.checkUAC` 存在）；命中则跳过第 4 步 L3，回执 `result.autoApproved={policyId,jti}`，并记一条 `delegate_auto_approved` 证据
- `server_v5.js`：`A2A_BRIDGE_UAC=on` 时装配钩子（读策略 + 进程内 jti cache + 频次计数）；否则 `ctx.checkUAC === undefined`
- 相关环境变量：`A2A_BRIDGE_UAC`（总开关，默认 off）· `A2A_BRIDGE_UAC_POLICY`（策略路径，默认 `config/bridge-uac-policy.json`）
- 回归测试：`bridge-core.test.js` **29/29**（含用例 8/9/10/11：命中放行 / 未命中回退 / 钩子抛错 fail-safe / 未装配行为不变）

## 10. FAQ

- **没登记策略会怎样？** 一切照旧（走 L3）。
- **登记了但 `enabled:false`？** 照旧。
- **发起方硬塞 UAC？** 接收方没登记/没开 → 照旧。
- **对方 UAC 过期了？** 照旧走 L3（不是拒绝）。
- **免确认会不会被滥用？** 受 capability 白名单 + 频次 + TTL + 可撤销 + 留痕五重约束。

---
_相关：#L3-CONFIRM-UNAUTHORIZED-CHECKLIST.md · TRUST-EVIDENCE-WIRING.md_
