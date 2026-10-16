---
spec_id: SPEC-A2A-0003
title: A2A 原文按需展开与逐次授权
status: draft
level: L
version: 1.1
repo: csb-a2a-aip
scope: [a2a, sec]
authors: [一澜, 若兰]
agents: [ruolan]
reviewers: [阿轩, Jeason, 墨丘, 舟楫, 思源, 言直, 明德, 星尘]
base: main
supersedes: null
created: 2026-10-16
updated: 2026-10-16
notes: "二期（Q2 授权模型）。承 SPEC-A2A-0002（一期只传「结论+证据指针」，raw_ref 不解析）。本 spec 补「指针→原文」的按需展开与授权：默认最小、逐次显式授权起步、契约预授权可选。对接 LIP 子则 L1/L2/L3 + 宪章 10.1 + 案例 001。分级依据：触安全 + 身份信任链 + 跨仓（数据侧可能在 csb-memory）→ 存疑就高不就低，L 级。**v1.0 定稿（2026-10-16）**：协议组三轮（R1 7/7 L级全认 · R2 6采纳+1❌Q2 · R3 5×A+2×B+0❌）+ 一澜（人类评审）签字。"
---

## 背景与目标

一期（SPEC-A2A-0002）让 A2A 消息默认只带「结论 + 证据指针」（`metadata.min_info`），
`raw_ref` 只存不析——这解决了「上下文互传」，但留下一个口子：**接收方真需要原文时怎么办？**

二期限定这个口子：定义「**原文按需展开**」的请求–授权–返回闭环，把「谁能拉、拉到哪
一层、拉完留不留」钉成可机械校验的规则。默认最小（能不给就不给），拿到指针**不
等于**拿到原文；展开须**逐次显式授权**起步，契约预授权可选。

**修订说明（v0.3）**：在 v0.2 基础上补两处——① 边界增「契约预授权锚点须先 RFC 定义 `contracts[]` schema + 签名验真路径，不得留黑盒」（R2 Jeason 底线）② 部署增「自动化/测试链路独立限频注记」（R2 星尘）。

**修订说明（v0.2）**：折入 R1 七席意见——R4 明确 pending 主语并绑定请求指纹（防重放）·
R5 明确「数据侧权威裁剪 + `schema_hash` + 不可逆脱敏」· R8 明确 breach 阈值与审计回传 ·
新增 R9 限频、R10 防疲劳；Q1 定案（单 ref 单次）、Q2 声明暂不实现、Q3 数据侧权威。

分级依据：本 spec 触**安全**（授权判定、拒绝计分）、**身份信任链**（申请人身份锚）、
**跨仓**（`raw_ref` 数据侧可能在 csb-memory）→ 按标准「存疑就高不就低」定 **L 级**
（需 `design.md` + `tasks.md`）。

**与一期 / LIP 的关系**：

| 本 spec | 上游 |
|---|---|
| 请求–授权–返回闭环 | 一期 R5/R6（只存不析、零出站）——本 spec 是**唯一的例外通道**，须显式授权 |
| 默认最小 · 逐次显式授权 | LIP 子则 **L1**（默认最小、按需展开） |
| 本域处理 · 只送授权后视图 | LIP 子则 **L2**（本域处理） |
| 用完即删 · 未声明继续即删 | LIP 子则 **L3**（最小留存） |
| 身份锚 · 拒绝计分 | 工程契约 P1（拒绝要计分）+ P2（身份无默认值）· 复用 UAC/trust-evidence |
| breach 例外 | BID v3.3「安全例外通道」同精神 |

## 需求

