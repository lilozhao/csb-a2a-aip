# ACPs Docker 单机部署安装指南

本文是 ACPs 基于 Docker 的单机 standalone 离线包部署安装说明。Docker 单机部署包的安装、升级、验证和常见排查只在本文维护，各项目仓库不再重复描述这部分流程。

本文面向已经拿到完整 standalone tar 包的部署者。首次安装与 same-host 整体升级时，安装者只需要操作顶层解压目录中的 `.env`、`install.sh` 和 `upgrade.sh`；只有在安装完成后需要调整 server 侧 `config/*.toml` 时，才需要进入对应组件运行目录重新执行其 `deploy.sh`。

## 1. 安装对象与基本原则

Docker 单机部署包文件名形如：

```text
acps-demo-standalone-{version}-{platform}.tar
```

该包用于在同一台目标机上部署一套完整 ACPs demo 系统。包内包含基础设施、应用服务、demo 应用、Docker 镜像、Compose 编排、证书 provision 脚本、配置模板和元数据。

安装时遵循以下原则：

- 只使用 standalone 包顶层的 `.env` 作为安装配置入口。
- 首次安装或全量重置后重装使用 `install.sh`。
- same-host 整体升级使用 `upgrade.sh`。
- 不手工修改 `bundles/`、`manifest.toml`、`checksums.txt` 或各组件包内容。
- 不把完整安装脚本当作单组件更新工具使用。

`install.sh` 会在安装前清理本流程管理的 Docker 容器、网络、卷和相关镜像。因此它适用于全新安装或明确接受全量重置的重装场景，不适用于保留当前运行状态的原地升级。

## 2. 安装包内容

standalone 包解压后的顶层结构如下：

```text
acps-demo-standalone-{version}-{platform}/
  bundles/
    acps-stage-infra-{version}.tar.gz
    registry-server-app-{version}.tar.gz
    ca-server-app-{version}.tar.gz
    discovery-server-app-{version}.tar.gz
    mq-auth-server-app-{version}.tar.gz
    demo-partner-{version}.tar.gz
    demo-leader-{version}.tar.gz
  .env.example
  VERSION
  manifest.toml
  version-matrix.toml
  checksums.txt
  install.sh
  upgrade.sh
  provision-registry-server-mtls-certs.py
  provision-stage-infra-certs.py
  provision-mq-auth-server-certs.py
  lib/
  README.md
```

关键文件说明：

| 文件 | 作用 |
| --- | --- |
| `bundles/` | 7 个组件离线包 |
| `.env.example` | 顶层安装配置模板 |
| `VERSION` | standalone 包版本、平台和构建时间 |
| `manifest.toml` | 组件包清单、来源信息和 SHA256 |
| `version-matrix.toml` | 组件、镜像、镜像 digest 和元数据矩阵 |
| `checksums.txt` | 顶层文件校验和 |
| `install.sh` | 首次安装或全量重置后重装入口 |
| `upgrade.sh` | same-host 整体升级入口 |
| `provision-*.py` | 安装期证书申请与分发脚本 |

## 3. 目标机准备

目标机需要具备：

- Docker daemon 可用。
- `docker compose` 可用。
- `bash`、`tar`、`curl`、`openssl` 可用。
- `sha256sum` 或 `shasum` 可用，用于校验安装包。
- Linux 目标机需要 root 权限执行安装或升级，以便调整 bind mount 证书目录属主。

Linux 目标机通常使用：

```bash
sudo bash install.sh
sudo bash upgrade.sh
```

如果目标机不是 Linux，或运行环境已经满足脚本所需权限，可以直接使用 `bash install.sh` 或 `bash upgrade.sh`。

部署前请确认以下宿主机端口没有被占用：

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `STAGE_NGINX_PORT` | `9000` | stage-nginx 对外入口 |
| `REGISTRY_SERVER_MTLS_PORT` | `9002` | registry-server 独立 mTLS 入口 |
| `MQ_AUTH_PORT` | `9007` | mq-auth-server 独立 mTLS 入口 |
| `LEADER_WEB_PORT` | `9010` | demo-leader Web UI 入口 |
| `RABBITMQ_PORT` | `5671` | RabbitMQ TLS 端口 |

