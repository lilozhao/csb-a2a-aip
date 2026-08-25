# mq-auth-server

mq-auth-server 是 ACPs 的 RabbitMQ 鉴权与群组 ACL 服务，负责为 RabbitMQ 提供 HTTP auth backend，
同时为 Leader 提供群组管理接口。本文只保留三件事：这个项目做什么、日常怎么开发、如何构建与
`acps-infra` 配合的 `release-app` 交付物。

## 1. 概述

### 1.1. 项目定位

- `9007` 提供 Group API，供 Leader 通过 mTLS 管理群组 ACL
- `9008` 提供 Auth API，供 RabbitMQ 执行 allow / deny 鉴权决策
- 使用 Redis 保存群组 ACL，并按需调用 RabbitMQ Management API 断开连接

### 1.2. 项目特点

- 双 listener 架构：Group API 与 Auth API 分端口运行
- 无数据库，ACL 完全保存在 Redis
- 两个端口都要求真实 mTLS 证书

### 1.3. 目录概览

```text
mq-auth-server/
├── app/                  # API、服务与基础设施
├── config/               # TOML 分层配置
├── certs/                # 本地开发证书
├── tests/                # unit / integration / e2e
├── scripts/release-app/  # release-app 打包脚本
├── Justfile              # 本地开发、测试、质量检查入口
└── Dockerfile            # 生产镜像构建
```

## 2. 开发

### 2.1. 前置条件

