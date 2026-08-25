# discovery-server

discovery-server 是 ACPs 的发现服务，负责接收自然语言请求、维护本地索引，并基于 DSP 同步结果返回
可用 Agent。本文重点覆盖项目定位、日常开发，以及两类交付路径：与 `acps-infra` 配合的 Docker
`release-app / standalone` 打包，以及不依赖 Docker 的通用 wheel 运行包部署。

## 1. 概述

### 1.1. 项目定位

- 接收自然语言发现请求并返回候选 Agent
- 通过 DSP 与 `registry-server` 保持 ACS 数据同步
- 在本地维护 embedding 索引、可用性状态与可选的 forwarder 逻辑

### 1.2. 项目特点

- 同一套服务同时支持 CPU / GPU 两种运行档位
- 支持样本数据导入，便于单仓验证 discovery 行为
- 详细运行行为与高级开关统一放在 `config/default.toml` 和 `config/{APP_ENV}.toml`

### 1.3. 目录概览

```text
discovery-server/
├── app/                  # discovery / sync / core
├── config/               # TOML 分层配置
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
- 同级目录已存在 `../acps-sdk/`
- 如需导入样本数据，建议同级目录存在 `../demo-partner/`，可选存在 `../demo-leader/`

### 2.2. 快速开始

```bash
git clone <仓库地址>
cd discovery-server

# 虽然 just prep env / just app bootstrap 会在缺失时生成 .env，
# 但仍建议先显式复制模板并检查关键配置。
cp .env.example .env
# 编辑 .env：确认数据库、LLM、embedding 等敏感项

just app bootstrap
just app
```

启动后常用地址：

- API: `http://localhost:9005`
- Docs: `http://localhost:9005/docs`
- Health: `http://localhost:9005/health`

### 2.3. 常用命令

```bash
# 帮助与环境检查
just help                               # 输出命令总览，直接执行 just 也会显示帮助
just doctor                               # 检查 Docker、数据库、配置和 sibling 前置
just infra up postgres                    # 启动 discovery-server 需要的共享依赖
just infra status                         # 查看共享依赖状态

# 环境准备
just prep env                             # 缺失时根据 .env.example 生成 .env
just prep sync                            # 下载 managed Python 3.14，并把依赖同步到 .venv/
just prep hooks                           # 安装/更新 Git hooks
just prep migrate app                     # 迁移开发数据库
just prep migrate test                    # 迁移测试数据库
just prep seed app                        # 向开发库导入样本数据
just prep seed test                       # 向测试库导入样本数据
just prep sync-embedding-dimension app    # 同步开发库 embedding 维度

# 应用
just app bootstrap                        # 一键建立本地开发环境
just app                                  # 快速后台启动服务（等价于 just app start）
just app start                            # 后台启动服务
just app start fg                         # 前台启动，便于调试
just app logs follow                      # 持续跟踪日志
just app stop                             # 停止本地实例

# 测试
just test bootstrap                       # 准备测试环境
just test unit                            # 单元测试
just test integration                     # 集成测试
just test e2e                             # 黑盒 e2e
just test coverage                        # 覆盖率报告
just test                                 # 默认执行 all，依次执行 unit / integration / e2e

# 质量
just qa                                   # 默认执行 all，先 fix，再跑 pre-commit
just qa full                              # 只读质量门禁
just qa type-app                          # 业务代码 mypy
just qa type-tests                        # 测试代码 mypy
just qa type-strict-coverage              # strict mypy 覆盖率检查
just qa audit                             # 依赖漏洞审计

# 打包
just package wheel                        # 构建在线运行包
just package wheel offline                # 构建离线运行包
```

### 2.4. 开发说明

- 项目运行所需 Python 不依赖本机预装版本；`just prep sync` 会通过 `uv` 下载 managed Python 3.14，
  并把依赖安装到当前项目的 `.venv/`。
- `DISCOVERY_MODE` 控制运行时档位；CPU 使用远端 embedding API，GPU 使用本地模型路径。
- `DISCOVERY_BUILD_PROFILE` 只影响 Docker `release-app` 构建时的依赖档位；真正的运行模式仍由
  `config/{APP_ENV}.toml` 中的 `[discovery].mode` 或环境变量 `DISCOVERY_MODE` 决定。
- `just prep seed app` / `just prep seed test` 会读取 sibling `demo-partner`，并按需读取
  `demo-leader` 的 ACS JSON 生成样本数据。