`9001`、`9003`、`9005` 对应的服务入口继续通过 nginx public plane 暴露；`9008` 保持为 Docker 网络内部 mTLS 入口，不发布到宿主机。

如果 `DISCOVERY_MODE=gpu`，目标机还需要提前准备 GPU 运行环境、本地 embedding 模型目录，以及与镜像运行方式匹配的设备访问能力。standalone 包不会安装 GPU 驱动，也不会内置本地模型文件。

## 4. 解包与顶层配置

将 standalone 包复制到目标机后执行：

```bash
tar xf acps-demo-standalone-{version}-{platform}.tar
cd acps-demo-standalone-{version}-{platform}
cp .env.example .env
```

然后编辑顶层 `.env`。

`install.sh` 和 `upgrade.sh` 都只读取当前解压目录下的顶层 `.env`。脚本会基于这个文件生成各组件运行目录中的 `.env`，不会从其他项目目录、工作区目录或宿主机其他位置回填配置。

安装完成后，如果只需要调整 `registry-server`、`ca-server`、`discovery-server`、`mq-auth-server` 的非敏感运行时配置，应修改各自运行目录中的 `config/{APP_ENV}.toml`，再重新执行该组件目录下的 `bash deploy.sh` 让新配置生效；这条路径不通过顶层 `install.sh` 或 `upgrade.sh` 完成。

## 5. 关键配置项

### 5.1. 安装行为

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `INSTALL_ROOT` | `./runtime` | 安装后的运行目录 |
| `RUN_BUSINESS_SMOKE` | `true` | 是否在核心健康检查后执行业务烟测 |
| `DEPLOY_DEMO_APPS` | 空 | 显式控制是否部署 demo 应用 |
| `DUMP_SMOKE_LOGS` | `false` | 业务烟测失败时是否自动输出长日志 |

当 `RUN_BUSINESS_SMOKE=false` 且未设置 `DEPLOY_DEMO_APPS` 时，安装器进入 infra-only 模式，只部署 stage-infra、registry-server、ca-server、discovery-server、MQ 相关组件，并跳过 demo 应用部署与业务烟测。

如果需要部署 demo 应用但不执行业务烟测，设置：

```bash
DEPLOY_DEMO_APPS=true
RUN_BUSINESS_SMOKE=false
```

业务烟测超时可以按需覆盖：

```bash
BUSINESS_HTTP_REQUEST_TIMEOUT=240
BUSINESS_TASK_POLL_TIMEOUT=600
BUSINESS_GROUP_POLL_TIMEOUT=600
```

这三个变量会分别映射给业务烟测脚本的 HTTP 请求超时、任务轮询超时和 group 模式轮询超时。通常保持默认即可。

### 5.2. 访问地址与端口

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `GATEWAY_PUBLIC_HOST` | `localhost` | 浏览器和宿主机访问 stage-nginx 的主机名 |
| `GATEWAY_SERVICE_HOST` | `stage-nginx` | release-app 容器在 Docker 网络内访问 stage-nginx 的服务名 |
| `GATEWAY_BRIDGE_HOST` | `host.docker.internal` | demo 容器和工具镜像访问宿主机 gateway 的地址 |
| `STAGE_NGINX_PORT` | `9000` | stage-nginx 对外发布端口 |
| `REGISTRY_SERVER_MTLS_PUBLIC_HOST` | 空 | registry-server `9002` mTLS 对外主机，留空回退到 `GATEWAY_PUBLIC_HOST` |
| `REGISTRY_SERVER_MTLS_PORT` | `9002` | registry-server mTLS 对外端口 |
| `MQ_AUTH_PORT` | `9007` | mq-auth-server mTLS 对外端口 |
| `LEADER_WEB_PORT` | `9010` | demo-leader Web UI 对外端口 |

如果目标机需要被其他机器访问，`GATEWAY_PUBLIC_HOST` 和 `REGISTRY_SERVER_MTLS_PUBLIC_HOST` 应设置为可被客户端访问的域名或 IP，而不是 `localhost`。

### 5.3. 密码与自动生成密钥

安装前应重点检查以下密码和密钥：

