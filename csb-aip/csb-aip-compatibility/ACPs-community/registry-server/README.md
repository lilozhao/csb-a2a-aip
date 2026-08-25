# registry-server

registry-server 是 ACPs 的 Agent 注册中心，负责 Agent 注册、审核、ATR / EAB 相关能力，以及 DSP
同步所需的注册数据管理。本文只保留四件事：这个项目做什么、日常怎么开发、如何构建与
`acps-infra` 配合的 standalone 交付链路，以及如何在一般环境中执行原生 wheel 部署。

## 1. 概述

### 1.1. 项目定位

- 对外提供 Agent 注册、查询、审核与文件上传等 API
- 为 ACPs ATR / EAB 流程提供注册与身份侧支撑
- 为 `discovery-server` 提供 DSP 同步源数据

### 1.2. 项目特点

- 双平面运行：`9001` public API，`9002` mTLS API
- 本地开发固定采用“宿主机进程 + `../acps-infra/dev-infra`”
- 真实跨服务联调统一放到 `acps-cli/tests/e2e/`，本仓测试只关注自身边界

### 1.3. 目录概览

```text
registry-server/
├── app/                  # 业务代码
├── alembic/              # 数据库迁移
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
cd registry-server

# 虽然 just prep env / just app bootstrap 会在缺失时生成 .env，
# 但仍建议先显式复制模板并检查关键配置。
cp .env.example .env
# 编辑 .env：确认数据库、token、证书路径等敏感项

just app bootstrap
just app
```

启动后常用地址：

- Public API: `http://localhost:9001`
- Public Docs: `http://localhost:9001/docs`
- mTLS API: `https://localhost:9002`

### 2.3. 常用命令

```bash
# 帮助与环境检查
just help                         # 输出命令总览，直接执行 just 也会显示帮助
just doctor                       # 检查 Docker、依赖、证书与关键配置
just infra up postgres            # 启动 registry-server 需要的共享依赖
just infra status                 # 查看共享依赖状态

# 环境准备
just prep env                     # 缺失时根据 .env.example 生成 .env
just prep sync                    # 下载 managed Python 3.14，并把依赖同步到 .venv/
just prep hooks                   # 安装/更新 Git hooks
just prep certs                   # 准备本地 mTLS 开发证书
just prep migrate app             # 迁移开发数据库
just prep migrate test            # 迁移测试数据库

# 应用
just app bootstrap                # 一键建立本地开发环境
just app                          # 快速后台启动 public + mTLS 双平面（等价于 just app start）
just app start                    # 后台启动 public + mTLS 双平面
just app start fg                 # 前台启动，便于调试
just app logs follow              # 持续跟踪日志
just app stop                     # 停止本地实例

# 测试
just test bootstrap               # 准备测试环境
just test unit                    # 单元测试
just test integration             # 集成测试
just test e2e                     # 黑盒 e2e
just test coverage                # 生成覆盖率统计
just test                         # 默认执行 all，依次执行 unit / integration / e2e

# 质量
just qa                           # 默认执行 all，先 fix，再跑 pre-commit
just qa full                      # 只读质量门禁
just qa type-app                  # 业务代码 mypy
just qa type-tests                # 测试代码 mypy
just qa audit                     # 依赖漏洞审计
```

### 2.4. 开发说明

- 项目运行所需 Python 不依赖本机预装版本；`just prep sync` 会通过 `uv` 下载 managed Python 3.14，
  并把依赖安装到当前项目的 `.venv/`。
- `just app bootstrap` 会准备 `.venv`、hooks、开发库迁移和本地证书。
- `9002` 默认使用真实 TLS + 客户端证书强制校验。
- `REGISTRY_SERVER_INTERNAL_API_TOKEN` 需要与 `ca-server` 保持一致，真实联调时尤其要注意。
- 如果要验证 `registry-server` 与 `ca-server`、`discovery-server` 的完整联调链路，请转到
  `acps-cli/tests/e2e/`。