- 配置项较多的运行行为说明，例如 forwarder、polling、secondary instance 和详细接口边界，统一以
  `config/default.toml` 与对应环境 TOML 为准，根 README 不再重复展开。
- 真实跨服务联调仍应转到 `acps-cli/tests/e2e/`；本仓测试主要覆盖 `discovery-server` 自身边界。

## 3. Docker 交付（release-app / standalone）

`discovery-server` 自己提供的 Docker 交付入口是 `scripts/release-app/build-app-bundle.sh`。它会构建应用镜像，
并生成一个离线 app-only bundle，供 `stage-infra` 或 standalone 顶层装配复用。

```bash
bash scripts/release-app/build-app-bundle.sh
```

打包说明：

- 这是一个离线 app-only 包，产物输出到 `dist/`，文件名形如 `discovery-server-app-{version}.tar.gz`。
- bundle 内包含 `images.tar.gz`、`deploy.sh`、compose 文件、`.env.example`、`VERSION`、`checksums.txt` 等发布元数据。
- `images.tar.gz` 中已经包含 `discovery-server` 应用镜像，因此镜像内的 Python 运行时和应用依赖也随包离线交付，不需要目标机再在线拉取 Python 包。
- `DISCOVERY_BUILD_PROFILE` 是构建期变量，用于选择 CPU / GPU 依赖档位；如需 GPU 版镜像，可执行 `DISCOVERY_BUILD_PROFILE=gpu bash scripts/release-app/build-app-bundle.sh`。

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
# 编辑 .env：填写 LLM 密钥、密码、端口、模型路径、公开地址等运行参数
bash install.sh
```

部署说明：

- `install.sh` 会先校验 `manifest.toml` 和 `checksums.txt`，再依次解压并部署 `stage-infra`、`registry-server`、`ca-server`、`discovery-server`、`mq-auth-server`、`demo-partner`、`demo-leader`。
- `install.sh` 默认会继续执行各个应用的健康检查和业务 smoke 测试；对 `discovery-server` 来说，后续还会进入 `provision` 的 DSP 同步和查询验证流程。
- standalone 包不会替你准备 GPU 驱动、本地 embedding 模型目录或外部 polling 服务；这些仍然需要按部署侧环境准备。

单机 standalone 场景下的更多详细信息，比如环境变量、模型材料、provision 流程和升级行为，以兄弟仓库 `acps-infra/README.md` 与 `acps-infra/scripts/release-standalone/README.md` 为准。

## 4. 通用打包与部署

`discovery-server` 也可以完全不依赖 Docker 和 `acps-infra`，直接以 Python wheel 运行包交付到一般环境。而用于部署的发布物不能只有 `.whl`，还必须同时带上运行时 TOML 配置、Alembic 迁移脚本、prompt 文件和环境变量模板。由于本项目依赖 sibling `acps-sdk`，运行包还会把对应的 `acps-sdk` wheel 一并收进去。仓库已经把这套流程收敛为统一的 `just package wheel` 命令。

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
git clone <discovery-server 仓库地址>
git clone <acps-sdk 仓库地址>
```

执行打包：

```bash
cd ~/acps-build/discovery-server
just package wheel
just package wheel offline
```

打包说明：

- `dist/discovery-server-wheel-{version}-{platform}.tar.gz` 是在线运行包。
- `dist/discovery-server-wheel-offline-{version}-{platform}.tar.gz` 是离线运行包。
- 文件名中的 `{platform}` 表示目标部署平台：默认使用当前构建机平台；如果显式传入 `--pip-platform`，则使用该值。
- 两种运行包都会包含以下运行时必需文件和目录：
  - `dist/`：包含当前版本的应用 wheel 文件，以及随包交付的 `acps-sdk` wheel。
  - `config/`：运行时 TOML 配置目录。
  - `alembic/`：数据库迁移脚本目录。
  - `alembic.ini`：Alembic 配置文件。
  - `.env.example`：环境变量模板。
  - `README.md`：随包交付的部署说明文档。
  - `requirements-runtime.txt`：运行时依赖清单。
  - `checksums.txt`：运行包内容校验清单。
  - `scripts/prompts/`：默认 planner / cluster prompt 文件。
  - `scripts/smoke-test.sh`：运行包目录内可直接执行的基础冒烟脚本。
  - `discovery-server.service`：systemd unit 模板。
- 离线运行包还会额外包含：
  - `wheelhouse/`：预下载的 Python 运行时依赖 wheel 目录，用于离线安装；其中也会包含运行包自带的 `acps-sdk` wheel。