| 配置项 | 说明 |
| --- | --- |
| `REDIS_PASSWORD` | Redis 密码 |
| `RABBITMQ_PASSWORD` | RabbitMQ 密码 |
| `MQ_AUTH_MGMT_PASS` | mq-auth-server 管理账号密码 |
| `REGISTRY_SERVER_INTERNAL_API_TOKEN` | registry-server 与 ca-server 服务间认证令牌 |
| `DSP_WEBHOOK_SECRET` | discovery webhook 共享密钥 |

如果这些变量为空或保留模板占位值，安装器会生成随机值，并写回顶层 `.env` 以及相关组件运行配置中。正式环境中也可以在安装前显式填写，便于后续审计和交接。

数据库账号和密码也在顶层 `.env` 中维护，包括 PostgreSQL 初始化账号，以及 registry、CA、discovery 各自的数据库用户、密码和库名。修改这些值时，只修改顶层 `.env`，不要直接改运行目录内的组件配置。

### 5.4. Discovery 配置

Discovery 运行模式由 `DISCOVERY_MODE` 控制：

| 模式 | 必填项 | 说明 |
| --- | --- | --- |
| `cpu` | `DISCOVERY_LLM_API_KEY`、`DISCOVERY_LLM_BASE_URL`、`DISCOVERY_LLM_MODEL_NAME`、`EMBEDDING_API_KEY`、`EMBEDDING_BASE_URL`、`EMBEDDING_MODEL_NAME` | 使用远端 embedding API |
| `gpu` | `DISCOVERY_LLM_API_KEY`、`DISCOVERY_LLM_BASE_URL`、`DISCOVERY_LLM_MODEL_NAME`、`EMBEDDING_MODEL_PATH`、`EMBEDDING_DEVICES`、`EMBEDDING_DIM` | 使用目标机本地模型路径 |

CPU 模式下，`EMBEDDING_DIM` 留空时安装器会根据常见模型名自动推断。GPU 模式下需要显式填写真实 embedding 维度。

`RERANKER_URL` 是 GPU 模式下的可选外部 reranker 地址。没有独立 reranker 服务时可以留空。

`DISCOVERY_BUILD_PROFILE` 是打包阶段变量，不属于目标机安装 `.env`。目标机实际运行 CPU 还是 GPU，由 `DISCOVERY_MODE` 和模型相关变量决定。

### 5.5. CA 材料

默认情况下：

```bash
AUTO_GENERATE_CA_MATERIALS=true
```

安装器会使用自动生成的验证用 CA 材料完成 ca-server 部署。

如果需要使用正式 CA 材料，设置：

```bash
AUTO_GENERATE_CA_MATERIALS=false
CA_CERT_SOURCE_PATH=
CA_KEY_SOURCE_PATH=
CA_CHAIN_SOURCE_PATH=
CA_TRUST_BUNDLE_SOURCE_PATH=
```

这 4 个路径支持绝对路径，也支持相对当前 standalone 解压目录的相对路径。安装器会在部署 ca-server 前复制它们到：

```text
runtime/ca-server/certs/ca.crt
runtime/ca-server/certs/ca.key
runtime/ca-server/certs/ca-chain.pem
runtime/ca-server/certs/trust-bundle.pem
```

### 5.6. Demo 应用 LLM 配置

默认完整安装会部署 demo-leader 和 demo-partner，并执行业务烟测。因此需要填写：

- `LEADER_LLM_FAST_*`
- `LEADER_LLM_DEFAULT_*`
- `LEADER_LLM_PRO_*`
- `PARTNER_LLM_FAST_*`
- `PARTNER_LLM_DEFAULT_*`

如果只需要 infra-only 部署，可设置 `RUN_BUSINESS_SMOKE=false` 并保持 `DEPLOY_DEMO_APPS` 为空，此时这些 demo 应用 LLM 变量不会作为必填项。

## 6. 首次安装

确认 `.env` 填写完成后执行：

```bash
bash install.sh
```

Linux 目标机执行：

```bash
sudo bash install.sh
```

安装器会先校验顶层 `manifest.toml` 与 `checksums.txt`，确认 bundle 缺失、篡改或版本不一致等问题不存在，然后执行全量首装流程。

主要流程如下：

