---
spec_id: SPEC-A2A-0002
title: A2A 消息最小信息约定（evidence/raw_ref 双字段）
status: draft
level: M
version: 0.1
repo: csb-a2a-aip
scope: a2a
authors: [一澜, 若兰]
agents: [ruolan]
reviewers: []
base: main
supersedes: null
created: 2026-10-16
updated: 2026-10-16
notes: "落点 1/3（若兰核真版《Context Mode 借鉴备忘》2026-10-15）：审计侧 evidence 升格为消息侧最小信息约定。对接 LIP 子则 L1（carbon-silicon-bond-protocol/protocol/csb-principle-lip-v0.1-draft.md）与宪章 10.1 上下文卫生 + 案例 001「上下文污染→身份漂移」的工程解。"
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

分级依据：单仓（csb-a2a-aip）、改动限于消息 schema 的向后兼容扩展与校验、不触协议/
安全/身份/契约路径 → **M 级**。

**字段约定（v0.1 · schema 版本 `csb://min-info/v0.1`）**：

```yaml
metadata:
  min_info:
    schema: "csb://min-info/v0.1"     # 版本标识，必填（存在 min_info 时）
    evidence:                          # 结论的证据指针，必填（存在 min_info 时）
      - ref: "csb://mem/event/12345"   # 本域指针（不透明），必填
        detail: "命中 case 001"         # 简短说明，选填
    raw_ref:                           # 原文指针，选填；接收方不自动解引用
      kind: "memory-event"             # 指针类型（枚举待 LIP 定，见 Q1）
      pointer: "csb://mem/raw/9f2a"    # 不透明指针
      hash: "sha256:..."               # 完整性校验，选填
    timestamp: "2026-10-16T05:30:00Z"  # 生成时刻，必填（存在 min_info 时）
```

## 需求

- **R1** [WHEN] 消息携带 `metadata.min_info` 且 `schema` 为已知版本值时，消息处理器 SHALL 原样保留该字段并随任务元数据一并转交接收方
- **R2** [IF] 消息未携带 `metadata.min_info` 时，处理器 SHALL 按既有行为处理，不新增校验、不改写正文
- **R3** [WHEN] `metadata.min_info.evidence` 存在时，其每一项 SHALL 至少含字符串 `ref` 字段
- **R4** [IF] `metadata.min_info` 存在但结构不合法（缺 `schema`/`timestamp`，或证据项缺 `ref`）时，处理器 SHALL 返回 `InvalidParams` 并将原因写入日志
- **R5** [WHEN] 处理器接收到含 `raw_ref` 的消息时，SHALL 将 `raw_ref` 作为不透明指针保存，且不自动解引用、不自动外发原文
- **R6** [WHERE] 在 A2A v4（`a2a-standard-api.js`）与 v5（`a2a-standard-api-v5.js`）两个实现中，`metadata.min_info` 的校验与透传语义 SHALL 一致

## 边界（不做什么）

- 不改消息正文（`parts[].text`）语义，也不动审计侧既有的 `evidence:{ref,detail}`
- 不实现 `raw_ref` 的实际解析/原文拉取服务（按需展开的传输协议另案）
- 不引入任何 npm 新依赖
- 不触协议 / 安全 / 身份 / 契约路径（本次仅做 schema 扩展与结构校验）

## 验收

- [ ] A1 → R1：`node tests/min-info.test.js` 断言转发后的 `metadata.min_info` 与输入逐字段相等
- [ ] A2 → R2：未带 `min_info` 的消息跑既有用例，断言行为与基线一致（无新增字段、无额外校验）
- [ ] A3 → R3：证据项缺 `ref` 的结构校验用例，断言该项被判为非法
- [ ] A4 → R4：非法结构用例断言返回 `InvalidParams` 且日志含原因
- [ ] A5 → R5：含 `raw_ref` 用例断言保存后**无任何出站请求**（mock 网络调用计数为 0）
- [ ] A6 → R6：v4 / v5 双实现对同一输入的校验结果一致性用例通过
- [ ] A7 → 背景：本 spec 与 LIP 子则 L1 的映射表写入 `specs/README.md` 索引备注并复核

## 部署

无（纯 schema 向后兼容扩展 + 结构校验；无需新增 env、无需数据迁移；老客户端不带字段行为不变）

## 待澄清 ⚠️

- Q1 `raw_ref` 指针粒度（文件级 / 行级 / 事件 id 级）——待 LIP 草案对应条定论，本 spec 暂取「不透明字符串」
- Q2 按需展开的授权模型（逐次授权 vs 契约预授权；挂身份护照哪个字段）——与 LIP 同议，二期定