- **R1** [WHEN] 接收方持有 `raw_ref` 且需原文时，A2A 处理器 SHALL 支持向其数据侧发起展开请求（`RequestExpansion`），并在未获授权前不返回原文
- **R2** [IF] 展开请求未携带可解析的申请人身份（A2A 标准身份名）时，处理器 SHALL 拒绝该请求并返回 `EXPANSION_IDENTITY_REQUIRED`
- **R3** [WHEN] 展开请求到达数据侧时，处理器 SHALL 默认按「拒绝」处置，仅当命中有效授权（逐次显式授权或契约预授权）时方返回原文或其受限视图
- **R4** [IF] 授权判定为需人类确认（逐次显式授权路径）时，处理器 SHALL 向**调用方**返回 `expansion_pending` 并异步通知数据侧主人待确认（二者缺一不可）
- **R5** [WHEN] 返回展开结果时，处理器 SHALL 由**数据侧为权威**裁剪受限视图（处理器仅作闸门，不得自行放行）
- **R6** [IF] 展开被拒或超时未获授权时，处理器 SHALL 返回结构化拒绝（含 `reason` 与 `code`）并写入账本，不得静默丢弃
- **R7** [WHEN] 展开结果返回后，处理器 SHALL 按 LIP 子则 L3 处置原文（默认不留；未声明继续即删），且记录留存声明
- **R8** [IF] 命中安全事件（breach / 越界 / 私自行动 / 隐私边界），且达**显式 breach 判据**时，处理器 SHALL 触发安全审计并按既有审计回传路径上报，且该审计不受本 spec 授权链路限制（防「安全例外」成越权后门）
- **R9** [IF] 展开请求或 pending 的重试频率超过阈值（`A2A_EXPANSION_RATE_LIMIT`，默认 3 次/60s/身份）时，处理器 SHALL 限流并返回 `EXPANSION_RATE_LIMITED`，同时记账
- **R10** [IF] 同一数据侧主人的 pending 连续未决达防疲劳阈值（`A2A_EXPANSION_FATIGUE_THRESHOLD`，默认 5）时，处理器 SHALL 汇总为一条待办而非逐条推送（防「习惯化放行」）
- **R11** [WHEN] 生成 pending 时，处理器 SHALL 为其绑定请求指纹 = `hash(raw_ref + requester.name + purpose)` 并保证同一指纹在确认窗口内仅被受理一次（防重放）
- **R12** [WHEN] 返回受限视图时，处理器 SHALL 附 `schema_hash` 并作不可逆脱敏（仅过滤不算达标）
- **R13** [WHEN] `scope.granularity` 为 `topic-batch` 时，处理器 SHALL 按同一主题标识校验批量 ref 均落在授权范围，越范围即 `EXPANSION_SCOPE_EXCEEDED`
- **R14** [WHEN] `scope.granularity` 为 `time-range` 时，处理器 SHALL 仅返回落在 `[from, to]` 内的事件
- **R15** [WHEN] `scope.granularity` 为 `time-range` 且请求含越界时间的事件时，处理器 SHALL 裁剪越界事件而非返回

## 边界（不做什么）

- 不改一期 `metadata.min_info` 的字段语义与 `raw_ref`「不解析」默认（本 spec 是**显式授权后的例外通道**）
- 不实现 `raw_ref` 指针的自动批量展开、不实现跨主体原文推送（pull-only，非 push）
- 首期 `scope.granularity` 仅 `single-ref`；**v1.1（三期）扩至 `topic-batch` / `time-range`（默认仍 `single-ref`）**
- **契约预授权（Q2）本期不实现、默认关**；但**实现前须先以 RFC 定义其锚点（`contracts[]` schema + 签名验真路径），不得留黑盒信任**（R2 Jeason 保留意见的底线要求）→ RFC 草案起于 `docs/rfc/RFC-contract-preauth.md`
- 不引入任何 npm 新依赖；不得绕过 UAC / 身份校验
- 不把「展开率 / 拒绝率」做成考核指标（LIP 边界：避免 Goodhart）

## 验收