1. 读取 `VERSION`、`.env`，补齐默认值并生成必要随机密钥。
2. 校验 Docker、tar、curl、checksum 工具、权限、bundle 和 provision 脚本。
3. 解压 7 个组件包，生成统一运行目录配置。
4. 清理本流程管理的旧 Docker 容器、网络、卷和镜像。
5. 引导 stage-infra 的 nginx 与 PostgreSQL。
6. 部署 registry-server public plane。
7. 部署 ca-server。
8. 为 registry-server `9002` 申请 mTLS 证书，并重新部署 registry-server 启用 `9002`。
9. 部署 discovery-server。
10. 为 stage-infra 申请证书，并启动完整 MQ stack。
11. 为 mq-auth-server 申请证书并部署 mq-auth-server。
12. 按配置部署 demo 应用。
13. 执行核心健康检查。
14. 按配置执行业务烟测。

安装成功后，脚本会输出完成信息，并将运行材料写入 `INSTALL_ROOT` 指定的目录。

### 6.1. 安装后调整 server 侧 TOML 配置

standalone 首装完成后，以下 4 个 server 组件会在运行目录中保留 `config/`：

| 组件 | 运行目录 |
| --- | --- |
| `registry-server` | `runtime/registry-server/` |
| `ca-server` | `runtime/ca-server/` |
| `discovery-server` | `runtime/discovery-server/` |
| `mq-auth-server` | `runtime/mq-auth-server/` |

这些目录中的 `config/*.toml` 用于承载非敏感业务配置。same-host 默认安装场景下，各组件通常使用 `APP_ENV=production`，因此最常见的是编辑：

```text
runtime/<component>/config/production.toml
```

修改后，推荐进入对应组件运行目录重新执行该组件自带的 `deploy.sh`，让应用重启并加载新的 TOML 配置。例如：

```bash
cd runtime/registry-server
vi config/production.toml
bash deploy.sh
```

Linux 目标机如果最初使用 `sudo bash install.sh` 写入了运行目录，后续这里通常也应使用：

```bash
sudo bash deploy.sh
```

这里推荐使用组件自己的 `deploy.sh`，而不是直接 `docker restart`，因为这些脚本除了重启进程，还会执行该组件发布模型约定的健康检查、蓝绿切换和必要的部署前校验。`registry-server` 在启用 `9002` 时还会额外处理证书与宿主机端口约束。

不要通过 `docker exec` 进入容器直接修改 `/app/config`。容器内看到的 `/app/config` 来自宿主机运行目录的只读挂载，正确做法始终是编辑宿主机侧 `runtime/<component>/config/{APP_ENV}.toml`，再重新执行该组件目录中的 `bash deploy.sh`。

## 7. 验证与访问入口

安装器会自动执行核心健康门禁，包括：

- `registry-server` 的 `/registry/health`
- `registry-server` 从 stage-nginx 内部访问的 `/registry/ready`
- `ca-server` 的 `/ca-server/health`
- `discovery-server` 的 `/discovery/health`
- `discovery-server` 从 stage-nginx 内部访问的 `/discovery/ready`
- `mq-auth-server` 的健康冒烟检查

安装后可以手工访问：

| 入口 | 默认地址 |
| --- | --- |
| stage gateway | `http://localhost:9000` |
| registry health | `http://localhost:9000/registry/health` |
| ca-server health | `http://localhost:9000/ca-server/health` |
| discovery health | `http://localhost:9000/discovery/health` |
| demo-leader Web UI | `http://localhost:9010` |

如果 `.env` 中修改了 `GATEWAY_PUBLIC_HOST`、`STAGE_NGINX_PORT` 或 `LEADER_WEB_PORT`，以上地址应按实际值替换。

registry-server `9002` 和 mq-auth-server `9007` 是独立 mTLS 入口，通常由脚本、SDK 或 CLI 使用，不作为普通浏览器入口。

### 7.1. 用浏览器观察 Leader 编排过程

如果本次安装包含 demo 应用，且已经为 `LEADER_LLM_*`、`PARTNER_LLM_*`、Discovery 相关配置填写了可用值，安装完成后可以直接在浏览器访问：

```text
http://{GATEWAY_PUBLIC_HOST}:{LEADER_WEB_PORT}
```

默认地址是：

```text
http://localhost:9010
```

页面可用于人工体验一次完整业务流程。建议这样验证：

