# demo-partner

demo-partner 是 ACPs 的 Partner Agent 示例应用，以多 Agent 方式运行，每个 Agent 暴露独立端口，
用于演示基于 ACPs SDK 的 Partner 调用与编排。本文保留四件事：这个项目做什么、日常怎么开发、
如何构建与 `acps-infra` 配合的 standalone `release-app` 交付物，以及如何直接以 Python wheel 运行包
完成通用部署。

## 1. 概述

### 1.1. 项目定位

- 提供多个可独立运行的 Partner Agent 示例
- 作为 demo-leader、discovery-server 和整体链路联调的下游服务
- 展示基于 ACS / AIC / mTLS 的 Partner 运行方式

### 1.2. 项目特点

- 多 Agent、多端口、配置驱动
- 无数据库，不依赖 PostgreSQL / Alembic
- 本地证书与发布证书都按 Agent 维度管理在 `partners/online/*/`

### 1.3. 目录概览

```text
demo-partner/
├── partners/              # Partner 业务代码与在线配置
├── tests/                 # unit / integration / e2e
├── scripts/release-app/   # release-app 打包脚本
├── scripts/systemd/       # systemd unit 模板
├── scripts/package-wheel-runtime.sh  # wheel 运行包打包脚本
├── scripts/smoke-test.sh  # 部署后冒烟脚本
├── Justfile               # 本地开发、测试、质量检查入口
└── Dockerfile             # 生产镜像构建
```

## 2. 开发

### 2.1. 前置条件