```bash
just package wheel offline \
  --pip-platform manylinux2014_x86_64 \
  --pip-platform manylinux_2_28_x86_64 \
  --pip-implementation cp \
  --pip-abi cp314
```

离线包说明：

- 这里的“离线”仅指应用本体和运行时依赖已随包提供；它不包括 Python 本身。
- PostgreSQL、registry-server、polling 服务、GPU 驱动、本地 embedding 模型目录，以及 `acps-infra` 的其它组件都不在该包内。
- `just package wheel offline` 默认按当前构建机平台下载 wheel；如果目标机平台不同，请显式传入 `--pip-platform`、`--pip-implementation` 和 `--pip-abi`。
- `--pip-platform` 可重复传入。对 Linux 目标来说，部分依赖会同时使用 `manylinux2014` 与更新的 `manylinux_2_28` 标签；例如 x86_64 目标通常应同时传 `manylinux2014_x86_64` 与 `manylinux_2_28_x86_64`。
- discovery 当前依赖集中包含 `cbor` 这类需要现编 wheel 的包；因此“未指定 `--pip-platform` 的当前平台离线构建”可以由脚本在本机直接补齐 wheel，但如果显式指定了外部目标平台，而该平台又没有现成二进制 wheel，就需要改到匹配目标平台的构建机或容器内执行打包。
- 常用的 `--pip-platform` 有：
  - `manylinux2014_x86_64`：适用于大多数 x86_64 Linux 发行版。
  - `manylinux_2_28_x86_64`：适用于发布新一代 Linux wheel 标签的 x86_64 依赖。
  - `manylinux2014_aarch64`：适用于大多数 aarch64 Linux 发行版。
  - `macosx_11_0_arm64`：适用于 macOS Big Sur 及以上的 Apple Silicon。
- `--pip-implementation` 和 `--pip-abi` 的值需要与目标机 Python 版本匹配，例如 Python 3.14 对应 `cp` 和 `cp314`。

### 4.2. 目标机部署

原生部署前请自行准备以下前置条件；这些能力不再由 Docker 或 `acps-infra` 代管。

基础服务前置条件：

- `PostgreSQL`：建议使用 PostgreSQL 17，并为 `discovery-server` 单独准备数据库和用户。与 `registry-server`、`ca-server` 不同，`discovery-server` 的目标库必须启用 `vector` / pgvector 扩展；shared `dev-infra` 的初始化脚本会自动为 discovery 开发/测试库补齐该扩展，独立部署环境则仍需由管理员预先执行 `CREATE EXTENSION vector`。
- `模型与推理依赖`：CPU 模式需要外部 embedding API 与 Discovery LLM；GPU 模式需要本地模型目录、设备配置和 GPU 运行时。

如果目标机尚未安装 Python 3.14，可以用 `uv` 命令或者其它方式安装 Python 3.14。命令：`uv python install 3.14 --install-dir /opt/uv-python --no-bin` 会把 Python 3.14 安装到 `/opt/uv-python/`，但不创建全局可执行链接；这样对目标机系统环境影响更小，也避免了与系统 Python 的版本冲突。

```bash
mkdir -p /opt/discovery-server
cd /opt/discovery-server
tar xzf discovery-server-wheel-offline-{version}-{platform}.tar.gz

# 注意：压缩包会解出一层同名根目录，后续命令应进入该目录执行
cd discovery-server-wheel-offline-{version}-{platform}

# 创建虚拟环境；python 3.14 的路径根据实际安装位置调整
/opt/uv-python/cpython-3.14.x-<platform>/bin/python3.14 -m venv .venv

# 在线安装：同一条命令同时安装锁定的运行时依赖和随包 wheel
.venv/bin/python -m pip install \
  -r requirements-runtime.txt \
  dist/acps_sdk-*.whl \
  dist/discovery_server-{version}-py3-none-any.whl

# 如果目标机无法访问公网，则改用下面这组离线安装命令；不要与上面的在线命令重复执行

# 离线安装：同一条命令同时安装锁定的运行时依赖和随包 wheel
.venv/bin/python -m pip install \
  --no-index \
  --find-links wheelhouse \
  -r requirements-runtime.txt \
  dist/acps_sdk-*.whl \
  dist/discovery_server-{version}-py3-none-any.whl

# 拷贝环境变量模板
cp .env.example .env
# 编辑 .env，设置环境变量；至少确认 APP_ENV、DATABASE_URL、DSP_WEBHOOK_SECRET、LLM/Embedding API Key 等敏感项
# 再按 APP_ENV 编辑对应 TOML（通常是 config/production.toml），补齐非敏感业务配置；
# 至少确认 [discovery]、[embedding.cpu] 或 [embedding.gpu]、[llm.discovery]、[dsp]、[dsp.webhook]、[polling]，以及按需启用 [forwarder]

# 执行数据库迁移
.venv/bin/python -m alembic upgrade head
```

