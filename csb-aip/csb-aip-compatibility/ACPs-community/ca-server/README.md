# ca-server

ca-server 是 ACPs 的证书服务，负责 ATR 场景下的证书申请、签发、吊销与查询。本文主要说明四件事：
这个项目做什么、日常怎么开发、如何构建与 `acps-infra` 配合的 Docker 交付物，以及如何在无 Docker 环境下完成通用打包与部署。

## 1. 概述

### 1.1. 项目定位

- 对外提供 ACME、CRL、OCSP 与 trust bundle 相关协议端点
- 为 Agent 签发业务证书，并维护证书状态与吊销信息
- 为其他 ACPs 组件提供 internal/admin 证书管理接口

### 1.2. 项目特点

- 同时承载 ACME、CRL、OCSP 三类协议能力
- 本地开发证书材料由 `../acps-infra/dev-infra` 统一下发
- 默认开发模式可 mock `registry-server`，需要时再切换真实联调

### 1.3. 目录概览

```text
ca-server/
├── app/                         # 业务代码
├── alembic/                     # 数据库迁移
├── certs/                       # 本地开发证书材料
├── tests/                       # unit / integration / e2e
├── scripts/release-app/         # release-app 打包脚本
├── scripts/package-wheel-runtime.sh # 原生 wheel 运行包打包脚本
├── scripts/systemd/             # systemd unit 模板
├── Justfile                     # 本地开发、测试、质量检查入口
└── Dockerfile                   # 生产镜像构建
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
cd ca-server

# 虽然 just prep env / just app bootstrap 会在缺失时生成 .env，
# 但仍建议先显式复制模板并检查关键配置。
cp .env.example .env
# 编辑 .env：确认数据库、CA 材料路径、服务 token 等敏感项

just app bootstrap
just app
```

启动后常用地址：

- API: `http://localhost:9003`
- Docs: `http://localhost:9003/docs`
- Health: `http://localhost:9003/health`

### 2.3. 常用命令

```bash
# 帮助与环境检查
just help                         # 输出命令总览，直接执行 just 也会显示帮助
just doctor                       # 检查 Docker、证书、数据库和关键配置
just infra up postgres            # 启动 ca-server 需要的共享依赖
just infra status                 # 查看共享依赖状态

# 环境准备
just prep env                     # 缺失时根据 .env.example 生成 .env
just prep sync                    # 下载 managed Python 3.14，并把依赖同步到 .venv/
just prep hooks                   # 安装/更新 Git hooks
just prep certs                   # 从共享开发 PKI 导出 CA 套件
just prep migrate app             # 迁移开发数据库
just prep migrate test            # 迁移测试数据库

# 应用
just app bootstrap                # 一键建立本地开发环境
just app                          # 快速后台启动服务（等价于 just app start）
just app start                    # 后台启动服务
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
just qa                           # 默认执行 all，先 fix，再跑 pre-commit 和 audit
just qa fmt                       # 只做格式化
just qa fix                       # 格式化并自动修复 Ruff 问题
just qa audit                     # 依赖漏洞审计

# 打包
just package wheel                # 构建在线运行包
just package wheel offline        # 构建离线运行包
```

### 2.4. 开发说明

- 项目运行所需 Python 不依赖本机预装版本；`just prep sync` 会通过 `uv` 下载 managed Python 3.14，
  并把依赖安装到当前项目的 `.venv/`。
- `just prep certs` 会从共享开发 PKI 导出 `ca-server` 需要的 CA 套件。
- 开发模式下默认不会请求真实 `registry-server`；如需联调，请在 `config/development.toml` 中将
  `[registry_server].mock` 改为 `false`，或在启动命令前临时注入 `REGISTRY_SERVER_MOCK=false` 作为 override。
- 本仓的 `tests/e2e/` 只验证 `ca-server` 自身黑盒行为；跨服务联调请转到 `acps-cli/tests/e2e/`。
- 生产配置中的证书对外地址、OCSP 和 CRL 地址应在部署前确认，不建议依赖默认占位值。

## 3. Docker 交付（release-app / standalone）

`ca-server` 自己提供的 Docker 交付入口是 `scripts/release-app/build-app-bundle.sh`。它会构建应用镜像，
并生成一个离线 app-only bundle，供 `stage-infra` 或 standalone 顶层装配复用。

```bash
bash scripts/release-app/build-app-bundle.sh
```