## 3. Docker 交付（release-app / standalone）

`registry-server` 自己提供的 Docker 交付入口是 `scripts/release-app/build-app-bundle.sh`。它会构建应用镜像，
并生成一个离线 app-only bundle，供 `stage-infra` 或 standalone 顶层装配复用。

```bash
bash scripts/release-app/build-app-bundle.sh
```

打包说明：

- 这是一个离线 app-only 包，产物输出到 `dist/`，文件名形如 `registry-server-app-{version}.tar.gz`。
- bundle 内包含 `images.tar.gz`、`deploy.sh`、compose 文件、`.env.example`、`VERSION`、`checksums.txt` 等发布元数据。
- `images.tar.gz` 中已经包含 `registry-server` 应用镜像，因此镜像内的 Python 运行时和应用依赖也随包离线交付，不需要目标机再在线拉取 Python 包。

但是，通常我们并不单独使用这个 app-only 包，而是让 `acps-infra` 的 standalone 打包链路把它收集进更大的全量离线包中，供单机 standalone 场景下的打包部署之用。单机 standalone 全量离线包，应切换到仓库 `acps-infra` 执行打包脚本：

```bash
cd ../acps-infra
bash scripts/release-standalone/build.sh 2.1.0
```

打包说明：

- `build.sh` 会统一调用各兄弟项目的 `build-app-bundle.sh`，然后把兄弟项目的打包产物收集进 standalone 包的 `bundles/` 目录，并额外生成
  `manifest.toml`、`version-matrix.toml`、`install.sh`、`upgrade.sh` 等顶层文件。
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

- `install.sh` 会先校验 `manifest.toml` 和 `checksums.txt`，再依次解压并部署 `stage-infra`、`registry-server`、
  `ca-server`、`discovery-server`、`mq-auth-server`、`demo-partner`、`demo-leader`。
- `install.sh` 默认会继续执行各个应用的健康检查和业务 smoke 测试。

单机 standalone 场景下的更多详细信息，比如环境变量、证书引导、业务烟测和升级行为，以兄弟仓库 `acps-infra/README.md` 与
`acps-infra/scripts/release-standalone/README.md` 为准。

## 4. 通用打包与部署