- [uv 官方安装文档](https://docs.astral.sh/uv/getting-started/installation/)
- [just 官方安装文档](https://just.systems/man/en/packages.html)
- [Docker Desktop 官方下载](https://www.docker.com/products/docker-desktop/)
- 同级目录已存在 `../acps-infra/`
- 如需跑完整联调链路，宿主机还应运行 `registry-server`、`ca-server`、`discovery-server`

### 2.2. 快速开始

```bash
git clone <仓库地址>
cd demo-partner

# 虽然 just prep env / just app bootstrap 会在缺失时生成 .env，
# 但仍建议先显式复制模板并检查关键配置。
cp .env.example .env
# 编辑 .env：确认 RabbitMQ、LLM 与各 Agent 运行参数

just app bootstrap
just app
```

默认会启动多个 Partner Agent，端口范围为 `9021-9025`。

### 2.3. 常用命令

```bash
# 帮助与环境检查
just help                         # 输出命令总览，直接执行 just 也会显示帮助
just doctor                       # 检查 Docker、RabbitMQ、证书和关键配置
just infra up rabbitmq            # 启动 demo-partner 需要的共享依赖
just infra status                 # 查看共享依赖状态

# 环境准备
just prep env                     # 缺失时根据 .env.example 生成 .env
just prep sync                    # 下载 managed Python 3.14，并把依赖同步到 .venv/
just prep hooks                   # 安装/更新 Git hooks
just prep certs                   # 按各 Agent 的 AIC 声明生成本地证书

# 应用
just app bootstrap                # 一键建立本地开发环境
just app                          # 快速后台启动全部 Partner Agent（等价于 just app start）
just app start                    # 后台启动全部 Partner Agent
just app status                   # 查看 Agent 进程状态
just app logs follow              # 持续跟踪日志
just app stop                     # 停止本地实例

# 测试
just test bootstrap               # 准备测试环境
just test unit                    # 单元测试
just test integration             # 集成测试
just test e2e                     # 黑盒 e2e
just test coverage                # 单元测试覆盖率
just test                         # 默认执行 all，依次执行 unit / integration / e2e

# 质量
just qa                           # 默认执行 all，先 fix，再跑 pre-commit
just qa fmt                       # 只做格式化
just qa type                      # mypy 类型检查

# 打包
just package wheel                # 构建在线 wheel 运行包
just package wheel offline        # 构建离线 wheel 运行包
```

### 2.4. 开发说明

- 项目运行所需 Python 不依赖本机预装版本；`just prep sync` 会通过 `uv` 下载 managed Python 3.14，
  并把依赖安装到当前项目的 `.venv/`。
- `partners/online/*/acs.json` 定义 Agent 能力，`config.toml` 定义运行配置。
- `just prep certs` 会按各 Agent 的 AIC 声明生成本地 mTLS 证书，不应把这些临时文件提交到 Git。
- 集成测试和 e2e 依赖 RabbitMQ；如需完整业务链路验证，通常还需要同时启动 `demo-leader`。
- 已部署实例也可通过 `TEST_E2E_BASE_URLS` 提供给 e2e 测试复用。

## 3. 基于 acps-infra 的 standalone release-app 交付

`demo-partner` 仍然保留与 `acps-infra` 配套的 `release-app` 路径，适用于基于 Docker 的单机 standalone
部署场景。该模式下，应用包、镜像编排、证书 provision 和目标机升级流程都继续复用
`acps-infra` 的约定，本仓只负责构建 `demo-partner` 自己的 `release-app` 交付物。

### 3.1. 构建 release-app 交付物

```bash
bash scripts/release-app/build-app-bundle.sh
DOCKER_PLATFORM=linux/amd64 bash scripts/release-app/build-app-bundle.sh
DOCKER_PLATFORM=linux/arm64 bash scripts/release-app/build-app-bundle.sh
```

打包说明：

- 产物会输出到 `dist/` 目录。
- `DOCKER_PLATFORM` 用于声明目标部署平台；在 Apple Silicon 上为 arm64 目标构建时，应显式传入
  `DOCKER_PLATFORM=linux/arm64`。
- 发布包不包含正式证书、私钥或 trust bundle；这些材料仍由目标机上的 standalone provision 流程负责。

### 3.2. 目标机部署说明

standalone 目标机上的安装、升级、证书材料准备和 smoke 流程，继续统一遵循 `acps-infra` 的
standalone 文档与脚本约定。`demo-partner` 这里只补充本仓的对接边界：

- `scripts/release-app/build-app-bundle.sh` 生成的是供 `acps-infra` standalone 安装器消费的应用交付物。
- 目标机上的 `provision.sh`、`provision.conf`、证书准备和运行时目录切换，均由 `acps-infra` 的
  standalone 流程托管，本仓不再复制维护一份平行说明。
- 若你走的是这一章的 Docker standalone 交付路径，请不要与第 4 章的 wheel 原生部署路径混用。

## 4. 通用打包与部署

`demo-partner` 也可以完全不依赖 Docker 和 `acps-infra`，直接以 Python wheel 运行包交付到一般环境。
但用于部署的发布物不能只有 `.whl`；它还必须同时带上 `partners/online/*` 运行目录、环境变量模板、
冒烟脚本、systemd unit 模板，以及 `acps-sdk`、`acps-cli` 这两个 sibling wheel。仓库已经把这套流程
收敛为统一的 `just package wheel` 命令。

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

克隆本仓库和依赖的兄弟项目：

```bash
cd ~/acps-build
git clone <demo-partner 仓库地址>
git clone <acps-sdk 仓库地址>
git clone <acps-cli 仓库地址>
```

执行打包：

```bash
cd ~/acps-build/demo-partner
just package wheel
just package wheel offline
```

打包说明：

- `dist/demo-partner-wheel-{version}-{platform}.tar.gz` 是在线运行包。
- `dist/demo-partner-wheel-offline-{version}-{platform}.tar.gz` 是离线运行包。
- 文件名中的 `{platform}` 表示目标部署平台：默认使用当前构建机平台；如果显式传入 `--pip-platform`，
  则使用该值。
- 两种运行包都会包含以下运行时必需文件和目录：
  - `dist/`：包含 `demo-partner`、`acps-sdk`、`acps-cli` 三个 wheel。
  - `partners/online/`：部署态 Partner 运行目录，包含 `acs.json`、`config.toml`、提示词与技能配置。
  - `.env.example`：环境变量模板。
  - `README.md`：随包交付的部署说明文档。
  - `requirements-runtime.txt`：剔除了 sibling wheel 后的运行时依赖清单。
  - `checksums.txt`：运行包内容校验清单。
  - `scripts/smoke-test.sh`：运行包目录内可直接执行的多 Agent mTLS 冒烟脚本。
  - `demo-partner.service`：systemd unit 模板。
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
- `just package wheel offline` 默认按当前构建机平台下载 wheel；如果目标机平台不同，请显式传入
  `--pip-platform`、`--pip-implementation` 和 `--pip-abi`。
- `--pip-platform` 可重复传入。对 Linux 目标来说，部分依赖会同时使用 `manylinux2014` 与更新的
  `manylinux_2_28` 标签；例如 x86_64 目标通常应同时传 `manylinux2014_x86_64` 与
  `manylinux_2_28_x86_64`。

### 4.2. 目标机部署

原生部署前请自行准备 Python 3.14、RabbitMQ、Registry、CA、Discovery 以及网络访问控制；这些能力不再由
Docker 或 `acps-infra` 代管。

基础服务前置条件：

- `RabbitMQ`：请参考 mq-auth-server 的部署说明。RabbitMQ 应该提供 TLS `5671` broker 监听，启用 `rabbitmq_management`、`rabbitmq_auth_mechanism_ssl`、`rabbitmq_auth_backend_http`、`rabbitmq_auth_backend_cache` 这 4 个插件。
- `RabbitMQ 共享对象`：参照 `stage-infra/init-rabbitmq.sh`，目标 RabbitMQ 应预先准备 `acps` vhost 和 `inbox.topic` topic exchange；否则 group 模式和跨 Agent 消息路由无法按默认合同工作。

如果目标机尚未安装 Python 3.14，可以用 `uv` 命令或者其它方式安装 Python 3.14。命令：
`uv python install 3.14 --install-dir /opt/uv-python --no-bin` 会把 Python 3.14 安装到
`/opt/uv-python/`，但不创建全局可执行链接；这样对目标机系统环境影响更小，也避免了与系统 Python 的版本冲突。

```bash
mkdir -p /opt/demo-partner
cd /opt/demo-partner
tar xzf demo-partner-wheel-offline-{version}-{platform}.tar.gz

# 注意：压缩包会解出一层同名根目录，后续命令应进入该目录执行
cd demo-partner-wheel-offline-{version}-{platform}

# 创建虚拟环境；python 3.14 的路径根据实际安装位置调整
/opt/uv-python/cpython-3.14.x-<platform>/bin/python3.14 -m venv .venv

# 在线安装：同一条命令同时安装锁定的运行时依赖和随包 wheel
.venv/bin/python -m pip install \
  -r requirements-runtime.txt \
  dist/acps_sdk-*.whl \
  dist/acps_cli-*.whl \
  dist/demo_partner-*.whl

# 如果目标机无法访问公网，则改用下面这组离线安装命令；不要与上面的在线命令重复执行

# 离线安装：同一条命令同时安装锁定的运行时依赖和随包 wheel
.venv/bin/python -m pip install \
  --no-index \
  --find-links wheelhouse \
  -r requirements-runtime.txt \
  dist/acps_sdk-*.whl \
  dist/acps_cli-*.whl \
  dist/demo_partner-*.whl

# 拷贝环境变量模板
cp .env.example .env
# 编辑 .env，至少填写 APP_ENV 和 PARTNER_LLM_FAST_*、PARTNER_LLM_DEFAULT_*、PARTNER_LLM_PRO_* 这些运行时敏感参数
# partners/online/*/config.toml 中的 llm.*.*_env 会从 .env 读取 key / base_url / model
```

部署说明：

- 如果用 `source .venv/bin/activate` 激活虚拟环境；命令行中的 `.venv/bin/python` 可简化为 `python`。
- 如果离线运行包中的 `wheelhouse/` 与目标机平台不匹配，请回到构建机重新执行
  `just package wheel offline ...`。
- `.env` 中的 `APP_ENV` 决定运行时环境标记；`demo-partner` 没有集中式 `config/` 目录，非敏感业务配置
  直接维护在 `partners/online/*/config.toml`。
- `partners/online/*/config.toml` 中的 `llm.*.*_env` 会统一引用 `.env` 中的变量；也就是说，
  `api_key`、`base_url` 和 `model` 都不直接写死在 TOML 中。
- 证书文件不需要在这一步手工准备空目录；第 4.3 节的 bootstrap 会把 `server.pem`、`server.key`、
  `trust-bundle.pem`、`client.pem`、`client.key` 直接写入每个 Partner 子目录。

### 4.3. 证书获取与启动方式

`demo-partner` 的每个 Agent 都要求真实 mTLS 证书。也就是说，生产部署时不能只解压运行包并填写 `.env`
就直接启动；需要先借助 `acps-cli` 走“注册 -> 审批 -> EAB -> 发证”流程，为每个 `partners/online/*`
子目录至少申请两套材料：

- 一张 `serverAuth` 服务端证书，供该 Partner 自己的 HTTPS `/rpc` / `/health` 端点使用。
- 一张 `clientAuth` 客户端证书，供部署态 `scripts/smoke-test.sh` 与跨 Agent mTLS 调用复用。

#### 4.3.1. 第一步：通过 demo-partner bootstrap 申请并落盘证书

这一步默认假定 `acps-cli` 已经作为独立工具完成安装与配置，并且当前生效配置已经指向目标
`registry-server` 与 `ca-server`；只有在需要临时覆盖现有配置时，才额外传 `--config PATH`。

与 `registry-server` / `mq-auth-server` 的静态 bootstrap 不同，`demo-partner` 模式会直接读取并回写
安装目录下的 `partners/online/*/acs.json`，因此 `acps-cli` 必须与 `demo-partner` 运行目录位于同一台机器，
或至少能够直接访问该安装目录。

统一改用 `acps-cli` 运行包自带的 `bootstrap.sh`：

```bash
cd /opt/acps-cli
bash scripts/bootstrap.sh demo-partner \
  --config ./acps-cli.toml \
  --install-dir /opt/demo-partner
```

补充说明：

- 若未显式提供凭据，脚本会交互式提示输入普通用户和管理员账号密码。
- 脚本会扫描 `/opt/demo-partner/partners/online/*/acs.json`，逐个执行保存、提交、审批与发证流程。
- 审批完成后，脚本会把返回的 `aic` 回写到对应的 `acs.json`，再把证书文件直接写入同目录。
- 默认汇总目录是 `/opt/demo-partner/bootstrap-artifacts/`；其中 `demo-partner/summary.json` 会记录每个
  Partner 的 AIC 与文件路径。

每个 Partner 子目录最终会得到以下部署态合同文件：

- `acs.json`
- `server.pem`
- `server.key`
- `trust-bundle.pem`
- `client.pem`
- `client.key`

#### 4.3.2. 第二步：启动并验证

依赖服务、`.env`、`partners/online/*/config.toml` 和证书都准备好之后，就可以直接启动。

```bash
cd /opt/demo-partner
.venv/bin/python -m partners.main
```

运行说明：

- `partners.main` 会按 `partners/online/*/config.toml` 拉起全部在线 Partner Agent。
- 各 Agent 的 `/health` 端点同样要求 mTLS，因此不能再用裸 `curl http://...` 代替部署验证。
- 部署态统一使用运行包自带的 `scripts/smoke-test.sh` 做多 Agent 冒烟：

```bash
cd /opt/demo-partner
bash scripts/smoke-test.sh
```

补充说明：

- `scripts/smoke-test.sh` 会自动加载当前运行目录 `.env`，校验所有 `config.toml` 中声明的 `*_env`
  是否已经解析成功。
- 冒烟脚本会逐个使用对应目录下的 `client.pem`、`client.key` 和 `trust-bundle.pem` 对
  `https://<host>:<port>/health` 执行 mTLS 健康检查。
- 如果你修改了 `partners/online/*/config.toml` 中的监听端口，冒烟脚本会自动按新端口探测，不需要再手工改脚本。

### 4.4. systemd 安装与启停

在验证应用可以执行，并且所有 Partner 的 mTLS `/health` 都通过后，就可以按照下面的步骤把它安装成
systemd 服务了。

使用运行包根目录中的 `demo-partner.service` unit 文件安装成 systemd 服务。该 unit 默认假定部署目录为
`/opt/demo-partner`；如果你的部署目录不同，请先修改 `WorkingDirectory`、`ExecStart` 和
`PARTNERS_ONLINE_DIR`。

```bash
cd /opt/demo-partner

# 可选：先检查并按需修改 unit 中的 WorkingDirectory / ExecStart / PARTNERS_ONLINE_DIR
vi demo-partner.service

sudo cp demo-partner.service /etc/systemd/system/demo-partner.service
sudo systemctl daemon-reload
sudo systemctl enable --now demo-partner
```

说明：

- 当前 unit 不使用 `EnvironmentFile=`，因为项目 `.env` 使用 dotenv 语法；应用会在 `WorkingDirectory`
  下自行读取 `.env`。
- 启动前请确认部署目录中的 `.env` 已配置好 LLM、RabbitMQ、Registry、CA、Discovery 等环境变量，
  并且 `partners/online/*/config.toml` 已调整到目标环境端口和并发设置。
- 如果需要使用专用系统用户运行，请先创建用户，再取消注释 unit 文件中的 `User=` 和 `Group=`。

常用命令：

```bash
sudo systemctl status demo-partner
sudo systemctl restart demo-partner
sudo journalctl -u demo-partner -f
```