打包说明：

- 这是一个离线 app-only 包，产物输出到 `dist/`，文件名形如 `ca-server-app-{version}.tar.gz`。
- bundle 内包含 `images.tar.gz`、`deploy.sh`、compose 文件、`.env.example`、`VERSION`、`checksums.txt` 等发布元数据。
- `images.tar.gz` 中已经包含 `ca-server` 应用镜像，因此镜像内的 Python 运行时和应用依赖也随包离线交付，不需要目标机再在线拉取 Python 包。

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
- `ca-server` 的 standalone 部署位于 `registry-server:9001` public plane 之后、`registry-server:9002` 证书自举之前；顶层安装器会在这个阶段准备 `ca-server` 的运行目录与 `.env`。
- 如果顶层 `.env` 中设置 `AUTO_GENERATE_CA_MATERIALS=false`，则需要同时提供 `CA_CERT_SOURCE_PATH`、`CA_KEY_SOURCE_PATH`、`CA_CHAIN_SOURCE_PATH`、`CA_TRUST_BUNDLE_SOURCE_PATH`；`install.sh` 会把这四个文件复制到运行目录下的 `ca-server/certs/`。
- `install.sh` 默认会继续执行各个应用的健康检查和业务 smoke 测试。

单机 standalone 场景下的更多详细信息，比如环境变量、证书引导、业务烟测和升级行为，以兄弟仓库 `acps-infra/README.md` 与 `acps-infra/scripts/release-standalone/README.md` 为准。

## 4. 通用打包与部署

`ca-server` 也可以完全不依赖 Docker 和 `acps-infra`，直接以 Python wheel 运行包交付到一般环境。而用于部署的发布物不能只有 `.whl`，还必须同时带上运行时 TOML 配置、Alembic 迁移脚本和环境变量模板。仓库已经把这套流程收敛为统一的 `just package wheel` 命令。

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
git clone <ca-server 仓库地址>
```

执行打包：

```bash
cd ~/acps-build/ca-server
just package wheel
just package wheel offline
```

打包说明：

- `dist/ca-server-wheel-{version}-{platform}.tar.gz` 是在线运行包。
- `dist/ca-server-wheel-offline-{version}-{platform}.tar.gz` 是离线运行包。
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
  - `scripts/smoke-test.sh`：运行包目录内可直接执行的基础冒烟脚本。
  - `ca-server.service`：systemd unit 模板。
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
- PostgreSQL、反向代理、CA 证书材料，以及 `acps-infra` 的其它组件都不在该包内。
- `just package wheel offline` 默认按当前构建机平台下载 wheel；如果目标机平台不同，请显式传入 `--pip-platform`、`--pip-implementation` 和 `--pip-abi`。
- `--pip-platform` 可重复传入。对 Linux 目标来说，部分依赖会同时使用 `manylinux2014` 与更新的 `manylinux_2_28` 标签；例如 x86_64 目标通常应同时传 `manylinux2014_x86_64` 与 `manylinux_2_28_x86_64`。
- 常用的 `--pip-platform` 有：
  - `manylinux2014_x86_64`：适用于大多数 x86_64 Linux 发行版。
  - `manylinux_2_28_x86_64`：适用于发布新一代 Linux wheel 标签的 x86_64 依赖。
  - `manylinux2014_aarch64`：适用于大多数 aarch64 Linux 发行版。
- `--pip-implementation` 和 `--pip-abi` 的值需要与目标机 Python 版本匹配，例如 Python 3.14 对应 `cp` 和 `cp314`。

### 4.2. 目标机部署

原生部署前请自行准备以下前置条件；这些能力不再由 Docker 或 `acps-infra` 代管。

基础服务前置条件：

- `PostgreSQL`：建议使用 PostgreSQL 17，并为 `ca-server` 单独准备数据库和用户。

如果目标机尚未安装 Python 3.14，可以用 `uv` 命令或者其它方式安装 Python 3.14。命令：`uv python install 3.14 --install-dir /opt/uv-python --no-bin` 会把 Python 3.14 安装到 `/opt/uv-python/`，但不创建全局可执行链接；这样对目标机系统环境影响更小，也避免了与系统 Python 的版本冲突。

```bash
mkdir -p /opt/ca-server
cd /opt/ca-server
tar xzf ca-server-wheel-offline-{version}-{platform}.tar.gz

