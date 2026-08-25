# Leader Agent Platform 测试套件

## 测试分类

### 单元测试 (`tests/unit/`)

单元测试使用 Mock 对象模拟外部依赖，不需要真实的 LLM 服务。运行速度快，适合开发时频繁执行。

**运行方式：**

```bash
cd demo-leader

# 运行单元测试（默认串行执行）
just test unit
```

> **默认串行**：单元测试默认使用串行执行模式 (`-n 0`)，无需额外指定参数。

### 集成测试 (`tests/integration/`)

本项目的集成测试的基本原则是不使用 Mock，使用真实的 LLM API 调用和真实的 Partner 服务，通过 API 响应和内部状态双重验证。

> **例外**：部分测试的 Fallback 测试类使用 Mock 模拟服务故障，以测试错误降级逻辑。

**运行方式：**

```bash
# 从项目根目录运行
cd demo-leader

# 准备本地测试环境
just test bootstrap

# 另起终端，先启动 demo-partner
cd ../demo-partner && just app bootstrap && just app start

# 运行集成测试（默认 2 worker 文件级并发）
just test integration

# 指定 worker 数量
just test integration -- -n 4 -v

# 串行运行（禁用并行，用于调试）
just test integration -- -n 0 -v
```

> **默认并行**：集成测试默认使用 `-n 2 --dist=loadfile`。这样会保持同一测试文件内的用例顺序，同时允许不同测试文件并发执行。使用 `-n 0` 可切换为串行模式用于调试；也可通过环境变量 `JUST_TEST_LOADFILE_WORKERS` 调整默认 worker 数。

**测试分组：**

| 测试文件                         | 对应功能 | 说明                               |
| -------------------------------- | -------- | ---------------------------------- |
| test_intent_analyzer.py          | LLM-1    | 意图分析与场景识别                 |
| test_planning_flow.py            | LLM-2    | 全量规划流程                       |
| test_clarification_flow.py       | LLM-3    | 反问合并流程（含 Fallback 测试）   |
| test_input_router_flow.py        | LLM-4    | 增量更新（InputRouter）路由流程    |
| test_completion_gate_flow.py     | LLM-5    | CompletionGate 完整流程            |
| test_aggregator_flow.py          | LLM-6    | 结果整合流程（含 Fallback 测试）   |
| test_history_compression_flow.py | LLM-7    | 历史压缩流程                       |
| test_task_new_flow.py            | 流程     | TASK_NEW 完整处理流程              |
| test_chitchat_flow.py            | 流程     | CHIT_CHAT 闲聊流程                 |
| test_multi_turn.py               | 流程     | 多轮对话流程                       |
| test_scenario_switch.py          | 流程     | 场景切换流程                       |
| test_idempotency_flow.py         | 校验     | 幂等性/模式/activeTaskId 校验      |
| test_async_execution_flow.py     | 异步     | 异步执行模式 (/submit + /result)   |
| test_session_creation.py         | Session  | Session 创建                       |
| test_session_ttl.py              | Session  | Session TTL 过期（patch 时间控制） |

### 端到端测试 (`tests/e2e/`)

端到端测试（E2E）是完全的黑盒测试，所有外部服务都是真实运行的，仅通过 HTTP API 的请求响应来验证业务正确性，不使用任何内部数据或模块进行断言。

**运行方式：**

```bash
# 从项目根目录运行
cd demo-leader

# 准备本地测试环境
just test bootstrap

# 另起终端启动 demo-partner
cd ../demo-partner && just app bootstrap && just app start

# 再另起终端启动 demo-leader
cd ../demo-leader && just app start

# 运行 E2E 测试（默认串行执行）
just test e2e

# 串行运行（禁用并行，用于调试）
just test e2e -- -n 0 -v
```

> **默认串行**：E2E 测试默认保持串行执行。真实环境基准中，默认并发会引入 `test_edge_cases.py::TestErrorHandling::test_empty_query` 读超时回归，因此这里只保留显式 opt-in 并发：需要实验时可手动传入 `-n 2 --dist=loadfile`，需要完全禁用 xdist 时可继续传入 `-n 0`。

**测试分组：**

| 测试文件             | 说明                                           |
| -------------------- | ---------------------------------------------- |
| test_api_contract.py | API 契约测试（请求/响应格式验证）              |
| test_edge_cases.py   | 边界情况测试（会话管理、错误处理、幂等性）     |
| test_user_journey.py | **用户旅程测试**（同一 session 12 轮完整交互） |

**重点：用户旅程测试 (`test_user_journey.py`)**

用户旅程测试模拟真实用户在**同一个 session** 中进行 12 轮完整交互，验证：

- 上下文累积与理解
- 历史压缩触发
- 场景切换（闲聊 ↔ 任务）
- 增量更新处理
- 异常恢复
- 长链路状态一致性

包含 6 个 Phase（所有测试共享同一 session）：

- `TestPhase1_Opening`: 开场问候和能力了解（Turn 1-2）
- `TestPhase2_InitiateTask`: 发起旅游规划任务（Turn 3）
- `TestPhase3_SupplementInfo`: 补充信息和修改要求（Turn 4-6）
- `TestPhase4_IntermittentChitchat`: 中间穿插闲聊（Turn 7-8）
- `TestPhase5_ErrorRecovery`: 异常输入和恢复（Turn 9-10）
- `TestPhase6_Conclusion`: 总结和验证（Turn 11-12）

## 测试命令汇总

| 测试类型 | 命令                    | 默认模式               | 外部依赖       |
| -------- | ----------------------- | ---------------------- | -------------- |
| 单元测试 | `just test unit`        | 串行                   | 无             |
| 集成测试 | `just test integration` | `-n 2 --dist=loadfile` | LLM + Partner  |
| E2E 测试 | `just test e2e`         | 串行                   | Leader+Partner |

> **说明**：当前默认执行模式由仓库根目录的 `Justfile` 控制，而不是各测试目录下独立的 `pytest.ini`。`unit` / `api` / `e2e` 默认串行，`integration` 默认使用 `-n 2 --dist=loadfile`。

## 其它测试

```bash
# 运行全部测试（沿用各目录的默认模式）
just test all

# 带覆盖率报告
uv run pytest tests/ -v --cov=leader/assistant --cov-report=term-missing -n 0
```

## 注意事项

1. 集成测试需要有效的 LLM 配置（`config.toml`）
2. 集成测试和 E2E 测试需要先启动兄弟项目 `demo-partner`：`cd ../demo-partner && just app bootstrap && just app start`
3. E2E 测试需要先启动当前项目：`just app start`
4. 测试运行时间较长时，可使用 `-x` 参数在首次失败时停止
5. 使用 `--tb=short` 简化错误输出