模式选择与切换：

| 项目           | CPU 模式                                                                                                                                                                                     | GPU 模式                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 开关           | `config/{APP_ENV}.toml` 中 `[discovery].mode = "cpu"`，或用 `DISCOVERY_MODE=cpu` 覆盖                                                                                                        | `config/{APP_ENV}.toml` 中 `[discovery].mode = "gpu"`，或用 `DISCOVERY_MODE=gpu` 覆盖                                                                                  |
| Embedding 来源 | 远端 OpenAI 兼容 Embedding API                                                                                                                                                               | 本地 embedding 模型                                                                                                                                                    |
| 必填项         | `[embedding].dimension` 或 `EMBEDDING_DIM`；`EMBEDDING_API_KEY`；`EMBEDDING_BASE_URL`；`EMBEDDING_MODEL_NAME`；`DISCOVERY_LLM_API_KEY`；`DISCOVERY_LLM_BASE_URL`；`DISCOVERY_LLM_MODEL_NAME` | `[embedding].dimension` 或 `EMBEDDING_DIM`；`EMBEDDING_MODEL_PATH`；`EMBEDDING_DEVICES`；`DISCOVERY_LLM_API_KEY`；`DISCOVERY_LLM_BASE_URL`；`DISCOVERY_LLM_MODEL_NAME` |
| 可选项         | 无额外必需项                                                                                                                                                                                 | `RERANKER_URL`；留空时跳过 reranker 步骤                                                                                                                               |
| 默认示例       | `text-embedding-3-small` 通常对应 `EMBEDDING_DIM=1536`                                                                                                                                       | 仓库默认示例模型为 `BAAI/bge-m3`，默认 `dimension=1024`                                                                                                                |
| 功能差异       | 支持标准发现与 trending，不支持 exploratory 查询                                                                                                                                             | 支持标准发现、trending 与 exploratory 查询                                                                                                                             |

部署说明：

- 如果用 `source .venv/bin/activate` 激活虚拟环境；命令行中的 `.venv/bin/python` 可简化为 `python`。
- 如果离线运行包中的 `wheelhouse/` 与目标机平台不匹配，请回到构建机重新执行 `just package wheel offline ...`。
- `.env` 中的 `APP_ENV` 决定加载哪个 `config/{APP_ENV}.toml`；生产环境通常应设置为 `production`。如果只是本机结合 shared `dev-infra` 验证运行包链路，也可以先保留 `development`，对应修改 `config/development.toml`。
- 如果目标数据库尚未启用 `vector` 扩展，请先用具备足够权限的 PostgreSQL 管理账号执行 `CREATE EXTENSION IF NOT EXISTS vector`；`discovery-server` 运行用户通常不具备创建扩展的权限。仓库内的 `just prep migrate app/test` 会优先使用 `DATABASE_ADMIN_URL` / `TEST_DATABASE_ADMIN_URL`（未设置时回退到 shared `dev-infra` 默认 `postgres:devpass`）自动补齐该扩展；如果你的目标环境不允许这样做，仍需提前由管理员完成扩展创建。
- 不要只修改 `.env` 就继续部署；在确定 `APP_ENV` 后，应立即检查并编辑 `config/{APP_ENV}.toml`。对 `discovery-server` 来说，至少要确认 `[discovery]` 运行模式、embedding/LLM 地址、DSP 上游地址、webhook 回调地址和 polling 服务地址是否已经与目标环境一致。
- CPU/GPU 两种模式都需要 `llm.discovery` 的三项配置；差别主要在 embedding 侧，而不是 Discovery LLM 侧。
- `EMBEDDING_BASE_URL` 和 `DISCOVERY_LLM_BASE_URL` 都应填写 API 根路径，例如 `https://api.openai.com/v1` 或 `https://dashscope.aliyuncs.com/compatible-mode/v1`；不要写成 `/chat/completions` 之类的资源级完整 URL。
- `EMBEDDING_DEVICES` 支持逗号分隔多个设备；首装时通常先从单卡或单设备开始验证，再扩展到多设备配置。
- CPU/GPU 模式切换或更换 embedding 模型时，必须同时核对 `[embedding].dimension` 或 `EMBEDDING_DIM` 是否与新模型输出维度一致；例如 `text-embedding-3-small` 通常为 `1536`，默认 `BAAI/bge-m3` 为 `1024`。
- 如果切换后 embedding 维度发生变化，请在 `alembic upgrade head` 之后、服务启动之前执行 `python scripts/maintenance/sync_embedding_dimension.py --force-clear`；该脚本会在调整 `skills.embedding` 列定义前清空本地 `agents`/`skills` 数据。
- 如果只是更换 embedding 模型但维度未变，也应视为“旧向量失效”：已有本地向量仍处于旧模型的向量空间，不能直接与新模型产生的查询向量混用。此时应主动清空本地同步数据，并触发一次 full snapshot 重建；可调用 `/admin/dsp/hard-reset`，或自行清空本地数据后再重置 DSP 同步状态。
- `release-app` 的 `deploy.sh` 会在发现维度不一致时自动清空本地数据并调整向量列定义；手工 wheel 部署不会自动做这一步，运维侧需要显式执行。
- GPU 模式下运行包不会附带本地 embedding 模型文件，也不会处理 CUDA / 驱动安装；部署前请先准备 `[embedding.gpu].model_path` 指向的模型目录和目标机 GPU 运行时。
- `config/{APP_ENV}.toml` 中的 `[dsp].base_url`、`[dsp.webhook].receive_url`、`[polling].server_url`、`[forwarder].server_url` 现在遵循统一规则：留空表示禁用对应功能；非空时只要求是绝对 `http(s)` URL，允许使用 `localhost` 等本机地址。