# 注意：压缩包会解出一层同名根目录，后续命令应进入该目录执行
cd ca-server-wheel-offline-{version}-{platform}

# 创建虚拟环境；python 3.14 的路径根据实际安装位置调整
/opt/uv-python/cpython-3.14.x-<platform>/bin/python3.14 -m venv .venv

# 在线安装：同一条命令同时安装锁定的运行时依赖和应用 wheel
.venv/bin/python -m pip install \
  -r requirements-runtime.txt \
  dist/agent_ca_server-{version}-py3-none-any.whl

# 如果目标机无法访问公网，则改用下面这组离线安装命令；不要与上面的在线命令重复执行

# 离线安装：同一条命令同时安装锁定的运行时依赖和应用 wheel
.venv/bin/python -m pip install \
  --no-index \
  --find-links wheelhouse \
  -r requirements-runtime.txt \
  dist/agent_ca_server-{version}-py3-none-any.whl

# 拷贝环境变量模板
cp .env.example .env
# 编辑 .env，设置环境变量；正式部署通常使用 APP_ENV=production；若只是接入本机 ../acps-infra/dev-infra 做 wheel 验证，建议改为 APP_ENV=development，并显式设置 REGISTRY_SERVER_MOCK=false
# 至少确认 DATABASE_URL、受保护端点 token 等敏感项
# 再按 APP_ENV 编辑对应 TOML（通常是 config/production.toml），补齐非敏感业务配置；
# 至少确认 [registry_server] 的 url/timeout，以及 [ca] 的 acme_directory_url / ocsp_responder_url / crl_distribution_point_url

# 准备 CA 证书材料（建议沿用默认文件名）
mkdir -p certs
# certs/ca.crt
# certs/ca.key
# certs/ca-chain.pem
# certs/trust-bundle.pem

# 如果只是做测试验证，也可以先在一台已接入 ../acps-infra/dev-infra 的开发机上
# 按开发流程执行 just prep certs，导出这 4 个文件后再复制到目标机的 certs/ 目录

