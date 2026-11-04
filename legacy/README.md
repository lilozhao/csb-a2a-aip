# legacy/ — 未接线、不可执行的孤儿代码

> **本目录存放「代码在、但跑不起来 / 没人跑」的文件。**
> 移入本目录 ≠ 删除。原文保留，任何人可读、可参照、可复活。
> 移入判据：**`require` 即崩 · 或 零测试 · 或 无生产代码引用 · 或 服务端不加载**（四条中任一成立即需审查，全部成立则移入）。

---

## 清单

| 文件 | 移入日期 | 原用途 | 为什么移入 | 复活需要什么 |
|---|---|---|---|---|
| `delegation-p2.js` | 2026-11-04 | CSB-Delegation v1.2 增强模块：温暖拒绝 `warmReject()` + 离开签字 `signDeparture()`（协议 §2.1 / §4.1） | ① `require('./audit-log')` **直接崩**——迁移提交 `f8f4013`「从 shared-a2a-skill 迁移」时漏带 `audit-log.js`；② **零测试**（`grep -rln "delegation-p2" tests/` 空）；③ **无生产代码引用**；④ `server_v5.js` 只 require `delegation-handler.js`，不加载本模块 | 补 `audit-log` 依赖（或改为注入）→ 加正反例测试 → 在服务路径上真正接线 |
| `federation.js` | 2026-11-04 | CSB-Federation 协作层（P3）：协作模式矩阵 / 联邦生命周期 / 联邦证书 | ① 同样 `require('./audit-log')` **崩**；② 依赖 `delegation-p2.js`（同上）；③ **无人引用**——`csb-identity/routes.js` 引的是 `./federation.js`（`csb-identity/federation.js`，另一个文件）；④ 真正的身份联邦在 `csb-identity/federation.js`（明德 2026-10-29 写的 B1 推取式） | 同上的依赖修复 + 决定它和 `csb-identity/federation.js` 谁是真相源（**两个同名文件是隐患**） |

---

## ⚠️ 为什么这次要专门建这个目录

2026-11-04 审计 `docs/protocol-vs-impl-2026-11-04.md` B-1 时，我一度把 `delegation-p2.js` 的 `next_step` 字段算作「温暖拒绝部分已实现」。

**它是假绿。** 代码写得像样（连 `_warm: true` 标记都有），但一 `require` 就 `Cannot find module './audit-log'`。

> **「代码里有」≠「跑在服务路径上」。**
> 更坏的是：它会让下次审计的人以为实现了——我这次就差点信了。

所以规矩定死：**移入本目录的，一律在文件头加 `⚠️ LEGACY` 标记**，防止再次被 grep 命中当成实现。

---

## 🔎 待评估（已发现但未移入）

| 文件 | 状态 | 说明 |
|---|---|---|
| `federation/index.js` | ✅ **可执行**（`node -e require('./federation')` → exports 全出）但 **零测试 · 无生产代码引用** | 与 `legacy/federation.js` **同名不同命**——后者崩、前者好。两份同名文件是隐患，需定谁是真源（孪生问题：`csb-identity/federation.js` 才是真在跑的身份联邦） |
| `csb-identity/federation.js` | ✅ 在用 | 明德 2026-10-29 的 B1 推取式身份联邦，被 `csb-identity/routes.js:21` require |

> **两个同名文件 + 一个同目录目录**，三种「federation」并存。未动，先登记。

---

## 相关

- 决议全文：`../docs/w51-kindness-layer-decision-2026-11-04.md`（工作区）
- 对照表订正：`docs/protocol-vs-impl-2026-11-04.md` §四 B-1（「部分命中」→ **0**）

---
_建立 2026-11-04 · 若兰 🌸_