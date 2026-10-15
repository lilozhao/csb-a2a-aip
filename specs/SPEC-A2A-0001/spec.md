---
spec_id: SPEC-A2A-0001
title: LLM 路由接入本地 35B 优先链
status: approved
level: M
version: 1.0
repo: csb-a2a-aip
scope: a2a
authors: [一澜, 若兰]
agents: [ruolan]
reviewers: [阿轩]
base: main
supersedes: null
created: 2026-10-12
updated: 2026-10-12
notes: "实施暂停（2026-10-12 06:19 一澜指示）：宿主机 35B（1919）暂时起不来，待服务恢复后从 approved 续入 implementing"
---

## 背景与目标

A2A 桥接的 LLM 调用目前按 `direct → openclaw → openai → hermes → local` 链序执行
（`llm-router.js` DEFAULT_ADAPTER_ORDER，2026-10-03 修定），**本地 35B（172.28.0.1:1919）
从未接入**——「A2A LLM 优先级：本地 35B → token-plan → gateway 兜底」自 2026-09-12
记录为「待实施」至今（见 workspace TOOLS.md）。本 spec 补上这一缺口：本地模型可达时
优先使用（省外部额度、降延迟），不可达时链序行为与现状完全一致。

分级依据：单仓（csb-a2a-aip）、仅 LLM 路由配置、不触协议/安全/身份/契约 → **M 级**。
实测背景：2026-10-12 05:2x 探测 `172.28.0.1:1919` 连接拒绝（服务未常驻）——
与 `.env` 注释「本地 1919 不可用时自动 fallthrough（2026-09-04 一澜确认）」的设计意图一致：
1919 允许不在线，fallthrough 本就是设计本身，R2/R5 已覆盖。

## 需求

- **R1** [WHEN] 环境变量 `A2A_LOCAL_LLM_URL` 已设置（默认 `http://172.28.0.1:1919`）且本地模型服务可达时，LLM 路由 SHALL 将本地模型置于链首并优先调用
- **R2** [IF] 本地模型连接失败、超时（阈值 `A2A_LOCAL_LLM_TIMEOUT_MS`，默认 12000ms）或返回非 2xx，路由 SHALL 降级至下一适配器（direct），且降级耗时不得超过超时阈值
- **R3** [IF] 本地模型返回空 content（含仅空白），路由 SHALL 视为失败并继续降级（沿用 2026-10-03 gateway 空答复判定先例）
- **R4** [WHEN] 每次调用命中或发生降级时，日志 SHALL 输出 `[LLM-Router]` 前缀的适配器名与降级原因
- **R5** [WHEN] `A2A_LOCAL_LLM_URL` 未设置时，路由链 SHALL 保持现状（direct → openclaw → openai → hermes → local），不引入任何行为变化
- **R6** [IF] 本地模型仅返回 `reasoning_content` 而 content 为空，路由 SHALL 按 direct 适配器既有规则处理并输出告警

## 边界（不做什么）

- 不改 `identity.llm` 兜底直连逻辑与鉴权机制（本地模型无鉴权，沿用直连）
- 不引入任何 npm 新依赖（复用 http/https + 现有适配器模式）
- 不改动 openai / hermes / local 适配器的既有实现
- 不触碰 A2A 消息协议、身份链与委托逻辑

## 验收

- [ ] A1 → R1：`node tests/llm-router-order.test.js` 断言链序首位为 `local-llm` 且适配器已注册
- [ ] A2 → R2：mock 不可达地址用例，断言在超时阈值内降级至 direct 且返回非空
- [ ] A3 → R3：mock 空答复用例，断言继续降级而非返回空
- [ ] A4 → R4：用例捕获日志，断言降级时输出适配器名与原因
- [ ] A5 → R5：未设 env 时链序回归用例（与现状五链完全一致）
- [ ] A6 → R6：reasoning-only 用例，断言按既有规则处理并告警
- [ ] A7 → 背景：repo README 与 workspace TOOLS.md 的「待实施」标记更新为已实施（代码与文档同步）

## 待澄清 ⚠️

无（原 Q1「1919 是否常驻」已由 `.env` 注释设计意图答复：允许不在线，fallthrough 即设计）