# 执行数据库迁移
.venv/bin/python -m alembic upgrade head
```

部署说明：

- 如果用 `source .venv/bin/activate` 激活虚拟环境；命令行中的 `.venv/bin/python` 可简化为 `python`。
- 如果离线运行包中的 `wheelhouse/` 与目标机平台不匹配，请回到构建机重新执行 `just package wheel offline ...`。
- `.env` 中的 `APP_ENV` 决定加载哪个 `config/{APP_ENV}.toml`；生产环境通常应设置为 `production`。
- 如果当前只是做本机 `localhost` wheel 验证，不要直接套用 production 示例；建议改用 `APP_ENV=development`，并显式设置 `REGISTRY_SERVER_MOCK=false`，否则 development 默认 mock 会短路真实 Registry EAB consume 链路。
- 不要只修改 `.env` 就继续部署；在确定 `APP_ENV` 后，应立即检查并编辑 `config/{APP_ENV}.toml`。对 `ca-server` 来说，至少要确认 `[registry_server]` 段和 `[ca]` 段中的公开协议地址是否已经与目标环境一致。
- 根 `.env.example` 只保留敏感项和启动级参数；`REGISTRY_SERVER_URL`、`REGISTRY_SERVER_TIMEOUT`、`REGISTRY_SERVER_MOCK` 以及 `ACME_DIRECTORY_URL`、`OCSP_RESPONDER_URL`、`CRL_DISTRIBUTION_POINT_URL` 默认都应在 `config/{APP_ENV}.toml` 中维护。
- `REGISTRY_SERVER_URL` 与 `REGISTRY_SERVER_TIMEOUT` 现在采用和 ACME/OCSP/CRL 地址一致的读取方式：默认读取 `config/{APP_ENV}.toml`，如部署系统确实需要环境变量覆盖，仍可单独注入 `REGISTRY_SERVER_URL` / `REGISTRY_SERVER_TIMEOUT`。
- `ACME_DIRECTORY_URL`、`OCSP_RESPONDER_URL`、`CRL_DISTRIBUTION_POINT_URL` 必须指向证书使用者和 ACME 客户端都能访问的公开地址；其中 `ocsp` 和 `crl` 地址会被写入新签发证书的扩展，生产环境不要保留 loopback、`localhost` 或示例域名。若部署系统必须用环境变量覆盖，也可以单独注入对应变量名。
- `config/{APP_ENV}.toml` 中的 `[registry_server].url` 应指向 registry-server 的 ATR 根地址，也就是包含 `/acps-atr-v2` 的服务根路径。
- `REGISTRY_SERVER_INTERNAL_API_TOKEN` 需要与 `registry-server` 保持一致；`ca-server` 的 internal 受保护端点可以直接复用这枚 token。若你希望单独发放 CA internal token，也可以额外设置 `CA_SERVER_INTERNAL_API_TOKEN`。
- `CA_SERVER_ADMIN_API_TOKEN` 用于 `/admin/certificates*` 等管理端点；如果没有显式设置，admin 端点会返回“authentication not configured”，而不是匿名开放。
- 理论上 `ca.crt`、`ca.key`、`ca-chain.pem`、`trust-bundle.pem` 应来自正式根 CA / 业务 CA 体系；但如果当前只是做测试运行验证，可以在一台开发机上进入本仓执行 `just prep certs`，它会委托 `../acps-infra/dev-infra/dev-cert.sh export-ca --ca agent` 导出同名开发证书套件，然后把这 4 个文件复制到目标机的 `certs/` 目录。
- 原生 wheel 部署不会像 Docker `release-bundle` 那样自动生成或复制 CA 材料。应用启动时会立即加载 `ca.crt`、`ca.key`、`ca-chain.pem`、`trust-bundle.pem`；缺失、残缺或互不匹配都会在启动阶段直接失败。

### 4.3. 启动方式

数据库迁移和 CA 证书材料就绪后，就可以直接启动。

```bash
.venv/bin/python -m app.main
```

运行说明：

- 启动端口来自 `config/{APP_ENV}.toml` 中的 `[server].port`，默认是 `9003`。
- `app.main` 在启动阶段会立即初始化 `CAManager`；如果 `certs/` 下的证书套件不完整，进程会直接退出，而不是延迟到首次发证请求时才报错。
- 第一阶段先确认 `9003` 的 `/health` 可达；如果 `DOCS_ENABLED=true`，还可以检查 `/docs`、`/redoc`、`/openapi.json`。

可以直接使用仓库自带的 smoke test 脚本做连通性验证：

```bash
# 连通性验证（health/docs/openapi + ACPs public 端点）
bash scripts/smoke-test.sh http://127.0.0.1:9003
```

补充说明：

- `scripts/smoke-test.sh` 现在只覆盖连通性，不再执行 internal / admin 业务链路验证。
- 若按本机 wheel 验证方式运行，请先确认当前环境或 `.env` 中使用的是 `APP_ENV=development` 且 `REGISTRY_SERVER_MOCK=false`。
- 跨服务业务烟测统一在 `acps-cli` 运行包执行：`bash scripts/smoke-test-business.sh --config ./acps-cli.toml --bootstrap-dir ./bootstrap-artifacts`。

### 4.4. systemd 安装与启停

在验证应用可以执行，并且 `9003` 能正常提供服务后，就可以按照下面的步骤把它安装成 systemd 服务了。

使用运行包根目录中的 `ca-server.service` unit 文件安装成 systemd 服务。该 unit 默认假定部署目录为 `/opt/ca-server`；如果你的部署目录不同，请先修改 `WorkingDirectory` 和 `ExecStart`。

```bash
cd /opt/ca-server

# 可选：先检查并按需修改 unit 中的 WorkingDirectory / ExecStart
vi ca-server.service

sudo cp ca-server.service /etc/systemd/system/ca-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now ca-server
```

说明：

- 当前 unit 不使用 `EnvironmentFile=`，因为项目 `.env` 使用 dotenv 语法并带有行内注释；应用会在 `WorkingDirectory` 下自行读取 `.env`。
- 启动前请确认部署目录中的 `.env` 已设置好 `APP_ENV=production`、数据库连接串、受保护端点 token，以及 CA 证书材料路径；非敏感的 registry/CA 地址默认应在 `config/production.toml` 中维护。
- 如需以专用系统用户运行，请先创建用户，再取消注释 unit 文件中的 `User=` 和 `Group=`。

常用命令：

```bash
sudo systemctl status ca-server
sudo systemctl restart ca-server
sudo systemctl stop ca-server
sudo systemctl disable ca-server
sudo journalctl -u ca-server -f
```
