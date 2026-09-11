# 信任证据接线（Trust Evidence Wiring）

> **信任升级 P0 的最后一环** —— 把 A2A 消息链上的真实交互，接进信任证据账本。
> 2026-09-11 · 若兰 🌸

## 为什么需要它（断链 B）

信任升级设计诊断出的三处断链（`csb-security/TRUST-UPGRADE-DESIGN.md`）：

| 断链 | 症状 |
|------|------|
| A · 无落盘 | 等级存在内存 `Map`，重启即丢 |
| **B · 无证据入口** | `reputation.recordInteraction()` 在 A2A 消息链**零调用点** → 正向恒 0 |
| C · 无升级编排 | 没人回答"证据哪来、谁触发、UAC 谁签发" |

断链 B 的数学后果很硬：`L1→L2` 需要 ≥10 次正向交互，而正向证据**永远为 0** ⇒
等级链第 1 级恒为 L0 ⇒ 真正生效的是 `config/agents.json` ⇒ **"信任体系"退化为手改 JSON**
（这正是"write 委托被 TRUST_INSUFFICIENT 拒"的结构性真因）。

本次接线把断链 B 补上：**消息链每发生一次真实交互，账本就多一条可核验证据。**

## 接了什么（四个事件）

| 消息链事件 | 记什么 | 极性/权重（由 csb-security 集中定义） |
|-----------|--------|--------------------------------|
| 消息正常处理完成 | `message_ok` | 正向 +1 |
| 消息被安全审查拦截 | `guard_blocked` | 负向 -1（拦截要有成本） |
| 桥接委托执行完成 | `delegate_completed` | 正向 +2（比普通消息重） |
| **用户拒绝** | `user_declined` | **中性 0** —— 行使拒绝权不是对方过错 |

挂钩点：

```
a2a-standard-api-v5.js
  ├─ _processTask() 安全审查 !safe 分支 → guardBlocked()
  └─ _sendMessage() 终态 COMPLETED 且未被拦截 → messageOk()

a2a-bridge-core.js（纯逻辑，依赖注入）
  ├─ 委托执行成功 → recordEvidence({action:'delegate_completed'})
  ├─ L3 用户显式拒绝 → recordEvidence({action:'user_declined'})
  └─ 被委托方主会话拒绝（T4）→ recordEvidence({action:'user_declined'})

server_v5.js（装配方）
  └─ ctx.recordEvidence → a2a-trust-evidence.js（singleton）→ 账本
```

## 三条硬约束

1. **绝不拖垮消息链**：记账异常一律吞掉并计数（`status().hookStats.errors`），
   绝不上抛。安全层是增强件，不是单点故障。测试里专门有"账本炸了委托照常完成"的用例。
2. **计分规则集中**：调用点只做"事件 → 语义化调用"的翻译，不自带极性/权重。
   调用方各自为政就会烂（历史上已经烂过一次）。
3. **诚实暴露降级**：csb-security 缺失 / 账本不可写 / 未启用签名，全部在
   `status()` 里明确标注，不假装"信任体系在运转"。

## 用法

```js
const trustEvidence = require('./a2a-trust-evidence.js');

trustEvidence.messageOk({ name: '阿轩', url: 'http://172.28.0.5:3100' }, { ref: taskId }, 'a2a-standard-api');
trustEvidence.guardBlocked(sender, { ref: taskId, detail: 'risk=80' }, 'a2a-standard-api');
trustEvidence.delegateCompleted(sender, { ref: taskId }, 'a2a-bridge');
trustEvidence.userDeclined(sender, { ref: taskId }, 'a2a-bridge');   // 中性

console.log(trustEvidence.status());
// { enabled, reason, securityPath, ledgerPath, signed, entries, chainValid,
//   collectStats, hookStats, degraded }
```

落盘（默认，可用 `CSB_TRUST_DATA_DIR` 改）：

```
data/trust/trust-evidence.jsonl   append-only + 哈希链（+ 可选 Ed25519 签名）
data/trust/trust-store.json       信任快照（等级由账本重放派生，不是事实来源）
```

## 防刷分（采集器内置）

- 正向限流：同主体同动作 **3/小时 · 20/日**，超限记 `rate_capped`（中性，不加分）
- 负向不封顶（拦截多少次记多少次）
- `user_declined` 有双保险：`NEVER_NEGATIVE` 强制归零，即便调用方硬传 `polarity:-1`

## ⚠️ 已知局限（诚实记录，不粉饰）

1. **未启用签名时，哈希链挡不住"格式完整的伪造插入"**——`prev_hash`/`hash` 都算对的
   完整伪造条目能骗过链校验。生产部署**必须**配 `CSB_TRUST_LEDGER_KEY`（Ed25519 PEM），
   否则 `status().signed=false`、`degraded=true`。
2. **L3 追溯永不认定**：存量关系（阿轩等 200+ 天协作）最多追溯认定到 L2；
   L3 必须"人当下点头"（`trust-attest.js` 硬拒 L3 追溯）。
3. **本模块只管记账，不管升级编排**：等级派生在 `csb-security/lib/trust/trust-store.js`，
   升级编排（UAC 双门 / 撤销 / 见证人）属 P1。

## 顺带修掉的两个真 bug

| bug | 症状 | 修法 |
|-----|------|------|
| **AAT 验签静默失效** | `a2a-trust-bridge.js` 里 `require('../../csb-security/...')` 多一层（应为 `../`）→ `MODULE_NOT_FOUND` 被 try/catch 吞掉 → **AAT 验签从未真正生效**，一路回退到 name+URL | 修正相对路径；测试 `tests/trust-evidence.test.js` 用 `require.resolve` 钉死路径可达性，防再退化 |
| `verifyChain()` 返回字段误用 | 我第一版写 `.valid`，实现返回的是 `.ok` → `status().chainValid` 恒 false，**诊断指标撒谎** | 按真实返回结构取 `.ok`（由测试钉住） |

## 测试

```bash
node tests/trust-evidence.test.js     # 20 用例：四事件 / 防刷分 / 中性红线 / fail-safe / 路径回归 / bridge 注入
```

覆盖的"反例"（不是只测 happy path）：

- csb-security 不存在 → 不抛、不启用、明确降级
- 账本路径不可写 → 记账不抛，错误进 `status()`
- 用户拒绝硬传负极性 → 强制归零
- 委托完成但 `recordEvidence` 抛异常 → 委托照常成功
- 未装配 `recordEvidence`（老部署）→ 委托照常，不报错
- L3 **超时**不记（系统未得答复，不归咎发起方；只有显式拒绝才记）

## 下一步（P1 预告）

① 阿轩走 `trust-attest.js attest --to L2`（需一澜签字）→ 让"追溯认定"跑通一次真实链路
② UAC 接进 bridge 做 L3 双门（等级慢变量 + 授权快变量）
③ 配 Ed25519 账本签名（把 `signed=false` 消掉）