`registry-server` 也可以完全不依赖 Docker 和 `acps-infra`，直接以 Python wheel 运行包交付到一般环境。而用于部署的发布物不能只有 `.whl`，还必须同时带上运行时 TOML 配置、Alembic 迁移脚本和环境变量模板。仓库已经把这套流程收敛为统一的 `just package wheel` 命令。

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
git clone <registry-server 仓库地址>
```

执行打包：

```bash
cd ~/acps-build/registry-server
just package wheel
just package wheel offline
```

打包说明：

- `dist/registry-server-wheel-{version}-{platform}.tar.gz` 是在线运行包。
- `dist/registry-server-wheel-offline-{version}-{platform}.tar.gz` 是离线运行包。
- 文件名中的 `{platform}` 表示目标部署平台：默认使用当前构建机平台；如果显式传入 `--pip-platform`，则使用该值。
- 两种运行包都会包含以下运行时必需文件和目录：
  - `dist/`：包含当前版本的应用 wheel 文件。
  - `config/`：运行时 TOML 配置目录。
  - `alembic/`：数据库迁移脚本目录。
  - `alembic.ini`：Alembic 配置文件。
  - `.env.example`：环境变量模板。
  - `README.md`：随包交付的部署说明文档。
  - `requirements-runtime.txt`：运行时依赖清单。
  - `checksums.txt`：运行包内容校验清单。
  - `registry-server.service`：systemd unit 模板。
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
- PostgreSQL、反向代理、证书文件，以及 `acps-infra` 的其它组件都不在该包内。
- `just package wheel offline` 默认按当前构建机平台下载 wheel；如果目标机平台不同，请显式传入
  `--pip-platform`、`--pip-implementation` 和 `--pip-abi`。
- `--pip-platform` 可重复传入。对 Linux 目标来说，部分依赖会同时使用 `manylinux2014` 与更新的
  `manylinux_2_28` 标签；例如 x86_64 目标通常应同时传 `manylinux2014_x86_64` 与
  `manylinux_2_28_x86_64`。
- 常用的 `--pip-platform` 有：
  - `manylinux2014_x86_64`：适用于大多数 x86_64 Linux 发行版。
  - `manylinux_2_28_x86_64`：适用于发布新一代 Linux wheel 标签的 x86_64 依赖。
  - `manylinux2014_aarch64`：适用于大多数 aarch64 Linux 发行版。
  - `win_amd64`：适用于 Windows x86_64。
  - `macosx_10_15_x86_64`：适用于 macOS Catalina 及以上的 x86_64。
  - `macosx_11_0_arm64`：适用于 macOS Big Sur 及以上的 Apple Silicon。
- `--pip-implementation` 和 `--pip-abi` 的值需要与目标机 Python 版本匹配，例如 Python 3.14 对应 `cp` 和 `cp314`。

### 4.2. 目标机部署

原生部署前请自行准备以下前置条件；这些能力不再由 Docker 或 `acps-infra` 代管。

基础服务前置条件：

- `PostgreSQL`：建议使用 PostgreSQL 17 部署，并为 `registry-server` 单独准备数据库和用户

如果目标机尚未安装 Python 3.14，可以用 `uv` 命令或者其它方式安装 Python 3.14。命令：`uv python install 3.14 --install-dir /opt/uv-python --no-bin` 会把 Python 3.14 安装到 `/opt/uv-python/`，但不创建全局可执行链接；这样对目标机系统环境影响更小，也避免了与系统 Python 的版本冲突。

```bash
mkdir -p /opt/registry-server
cd /opt/registry-server
tar xzf registry-server-wheel-offline-{version}-{platform}.tar.gz

# 注意：压缩包会解出一层同名根目录，后续命令应进入该目录执行
cd registry-server-wheel-offline-{version}-{platform}

# 创建虚拟环境；python 3.14 的路径根据实际安装位置调整
/opt/uv-python/cpython-3.14.x-<platform>/bin/python3.14 -m venv .venv

# 在线安装：同一条命令同时安装锁定的运行时依赖和应用 wheel
.venv/bin/python -m pip install \
  -r requirements-runtime.txt \
  dist/registry_server-{version}-py3-none-any.whl

# 如果目标机无法访问公网，则改用下面这组离线安装命令；不要与上面的在线命令重复执行

# 离线安装：同一条命令同时安装锁定的运行时依赖和应用 wheel
.venv/bin/python -m pip install \
  --no-index \
  --find-links wheelhouse \
  -r requirements-runtime.txt \
  dist/registry_server-{version}-py3-none-any.whl

# 拷贝环境变量模板
cp .env.example .env
# 编辑 .env，设置环境变量；非常重要的一步，很多运行时参数都来自环境变量；比如 APP_ENV=production、DATABASE_URL、SECRET_KEY、SM4_ENCRYPTION_KEY、AIC_CRC_SALT 等
# 再按 APP_ENV 编辑对应 TOML（通常是 config/production.toml），补齐非敏感业务配置；
# 至少确认 [server] 的 port / enable_mtls_listener / mtls_port，以及 [ca_server] 的 base_url

