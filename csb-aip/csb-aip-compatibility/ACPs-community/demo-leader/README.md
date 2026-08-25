# demo-leader

demo-leader 是 ACPs 的 Leader Agent 示例应用，负责接收用户输入、编排 Partner Agents、聚合结果，
并以 API / SSE 和 Web UI 的方式输出。本文说明三件事：这个项目做什么、日常怎么开发，以及如何分别构建
与 `acps-infra` 配合的 standalone `release-app` 交付物，或直接以 Python wheel 运行包部署到普通环境。

## 1. 概述

### 1.1. 项目定位

- 提供 Leader API，负责接收请求、编排 Partner 和聚合结果
- 提供本地 Web UI，便于手工联调与演示
- 作为 demo-partner、mq-auth-server、registry / ca / discovery 的上游业务入口

### 1.2. 项目特点

- 双进程运行：`9011` Leader API，`9010` Web UI
- 无数据库，业务状态主要由编排逻辑与会话流转维护
- `leader/config.toml` 保留非敏感配置，敏感值统一走环境变量
- 运行时 mTLS 证书位于 `leader/atr/`

### 1.3. 目录概览

```text
demo-leader/
├── leader/                      # Leader API、运行时配置、ACS 与场景
├── web_app/                     # 本地静态前端
├── tests/                       # unit / integration / e2e
├── scripts/release-app/         # standalone release-app 打包脚本
├── scripts/systemd/             # wheel 运行包 systemd unit 模板
├── scripts/package-wheel-runtime.sh
├── scripts/smoke-test.sh        # 基础 smoke
├── scripts/smoke-test-business.sh
├── Justfile                     # 本地开发、测试、质量检查入口
└── Dockerfile                   # release-app 镜像构建
```

## 2. 开发

### 2.1. 前置条件