1. 打开 `demo-leader` Web 页面。
2. 在首条请求发送前，根据需要选择 `直连模式` 或 `群组模式`。
3. 输入一条适合 demo 场景的自然语言请求，例如北京旅游、酒店、美食、交通组合需求。
4. 点击发送，观察页面从 `等待处理`、`处理中` 到 `需要补充信息` 或 `已完成` 的状态变化。

页面上可以直接看到以下信息：

- `请求分析` 面板：展示本次提交进入 Leader 后的基础分析结果。
- `多 Agent 调用状态` 面板：展示被调度的 Partner 列表、各 Partner 当前状态、维度信息、最近更新时间和返回的数据片段。
- `整合结果` 面板：展示给最终用户的汇总响应，或补充信息请求。
- 顶部状态栏：展示当前任务整体状态，以及 Partner 执行进度。

通过这几个区域，用户可以直观看到一次请求如何进入 Leader 编排、如何调度到多个 Partner、执行过程中哪些 Partner 在等待输入或已经返回结果，以及最终如何被汇总成统一答复。

需要注意：

- 如果安装时采用 infra-only 模式，或显式跳过了 demo 应用部署，则这里不会有可访问的 `demo-leader` Web 页面。
- Web 页面能展示整体编排过程和各 Partner 状态，但不会暴露所有内部调试细节；如果需要更细粒度的排查信息，请结合 `runtime/demo/leader`、`runtime/demo/partners` 和 `runtime/stage-infra` 的容器日志一起查看。

## 8. 业务烟测与排查

默认完整安装会执行：

```text
runtime/demo/leader/smoke-test-business.sh
```

为避免业务烟测失败时输出大量组件日志，安装器默认以 `DUMP_SMOKE_LOGS=false` 调用该脚本，只保留烟测自身失败信息。需要恢复长日志输出时，在顶层 `.env` 中设置：

```bash
DUMP_SMOKE_LOGS=true
```

业务烟测失败后，建议按需查看以下日志：

```bash
# Leader 编排与业务烟测主入口
cd ./runtime/demo/leader
docker compose --env-file .env -f compose.yml logs -f --tail 100 leader

# Partner 侧任务执行与群组通信
cd ./runtime/demo/partners
docker compose --env-file .env -f compose.yml logs -f --tail 100 partners

# MQ Auth / RabbitMQ ACL 与队列行为
cd ./runtime/stage-infra
COMPOSE_PROJECT_NAME=stage-infra docker compose --env-file .env -f compose.yml logs -f --tail 100 mq-auth-server rabbitmq
```

如果 Linux 目标机是通过 `sudo bash install.sh` 完成安装，运行目录下的 `.env` 和部分运行材料通常会由 root 写入。此时查看日志、重跑烟测等排查命令也应补上 `sudo`，例如：

```bash
cd ./runtime/demo/leader
sudo docker compose --env-file .env -f compose.yml logs -f --tail 100 leader

cd ./runtime/demo/partners
sudo docker compose --env-file .env -f compose.yml logs -f --tail 100 partners

cd ./runtime/stage-infra
sudo COMPOSE_PROJECT_NAME=stage-infra docker compose --env-file .env -f compose.yml logs -f --tail 100 mq-auth-server rabbitmq
```

也可以手工重跑业务烟测：

```bash
cd ./runtime/demo/leader
env DUMP_SMOKE_LOGS=false bash ./smoke-test-business.sh
```

如果业务烟测不是立即失败，而是卡在 `POST /api/v1/submit` 直到超时，优先检查 `leader` 日志里是否出现上游 LLM 请求超时或重试。该 happy path 依赖 `.env` 中配置的外部 LLM / embedding 服务可从目标机容器网络访问，若对应 API 网关不可达、响应过慢或限流，安装末尾的业务烟测会超时，但这不属于离线包解包或组件部署本身的失败。

如果安装失败发生在核心健康门禁之前，优先检查：

- `.env` 中必填 LLM、embedding、密码和端口配置是否完整。
- Docker daemon 是否运行，当前用户或 root 是否可访问 Docker。
- 目标机端口是否已被占用。
- `manifest.toml`、`checksums.txt`、`bundles/` 是否保持原始状态。
- GPU 模式下本地模型路径和设备是否可被容器访问。
- 使用正式 CA 材料时，4 个 CA 源文件路径是否存在且内容匹配。

