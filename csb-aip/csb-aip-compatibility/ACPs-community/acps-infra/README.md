# acps-infra

acps-infra 是 ACPs 的基础设施与交付编排仓库，负责三类事情：给 sibling 项目提供本地开发共享依赖、
为交付准备 stage 基础设施、把多个 `release-app` 产物组装成 same-host standalone 包并完成安装或升级。
本文从使用者角度组织，重点回答三个问题：这个仓库负责什么、日常开发依赖怎么起、打包和部署时该用哪个脚本。

## 1. 概述

### 1.1. 这个仓库负责什么

- `dev-infra/`：本地开发共享依赖，服务于 `registry-server`、`ca-server`、`discovery-server` 等 sibling 项目
- `stage-infra/`：交付侧基础设施，提供 nginx、postgres、redis、rabbitmq 等运行底座
- `scripts/release-standalone/`：统一构建 standalone 包，并提供目标机的 `install.sh` / `upgrade.sh`
- `provision/`：提供 Agent 注册、证书申请和 discovery 同步等辅助工具
- `scripts/tests/`：打包前置检查、smoke 和全链路验证脚本

### 1.2. 关键目录

```text
acps-infra/
├── dev-infra/                    # 本地开发共享依赖
├── stage-infra/                  # stage 基础设施
├── scripts/release-standalone/   # standalone 构建、安装、升级
├── provision/                    # Agent 配置与注册工具
└── scripts/tests/                # preflight、smoke、E2E 验证脚本
```

### 1.3. 什么时候用哪个入口

| 目标                       | 入口                                  |
| -------------------------- | ------------------------------------- |
| 启动本地开发共享依赖       | `dev-infra/dev-infra.sh`              |
| 准备 stage 基础设施        | `stage-infra/deploy.sh`               |
| 构建统一 standalone 交付包 | `scripts/release-standalone/build.sh` |
| 目标机首次安装             | standalone 包内的 `install.sh`        |
| same-host 升级             | standalone 包内的 `upgrade.sh`        |
| Agent 注册、证书与发现辅助 | `provision/provision.sh`              |

## 2. 开发

### 2.1. 前置条件