# 执行数据库迁移
.venv/bin/python -m alembic upgrade head
```

部署说明：

- 如果用 `source .venv/bin/activate` 激活虚拟环境；命令行中的 `.venv/bin/python` 可简化为 `python`。
- 如果离线运行包中的 `wheelhouse/` 与目标机平台不匹配，请回到构建机重新执行 `just package wheel offline ...`。
- `.env` 中的 `APP_ENV` 决定加载哪个 `config/{APP_ENV}.toml`；生产环境通常应设置为 `production`。
- 不要只修改 `.env` 就继续部署；在确定 `APP_ENV` 后，应立即检查并编辑 `config/{APP_ENV}.toml`。对 `registry-server` 来说，至少要确认 `[server]` 与 `[ca_server]` 段，尤其是 `enable_mtls_listener`、`mtls_port`、`base_url` 等非敏感配置是否已经与目标环境一致。
- `config/production.toml` 默认仍是 `enable_mtls_listener = true`；首次启动前不要跳过 4.3.1，必须先显式关闭 `9002`，等服务端证书就绪后再切回双端口。
- 如果 `ca-server` 不在默认的 `http://localhost:9003`，请在 `.env` 中显式设置 `CA_SERVER_BASE_URL`；这里填写的是 CA 服务根地址，不要追加 `/acps-atr-v2`，应用会自行拼出 ATR 根路径。
- `REGISTRY_SERVER_INTERNAL_API_TOKEN` 需要与 `ca-server` 端保持一致；证书自举、EAB 或内部联调若出现莫名的鉴权失败，应优先核对这两个服务的令牌是否一致。

### 4.3. 启动方式

`9002` 端口是用于派生实体自动注册审批的 mTLS 端口，它不能在首次部署时直接启用。它依赖 registry-server 自己的 `serverAuth` 服务端证书，而这套证书需要在 `9001` 与 `ca-server:9003` 都已经可用后，借助 `acps-cli` 走“注册 -> 审批 -> EAB -> 发证”流程申请出来。因此，生产部署应按“两步走”处理。

#### 4.3.1. 第一步：先只启动 9001

首次启动时，先在 `config/{APP_ENV}.toml` 中关闭 `9002` listener，只让 public plane 提供服务：

```bash
[server]
port = 9001
enable_mtls_listener = false
mtls_port = 9002
```

此时 `.env` 中的 `REGISTRY_SERVER_MTLS_CERT_FILE`、`REGISTRY_SERVER_MTLS_KEY_FILE`、
`REGISTRY_SERVER_MTLS_CA_CERT_FILE` 还可以先保留占位值，因为第一步不会实际拉起 `9002`。

启动命令仍然统一使用 supervisor 入口：

```bash
.venv/bin/python -m app.runtime_dual_listener
```

运行说明：

- `server.enable_mtls_listener = false` 时，`app.runtime_dual_listener` 只会拉起 `9001` public plane。
- 第一阶段先确认 `9001` 的 `/health` 可达，并确保 `ca-server` 也已按其 README 在 `9003` 启动成功。
- 如需做进程存活探针，可执行 `.venv/bin/python -m app.runtime_healthcheck`；当 `enable_mtls_listener = false`
  时，它只检查 `9001`。

#### 4.3.2. 第二步：申请 9002 证书并切换到双端口

第二步默认假定 `acps-cli` 已经作为独立工具完成安装与配置，需要当前生效配置已经指向目标 `registry-server:9001`
与 `ca-server:9003`，就可以直接用；只有在需要临时覆盖现有配置时，才额外传 `--config PATH`。

现在不再建议在这里手工逐条执行“登录 -> 保存 ACS -> 提交审核 -> 审批 -> EAB -> 发证”。统一改用 `acps-cli` 运行包自带的 `bootstrap.sh`：

```bash
cd /opt/acps-cli
bash scripts/bootstrap.sh registry-9002 --config ./acps-cli.toml
```

补充说明：

- 若未显式提供凭据，脚本会交互式提示输入普通用户和管理员账号密码。
- 运行前请先在 `acps-cli` 运行包的 `scripts/acs/` 下手工修改 `registry-server-9002-service-acs.json` 与 `registry-server-9002-probe-acs.json`，尤其是 `certificate.altNames` 中的对外 DNS/IP；如需避免名称冲突，也应同步调整 `name`。
- `bootstrap.sh` 只会读取这些静态 JSON，不会再根据 `acps-cli.toml` 生成 ACS/SAN，也不会回写 `aic`。
- 产物会写入 `acps-cli` 运行目录下的 `bootstrap-artifacts/registry-server-9002/`，并生成对应 `summary.json`。

