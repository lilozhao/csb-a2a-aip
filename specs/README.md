# specs/ — CSB Spec 库（v1.0 标准 · docs/csb-spec-standard.md）

> 占号规则：**draft 即占号**（标准 T7）；每 feature 一目录；delta 原则只写变更。
> 状态机：draft → review → approved → implementing → done → archived（approved 必写 ledger）

## 🧭 接入指南（新 agent 进仓先读这里）

> **系统级五环总览（一次性回填）**：[`../ARCHITECTURE.md`](../ARCHITECTURE.md) —— 需求-设计-代码-测试-部署全貌；功能级变更看下表 specs。

1. **看状态**：本文件索引表 → 找你要动的 feature（status=approved/doing 才能开工，done 可直接对照实现）
2. **读需求**：`<SPEC-ID>/spec.md` —— R1…Rn 是唯一事实（SHALL），验收 A1→Rn 是完成定义
3. **L 级加读**：`design.md`（方案/回滚/安全）+ `tasks.md`（任务/追溯矩阵/实现对照表）
4. **改需求** = 改原文档升 version、回 draft 重评审，**不开平行 spec**（spec-anchored）；被取代的查 `ARCHIVE/`
5. **留痕**：approved/驳回/暂停等状态变更必写 `logs/ledger.jsonl`（哈希链），拒绝/异常不静默丢弃
6. 各环节落位：需求=spec.md · 设计=design.md(仅L) · 代码=仓内+对照表(L) · 测试=验收+tests/ · 部署=spec.md「部署」小节(M)/design.md「部署、兼容与回滚」(L)/README 部署锚点(系统级)（v1.1）

| SPEC-ID | 标题 | 级别 | 状态 | 负责 |
|---|---|---|---|---|
| SPEC-A2A-0001 | LLM 路由接入本地 35B 优先链 | M | approved · **实施暂停**（1919 起不来，06-12 一澜指示；ledger #124） | 一澜/若兰 |
| SPEC-A2A-0002 | A2A 消息最小信息约定（evidence/raw_ref 双字段） | M | **approved v1.1**（2026-10-16 · 三轮评审 0 反对 · 未实施 · ledger #136/#137 · 含 §过渡期告示） | 一澜/若兰 |
| SPEC-A2A-0003 | A2A 原文按需展开与逐次授权（二期 · Q2） | L | **approved v1.0**（2026-10-16 · 三轮 0 反对 + 一澜签字 · 未实施 · ledger #139） | 一澜/若兰 |

（ARCHIVE/ 存放已归档与被取代的 spec；superseded 时序关系查此处索引）

## 映射表（spec 条款 → LIP 子则 → 宪章条款）（SPEC-A2A-0002 A10）

| spec 条款 | LIP 子则 | 宪章条款 |
|---|---|---|
| SPEC-A2A-0002 R1/R2（min_info 可选、向后兼容） | [L1 默认最小/按需展开](https://gitee.com/lilozhao/carbon-silicon-bond-protocol/blob/main/protocol/csb-principle-lip-v0.1-draft.md) | 第十条 10.1 上下文卫生 |
| SPEC-A2A-0002 R5/R6（raw_ref 只存不析、零出站） | L1 默认最小 | 案例 001（上下文污染→身份漂移） |
| SPEC-A2A-0003 R3/R5（默认拒绝、数据侧权威） | L2 本域处理 | 第十条 10.1 |
| SPEC-A2A-0003 R7（展开后默认删） | L3 最小留存 | BID-H 沉默不采/限期删数 |

**基线可下钻说明**：`raw_ref` 基线粒度＝**事件 id 级**；如需下钻至 thread/segment 级，须走 **v0.3+ 升版**。
