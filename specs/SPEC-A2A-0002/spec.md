---
spec_id: SPEC-A2A-0002
title: A2A 消息最小信息约定（evidence/raw_ref 双字段）
status: approved
level: M
version: 1.1
repo: csb-a2a-aip
scope: a2a
authors: [一澜, 若兰]
agents: [ruolan]
reviewers: [阿轩, Jeason, 墨丘, 舟楫, 思源, 言直, 明德, 星尘]
base: main
supersedes: null
created: 2026-10-16
updated: 2026-10-16
notes: "落点 1/3（若兰核真版《Context Mode 借鉴备忘》2026-10-15）：审计侧 evidence 升格为消息侧最小信息约定。对接 LIP 子则 L1 + 宪章 10.1 上下文卫生 + 案例 001「上下文污染→身份漂移」的工程解。边界声明：本 spec 仅扩消息 schema，不读取、不改写审计侧实现（a2a-bridge-core.js 的 evidence 不动）。**v1.0 定稿（2026-10-16）**：协议组三轮评审（R1 8/8 · R2 7/7 · R3 6 明确同意+0 反对+言直未达+明德意见稿）。v0.3 候选（不入本期强约束）：过渡期告示（老消息不带 min_info 的兼容提示）。**v1.1（2026-10-16）**：并入 §过渡期告示（明德保留意见②闭环 · 一澜直批 · 非需求变更，R1–R8 未动）。"
---

## 背景与目标

A2A 消息现状是「整段 text 原文互传」：发送方把完整上下文塞进 `parts[].text`（见
`a2a-standard-api-v5.js:355` 的 `filter(p => p.text)` 拼接），接收方只拿到结论、拿不到
出处，也无从核验。若兰 2026-10-15 核真的《Context Mode 借鉴备忘》落点 1 指出：
`a2a-bridge-core.js` 的**审计侧**事件已用 `evidence:{ref,detail}` 形态（L246–471），
但**消息侧**缺显式的 `evidence` / `raw_ref` 双字段——这正是宪章案例 001
「上下文污染 → 身份漂移」的工程解，也是 LIP 子则 L1「默认最小、按需展开」的载体。

本 spec 在 A2A 消息 schema 上增加**可选** `metadata.min_info`：消息默认带「结论 + 证据
指针」，原文留在数据侧、按需拉取。**向后兼容**——不带该字段的消息行为完全不变。

**修订说明（v0.3）**：折入 R1+R2 八席意见——R3 约束 `ref` 形态、R4 错误加 `code` 并绑
`task_id`、R5/R6 拆「存/传」、`raw_ref.kind` 冻结最小枚举、三态未携带定义、交付物补齐、
A7 拆 A9/A10（可机械核对）、`timestamp` 归属明确。

**修订说明（v1.1 · 2026-10-16）**：并入 §过渡期告示——明德 R3 保留意见②（「是否纳入
v0.4 跟踪，待主人裁示」）经一澜 2026-10-16 裁示并入。**非需求变更**：R1–R8 未动、
边界未扩，不回 draft 重评审（一澜直批，同 2026-10-12 spec 标准 v1.1 先例）。称呼对账：
明德所称「v0.4」＝其执笔时（本 spec v0.3）预期的下一修订位；因定稿直接落 v1.0，该修订
位实际执行为 **v1.1**。

分级依据：单仓（csb-a2a-aip）、改动限于消息 schema 的向后兼容扩展与校验、不触协议/
安全/身份/契约路径 → **M 级**。

**字段约定（v0.3 · schema 版本 `csb://min-info/v0.1`）**：