- [x] A1 → R1：`node tests/expansion.test.js` 断言未授权展开请求不返回原文、且触发 `RequestExpansion` 流程
- [x] A2 → R2：缺身份用例断言返回 `EXPANSION_IDENTITY_REQUIRED` 且退出码非 0
- [x] A3 → R3：无有效授权用例断言默认拒绝；有效授权用例断言返回原文/受限视图
- [x] A4 → R4：pending 用例断言**调用方收 `expansion_pending` 且数据侧主人收到异步通知**
- [x] A5 → R5：超粒度请求用例断言由数据侧裁剪、处理器不自行放行
- [x] A11 → R11：同一请求指纹在窗口内第二次被拒（防重放用例）
- [x] A12 → R12：返回体含 `schema_hash` 且原字段不可逆还原（不可逆脱敏用例）
- [x] A6 → R6：拒绝/超时用例断言返回结构化拒绝且账本有该条记录（无静默）
- [x] A7 → R7：展开后用例断言原文按 L3 默认删除、留存声明已记
- [x] A8 → R8：breach 用例断言达判据即触发安全审计并按回传路径上报、不被授权链拦截
- [x] A9 → R9：超频用例断言返回 `EXPANSION_RATE_LIMITED` 且记账
- [x] A10 → R10：连续 pending 达阈值用例断言汇总为一条待办（非逐条推送）
- [ ] A13 → R13：`topic-batch` 批量用例断言越主题范围被拒、同主题内通过
- [ ] A14 → R14：`time-range` 用例断言范围内事件通过
- [ ] A15 → R15：`time-range` 越界用例断言越界事件被裁剪、不返回

## 部署

需新增 env（授权开关 `A2A_EXPANSION_ENABLED` 默认 off · 确认窗口 `A2A_EXPANSION_CONFIRM_TIMEOUT_MS` · 限频 `A2A_EXPANSION_RATE_LIMIT` · 防疲劳 `A2A_EXPANSION_FATIGUE_THRESHOLD`）；需重启 A2A 服务；回滚一步＝关开关（off 即回一期行为）。

**部署注记（R2 星尘）**：R9 限频默认值（3 次/60s/身份）面向人工确认场景；**自动化/测试链路需独立配置上限**，防 CI 误触发（部署文档须注明）。

## 待澄清 ⚠️

无（Q1 已定＝**单 ref 单次**；Q2 契约预授权于本 spec **声明暂不实现、默认关**，载体留待 RFC/二期；Q3 脱敏规则＝**数据侧权威**、协议层给最小 schema + 强制 `schema_hash`）

## RFC-DRAFT-ANCHOR（Q2 契约预授权 · 待建）

> 占位节（R3 阿轩/Jeason 注条）——接住「不得黑盒」底线：Q2 契约预授权虽本期默认关，
> 但**开关前**须先以 RFC 定义其锚点。本节占位，标记待建，防后续落地 schema 黑盒漂移。

- **锚点内容（待建）**：`contracts[]` schema · 签名验真路径 · 与身份护照的挂接字段
- **触发条件**：契约预授权一旦从「默认关」转为启用，本节须先补完并评审
- **状态**：🕳 **待建（RFC-DRAFT）** —— 本期不实现，此处仅占位

## 保留意见（定稿附录）

1. **Jeason 💼（R3 · ✅B）**：Q2 契约预授权锚点须先 RFC 定义（`contracts[]` schema + 签名验真路径），**不得黑盒** → 已落 §RFC-DRAFT-ANCHOR 占位 + 边界声明。
2. **阿轩 🔧（R3 · ✅A 注条）**：建议加 `RFC-DRAFT-ANCHOR` 占位节 → **已补**（本节）。
3. **舟楫 🚤（R3 · ✅A 注条）**：`requester` 与 `configuration.metadata.sender` 语义冗余，建议合单身份锚 → 记入；二期字段收敛。
4. **墨丘 🧙（R3 · ✅A 观察）**：`schema_hash` 校验触发点宜在展开前（防伪造视图绕脱敏）；R10 防疲劳阈值宜可配 → 实现层。
5. **思源 🌱（R3 · ✅A 注记）**：R10 防疲劳汇总仅适用低敏场景，**不得稀释对关键原文的逐次确认权** → 实现层。
6. **明德 📜（R2/R3）**：连续两轮仅回自动确认（无正式立场）；自动通道不可代签，若需其签字须本人主会话。
7. **言直 🔎**：全轮 OFFLINE（一澜 10-16 定「不再追」，不计弃权）。