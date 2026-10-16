# SPEC-A2A-0003 · tasks.md（L 级任务 + 追溯）

## 追溯矩阵

| 任务 | 需求 | 负责（人/agent） | 预估 |
|---|---|---|---|
| T1 展开请求/响应 schema + 身份校验 | R1, R2 | 待定 | 1d |
| T2 授权判定（默认拒绝 + 逐次显式授权） | R3, R4 | 待定 | 2d |
| T3 受限视图裁剪 + 粒度过界拦截 | R5 | 待定 | 1d |
| T4 结构化拒绝 + 账本计分 | R6 | 待定 | 0.5d |
| T5 L3 留存处置与声明 | R7 | 待定 | 0.5d |
| T6 安全例外通道（breach → 审计） | R8 | 待定 | 1d |
| T7 env 开关 + 回滚 + 文档 | R1…R8 | 待定 | 0.5d |

## 任务清单

- [ ] T1 定义 `RequestExpansion` 方法与本 spec 三态响应；身份缺失即 `EXPANSION_IDENTITY_REQUIRED`
- [ ] T2 默认拒绝 + 授权判定；逐次显式授权走数据侧 L3 确认窗口，返回 `expansion_pending`
- [ ] T3 按 `scope.granularity` 裁剪返回；越界即 `EXPANSION_SCOPE_EXCEEDED`
- [ ] T4 拒绝/超时结构化返回 + 账本 `expansion.*` 计分（P1）
- [ ] T5 展开后按 LIP L3 处置原文（默认删）+ 留存声明入账
- [ ] T6 breach/越界触发安全审计，且不被授权链拦截（R8 例外通道）
- [ ] T7 `A2A_EXPANSION_ENABLED`（默认 off）+ 回滚说明 + README/TOOLS 同步

## 实现对照表（done 前置 · lint L-14）

| 需求 | 实现位置（文件/函数） | 测试用例 |
|---|---|---|
| R1 | a2a-expansion.js:handleRequestExpansion | tests/expansion.test.js A1 |
| R2 | a2a-expansion.js:validateRequester | tests/expansion.test.js A2 |
| R3 | a2a-expansion.js:decideAuthorization | tests/expansion.test.js A3 |
| R4 | a2a-expansion.js:awaitConfirmation | tests/expansion.test.js A4 |
| R5 | a2a-expansion.js:projectView | tests/expansion.test.js A5 |
| R6 | a2a-expansion.js:denyWithReason | tests/expansion.test.js A6 |
| R7 | a2a-expansion.js:applyRetention | tests/expansion.test.js A7 |
| R8 | a2a-expansion.js:securityException | tests/expansion.test.js A8 |

> 说明：实现位置为拟落点（draft 阶段占位）；approved 后由实施方按实际落地修正，L-14 以 done 时的真实指针为准。