- [uv 官方安装文档](https://docs.astral.sh/uv/getting-started/installation/)
- [just 官方安装文档](https://just.systems/man/en/packages.html)
- [Docker Desktop 官方下载](https://www.docker.com/products/docker-desktop/)
- 同级目录已存在 `../acps-infra/`

### 2.2. 快速开始

```bash
git clone <仓库地址>
cd mq-auth-server

# 虽然 just prep env / just app bootstrap 会在缺失时生成 .env，
# 但仍建议先显式复制模板并检查关键配置。
cp .env.example .env
# 编辑 .env：确认 Redis、RabbitMQ、证书路径等敏感项

just app bootstrap
just app
```

启动后常用地址：

- Group API: `https://localhost:9007`
- Auth API: `https://localhost:9008`

### 2.3. 常用命令

```bash
# 帮助与环境检查
just help                         # 输出命令总览，直接执行 just 也会显示帮助
just doctor                       # 检查 Docker、Redis、RabbitMQ、证书与关键配置
just infra up redis rabbitmq      # 启动 mq-auth-server 需要的共享依赖
just infra status                 # 查看共享依赖状态

# 环境准备
just prep env                     # 缺失时根据 .env.example 生成 .env
just prep sync                    # 下载 managed Python 3.14，并把依赖同步到 .venv/
just prep hooks                   # 安装/更新 Git hooks
just prep certs                   # 准备开发证书
just prep certs reset             # 清理本地证书后重新签发
just prep migrate test            # 无数据库项目，显式 skip

# 应用
just app bootstrap                # 一键建立本地开发环境
just app                          # 快速后台启动双 listener（等价于 just app start）
just app start                    # 后台启动双 listener
just app start fg                 # 前台启动，便于调试
just app logs follow              # 持续跟踪日志
just app stop                     # 停止本地实例

# 测试
just test bootstrap               # 准备测试环境
just test unit                    # 单元测试
just test integration             # 集成测试
just test e2e                     # 黑盒 e2e
just test coverage                # 覆盖率统计
just test                         # 默认执行 all，依次执行 unit / integration / e2e

# 质量
just qa                           # 默认执行 all，先 fix，再跑 pre-commit
just qa full                      # 只读质量门禁
just qa type                      # 常用 mypy 入口（等价于 qa type-app）
just qa type-tests                # 测试代码 mypy
just qa audit                     # 依赖漏洞审计
```

### 2.4. 开发说明

- 项目运行所需 Python 不依赖本机预装版本；`just prep sync` 会通过 `uv` 下载 managed Python 3.14，
  并把依赖安装到当前项目的 `.venv/`。
- `just prep certs` 会从共享开发 PKI 准备服务端证书、信任锚和健康检查客户端证书。
- `9007` 仅供 Leader 通过 mTLS 调用，`9008` 仅供 RabbitMQ 调用，两类接口不要混用。
- 本仓 `tests/e2e/` 会启动临时双 listener 实例做黑盒验证，不依赖 sibling 服务。
- 生产部署时的证书挂载、stage 前置条件和升级方式，统一在 `acps-infra/README.md` 中说明。

## 3. Docker 交付（release-app / standalone）

`mq-auth-server` 自己提供的 Docker 交付入口是 `scripts/release-app/build-app-bundle.sh`。它会构建应用镜像，
并生成一个离线 app-only bundle，供 `stage-infra` 或 standalone 顶层装配复用。

```bash
bash scripts/release-app/build-app-bundle.sh
```

打包说明：

- 这是一个离线 app-only 包，产物输出到 `dist/`，文件名形如 `mq-auth-server-app-{version}.tar.gz`。
- bundle 内包含 `images.tar.gz`、`deploy.sh`、compose 文件、`.env.example`、`VERSION`、`checksums.txt` 等发布元数据。
- `images.tar.gz` 中已经包含 `mq-auth-server` 应用镜像，因此镜像内的 Python 运行时和应用依赖也随包离线交付，不需要目标机再在线拉取 Python 包。

但是，通常我们并不单独使用这个 app-only 包，而是让 `acps-infra` 的 standalone 打包链路把它收集进更大的全量离线包中，供单机 standalone 场景下的打包部署之用。单机 standalone 全量离线包，应切换到仓库 `acps-infra` 执行打包脚本：

```bash
cd ../acps-infra
bash scripts/release-standalone/build.sh 2.1.0
```

打包说明：

- `build.sh` 会统一调用各兄弟项目的 `build-app-bundle.sh`，然后把兄弟项目的打包产物收集进 standalone 包的 `bundles/` 目录，并额外生成 `manifest.toml`、`version-matrix.toml`、`install.sh`、`upgrade.sh` 等顶层文件。
- 最终产物输出到 `acps-infra/dist/`，文件名形如 `acps-demo-standalone-{version}-{platform}.tar`。

部署时，目标机收到 standalone 包后，应在解压目录执行顶层安装器，而不是逐个进入子 bundle 手工部署：

```bash
tar xf acps-demo-standalone-{version}-{platform}.tar
cd acps-demo-standalone-{version}-{platform}
cp .env.example .env
# 编辑 .env：填写 LLM 密钥、密码、端口、证书来源等运行参数
bash install.sh
```

部署说明：

- `install.sh` 会先校验 `manifest.toml` 和 `checksums.txt`，再依次解压并部署 `stage-infra`、`registry-server`、`ca-server`、`discovery-server`、`mq-auth-server`、`demo-partner`、`demo-leader`。
- 对 `mq-auth-server` 来说，顶层安装器会先准备运行目录与 `.env`，再调用 `provision-mq-auth-server-certs.py` 申请服务端证书与健康检查客户端证书，最后执行 `deploy.sh` 完成 release-app 部署与健康检查。
- standalone 流程会把 `mq-auth-server` 的证书目录收口为固定文件名合同：`certs/server.pem`、`certs/server.key`、`certs/acps-root-ca.pem`、`certs/client.pem`、`certs/client.key`。
- `install.sh` 默认会继续执行各个应用的健康检查和业务 smoke 测试。

单机 standalone 场景下的更多详细信息，比如环境变量、证书引导、业务烟测和升级行为，以兄弟仓库 `acps-infra/README.md` 与 `acps-infra/scripts/release-standalone/README.md` 为准。

## 4. 通用打包与部署

`mq-auth-server` 也可以完全不依赖 Docker 和 `acps-infra`，直接以 Python wheel 运行包交付到一般环境。而用于部署的发布物不能只有 `.whl`，还必须同时带上运行时 TOML 配置、环境变量模板、冒烟脚本和证书模板。仓库已经把这套流程收敛为统一的 `just package wheel` 命令。

### 4.1. 构建运行包

执行前置条件：

- 执行环境需要在 `PATH` 中提供 `just`、`uv` 和 `python3` 命令。
- 如果构建机还没有可用的 `python3`，推荐先用 `uv` 安装 Python 3.14，并创建一个共享的 `.venv`；激活后 `python3` 会指向这个虚拟环境，多个兄弟项目可以共用它来构建。

假设你在`~/acps-build`下准备构建环境：

```bash
mkdir -p ~/acps-build
cd ~/acps-build
uv python install 3.14
uv venv --python 3.14 .venv
source .venv/bin/activate
python3 --version
```

克隆本仓库：

```bash
cd ~/acps-build
git clone <mq-auth-server 仓库地址>
```

执行打包：

```bash
cd ~/acps-build/mq-auth-server
just package wheel
just package wheel offline
```

打包说明：

- `dist/mq-auth-server-wheel-{version}-{platform}.tar.gz` 是在线运行包。
- `dist/mq-auth-server-wheel-offline-{version}-{platform}.tar.gz` 是离线运行包。
- 文件名中的 `{platform}` 表示目标部署平台：默认使用当前构建机平台；如果显式传入 `--pip-platform`，则使用该值。
- 两种运行包都会包含以下运行时必需文件和目录：
  - `dist/`：包含当前版本的应用 wheel 文件。
  - `config/`：运行时 TOML 配置目录。
  - `.env.example`：环境变量模板。
  - `README.md`：随包交付的部署说明文档。
  - `requirements-runtime.txt`：运行时依赖清单。
  - `checksums.txt`：运行包内容校验清单。
  - `scripts/smoke-test.sh`：运行包目录内可直接执行的基础冒烟脚本。
  - `mq-auth-server.service`：systemd unit 模板。
- 离线运行包还会额外包含：
  - `wheelhouse/`：预下载的 Python 运行时依赖 wheel 目录，用于离线安装。

```bash
just package wheel offline \
  --pip-platform manylinux2014_x86_64 \
  --pip-platform manylinux_2_28_x86_64 \
  --pip-implementation cp \
  --pip-abi cp314
```

离线包说明：

- 这里的“离线”仅指应用本体和运行时依赖已随包提供；它不包括 Python 本身。
- Redis、RabbitMQ、反向代理和正式证书材料，以及 `acps-infra` 的其它组件都不在该包内。
- `just package wheel offline` 默认按当前构建机平台下载 wheel；如果目标机平台不同，请显式传入 `--pip-platform`、`--pip-implementation` 和 `--pip-abi`。
- `--pip-platform` 可重复传入。对 Linux 目标来说，部分依赖会同时使用 `manylinux2014` 与更新的 `manylinux_2_28` 标签；例如 x86_64 目标通常应同时传 `manylinux2014_x86_64` 与 `manylinux_2_28_x86_64`。
- 常用的 `--pip-platform` 有：
  - `manylinux2014_x86_64`：适用于大多数 x86_64 Linux 发行版。
  - `manylinux_2_28_x86_64`：适用于发布新一代 Linux wheel 标签的 x86_64 依赖。
  - `manylinux2014_aarch64`：适用于大多数 aarch64 Linux 发行版。
  - `macosx_10_15_x86_64`：适用于 macOS Catalina 及以上的 x86_64。
  - `macosx_11_0_arm64`：适用于 macOS Big Sur 及以上的 Apple Silicon。
- `--pip-implementation` 和 `--pip-abi` 的值需要与目标机 Python 版本匹配，例如 Python 3.14 对应 `cp` 和 `cp314`。

### 4.2. 目标机部署

原生部署前请自行准备以下前置条件；这些能力不再由 Docker 或 `acps-infra` 代管。

基础服务前置条件：

- `Redis`：建议使用Redis 7，并开启密码保护。默认启用 AOF 持久化、`allkeys-lru` 淘汰策略和 TLS-only `6379` 监听；如果你不打算走 TLS，需要同步调整 `.env` 中的 `REDIS_URL` / `REDIS_TLS_CA_CERT`。
- `RabbitMQ`：建议使用 RabbitMQ 4.2+ 部署，同时提供 TLS broker `5671` 和 Management API `15672`。RabbitMQ 需要启用 `rabbitmq_management`、`rabbitmq_auth_mechanism_ssl`、`rabbitmq_auth_backend_http`、`rabbitmq_auth_backend_cache` 这 4 个插件。
- `Redis` 和 `RabbitMQ` 的 TLS 证书，建议统一通过 `acps-cli` 运行包中的 `bash scripts/bootstrap.sh redis` 与 `bash scripts/bootstrap.sh rabbitmq` 完成注册和获取。
- `RabbitMQ 配置合同`：参照 `stage-infra/rabbitmq.conf` 与 `init-rabbitmq.sh`，目标 RabbitMQ 应启用 `EXTERNAL` + `PLAIN` 认证机制、将 HTTP auth backend 指向 `mq-auth-server:9008`，并预先准备 `acps` vhost、`inbox.topic` exchange，以及与 `mgmt_user` 分离的管理账号。

如果目标机尚未安装 Python 3.14，可以用 `uv` 命令或者其它方式安装 Python 3.14。命令：`uv python install 3.14 --install-dir /opt/uv-python --no-bin` 会把 Python 3.14 安装到 `/opt/uv-python/`，但不创建全局可执行链接；这样对目标机系统环境影响更小，也避免了与系统 Python 的版本冲突。

```bash
mkdir -p /opt/mq-auth-server
cd /opt/mq-auth-server
tar xzf mq-auth-server-wheel-offline-{version}-{platform}.tar.gz

# 注意：压缩包会解出一层同名根目录，后续命令应进入该目录执行
cd mq-auth-server-wheel-offline-{version}-{platform}

# 创建虚拟环境；python 3.14 的路径根据实际安装位置调整
/opt/uv-python/cpython-3.14.x-<platform>/bin/python3.14 -m venv .venv

# 在线安装：同一条命令同时安装锁定的运行时依赖和应用 wheel
.venv/bin/python -m pip install \
  -r requirements-runtime.txt \
  dist/mq_auth_server-{version}-py3-none-any.whl

# 如果目标机无法访问公网，则改用下面这组离线安装命令；不要与上面的在线命令重复执行

# 离线安装：同一条命令同时安装锁定的运行时依赖和应用 wheel
.venv/bin/python -m pip install \
  --no-index \
  --find-links wheelhouse \
  -r requirements-runtime.txt \
  dist/mq_auth_server-{version}-py3-none-any.whl

# 拷贝环境变量模板
cp .env.example .env
# 编辑 .env，设置环境变量；至少确认 APP_ENV=production、RABBITMQ_MGMT_URL、RABBITMQ_MGMT_PASS、REDIS_URL、TLS_CERT_FILE、TLS_KEY_FILE、TLS_CA_CERT_FILE
# 还要确认 HEALTHCHECK_TLS_CERT_FILE、HEALTHCHECK_TLS_KEY_FILE、HEALTHCHECK_TLS_CA_CERT_FILE；通常分别指向 certs/client.pem、certs/client.key、certs/acps-root-ca.pem
# 再按 APP_ENV 编辑对应 TOML（通常是 config/production.toml），补齐非敏感业务配置；
# 至少确认 [server] 的 group_api_port / auth_api_port，以及 [rabbitmq] 的 mgmt_user

# 准备运行目录证书（建议沿用默认文件名）
mkdir -p certs
# certs/server.pem
# certs/server.key
# certs/acps-root-ca.pem
# certs/client.pem
# certs/client.key
```

部署说明：

- 如果用 `source .venv/bin/activate` 激活虚拟环境；命令行中的 `.venv/bin/python` 可简化为 `python`。
- 如果离线运行包中的 `wheelhouse/` 与目标机平台不匹配，请回到构建机重新执行 `just package wheel offline ...`。
- `.env` 中的 `APP_ENV` 决定加载哪个 `config/{APP_ENV}.toml`；生产环境通常应设置为 `production`。
- 不要只修改 `.env` 就继续部署；在确定 `APP_ENV` 后，应立即检查并编辑 `config/{APP_ENV}.toml`。对 `mq-auth-server` 来说，至少要确认 `[server]` 段和 `[rabbitmq]` 段中的端口与管理账号是否已经与目标环境一致。
- `RABBITMQ_MGMT_URL` 指向的是 RabbitMQ Management API 根地址，例如 `http://rabbitmq.internal:15672`；这里不是 AMQPS broker 地址，不要误填成 `amqps://...:5671`。
- 如果 Redis 使用 TLS，请在 `.env` 中把 `REDIS_URL` 配成 `rediss://...`，并把 `REDIS_TLS_CA_CERT` 指向相应 CA bundle；如果 Redis 不使用 TLS，可保留 `redis://...` 并将 `REDIS_TLS_CA_CERT` 置空。
- `scripts/smoke-test.sh` 与 `app.core.health_probe` 读取的是 `HEALTHCHECK_TLS_CERT_FILE`、`HEALTHCHECK_TLS_KEY_FILE`、`HEALTHCHECK_TLS_CA_CERT_FILE`；如果这些变量未显式指向 `client.pem`、`client.key`、`acps-root-ca.pem`，即使 `certs/` 目录中文件齐全，health probe 与基础 smoke 也可能失败。
- `9007` 是供 Leader 调用的宿主机直出 mTLS 端口，`9008` 语义上仍是供 RabbitMQ HTTP auth backend 使用的内部端口。原生 wheel 部署不会像 release-app 那样自动把 `9008` 限制在 Docker 网络内，所以应自行通过防火墙、主机 ACL、反向代理或隔离网段限制其可达范围。
- 现在推荐统一改用 `acps-cli` 运行包自带的 `scripts/bootstrap.sh mq-auth-server` 申请部署证书，并把产物复制到当前运行目录的 `certs/` 中。

### 4.3. 证书获取与启动方式

`mq-auth-server` 的两个 listener 都要求真实 mTLS 证书。也就是说，生产部署时不能只创建一个空的 `certs/` 目录就直接启动；需要先借助 `acps-cli` 走“注册 -> 审批 -> EAB -> 发证”流程，至少申请两套材料：

- 一张 `serverAuth` 服务端证书，供 `9007` Group API 和 `9008` Auth API 两个 listener 共用。
- 一张 `clientAuth` 健康检查客户端证书，供 `scripts/smoke-test.sh` 和 `app.core.health_probe` 使用。

#### 4.3.1. 第一步：通过注册审批申请服务端证书和健康检查客户端证书

这一步默认假定 `acps-cli` 已经作为独立工具完成安装与配置，并且当前生效配置已经指向目标 `registry-server` 与 `ca-server`；只有在需要临时覆盖现有配置时，才额外传 `--config PATH`。

统一改用 `acps-cli` 运行包自带的 `bootstrap.sh`：

```bash
cd /opt/acps-cli
bash scripts/bootstrap.sh mq-auth-server --config ./acps-cli.toml
```

补充说明：

- 若未显式提供凭据，脚本会交互式提示输入普通用户和管理员账号密码。
- 运行前请先在 `acps-cli` 运行包的 `scripts/acs/` 下手工修改 `mq-auth-server-acs.json` 与 `healthcheck-client-acs.json`，尤其是 `certificate.altNames` 中的对外 DNS/IP；如需避免名称冲突，也应同步调整 `name`。
- `bootstrap.sh` 只会读取这些静态 JSON，不会再根据 `acps-cli.toml` 生成 ACS/SAN，也不会回写 `aic`。
- 产物会写入 `acps-cli` 运行目录下的 `bootstrap-artifacts/mq-auth-server/`，并生成对应 `summary.json`。

把以下文件复制到 `mq-auth-server` 主机的运行目录 `certs/`：

- `bootstrap-artifacts/mq-auth-server/server.pem -> /opt/mq-auth-server/certs/server.pem`
- `bootstrap-artifacts/mq-auth-server/server.key -> /opt/mq-auth-server/certs/server.key`
- `bootstrap-artifacts/mq-auth-server/client.pem -> /opt/mq-auth-server/certs/client.pem`
- `bootstrap-artifacts/mq-auth-server/client.key -> /opt/mq-auth-server/certs/client.key`
- `bootstrap-artifacts/mq-auth-server/acps-root-ca.pem -> /opt/mq-auth-server/certs/acps-root-ca.pem`

这 5 个文件都是部署态合同的一部分：`server.pem` / `server.key` 供两个 listener 共用，`client.pem` / `client.key` 供本仓健康检查与部署烟测复用，`acps-root-ca.pem` 同时承担服务端校验客户端证书链和客户端校验服务端证书链的 trust anchor。

#### 4.3.2. 第二步：启动并验证

Redis、RabbitMQ Management API、证书目录和运行时配置就绪后，就可以直接启动。

```bash
.venv/bin/python -m app.main
```

运行说明：

- `app.main` 会同时拉起 `9007` Group API 和 `9008` Auth API 两个 listener。
- 两个 listener 都要求 mTLS，因此直接用浏览器访问 `/health` 往往会失败；健康检查与冒烟测试应使用客户端证书。
- `group_api_port` 与 `auth_api_port` 默认来自 `config/default.toml`，分别是 `9007` 与 `9008`；若你在 `config/{APP_ENV}.toml` 中覆写了端口，请同步调整冒烟命令。

补充说明：

- 跨服务部署验证现在统一使用 `acps-cli` 运行包中的 `bash scripts/smoke-test-business.sh --config ./acps-cli.toml --bootstrap-dir ./bootstrap-artifacts`；它会连带验证 Registry / CA / Discovery / MQ 主干链路，而不是只检查本服务 `/health`。
- 如果使用仓库内置的 `scripts/smoke-test.sh` 或直接复用 `app.core.health_probe`，请先确认 `HEALTHCHECK_TLS_*` 三个环境变量已经指向部署态 `client.pem`、`client.key`、`acps-root-ca.pem`。
- `app.core.health_probe` 仍适合被进程存活探针或 systemd `ExecStartPost` 类脚本复用；如果你只需要做进程级探活，可以继续单独使用它。

### 4.4. systemd 安装与启停

在验证应用可以执行，并且 `9007` / `9008` 能正常提供服务后，就可以按照下面的步骤把它安装成 systemd 服务了。

使用运行包根目录中的 `mq-auth-server.service` unit 文件安装成 systemd 服务。该 unit 默认假定部署目录为 `/opt/mq-auth-server`；如果你的部署目录不同，请先修改 `WorkingDirectory` 和 `ExecStart`。

```bash
cd /opt/mq-auth-server

# 可选：先检查并按需修改 unit 中的 WorkingDirectory / ExecStart
vi mq-auth-server.service

sudo cp mq-auth-server.service /etc/systemd/system/mq-auth-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now mq-auth-server
```

说明：

- 当前 unit 不使用 `EnvironmentFile=`，因为项目 `.env` 使用 dotenv 语法并带有行内注释；应用会在 `WorkingDirectory` 下自行读取 `.env`。
- 启动前请确认部署目录中的 `.env` 已设置好 `APP_ENV=production`、RabbitMQ/Redis 连接信息和证书路径；非敏感的监听端口与 RabbitMQ 管理账号默认应在 `config/production.toml` 中维护。
- 如果不希望 `9008` 对非 RabbitMQ 调用方暴露，systemd 只负责进程托管，不负责网络隔离；仍需配合主机防火墙或其它网络控制手段限制可达范围。
- 如需以专用系统用户运行，请先创建用户，再取消注释 unit 文件中的 `User=` 和 `Group=`。

常用命令：

```bash
sudo systemctl status mq-auth-server
sudo systemctl restart mq-auth-server
sudo systemctl stop mq-auth-server
sudo systemctl disable mq-auth-server
sudo journalctl -u mq-auth-server -f
```