### 4.3. 启动方式

数据库迁移完成后，就可以直接启动。

```bash
.venv/bin/python -m app.main
```

运行说明：

- 启动端口来自 `config/{APP_ENV}.toml` 中的 `[server].port`，默认是 `9005`。
- `discovery-server` 会在启动阶段尝试初始化语义匹配器、DSP 同步、polling 和可选的 forwarder 健康检查；即使上游 registry、polling 服务或本地模型暂时不可用，进程通常仍可启动，但这些子服务的降级状态会反映在根探针返回体的 `runtime` 字段、`/acps-adp-v2/health`、`/admin/dsp/status` 和日志中。
- 第一阶段至少先确认 `/health`、`/ready`、`/acps-adp-v2/health` 和 `/admin/dsp/status` 可达。

可以直接使用仓库自带的 smoke test 脚本做基础验证：

```bash
bash scripts/smoke-test.sh http://127.0.0.1:9005
```

补充说明：

- 这条命令只依赖本机已启动的 `discovery-server` 和已经迁移好的数据库；即使数据库里还没有任何同步数据，也可以完成基础探针与状态端点的连通性验证。
- 如需验证 DSP 同步触发、discover 查询等业务链路，请统一在 `acps-cli` 运行包执行跨服务业务烟测：`bash scripts/smoke-test-business.sh --config ./acps-cli.toml --bootstrap-dir ./bootstrap-artifacts`。

### 4.4. systemd 安装与启停

在验证应用可以执行，并且 `9005` 能正常提供服务后，就可以按照下面的步骤把它安装成 systemd 服务了。

使用运行包根目录中的 `discovery-server.service` unit 文件安装成 systemd 服务。该 unit 默认假定部署目录为 `/opt/discovery-server`；如果你的部署目录不同，请先修改 `WorkingDirectory` 和 `ExecStart`。

```bash
cd /opt/discovery-server

# 可选：先检查并按需修改 unit 中的 WorkingDirectory / ExecStart
vi discovery-server.service

sudo cp discovery-server.service /etc/systemd/system/discovery-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now discovery-server
```

说明：

- 当前 unit 不使用 `EnvironmentFile=`，因为项目 `.env` 使用 dotenv 语法并带有行内注释；应用会在 `WorkingDirectory` 下自行读取 `.env`。
- 启动前请确认部署目录中的 `.env` 已设置好 `APP_ENV`、数据库连接、DSP webhook secret 和 LLM/Embedding API key；非敏感的运行模式、上游地址和 prompt 路径默认应在 `config/{APP_ENV}.toml` 中维护。
- 如需以专用系统用户运行，请先创建用户，再取消注释 unit 文件中的 `User=` 和 `Group=`。

常用命令：

```bash
sudo systemctl status discovery-server
sudo systemctl restart discovery-server
sudo systemctl stop discovery-server
sudo systemctl disable discovery-server
sudo journalctl -u discovery-server -f
```