- [uv 官方安装文档](https://docs.astral.sh/uv/getting-started/installation/)
  ：如需运行 `provision_tools` 或与 sibling 项目保持一致的 Python 工具链，建议安装
- [just 官方安装文档](https://just.systems/man/en/packages.html)
  ：本仓主流程不直接依赖 `just`，但 sibling 项目开发统一通过 `just` 组织
- [Docker Desktop 官方下载](https://www.docker.com/products/docker-desktop/)
  ：`dev-infra`、`stage-infra`、standalone 构建与部署验证都依赖 Docker

### 2.2. 本地开发共享依赖

如果你的目标是给 sibling 项目提供共享依赖，优先使用 `dev-infra/dev-infra.sh`，不要直接操作底层
Compose 文件：

```bash
./dev-infra/dev-infra.sh doctor              # 检查 Docker、Compose、网络与配置
./dev-infra/dev-infra.sh up                  # 启动默认共享依赖（postgres）
./dev-infra/dev-infra.sh up redis rabbitmq   # 按需补充 redis / rabbitmq
./dev-infra/dev-infra.sh status              # 查看当前共享依赖状态
./dev-infra/dev-infra.sh down                # 停止共享依赖
```

### 2.3. 开发说明

- `dev-infra` 的职责是支持本地开发，不是生产部署入口。
- sibling 项目日常开发通常只需要 `postgres`，按需再启动 `redis`、`rabbitmq` 和 `gateway`。
- ACPs 各 Python 项目的运行环境不依赖本机预装 Python；进入 sibling 项目开发时，通常由各项目的
  `just prep sync` 通过 `uv` 下载 managed Python，并把依赖安装到各自的 `.venv/`。
- `dev-infra` 的服务、端口、证书和更多命令说明，统一见 [dev-infra/README.md](dev-infra/README.md)。

## 3. 打包

### 3.1. 构建 standalone 交付包

`scripts/release-standalone/build.sh` 会统一调用各项目的 `release-app` 打包脚本，并最终生成一个
same-host standalone 离线包。

```bash
# 指定版本号
bash scripts/release-standalone/build.sh 1.0.0

# 使用时间戳版本
bash scripts/release-standalone/build.sh

# 指定目标平台
PLATFORMS=linux/amd64 bash scripts/release-standalone/build.sh 1.0.0

# 让 discovery-server 使用 GPU 构建档位
DISCOVERY_BUILD_PROFILE=gpu bash scripts/release-standalone/build.sh 1.0.0
```

构建说明：

- 产物会输出到 `dist/` 目录，最终文件名形如 `acps-demo-standalone-{version}-{platform}.tar`。
- 当前 standalone 交付包含 7 个 bundle：`acps-stage-infra`、`registry-server-app`、`ca-server-app`、
  `discovery-server-app`、`mq-auth-server-app`、`demo-partner`、`demo-leader`。

### 3.3. 目标机首次安装

```bash
tar xf acps-demo-standalone-{version}-{platform}.tar
cd acps-demo-standalone-{version}-{platform}
cp .env.example .env
# 编辑 .env：填写 LLM 密钥、密码、端口等运行参数
bash install.sh
```

安装说明：

- `install.sh` 仅用于 same-host 全新安装或全量重置后重装。
- 它读取当前解压目录下的顶层 `.env`。
- 默认会执行完整部署和业务烟测；如果只想验证基础设施与 server，可关闭业务烟测。

### 3.4. 升级

```bash
tar xf acps-demo-standalone-{version}-{platform}.tar
cd acps-demo-standalone-{version}-{platform}
# 按现网值准备当前包根目录下的 .env
bash upgrade.sh
```

升级说明：

- `upgrade.sh` 会先准备新 release，再对既有 runtime 执行原地升级和健康检查。
- 成功后会切换到新 release；失败时不会自动回退，保留现场供人工排查。

### 3.5. 业务烟测

为避免 `install.sh` / `upgrade.sh` 在业务烟测失败时把多个组件的长日志直接混进最终输出，standalone 安装器默认会用 `DUMP_SMOKE_LOGS=false` 执行 `demo/leader/smoke-test-business.sh`。如果你明确需要恢复旧行为，可在顶层 `.env` 中设置 `DUMP_SMOKE_LOGS=true`。

安装和升级后，如需手工重跑业务烟测：

```bash
# 默认 active runtime 路径为 ./runtime；如自定义 INSTALL_ROOT，请替换为实际 runtime 路径
cd ./runtime/demo/leader
env DUMP_SMOKE_LOGS=false bash ./smoke-test-business.sh

# 如只想跑业务 happy path，不附带 AIP v2.1.0 审计
# env DUMP_SMOKE_LOGS=false RUN_AIPV210_AUDIT=false bash ./smoke-test-business.sh
```

`demo/leader/smoke-test-business.sh` 默认串联三段检查：

- 核心 happy-path 冒烟：验证 `registry-server`、`ca-server`、`discovery-server` 的基础业务链路。
- 混合静态/动态业务 happy path：通过 Leader API 执行一次完整业务流程，其中 `hotel`、`intercity_transport`
  走静态映射，`food`、`local_transport`、`attraction` 走动态 discovery；流程同时覆盖 direct RPC 与 group
  两种协同模式。
- AIP v2.1.0 审计冒烟：补充校验证书与 ACS、传输安全、RabbitMQ runtime、Auth/ACL、Redis fallback 和关键业务日志。

如需手工查看失败时的组件日志，建议分别执行：

```bash
cd ./runtime/demo/leader
docker compose --env-file .env -f compose.yml logs -f --tail 100 leader

cd ./runtime/demo/partners
docker compose --env-file .env -f compose.yml logs -f --tail 100 partners

cd ./runtime/stage-infra
COMPOSE_PROJECT_NAME=stage-infra docker compose --env-file .env -f compose.yml logs -f --tail 100 mq-auth-server rabbitmq
```