## 9. 安装后目录

默认安装目录由 `INSTALL_ROOT` 控制，默认值为：

```text
./runtime
```

安装完成后的主要布局为：

```text
runtime/
  images.lock
  version-matrix.toml
  acps-cli.toml
  stage-infra/
  registry-server/
    certs/
  ca-server/
    certs/
  discovery-server/
  mq-auth-server/
    certs/
  demo/
    leader/
    partners/
```

关键文件说明：

| 文件 | 作用 |
| --- | --- |
| `runtime/images.lock` | 记录当前 runtime 实际使用过的应用镜像，供后续清理使用 |
| `runtime/version-matrix.toml` | 记录本次安装对应的组件、镜像、digest 和来源元数据 |
| `runtime/acps-cli.toml` | 安装器生成的 CLI bootstrap 配置 |
| `runtime/*/certs/` | 安装期生成或复制的证书材料 |
| `runtime/{registry-server,ca-server,discovery-server,mq-auth-server}/config/` | 安装后可调整的 server 侧非敏感 TOML 配置 |

运行目录中的组件 `.env` 由安装器生成。后续需要调整安装配置时，优先修改下一次安装或升级包根目录中的顶层 `.env`，不要把运行目录内的组件 `.env` 当作长期维护入口。例外是上述 4 个 server 组件的 `runtime/*/config/`，它们可以作为安装后调整非敏感 TOML 配置的维护入口，但修改后仍需重新执行对应组件目录中的 `bash deploy.sh` 使新配置生效。

## 10. Same-host 整体升级

same-host 整体升级使用新版本 standalone 包中的 `upgrade.sh`。

基本流程：

```bash
tar xf acps-demo-standalone-{new-version}-{platform}.tar
cd acps-demo-standalone-{new-version}-{platform}
cp .env.example .env
# 按既有环境填写 .env，INSTALL_ROOT 指向当前 runtime 入口
bash upgrade.sh
```

Linux 目标机执行：

```bash
sudo bash upgrade.sh
```

升级脚本会：

1. 根据 `INSTALL_ROOT` 找到当前 active runtime。
2. 将新版本 release 准备到 `${INSTALL_ROOT}.releases/{version}`。
3. 使用新版本配置执行原地 compose 升级。
4. 执行核心健康检查和按配置启用的业务烟测。
5. 升级成功后，把 `${INSTALL_ROOT}` 切换为指向新 release 的符号链接。
6. 将当前 active release 记录到 `${INSTALL_ROOT}.current`。

首次成功升级时，如果原 `${INSTALL_ROOT}` 是实体目录，脚本会把它归档到 `${INSTALL_ROOT}.releases/`，再让 `${INSTALL_ROOT}` 成为指向 active release 的符号链接。

如果升级部署或健康门禁失败，`upgrade.sh` 不会自动回退，也不会切换 runtime 指针；失败的 staged release 会保留在 `${INSTALL_ROOT}.releases/{version}`，用于人工检查。

## 11. 边界与注意事项

- `install.sh` 是全量安装入口，会清理本流程管理的 Docker 资源和卷。
- `upgrade.sh` 是 same-host 整体升级入口，不提供当前版本的自动回退能力。
- 单组件更新不通过本文的 `install.sh` 或 `upgrade.sh` 完成；如果只是调整 `registry-server`、`ca-server`、`discovery-server`、`mq-auth-server` 的非敏感 TOML 配置，请编辑 `runtime/<component>/config/{APP_ENV}.toml` 后重新执行该组件目录中的 `bash deploy.sh`。
- 顶层 `.env` 是安装和升级配置入口；不要依赖各组件目录中的模板或运行时 `.env`。`runtime/*/config/` 仅用于安装后调整少量 server 侧非敏感配置。
- `DISCOVERY_BUILD_PROFILE` 不属于目标机安装配置。
- `REGISTRY_SERVER_MTLS_PORT` 对应的 `9002` 会在 ca-server 可用后由安装器自动 provision 证书并启用。
- 正式 CA 材料、LLM API key、数据库和中间件密码、GPU 驱动、本地模型目录都不包含在 standalone 包内，需要由目标机环境或顶层 `.env` 提供。