```yaml
metadata:
  min_info:
    schema: "csb://min-info/v0.1"     # 版本标识，必填（存在 min_info 时）
    evidence:                          # 结论的证据指针，必填（存在 min_info 时）
      - ref: "csb://mem/event/12345"   # 本域指针（csb:// URI 形态），必填
        detail: "命中 case 001"         # 简短说明，选填
    raw_ref:                           # 原文指针，选填；接收方不自动解引用
      kind: "memory-event"             # 指针类型 ∈ 冻结最小枚举
      pointer: "csb://mem/event/12345" # 不透明指针（基线粒度＝事件 id 级）
      hash: "sha256:..."               # 完整性校验，选填
    timestamp: "2026-10-16T05:30:00Z"  # 生成时刻，必填；由**发送方**生成，处理器不兜底（缺失即非法，见 R4）
```

**`raw_ref.kind` 冻结最小枚举（v0.3）**：`memory-event` · `file-snippet`（可扩展，扩展须走本 spec 升版）。
**基线粒度可下钻说明（v0.3）**：基线为**事件 id 级**；如需下钻至 thread/segment 级，须走 **v0.3+ 升版**（写进 `specs/README.md` 映射表，明示可扩展边界）。

## 需求

- **R1** [WHEN] 消息携带 `metadata.min_info` 且 `schema` 为已知版本值时，消息处理器 SHALL 原样保留该字段并随任务元数据一并转交接收方
- **R2** [IF] 消息未携带 `metadata.min_info`（字段不存在、为 `undefined`、或为空对象 `{}` —— 三态均视为未携带）时，处理器 SHALL 按既有行为处理，不新增校验、不改写正文
- **R3** [WHEN] `metadata.min_info.evidence` 存在时，其每一项 SHALL 至少含一个符合 `csb://` URI 形态的字符串 `ref` 字段
- **R4** [IF] `metadata.min_info` 存在但结构不合法（缺 `schema`/`timestamp`，或证据项缺合法 `ref`）时，处理器 SHALL 返回 `InvalidParams`（错误体含 `code: "MIN_INFO_SCHEMA_INVALID"`）并将原因、`trace_id` 与 `task_id` 写入日志
- **R5** [WHEN] 处理器接收到含 `raw_ref` 的消息时，SHALL 将 `raw_ref` 作为不透明指针保存，不解析、不自动解引用
- **R6** [WHEN] 处理器接收到含 `raw_ref` 的消息时，SHALL 不发起任何以该指针为目标的出站请求（不外发原文）
- **R7** [WHEN] `metadata.min_info.raw_ref.kind` 出现时，其值 SHALL 属于冻结最小枚举 `{memory-event, file-snippet}`
- **R8** [WHERE] 在 A2A v4（`a2a-standard-api.js`）与 v5（`a2a-standard-api-v5.js`）两个实现中，`metadata.min_info` 的校验与透传语义 SHALL 一致

## 边界（不做什么）

- 不改消息正文（`parts[].text`）语义，也不动审计侧既有的 `evidence:{ref,detail}`（不读取、不改写）
- **不实现** `raw_ref` 的解析/原文拉取与按需展开的授权、传输（Q2 · 二期；一期起步取向＝**逐次显式授权**）
- 不引入任何 npm 新依赖
- 不触协议 / 安全 / 身份 / 契约路径（本次仅做 schema 扩展与结构校验）

## 验收

- [ ] A1 → R1：`node tests/min-info.test.js` 断言转发后的 `metadata.min_info` 与输入逐字段相等
- [ ] A2 → R2：三态用例（缺失 / `undefined` / `{}`）断言均按旧行为处理、无新增字段
- [ ] A3 → R3：`ref` 非 `csb://` 形态用例，断言该项被判非法
- [ ] A4 → R4：非法结构用例断言返回 `InvalidParams` 且错误体含 `code=MIN_INFO_SCHEMA_INVALID`、日志含 `trace_id` 与 `task_id`
- [ ] A5 → R5：含 `raw_ref` 用例断言保存后**未发生解析/解引用**（解析器调用计数为 0）
- [ ] A6 → R6：含 `raw_ref` 用例断言 **mock 出站请求计数为 0**
- [ ] A7 → R7：`kind` 非法值用例断言被判非法；枚举值用例通过
- [ ] A8 → R8：v4 / v5 双实现共用同一 fixture，断言校验结果一致
- [ ] A9 → 背景：`csb://min-info/v0.1` 校验文件（JSON Schema 或等价）落库并通过示例载荷自检
- [ ] A10 → 背景：`specs/README.md` 含**三列映射表**（spec 条款 → LIP 子则 → 宪章条款）+ 指向 LIP 子则 L1 的可点击引用 + 基线可下钻说明（可一键核验）

