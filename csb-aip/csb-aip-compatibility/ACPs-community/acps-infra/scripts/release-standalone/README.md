# ACPs Demo Standalone 安装与升级说明

`acps-demo-standalone-{version}-{platform}.tar` 是面向 same-host 交付的统一离线包。
它会把以下 7 个 bundle 一起交付给用户：

- `acps-stage-infra`
- `registry-server-app`（registry-server release-app bundle）
- `ca-server-app`（ca-server release-app bundle）
- `discovery-server-app`（discovery-server release-app bundle）
- `mq-auth-server-app`（mq-auth-server release-app bundle）
- `demo-partner`
- `demo-leader`

standalone 包默认执行完整链路首装，并在基础烟测完成后继续执行业务烟测。
执行 `install.sh` 前会先清理这套流程管理的 Docker 容器、网络和卷；same-host 升级则应使用同包内的 `upgrade.sh`。

## 快速开始

```bash
tar xf acps-demo-standalone-{version}-{platform}.tar
cd acps-demo-standalone-{version}-{platform}
cp .env.example .env
```

目标机需要具备 `Docker daemon`、`docker compose`、`bash`、`tar`、`curl`、`openssl` 和 `sha256sum`/`shasum`。

然后编辑 `.env`，至少补齐以下敏感项：

`install.sh` 和 `upgrade.sh` 都只读取当前压缩包根目录下的顶层 `.env`，不会再从 sibling 项目或宿主机其他目录回填配置。

discovery-server 运行相关变量包括：

- `DISCOVERY_MODE=cpu|gpu`：目标机运行时实际使用的 discovery 模式；`install.sh` 会把它写入 `runtime/discovery-server/.env`
- 当 `DISCOVERY_MODE=cpu` 时，需要填写 `EMBEDDING_API_KEY`、`EMBEDDING_BASE_URL`、`EMBEDDING_MODEL_NAME`；`EMBEDDING_DIM` 留空时会按模型名自动推断
- 当 `DISCOVERY_MODE=gpu` 时，需要填写 `EMBEDDING_MODEL_PATH`、`EMBEDDING_DEVICES`、`EMBEDDING_DIM`；`RERANKER_URL` 可选
- `.env.example` 已为 `DISCOVERY_LLM_BASE_URL` 和 `EMBEDDING_BASE_URL` 提供官方接口示例；实际部署时可按供应商和地域替换。

`DISCOVERY_BUILD_PROFILE` 属于构建时环境变量，应在源仓库执行 `build.sh` 时像 `PLATFORMS` 一样显式传入；目标机安装 `.env` 不承载该变量。

- `REDIS_PASSWORD`
- `RABBITMQ_PASSWORD`
- `MQ_AUTH_MGMT_PASS`
- `DISCOVERY_LLM_API_KEY`
- `DISCOVERY_LLM_BASE_URL`
- `DISCOVERY_LLM_MODEL_NAME`
- `EMBEDDING_*`（按 `DISCOVERY_MODE` 选择 CPU 或 GPU 所需变量）
- `LEADER_LLM_*`
- `PARTNER_LLM_*`
- 如需替换默认密码，再同步修改 `*_PASSWORD`

非敏感但常用的 demo-leader Web UI 宿主机端口由 `LEADER_WEB_PORT` 控制，默认值为 `9010`。

以下变量如果留空或保留占位值，安装器会自动生成随机值：

- `REGISTRY_SERVER_INTERNAL_API_TOKEN`
- `DSP_WEBHOOK_SECRET`

如果你希望禁用 `ca-server` 的验证用自动建证书流程，请设置：

- `AUTO_GENERATE_CA_MATERIALS=false`
- `CA_CERT_SOURCE_PATH`
- `CA_KEY_SOURCE_PATH`
- `CA_CHAIN_SOURCE_PATH`
- `CA_TRUST_BUNDLE_SOURCE_PATH`

