# ACPs 通用打包与部署总览

本文用于总括 ACPs 在非 Docker / 通用 wheel 运行包场景下的整体打包与部署过程。它不替代各项目 README 第 4 章，也不重复 PostgreSQL、RabbitMQ、Redis 的原生安装细节；它的目标是回答三件事：

- 整体上应该按什么顺序部署。
- 每一步的关键前置依赖是什么。
- 具体细节应该到哪个项目或哪篇文档里继续看。

## 1. 适用范围

本文覆盖以下 7 个项目和 3 个基础服务文档：

- 核心服务：`registry-server`、`ca-server`、`discovery-server`、`mq-auth-server`
- 运维工具：`acps-cli`
- 示例应用：`demo-partner`、`demo-leader`
- 基础服务：PostgreSQL 17、RabbitMQ 4.x、Redis 7

如果你使用的是 `acps-infra` 的 standalone 顶层安装器，应优先以 `acps-infra/README.md` 和 `acps-infra/scripts/release-standalone/README.md` 为准。本文面向的是“不依赖 Docker 编排、按各仓 README 第 4 章逐个部署”的场景。

## 2. 文档地图

先把文档入口放在一起，部署时按这个表跳转最省事：

| 主题                              | 作用                                                             | 详细文档                                                                                |
| --------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| PostgreSQL 17 原生安装            | 给 `registry-server`、`ca-server`、`discovery-server` 提供数据库 | [postgresql-native-deployment.md](postgresql-native-deployment.md)                      |
| RabbitMQ 4.x 原生安装             | 给 `mq-auth-server` 与 AIP / 群组消息提供 Broker                 | [rabbitmq-native-deployment.md](rabbitmq-native-deployment.md)                          |
| Redis 7 原生安装                  | 给 `mq-auth-server` 提供 ACL 存储                                | [redis-native-deployment.md](redis-native-deployment.md)                                |
| `registry-server` 通用打包与部署  | Registry 部署、`9002` 两阶段切换                                 | [registry-server/README.md 第 4 章](../../registry-server/README.md#4-通用打包与部署)   |
| `ca-server` 通用打包与部署        | CA 部署、CA 材料准备                                             | [ca-server/README.md 第 4 章](../../ca-server/README.md#4-通用打包与部署)               |
| `discovery-server` 通用打包与部署 | Discovery 部署、pgvector、模型与同步                             | [discovery-server/README.md 第 4 章](../../discovery-server/README.md#4-通用打包与部署) |
| `mq-auth-server` 通用打包与部署   | MQ 鉴权服务部署、MQ/Redis 对接、证书获取                         | [mq-auth-server/README.md 第 4 章](../../mq-auth-server/README.md#4-通用打包与部署)     |
| `acps-cli` 通用打包与部署         | 统一证书 bootstrap、跨服务业务 smoke                             | [acps-cli/README.md 第 4 章](../../acps-cli/README.md#4-通用打包与部署)                 |
| `demo-partner` 通用打包与部署     | Partner 运行包部署与原地 bootstrap                               | [demo-partner/README.md 第 4 章](../../demo-partner/README.md#4-通用打包与部署)         |
| `demo-leader` 通用打包与部署      | Leader 运行包部署、原地 bootstrap、业务 smoke                    | [demo-leader/README.md 第 4 章](../../demo-leader/README.md#4-通用打包与部署)           |

## 3. 先理解这几条关键依赖

在开始部署前，先把下面几条关系记住；这决定了推荐顺序为什么不能随意打乱。

### 3.1. PostgreSQL 必须先于 3 个数据库服务

- `registry-server` 依赖 PostgreSQL。
- `ca-server` 依赖 PostgreSQL。
- `discovery-server` 依赖 PostgreSQL，并且只在它自己的数据库里额外需要 `pgvector`。

这 3 个服务都不能在数据库未准备完成时稳定启动。

### 3.2. `registry-server:9001` 和 `ca-server:9003` 必须先于证书 bootstrap

- `acps-cli` 的 `bootstrap.sh` 本质上在做“注册 -> 审批 -> EAB -> 发证”。
- 这条链路要求 Registry public plane 已经可用，也要求 CA 已经可用。

因此，下面这些证书都不能在 `registry-server:9001` 和 `ca-server:9003` 启动前申请：

- `registry-server:9002` 的 mTLS 证书
- `mq-auth-server` 的服务端证书和健康检查客户端证书
- RabbitMQ 的 `rabbitmq-server.pem` / `rabbitmq-client.pem`
- Redis 的 `redis-server.pem`
- `demo-partner` / `demo-leader` 的部署态证书

这些证书虽然都依赖 Registry + CA，但并不意味着要在 `acps-cli` 安装完成后集中一次性申请。更推荐的做法是：`acps-cli` 先作为工具安装好，后续在各自应用或基础服务的安装步骤里按需触发对应的 bootstrap。

### 3.3. `registry-server:9002` 不能首次部署就直接启用

`registry-server` README 第 4 章明确要求按“两步走”部署：

1. 先只启动 `9001`
2. 等 `acps-cli` 申请出 `9002` 服务端证书后，再切回双端口

也就是说，Registry 是整个系统里最明显的“先启动一半，再补证书，再完整切换”的项目。

### 3.4. RabbitMQ / Redis 应并入 `mq-auth-server` 前的安装链路

RabbitMQ / Redis 的软件安装本身不依赖证书申请，但如果把它们拆成“先装软件、后补证书、再回头改配置和启动”三段，安装过程会不连续，用户理解成本也会明显升高。因此本文不推荐“预安装”这两个基础服务，而是建议在 `mq-auth-server` 安装前，把 `rabbitmq` / `redis` 的证书申请和它们自己的 Linux 安装过程放在同一阶段里连续完成。

按这条主线理解更简单：

- PostgreSQL 需要一开始先完整装好。
- RabbitMQ / Redis 推荐在 `mq-auth-server` 安装前，先申请好各自证书，再一次性安装和启动。
- 如果沿用本文推荐的 ACPs 证书申请流程，RabbitMQ / Redis 的部署态证书需要在 Registry + CA + `acps-cli` 就绪之后申请。

### 3.5. `mq-auth-server` 必须晚于 RabbitMQ / Redis

`mq-auth-server` 运行时同时依赖：

- Redis
- RabbitMQ Management API
- 自己的 mTLS 证书目录

因此它通常应放在 RabbitMQ / Redis 已经可用之后再启动。

### 3.6. `demo-partner` 应早于 `demo-leader`

从两个 demo README 的第 4 章可以看出：

- `demo-partner` 自己可以先独立 bootstrap 和启动。
- `demo-leader` 的业务 smoke 依赖 `demo-partner` 已经存在并且已被 `discovery-server` 同步可见。

所以推荐顺序始终是：先 `demo-partner`，后 `demo-leader`。

## 4. 推荐的总体流程

下面给出一个保守但稳定的推荐流程。它优先保证依赖链清晰，而不是追求并行部署最短路径。

### 4.1. 第零步：先统一产出 7 个运行包

建议先在构建机统一完成 7 个项目的打包，再把产物交给目标环境部署。这样部署阶段只关心“安装和配置”，不再混入“现场编译与打包”。

建议打包对象：

- `registry-server`
- `ca-server`
- `discovery-server`
- `mq-auth-server`
- `acps-cli`
- `demo-partner`
- `demo-leader`

每个项目的具体打包命令和在线 / 离线包说明，请分别看各自 README 第 4.1 节。

### 4.2. 第一步：先安装 PostgreSQL 17

先按 [postgresql-native-deployment.md](postgresql-native-deployment.md) 完成以下动作：

- 安装 PostgreSQL 17
- 为 `registry-server`、`ca-server`、`discovery-server` 创建独立数据库和独立用户
- 仅在 `discovery-server` 的数据库里执行 `CREATE EXTENSION vector`

完成这一步后，3 个 PostgreSQL 依赖服务才有启动基础。

### 4.3. 第二步：先部署 `registry-server` 的第一阶段

先按 `registry-server/README.md` 第 4 章完成：

- wheel 运行包安装
- `.env` 与 `config/{APP_ENV}.toml` 配置
- 数据库迁移
- 只启动 `9001`，不要在第一次启动时直接拉起 `9002`

完成标志：

- `registry-server:9001` 可用
- `/health` 正常

这一步是整个系统证书 bootstrap 的前置门槛。

### 4.4. 第三步：部署 `ca-server`

再按 `ca-server/README.md` 第 4 章完成：

- wheel 运行包安装
- `.env` 与 `config/{APP_ENV}.toml` 配置
- CA 证书材料准备
- 数据库迁移
- 启动 `9003`

完成标志：

- `ca-server:9003` 可用
- Registry 与 CA 的互信令牌、地址配置已经一致

到这一步，证书注册与签发链路才算真正齐备。

### 4.5. 第四步：部署 `acps-cli`

按 `acps-cli/README.md` 第 4 章完成：

- 安装 `acps-cli` 运行包
- 准备 `acps-cli.toml`
- 确认至少 `[registry]` 与 `[ca]` 指向目标环境
- 预留 `bootstrap-artifacts/` 目录

如果稍后要直接做 core smoke，建议这一步也把 `[discovery]` 与 `[mq]` 地址一起配好。

这一步的重点是先把运维工具准备好；不要在这里把后续所有应用的证书一次性申请完。更推荐在各自安装步骤里按需执行对应的 `bootstrap.sh <profile>`。

### 4.6. 第五步：完成 `registry-server` 第二阶段证书申请与双端口切换

现在 `registry-server:9001`、`ca-server:9003` 和 `acps-cli` 都已就绪，可以把 Registry 安装过程推进到第二阶段。

在这个步骤里，按 `registry-server/README.md` 第 4.3 节，用 `acps-cli` 为 `9002` 申请部署态证书，再把 Registry 切回双端口：

1. 在 `acps-cli` 运行目录执行 `bash scripts/bootstrap.sh registry-9002`
2. 把 `server.pem`、`server.key`、`trust-bundle.pem` 复制到 Registry 运行目录
3. 保留 `client.pem`、`client.key`、`trust-bundle.pem` 在 `acps-cli` / 运维机上，供后续统一业务烟测使用
4. 把 `enable_mtls_listener` 切回 `true`
5. 重新拉起 `9001 + 9002`

这样做的原因是：`registry-server:9002` 本身就是 Registry 安装过程的一部分，更适合在 Registry 的安装步骤里完成，而不是和 RabbitMQ / Redis / `mq-auth-server` 证书混在一轮集中 bootstrap 里。

### 4.7. 第六步：部署 `discovery-server`

按 `discovery-server/README.md` 第 4 章完成：

- wheel 运行包安装
- `.env` 与 `config/{APP_ENV}.toml` 配置
- 数据库迁移
- embedding / LLM / DSP / polling 等外部依赖配置
- 启动 `9005`

`discovery-server` 不依赖 RabbitMQ / Redis 或 `mq-auth-server`，因此在 Registry 双端口恢复后就可以先部署。把它放在这里的好处是：后续 `acps-cli` 核心业务烟测会同时覆盖 Discovery，同一轮 smoke 前就不需要再回头补装 Discovery。

### 4.8. 第七步：安装并启动 RabbitMQ 4.x 和 Redis 7

现在进入与 `mq-auth-server` 最接近的基础设施阶段。推荐把 RabbitMQ / Redis 的证书申请和它们自己的 Linux 安装放在同一个步骤里连续完成：

1. 在 `acps-cli` 运行目录执行 `bash scripts/bootstrap.sh rabbitmq`
2. 在 `acps-cli` 运行目录执行 `bash scripts/bootstrap.sh redis`
3. 按 [rabbitmq-native-deployment.md](rabbitmq-native-deployment.md) 完成 RabbitMQ 安装、证书落盘、TLS / auth backend / vhost / exchange 初始化与启动
4. 按 [redis-native-deployment.md](redis-native-deployment.md) 完成 Redis 安装、证书落盘、TLS-only / AOF / 密码 / 缓存策略配置与启动

这里要特别注意：

- RabbitMQ / Redis 的基础设施证书需要单独执行 `rabbitmq` 和 `redis` profile。
- 这一阶段通常不需要给 `rabbitmq` / `redis` profile 传 `--install-dir`；先让证书产物落在 `bootstrap-artifacts/`，再随着正式安装一起复制到目标证书目录即可。

这一步结束后，`mq-auth-server` 所依赖的两个基础服务才真正满足部署态合同。

### 4.9. 第八步：部署 `mq-auth-server`

按 `mq-auth-server/README.md` 第 4 章完成：

- wheel 运行包安装
- `.env` 与 `config/{APP_ENV}.toml` 配置
- 在 `acps-cli` 运行目录执行 `bash scripts/bootstrap.sh mq-auth-server`
- 把 `bootstrap-artifacts/mq-auth-server/` 里的证书落到 `certs/`
- 确认 Redis 与 RabbitMQ Management API 参数
- 启动 `9007 / 9008`

这样安排的原因是：RabbitMQ / Redis 和 `mq-auth-server` 的依赖关系最直接，把这三者放成相邻步骤，整体理解成本最低。

### 4.10. 第九步：执行 `acps-cli` 核心业务 smoke

到这一步，核心链路所需的依赖都已经 ready：

- `registry-server`
- `ca-server`
- `RabbitMQ`
- `Redis`
- `mq-auth-server`
- `discovery-server`

在 demo 部署之前，建议先用 `acps-cli` 自带的跨服务业务烟测做一次“核心闭环验收”：

```bash
cd /opt/acps-cli
bash scripts/smoke-test-business.sh --config ./acps-cli.toml --bootstrap-dir ./bootstrap-artifacts
```

这一步的目标不是测 demo，而是确认 4 个核心服务及其关键基础设施依赖已经形成最小闭环：

- Registry 注册与审批可用
- CA EAB / 发证可用
- Discovery 同步与查询可用
- MQ ACL 写入与 allow / deny 可用

如果这里还不通过，不建议继续部署 demo。

### 4.11. 第十步：部署并 bootstrap `demo-partner`

按 `demo-partner/README.md` 第 4 章完成：

- 安装运行包
- 配置 `.env`
- 使用 `bash scripts/bootstrap.sh demo-partner --install-dir /opt/demo-partner`
- 启动全部 Partner
- 执行 `demo-partner` 自带 `scripts/smoke-test.sh`

完成标志：

- 各 Partner `acs.json` 已写回 AIC
- 各 Partner 子目录证书材料已落盘
- 本地 smoke 正常

### 4.12. 第十一步：让 `demo-partner` 先进入 Discovery 可见状态

在启动 `demo-leader` 业务 smoke 之前，推荐先按 `demo-leader/README.md` 的说明，通过 `acps-cli` 显式触发一次 Discovery 同步，并确认目标 Partner AIC 已可被 `discover query` 命中。

这一步可以避免把“Registry -> Discovery 的同步延迟”误诊成 Leader 逻辑故障。

### 4.13. 第十二步：部署并 bootstrap `demo-leader`

按 `demo-leader/README.md` 第 4 章完成：

- 安装运行包
- 配置 `.env` 与 `leader/config.toml`
- 使用 `bash scripts/bootstrap.sh demo-leader --install-dir /opt/demo-leader --partner-install-dir /opt/demo-partner`
- 启动 Leader API 与 Web UI
- 先跑基础 smoke，再跑业务 smoke

`demo-leader` 是整个推荐流程里的最后一层，因为它同时依赖：

- Registry
- CA
- Discovery
- RabbitMQ / mq-auth-server
- demo-partner

## 5. 一条更容易执行的推荐顺序

如果你只想拿一条最保守、最不容易错的顺序，直接按下面执行：

1. 统一打包 7 个运行包
2. 安装 PostgreSQL 17，并建好 3 个数据库
3. 部署 `registry-server`，只启动 `9001`
4. 部署 `ca-server`
5. 部署 `acps-cli`
6. 在 Registry 第二阶段安装过程中，用 `acps-cli` 申请 `registry-9002` 证书并切回双端口
7. 部署 `discovery-server`
8. 在 RabbitMQ / Redis 安装过程中，用 `acps-cli` 申请并落盘它们各自的证书，然后完成 RabbitMQ / Redis 安装与启动
9. 在 `mq-auth-server` 安装过程中，用 `acps-cli` 申请并落盘它自己的证书，然后完成 `mq-auth-server` 部署
10. 执行 `acps-cli` 核心业务 smoke
11. 在 `demo-partner` 安装过程中执行原地 bootstrap，并完成启动与基础 smoke
12. 触发 Discovery 同步并确认 Partner 可见
13. 在 `demo-leader` 安装过程中执行原地 bootstrap，并完成基础 smoke / 业务 smoke

## 6. 最后几个容易踩坑的点

- 不要把 `registry-server:9002` 当成第一次启动就能直接启用的端口；它必须等证书 bootstrap 完成后再打开。
- 不要在 `acps-cli` 安装完成后就集中一次性申请所有项目证书；更推荐在各自应用或基础服务的安装步骤里按需触发 bootstrap。
- 不要把 `discovery-server` 拖到 RabbitMQ / Redis / `mq-auth-server` 之后再装；本文推荐在 Registry 双端口恢复后先装 Discovery，再进入 MQ 相关链路，这样核心 smoke 的顺序更自然。
- 不要把 RabbitMQ / Redis 和 `mq-auth-server` 拆得太开；更推荐先完成 RabbitMQ / Redis，再紧接着完成 `mq-auth-server`。
- 不要因为 RabbitMQ / Redis 软件还没装，就误以为它们的证书还不能申请；`rabbitmq` / `redis` 的 bootstrap 依赖的是 Registry、CA 和 `acps-cli`，不是 RabbitMQ / Redis 进程本身。
- 不要以为 `acps-cli bootstrap.sh all` 覆盖了全部项目；它目前只覆盖 `registry-9002` 和 `mq-auth-server`。
- 不要在 `discovery-server` 部署完成前就执行 `acps-cli` 跨服务业务烟测；这套 smoke 会把 Discovery 同步与查询也算进主干闭环。
- 不要在 `demo-partner` 之前做 `demo-leader` 业务烟测；Leader 的 group 模式依赖 Partner 已存在且已被 Discovery 命中。
- 不要把各仓 README 第 4 章逐条平铺串起来执行而不看依赖关系；真正决定顺序的是“数据库、控制面、CLI 证书申请、消息基础设施、发现面、demo”这 6 层。

如果你在执行中卡住，优先回到“文档地图”表，定位当前步骤对应的项目 README 第 4 章或基础服务安装文档，而不是在本总览里继续找细节命令。