把以下文件复制到 `registry-server` 主机的证书目录：

- `bootstrap-artifacts/registry-server-9002/server.pem -> /opt/registry-server/certs/server.pem`
- `bootstrap-artifacts/registry-server-9002/server.key -> /opt/registry-server/certs/server.key`
- `bootstrap-artifacts/registry-server-9002/trust-bundle.pem -> /opt/registry-server/certs/trust-bundle.pem`

另外，`bootstrap-artifacts/registry-server-9002/client.pem` 与 `client.key` 应保留在 `acps-cli` / 运维机上，供后续 `9002` 黑盒探测和统一烟测使用，不需要复制进 `registry-server` 自身运行目录。

再把 `config/{APP_ENV}.toml` 切回双端口模式：

```bash
[server]
port = 9001
enable_mtls_listener = true
mtls_port = 9002
```

最后重启应用服务：

```bash
.venv/bin/python -m app.runtime_dual_listener
```

切换说明：

- `server.enable_mtls_listener = true` 后，`app.runtime_dual_listener` 会同时拉起 `9001` 和 `9002`；`9002`
  的端口号来自 `config/{APP_ENV}.toml` 中的 `server.mtls_port`。
- `9002` 所需的证书路径仍通过 `.env` 中的环境变量提供：`REGISTRY_SERVER_MTLS_CERT_FILE`、
  `REGISTRY_SERVER_MTLS_KEY_FILE`、`REGISTRY_SERVER_MTLS_CA_CERT_FILE`，它们应分别指向刚复制过去的 `server.pem`、`server.key`、`trust-bundle.pem`。
- `REGISTRY_SERVER_MTLS_CA_CERT_FILE` 是 `9002` 用来校验“客户端证书链”的 trust anchor；它应指向 CA 主链路的 trust bundle，并至少包含 root，不要只填 intermediate 证书。
- `bootstrap.sh` 已经同时生成了专用 `clientAuth` 探针证书，后续直接复用 `bootstrap-artifacts/registry-server-9002/client.pem` 与 `client.key` 即可，不需要再手工补签一张探针证书。
- 如果后续还要用 `acps-cli entity derive` 访问 `9002`，客户端侧应把 `registry.mtls_server_ca_file` 指向同一份
  `trust-bundle.pem`，并按本体 AIC 准备 `certificate.pem` / `private-key.pem` 材料目录。

### 4.4. systemd 安装与启停

在验证应用可以执行，并且 `9001`、`9002` 都能正常提供服务后，就可以按照下面的步骤把它安装成 systemd 服务了。

使用运行包根目录中的 `registry-server.service` unit 文件安装成 systemd 服务。该 unit 默认假定部署目录为 `/opt/registry-server`；如果你的部署目录不同，请先修改 `WorkingDirectory` 和 `ExecStart`。

```bash
cd /opt/registry-server

# 可选：先检查并按需修改 unit 中的 WorkingDirectory / ExecStart
vi registry-server.service

sudo cp registry-server.service /etc/systemd/system/registry-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now registry-server
```

说明：

- 当前 unit 不使用 `EnvironmentFile=`，因为项目 `.env` 使用 dotenv 语法并带有行内注释；应用会在
  `WorkingDirectory` 下自行读取 `.env`。
- 启动前请确认部署目录中的 `.env` 已设置好 `APP_ENV=production`、数据库连接串、密钥和 mTLS 证书路径。
- 如需以专用系统用户运行，请先创建用户，再取消注释 unit 文件中的 `User=` 和 `Group=`。

常用命令：

```bash
sudo systemctl status registry-server
sudo systemctl restart registry-server
sudo systemctl stop registry-server
sudo systemctl disable registry-server
sudo journalctl -u registry-server -f
```
