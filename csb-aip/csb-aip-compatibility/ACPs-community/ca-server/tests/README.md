# 测试目录说明

## 分层约定

- `unit/`：纯单元测试，只验证本仓逻辑，不依赖真实数据库或真实网络服务。
- `integration/`：验证 `ca-server` 自身运行时与测试数据库、证书材料和内部依赖装配；外部 `registry-server` 交互必须通过 fake registry verifier、stub transport 或 contract fixture 表达，而不是要求真实 sibling 进程同时运行。
- `e2e/`：验证受管启动的临时 `ca-server` 实例的黑盒行为，覆盖 ACME、证书 CRUD、CRL、OCSP、admin-only 管理能力等本服务自闭环场景。

## 边界说明

- 本仓 `tests/` 不承载真实跨服务联调 e2e。
- 涉及 `ca-server` 与 `registry-server`、`discovery-server` 的真实联调链路，统一放在 `acps-cli/tests/e2e/` 中验证。
- 如果某个测试场景依赖真实 sibling 服务、共享 sibling 仓库配置或跨仓拓扑协作，它就不属于本仓 `integration` / `e2e` 的长期边界。

## 运行入口

- `just test unit`：纯单元层。
- `just test integration`：本服务 + 测试数据库 + fake registry peer。
- `just test e2e`：受管启动临时 `ca-server` 测试实例，并注入 `TEST_E2E_BASE_URL`。
- `just test`：顺序执行 `unit -> integration -> e2e`。

## 前置条件约定

- `just test bootstrap` 负责建立测试环境、准备测试库 schema 和本仓测试证书材料。
- `just test integration` 与 `just test e2e` 不会隐式执行 bootstrap；如果测试环境未准备好，会在入口检查阶段直接失败。
- 如需绕过 `just test ...` 直接执行 `uv run pytest`，请先确保 `.env` 中已配置 `TEST_DATABASE_URL`，并按需执行 `just prep migrate test`。
- 当前本仓黑盒 e2e 的目标是不依赖 sibling 仓库环境文件；如需真实跨服务联调，请切换到 `acps-cli`。

## skip 与 warning 约定

- 缺少真实 sibling 服务、缺少手工准备的 token/证书/环境文件，不应长期通过 `skip` 规避；这类前置条件应逐步转入 bootstrap、fixture 或受管测试实例准备逻辑。
- `skip` 只应用于未来工作、尚未实现能力或明确不支持的平台路径。
- warning 应视为待修复问题，优先在测试代码、fixture 和依赖兼容层处理。

## 调试建议

- 如需调试本仓黑盒 e2e，可优先使用 `just test e2e`，让测试入口自动拉起临时实例。
- 如需调试真实跨服务行为，请切换到 `acps-cli` 仓库，并按其 README 中的联调测试说明运行。