这 4 个路径支持绝对路径，或相对当前 standalone 解压目录的相对路径。安装器会在部署 `ca-server` 前，把它们复制到 `runtime/ca-server/certs/ca.crt`、`runtime/ca-server/certs/ca.key`、`runtime/ca-server/certs/ca-chain.pem`、`runtime/ca-server/certs/trust-bundle.pem`。这些源文件可以来自你现有的 CA 运行目录，也可以来自你预先准备好的正式 CA 套件导出目录。

完成后执行：

```bash
bash install.sh
```

该安装器会先清理旧的同机部署环境，再执行全量首装。
在任何解压和部署动作之前，安装器会先校验顶层 `manifest.toml` 与 `checksums.txt`，用于识别 bundle 缺失、篡改或版本不一致的情况。
部署完成后，安装器还会执行一轮核心健康门禁：校验 `registry-server` / `ca-server` / `discovery-server` 的 `/health`，并从 `stage-nginx` 容器内部校验仅限内网开放的 `/ready`，同时执行 `mq-auth-server` 的健康冒烟检查。

## 目录说明

- `bundles/`：7 个子组件离线包
- `.env.example`：顶层统一配置模板
- `manifest.toml`：standalone 产物元数据清单（版本、平台、bundle 文件及其 SHA256）
- `checksums.txt`：顶层文件校验和
- `install.sh`：统一安装入口
- `upgrade.sh`：same-host 原地升级入口
- `provision-registry-server-mtls-certs.py`：为 registry-server `9002` 自动申请服务端与 probe 客户端证书
- `provision-stage-infra-certs.py`：为 stage-infra 申请 RabbitMQ / Auth Service / Redis 证书
- `README.md`：当前说明文档

默认安装目录由 `.env` 中的 `INSTALL_ROOT` 控制，默认值为当前目录下的 `./runtime`。
安装完成后的目标布局为：

```text
runtime/
  images.lock
  version-matrix.toml
  stage-infra/
  registry-server/
    certs/
  ca-server/
    certs/
  discovery-server/
  demo/
    leader/
    partners/
```

其中 `runtime/images.lock` 由安装器根据 bundle 元数据和顶层镜像选择生成，用于后续 same-host 清理流程准确删除当前 runtime 实际使用过的应用镜像。

`version-matrix.toml` 由顶层 `build.sh` 在打包阶段生成，用于记录各子 bundle 的源码 commit、镜像标签、镜像 digest 和元数据文件位置，便于后续比对同版本重打结果。

## registry-server 9002 自动启用

standalone 安装器现在会按两阶段自动启用 `registry-server:9002`：

1. 首次部署 `registry-server` 时保持 `REGISTRY_SERVER_ENABLE_MTLS_LISTENER=false`，先收敛 `9001` public plane
2. 部署 `ca-server` 后，自动执行 `provision-registry-server-mtls-certs.py`
3. 证书申请成功后，安装器会把 `registry-server/.env` 中的 `REGISTRY_SERVER_ENABLE_MTLS_LISTENER` 切换为 `true`
4. 再次执行 `registry-server` release-app 部署，把 `9002` 作为独立宿主机 mTLS 端口发布出来

相关顶层配置项：

- `REGISTRY_SERVER_MTLS_PUBLIC_HOST`：`9002` 对外发布主机，留空时默认回退到 `GATEWAY_PUBLIC_HOST`
- `REGISTRY_SERVER_MTLS_PORT`：`9002` 对外发布端口，默认 `9002`

`9001 / 9003 / 9005` 继续走 nginx public plane；`9002 / 9007` 走宿主机独立 mTLS plane；`9008` 仍保持 Docker 网络内部 mTLS 入口，不暴露到宿主机。

## 业务烟测

默认会执行 `demo/leader/smoke-test-business.sh`。

为避免 `install.sh` / `upgrade.sh` 在业务烟测失败时把 Leader、Partner、stage-infra 的长日志直接混进最终结果，安装器默认会以 `DUMP_SMOKE_LOGS=false` 调用该脚本，只保留烟测本身的失败信息。