- [uv 官方安装文档](https://docs.astral.sh/uv/getting-started/installation/)
- [just 官方安装文档](https://just.systems/man/en/packages.html)
- [Docker Desktop 官方下载](https://www.docker.com/products/docker-desktop/)
- 同级目录已存在 `../acps-sdk/`、`../acps-cli/`、`../acps-infra/`
- 如需跑集成测试或 e2e，通常还需要先启动 sibling `demo-partner`

### 2.2. 快速开始

```bash
git clone <仓库地址>
cd demo-leader

# 虽然 just prep env / just app bootstrap 会在缺失时生成 .env，
# 但仍建议先显式复制模板并检查关键配置。
cp .env.example .env
# 编辑 .env：确认 LLM、RabbitMQ 与 Leader 运行参数

just app bootstrap
just app
```

启动后常用地址：

- Web UI: `http://localhost:9010`
- Leader API: `http://localhost:9011`

### 2.3. 常用命令

```bash
# 帮助与环境检查
just help                         # 输出命令总览，直接执行 just 也会显示帮助
just doctor                       # 检查 Docker、证书、sibling 前置和关键配置
just infra status                 # 查看共享依赖状态

# 环境准备
just prep env                     # 缺失时根据 .env.example 生成 .env
just prep sync                    # 下载 managed Python 3.14，并把依赖同步到 .venv/
just prep hooks                   # 安装/更新 Git hooks
just prep certs                   # 基于 leader/atr/acs.json 生成本地证书

# 应用
just app bootstrap                # 一键建立本地开发环境
just app                          # 快速后台启动 Leader API + Web UI（等价于 just app start）
just app start                    # 后台启动 Leader API + Web UI
just app status                   # 查看后台进程状态
just app logs follow              # 持续跟踪日志
just app stop                     # 停止本地实例
just app smoke                    # 执行本地基础 smoke 检查

# 测试
just test bootstrap               # 准备测试环境
just test unit                    # 单元测试
just test api                     # API 级测试
just test integration             # 集成测试
just test e2e                     # 黑盒 e2e
just test coverage                # 单元测试覆盖率
just test                         # 默认执行 all，依次执行 unit / api / integration / e2e

# 打包
just package wheel                # 构建在线 wheel 运行包
just package wheel offline        # 构建离线 wheel 运行包

# 质量
just qa                           # 默认执行 all，先 fix，再跑 pre-commit
just qa fmt                       # 只做格式化
just qa type                      # mypy 类型检查
```

### 2.4. 开发说明

- 项目运行所需 Python 不依赖本机预装版本；`just prep sync` 会通过 `uv` 下载 managed Python 3.14，
  并把依赖安装到当前项目的 `.venv/`。
- `leader/atr/` 下的本地 mTLS 证书由 `just prep certs` 生成，不应提交到 Git。
- 集成测试和 e2e 通常需要先启动 sibling `demo-partner`。
- `leader/config.toml` 中只保留环境变量名引用，真实 LLM 参数由 `.env` 注入。
- Web UI 默认服务于本地调试与演示；standalone 交付侧端口仍由 `acps-infra` 的 `LEADER_WEB_PORT` 控制。

## 3. 基于 acps-infra 的通用打包和部署（单机 standalone / Docker）

`demo-leader` 仍然保留与 `acps-infra` 配套的 `release-app` 路径，适用于基于 Docker 的单机 standalone
交付。该路径沿用 `acps-infra` 的安装器、provision、nginx 反向代理和 smoke 约定，本仓只负责构建
`demo-leader` 自己的 `release-app` 交付物。

### 3.1. 构建 release-app 交付物

```bash
bash scripts/release-app/build-app-bundle.sh
DOCKER_PLATFORM=linux/amd64 bash scripts/release-app/build-app-bundle.sh
DOCKER_PLATFORM=linux/arm64 bash scripts/release-app/build-app-bundle.sh
```

打包说明：

- 产物会输出到 `dist/` 目录。
- 发布包不包含正式证书与运行期敏感配置，部署前需要先完成 provision / 证书准备。
- `scripts/release-app/build-app-bundle.sh` 生成的是供 `acps-infra` standalone 安装器消费的应用交付物。
- `demo-leader` 的 standalone 路径仍然是 `Leader API + Web UI + nginx` 的 Docker 组合，不是本章要展开的
  原生 wheel 部署路径。

### 3.2. 说明边界

- 目标机上的 `provision.sh`、证书准备、`LEADER_WEB_PORT`、部署、升级和 smoke 流程，统一参考 sibling 仓库
  `acps-infra/README.md`。
- 本章不改变现有 `release-app` / `deploy.sh` / `install.sh` / `nginx` 实现，只说明本仓如何构建该交付物。
- 若你走的是这一章的 Docker standalone 交付路径，请不要与第 4 章的 wheel 原生部署路径混用。

## 4. 通用打包与部署

`demo-leader` 也可以完全不依赖 Docker 和 `acps-infra`，直接以 Python wheel 运行包交付到一般环境。
但用于部署的发布物不能只有 `.whl`；它还必须同时带上部署态 `leader/config.toml`、`leader/atr/`、
`leader/scenario/`、`web_app/`、双进程启动脚本、基础 smoke、Leader-centric 业务 smoke、systemd unit 模板，
以及 `acps-sdk`、`acps-cli` 这两个 sibling wheel。仓库已经把这套流程收敛为统一的 `just package wheel` 命令。

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
git clone <demo-leader 仓库地址>
git clone <acps-sdk 仓库地址>
git clone <acps-cli 仓库地址>
```

执行打包：

```bash
cd ~/acps-build/demo-leader
just package wheel
just package wheel offline
```

打包说明：

- `dist/demo-leader-wheel-{version}-{platform}.tar.gz` 是在线运行包。
- `dist/demo-leader-wheel-offline-{version}-{platform}.tar.gz` 是离线运行包。
- 文件名中的 `{platform}` 表示目标部署平台：默认使用当前构建机平台；如果显式传入 `--pip-platform`，则使用该值。
- 两种运行包都会包含以下运行时必需文件和目录：
  - `dist/`：包含 `demo-leader`、`acps-sdk`、`acps-cli` 三个 wheel。
  - `leader/config.toml`：部署态运行配置副本。
  - `leader/atr/`：部署态 ACS 与证书落盘目录。
  - `leader/scenario/`：运行时场景目录副本。
  - `web_app/`：静态前端运行时目录副本。
  - `.env.example`：环境变量模板。
  - `README.md`：随包交付的部署说明文档。
  - `requirements-runtime.txt`：剔除了 sibling wheel 后的运行时依赖清单。
  - `checksums.txt`：运行包内容校验清单。
  - `scripts/start-leader-api.sh`：Leader API 启动脚本。
  - `scripts/start-web-ui.sh`：Web UI 启动脚本。
  - `scripts/smoke-test.sh`：基础 smoke，检查原生 `Web UI` 与 `Leader API`。
  - `scripts/smoke-test-business.sh`：Leader-centric 业务 smoke。
  - `scripts/smoke/business.py`：业务 smoke 的最小 Python 支撑代码。
  - `demo-leader-api.service`、`demo-leader-web.service`：systemd unit 模板。
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
  `manylinux_2_28` 标签。

### 4.2. 目标机部署

原生部署前请自行准备 Python 3.14、RabbitMQ、Registry、CA、Discovery 以及网络访问控制；这些能力不再由
Docker 或 `acps-infra` 代管。

基础服务前置条件：

- `RabbitMQ`：请参考 mq-auth-server 的部署说明。RabbitMQ 应该提供 TLS `5671` broker 监听，启用 `rabbitmq_management`、`rabbitmq_auth_mechanism_ssl`、`rabbitmq_auth_backend_http`、`rabbitmq_auth_backend_cache` 这 4 个插件。
- `RabbitMQ 共享对象`：参照 `stage-infra/init-rabbitmq.sh`，目标 RabbitMQ 应预先准备 `acps` vhost 和 `inbox.topic` topic exchange；否则 group 模式和跨 Agent 消息路由无法按默认合同工作。

如果目标机尚未安装 Python 3.14，可以用 `uv` 命令或者其它方式安装 Python 3.14。命令：
`uv python install 3.14 --install-dir /opt/uv-python --no-bin` 会把 Python 3.14 安装到 `/opt/uv-python/`，
但不创建全局可执行链接；这样对目标机系统环境影响更小，也避免了与系统 Python 的版本冲突。

```bash
mkdir -p /opt/demo-leader
cd /opt/demo-leader
tar xzf demo-leader-wheel-offline-{version}-{platform}.tar.gz

# 注意：压缩包会解出一层同名根目录，后续命令应进入该目录执行
cd demo-leader-wheel-offline-{version}-{platform}

# 创建虚拟环境；python 3.14 的路径根据实际安装位置调整
/opt/uv-python/cpython-3.14.x-<platform>/bin/python3.14 -m venv .venv

# 在线安装：同一条命令同时安装锁定的运行时依赖和随包 wheel
.venv/bin/python -m pip install \
  -r requirements-runtime.txt \
  dist/acps_sdk-*.whl \
  dist/acps_cli-*.whl \
  dist/demo_leader-*.whl

# 如果目标机无法访问公网，则改用下面这组离线安装命令；不要与上面的在线命令重复执行

# 离线安装：同一条命令同时安装锁定的运行时依赖和随包 wheel
.venv/bin/python -m pip install \
  --no-index \
  --find-links wheelhouse \
  -r requirements-runtime.txt \
  dist/acps_sdk-*.whl \
  dist/acps_cli-*.whl \
  dist/demo_leader-*.whl

# 拷贝环境变量模板
cp .env.example .env
# 编辑 .env，至少填写 APP_ENV 和 LEADER_LLM_FAST_*、LEADER_LLM_DEFAULT_*、LEADER_LLM_PRO_* 这些运行时敏感参数
# leader/config.toml 中的 llm.*.*_env 会从 .env 读取 key / base_url / model
```

部署说明：

- 如果用 `source .venv/bin/activate` 激活虚拟环境；命令行中的 `.venv/bin/python` 可简化为 `python`。
- 如果离线运行包中的 `wheelhouse/` 与目标机平台不匹配，请回到构建机重新执行 `just package wheel offline ...`。
- 运行时以安装目录中的 `leader/config.toml`、`leader/atr/`、`leader/scenario/`、`web_app/` 和 `.env` 为准；
  启动脚本会显式导出 `LEADER_RUNTIME_ROOT` / `LEADER_SCENARIO_ROOT` / `WEB_APP_ROOT`，避免误用 site-packages
  中的只读模板路径。
- `leader/config.toml` 中的 `acs_json = "atr/acs.json"` 与 `[mtls]` 相对路径默认都相对于安装目录下的
  `leader/` 运行时副本解析。

### 4.3. 证书获取与启动方式

`demo-leader` 的部署态至少需要有效的 `leader/atr/acs.json.aic`，以及一套真实 mTLS 客户端证书：

- `leader/atr/client.pem`
- `leader/atr/client.key`
- `leader/atr/trust-bundle.pem`

也就是说，生产部署时不能只解压运行包并填写 `.env` 就直接启动；需要先借助 `acps-cli` 走
“注册 -> 审批 -> EAB -> 发证”流程。

#### 4.3.1. 第一步：通过 demo-leader bootstrap 申请并落盘证书

这一步默认假定 `acps-cli` 已经作为独立工具完成安装与配置，并且当前生效配置已经指向目标
`registry-server` 与 `ca-server`；只有在需要临时覆盖现有配置时，才额外传 `--config PATH`。

与 `registry-server` / `mq-auth-server` 的静态 bootstrap 不同，`demo-leader` 模式会直接读取并回写
安装目录下的 `leader/atr/acs.json`。如果本机还能访问 `demo-partner` 的安装目录，bootstrap 还会把
`leader/scenario/expert/tour/china_hotel.json` 与 `china_transport.json` 整文件同步成 `demo-partner`
对应的静态 ACS，从而避免 group 模式因旧 AIC 打到死队列；因此 `acps-cli` 必须与 `demo-leader`
运行目录位于同一台机器，或至少能够直接访问该安装目录。

```bash
cd /opt/acps-cli
bash scripts/bootstrap.sh demo-leader \
  --config ./acps-cli.toml \
  --install-dir /opt/demo-leader \
  --partner-install-dir /opt/demo-partner
```

补充说明：

- 若未显式提供凭据，脚本会交互式提示输入普通用户和管理员账号密码。
- 脚本会对 `/opt/demo-leader/leader/atr/acs.json` 执行保存、提交、审批和发证流程。
- 审批完成后，脚本会把返回的 `aic` 回写到 `leader/atr/acs.json`，再把 `client.pem`、`client.key`、
  `trust-bundle.pem` 直接写入同目录。
- 如果 `demo-partner` 运行目录可访问，脚本会把 `leader/scenario/expert/tour/china_hotel.json` 和
  `china_transport.json` 同步为 `demo-partner` 的对应 ACS；也可以显式通过 `--partner-install-dir`
  指定来源目录。
- 默认汇总目录是 `/opt/demo-leader/bootstrap-artifacts/`；其中 `demo-leader/summary.json` 会记录 AIC 与文件路径。

#### 4.3.2. 第二步：为业务 smoke 准备 demo-partner 与 discovery 数据

如果你只需要基础 smoke，可以直接进入下一步。若要执行 `demo-leader` 自带的业务 smoke，则还需要先按
`demo-partner` README 第 4 章部署并 bootstrap 可用的 `demo-partner` 运行实例，然后在 `Leader` 开始依赖
`discovery-server` 做搜索前，先显式做一次 discovery 同步与可见性校验。

推荐顺序：

```bash
cd /opt/acps-cli
acps-cli --config ./acps-cli.toml admin discovery run-sync

# 对 /opt/demo-partner/partners/online/*/acs.json 中的每个 aic 重复执行，
# 直到 result.acsMap 中能命中对应 Partner；若未命中，则再次 run-sync 后重试。
acps-cli --config ./acps-cli.toml discover query \
  --type filtered \
  --filter-json '{"conditions":[{"field":"aic","op":"eq","value":"<partner-aic>"},{"field":"active","op":"eq","value":true}]}'
```

补充说明：

- `admin discovery run-sync` 不支持 `--json`；`discover query` 默认直接输出 JSON，也不需要额外追加 `--json`。
- 不要把自然语言 query 当作 readiness gate；结构化 `filtered` query 更稳定。
- 只有在目标 Partner 已经被 `discovery-server` 返回后，再去执行 `group` / 搜索相关业务烟测，才能避免
  因 Registry -> Discovery 同步延迟导致的伪失败。

#### 4.3.3. 第三步：启动并验证

依赖服务、`.env`、`leader/config.toml`、`leader/atr/` 和 `demo-partner` discovery 可见性都准备好之后，
就可以直接启动。

```bash
cd /opt/demo-leader

# 终端 1：启动 Leader API
bash scripts/start-leader-api.sh

# 终端 2：启动 Web UI
bash scripts/start-web-ui.sh
```

基础 smoke：

```bash
cd /opt/demo-leader
bash scripts/smoke-test.sh
```

业务 smoke：

```bash
cd /opt/demo-leader
bash scripts/smoke-test-business.sh
```

补充说明：

- `scripts/start-leader-api.sh` 会自动解析已安装的 `leader` wheel 包路径，并把它加入 `PYTHONPATH`，以兼容现有
  `assistant.*` 顶层导入。
- `scripts/start-web-ui.sh` 与 `web_app.webserver` 会显式优先使用安装目录下的 `web_app/` 运行时副本。
- `scripts/smoke-test.sh` 只覆盖两个基础端点：`Web UI` 根路径和 `Leader API` 直接健康检查路径。
- `scripts/smoke-test-business.sh` 只聚焦 `demo-leader` 自身 API 的 happy-path：`direct_rpc` 与 `group`。
- wheel 通用包中的业务 smoke 不包含 `core_services.py` 和 `aip_v210_audit.py`。

### 4.4. systemd 安装与启停

在验证双进程可以独立执行，并且基础 smoke / 业务 smoke 都通过后，就可以按下面的步骤把它安装成两个
systemd 服务。

运行包根目录提供了两个 unit 模板：`demo-leader-api.service` 和 `demo-leader-web.service`。它们默认假定
部署目录为 `/opt/demo-leader`；如果你的部署目录不同，请先修改 `WorkingDirectory` 和 `ExecStart`。

```bash
cd /opt/demo-leader

# 可选：先检查并按需修改 unit 中的 WorkingDirectory / ExecStart
vi demo-leader-api.service
vi demo-leader-web.service

sudo cp demo-leader-api.service /etc/systemd/system/demo-leader-api.service
sudo cp demo-leader-web.service /etc/systemd/system/demo-leader-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now demo-leader-api demo-leader-web
```

说明：

- 当前 unit 不使用 `EnvironmentFile=`，因为项目 `.env` 使用 dotenv 语法；应用会在 `WorkingDirectory` 下自行读取 `.env`。
- Web UI unit 只负责静态页面服务；Leader API unit 负责后端编排与业务入口。两者是两个独立进程，不应被文档伪装成单进程应用。
- 如果需要使用专用系统用户运行，请先创建用户，再取消注释 unit 文件中的 `User=` 和 `Group=`。

常用命令：

```bash
sudo systemctl status demo-leader-api
sudo systemctl status demo-leader-web
sudo systemctl restart demo-leader-api
sudo systemctl restart demo-leader-web
sudo journalctl -u demo-leader-api -f
sudo journalctl -u demo-leader-web -f
```