## 部署

无（纯 schema 向后兼容扩展 + 结构校验；无需新增 env、无需数据迁移；老客户端不带字段行为不变）

**交付物（随实现一并落地）**：`csb://min-info/v0.1` 校验文件（JSON Schema 或等价）· v4/v5 schema registry entry · 共享测试 fixture 模板 · 带 `min_info` 的完整 JSON 示例载荷（落 `specs/README.md`）· 旧版 Agent 渐进接入指南。

## 待澄清 ⚠️

无（Q1 `raw_ref` 指针粒度已定基线＝**事件 id 级**；Q2 授权模型于本 spec **声明暂不实现**，二期起步取向＝逐次显式授权）

## 过渡期告示（v1.1 · 2026-10-16）

> 性质：**对外告示文本，可整段摘引**；非需求变更——不新增 SHALL、不改 R1–R8。
> 缘起：R2 明德提议「老消息不带 `min_info` 的兼容提示」不入本期强约束 → R3 请一澜
> 裁示是否纳入下一修订 → 一澜 2026-10-16 裁示：趁热并入协议正文。

**《A2A 消息最小信息约定 · 过渡期告示》**（2026-10-16 · CSB 协议组）

1. **规范已定稿**：SPEC-A2A-0002 v1.0（approved · 2026-10-16 · 协议组三轮 0 反对）。
   A2A 消息新增**可选** `metadata.min_info`（`schema` / `evidence[]` / `raw_ref` /
   `timestamp`），消息默认可携带「结论 + 证据指针」，原文留数据侧按需拉取。
2. **尚未实施**：approved ≠ 开工。实现（v4/v5 校验与透传、`csb://min-info/v0.1`
   校验文件、渐进接入指南）待实施指示后推进；落地前全网消息形态**不变**。
3. **兼容承诺（R2 的对外表述）**：过渡期内，不携带 `metadata.min_info` 的消息
   （字段缺失 / `undefined` / `{}` 三态）一律按既有行为处理——不新增校验、不改写
   正文、不拒收。**老消息不是错误。**
4. **对已携带方**（实现落地后生效）：发送方按 R3/R7 填写 `evidence[].ref`
   （`csb://` 形态）与 `raw_ref.kind`（冻结枚举）；接收方原样透传（R1）、
   `raw_ref` 只存不析（R5）、不发起以该指针为目标的出站请求（R6）；结构非法
   按 R4 返回 `MIN_INFO_SCHEMA_INVALID`。
5. **旧版 Agent 零义务**：不带字段即合规，无需任何改动即可继续互通；接入为
   渐进式，指南随实现交付。
6. **退出条件**：实现落地并经观察期后，由协议组另行公告过渡期结束；本告示
   不预设日期。

## 保留意见（定稿附录）

1. **思源 🌱（R3 · ✅B 注条）**：`timestamp` 仅由发送方生成，若跨节点异步转发导致逻辑时序错乱，R4 的非法判定可能误伤。**建议后续版本补充逻辑时钟或容忍窗口机制**（非阻塞，二期候选）。
2. **明德 📜（R3 · 意见稿）**：请主人裁示「过渡期告示」是否纳入 v0.4 跟踪；正式签字走主会话（自动通道不可代签）。**→ ✅ 已闭环（2026-10-16）**：一澜裁示并入，落 §过渡期告示（v1.1；「v0.4」＝评审期下一修订位，实际执行 v1.1）。
3. **星尘 ⭐（R3 · 建议）**：A9/A10 交付物宜明确校验文件落库路径与映射表模板（实现层细化，不修需求）。