如果你希望恢复旧行为，可在顶层 `.env` 中显式设置：

```bash
DUMP_SMOKE_LOGS=true
```

如果你只想完成基础设施与 release-app 部署验证，可在 `.env` 中设置：

```bash
RUN_BUSINESS_SMOKE=false
```

此时安装器会默认进入 **infra-only** 模式：完成 stage-infra / registry-server / ca-server / discovery-server 部署、为 stage-infra 申请证书并启动 MQ 相关组件，但跳过 demo-apps 部署与业务烟测。

如果你想“部署 demo-apps 但不跑业务烟测”，可额外设置：

```bash
DEPLOY_DEMO_APPS=true
RUN_BUSINESS_SMOKE=false
```

业务烟测超时变量属于高级可选项，通常不需要设置。顶层 `install.sh` 会把它们转换为 `smoke-test-business.sh` 支持的环境变量：

- `BUSINESS_HTTP_REQUEST_TIMEOUT`：映射到 `HTTP_REQUEST_TIMEOUT`，控制单次 HTTP 请求超时。
- `BUSINESS_TASK_POLL_TIMEOUT`：映射到 `TASK_POLL_TIMEOUT`，控制 `direct_rpc` 多轮任务阶段的结果轮询超时。
- `BUSINESS_GROUP_POLL_TIMEOUT`：映射到 `GROUP_POLL_TIMEOUT`，控制 `group` 模式结果轮询超时。

如果不设置这三个变量，standalone 安装器会直接使用内置默认值：`240 / 600 / 600` 秒，业务烟测会照常执行。设置得过小会让脚本提前以 HTTP 超时或轮询超时失败退出；如果你不想控制业务烟测执行时间，可以完全忽略它们。

如果业务烟测失败，建议按下面的方式手工查看日志，而不是依赖安装器自动回显：

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

# 手工重跑业务烟测（默认仍建议不自动 dump 长日志）
cd ./runtime/demo/leader
env DUMP_SMOKE_LOGS=false bash ./smoke-test-business.sh
```

## 升级说明

- `install.sh` 仍然只用于“全新安装 / 全量重置后重新部署”场景。
- same-host 整体升级请使用当前解压目录下的顶层 `.env` 和 `upgrade.sh`：

```bash
bash upgrade.sh
```

- `upgrade.sh` 会先把新版本解包到 `${INSTALL_ROOT}.releases/{version}`，并使用该 release 的配置对既有 compose project 执行原地升级和健康检查。
- 首次成功升级后，原来的实体目录 `${INSTALL_ROOT}` 会被归档到 `${INSTALL_ROOT}.releases/`，`${INSTALL_ROOT}` 自身变为指向当前 active release 的符号链接。
- 当前 active release 会记录到 `${INSTALL_ROOT}.current`。
- 如果升级部署或健康门禁失败，`upgrade.sh` 不会执行自动回退，也不会切换 runtime 链接；staged release 会保留在 `${INSTALL_ROOT}.releases/{version}` 供人工排查。
- standalone 回退能力已从当前脚本中撤出，后续会在版本身份、数据兼容和业务闭环分析完成后再单独设计。

- 如果你只想更新某个单独组件，不要重复运行这里的 `install.sh` 或 `upgrade.sh`，请直接使用各项目自己的 `release-app` 升级文档。

## 说明

- standalone 包默认不再附带额外的 CLI wheel 与 `acps-sdk` wheel，因为当前首装链路不依赖它们。
- `demo-apps` 的 `provision.sh` 与 standalone 安装器中的 stage-infra 证书申请步骤，在宿主机缺少 `acps-cli` 时都会自动回退到包内镜像执行。
- 4 个 server 使用的是与 `stage-infra` 配套的 `release-app` 包，而不是各自独立离线用的 `release-bundle`。
