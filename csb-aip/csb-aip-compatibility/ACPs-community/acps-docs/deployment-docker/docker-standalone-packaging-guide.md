# ACPs Docker 单机部署打包指南

本文是 ACPs 基于 Docker 的单机 standalone 离线包打包说明。Docker 单机部署的打包说明只在本文维护，各项目仓库不再重复描述打包流程。

本文只覆盖打包阶段：构建机前置条件、打包命令、构建参数、产物结构和打包边界。目标机安装、升级、证书 provision 和业务烟测属于部署阶段，不在本文展开。

## 1. 打包目标

Docker 单机部署包用于在同一台目标机上交付一套完整 ACPs demo 系统。最终产物位于 `acps-infra/dist/`，文件名形如：

```text
acps-demo-standalone-{version}-{platform}.tar
```

该 tar 包是完整离线包，内部包含基础设施和应用服务所需的 Docker 镜像、Compose 编排、安装脚本、升级脚本、配置模板和元数据。普通使用者只需要拿到这个顶层 tar 包，不需要理解或操作各项目的中间 bundle。

当前完整包包含 7 个组件：

| 组件 | 来源项目 | 内容 |
| --- | --- | --- |
| `acps-stage-infra` | `acps-infra` | nginx、PostgreSQL、Redis、RabbitMQ 等 stage 基础设施 |
| `registry-server-app` | `registry-server` | Registry 应用镜像和部署材料 |
| `ca-server-app` | `ca-server` | CA 应用镜像和部署材料 |
| `discovery-server-app` | `discovery-server` | Discovery 应用镜像和部署材料 |
| `mq-auth-server-app` | `mq-auth-server` | MQ Auth 应用镜像和部署材料 |
| `demo-partner` | `demo-partner` | Partner Agents 应用镜像和部署材料 |
| `demo-leader` | `demo-leader` | Leader API、Web UI 应用镜像和部署材料 |

## 2. 工作区要求

打包需要在包含所有同级项目的工作区中执行。目录布局应保持如下结构：

```text
acps/
  acps-infra/
  registry-server/
  ca-server/
  discovery-server/
  mq-auth-server/
  demo-partner/
  demo-leader/
  acps-cli/
  acps-sdk/
```

构建机需要具备：

- Docker daemon 可用。
- Docker Buildx 可用。
- `docker`、`uv`、`openssl`、`python3` 命令可用。
- 上述同级项目目录齐备。

打包脚本开始实际构建前会执行前置检查。检查内容包括同级项目是否完整、Dockerfile 是否存在、打包脚本是否存在、工具链是否可用、Docker daemon 是否运行、Docker Buildx 是否可用、共享脚本是否一致，以及各应用项目的打包接口是否满足顶层脚本要求。

## 3. 打包命令

进入 `acps-infra` 仓库执行顶层打包脚本：

```bash
cd acps-infra
bash scripts/release-standalone/build.sh 2.1.0
```

版本号是可选参数。如果不传版本号，脚本会使用当前时间戳作为版本：

```bash
cd acps-infra
bash scripts/release-standalone/build.sh
```

版本号会写入最终 tar 包名称、各组件包名称、`VERSION`、`manifest.toml` 和 `version-matrix.toml`。正式交付时应显式传入版本号，保证产物可追踪。

打包完成后，产物输出到：

```text
acps-infra/dist/
```

文件名示例：

```text
acps-demo-standalone-2.1.0-linux-amd64.tar
acps-demo-standalone-2.1.0-linux-arm64.tar
```

## 4. 构建参数

### 4.1. 目标平台

默认会分别构建两个平台：

```text
linux/arm64
linux/amd64
```

通过 `PLATFORMS` 可以限制目标平台：

```bash
PLATFORMS=linux/amd64 bash scripts/release-standalone/build.sh 2.1.0
```

`PLATFORMS` 支持逗号分隔：

```bash
PLATFORMS=linux/amd64,linux/arm64 bash scripts/release-standalone/build.sh 2.1.0
```

打包过程中，顶层脚本会把当前平台写入 `DOCKER_PLATFORM`，并传递给各组件镜像构建过程。

### 4.2. Discovery 构建档位

`discovery-server` 支持 CPU / GPU 两种构建档位，由 `DISCOVERY_BUILD_PROFILE` 控制：

```bash
DISCOVERY_BUILD_PROFILE=gpu bash scripts/release-standalone/build.sh 2.1.0
```

取值说明：

| 值 | 说明 |
| --- | --- |
| `cpu` | 默认值，使用较轻的 CPU 构建依赖清单 |
| `gpu` | 包含本地模型推理相关依赖，适合需要 GPU 版 Discovery 镜像的交付 |

`DISCOVERY_BUILD_PROFILE` 是构建期变量，只影响镜像里安装的依赖。目标机实际以 CPU 还是 GPU 模式运行，由部署阶段的 `DISCOVERY_MODE` 和模型相关配置决定。

平台和 Discovery 构建档位可以同时指定：

```bash
PLATFORMS=linux/amd64 DISCOVERY_BUILD_PROFILE=gpu \
  bash scripts/release-standalone/build.sh 2.1.0
```

## 5. 构建流程

对每个目标平台，顶层打包脚本会执行以下流程：

1. 设置当前目标平台。
2. 运行打包前置检查。
3. 构建 `acps-stage-infra` 基础设施离线包。
4. 调用各应用项目的打包脚本构建应用镜像和组件包。
5. 收集所有组件包到 standalone 产物目录的 `bundles/`。
6. 复制顶层安装脚本、升级脚本、证书 provision 脚本、配置模板和必要库文件。
7. 生成 `VERSION`、`manifest.toml`、`version-matrix.toml` 和 `checksums.txt`。
8. 打出最终 `acps-demo-standalone-{version}-{platform}.tar`。

任一组件构建失败，顶层打包都会失败，不会生成可交付的完整 standalone 包。

## 6. 产物结构

最终 tar 包解压后的顶层结构如下：

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
| `.env.example` | 目标机顶层配置模板 |
| `VERSION` | 记录版本、平台和构建时间 |
| `manifest.toml` | 记录组件包、来源项目、源码 commit 和 SHA256 |
| `version-matrix.toml` | 记录组件包、镜像、镜像 digest 和元数据文件 |
| `checksums.txt` | 顶层文件校验和 |
| `install.sh` | 目标机首次安装入口 |
| `upgrade.sh` | same-host 原地升级入口 |
| `provision-*.py` | 安装期证书申请与分发脚本 |

目标机安装或升级时会校验 `manifest.toml` 和 `checksums.txt`。因此不要手工修改解压后的组件包、元数据或校验文件。

## 7. 打包边界

打包产物包含镜像、脚本、配置模板和元数据，但不包含以下运行期敏感材料：

- 正式证书和私钥。
- LLM API key。
- 数据库、Redis、RabbitMQ 密码的最终取值。
- 目标机运行目录中的持久化数据。
- GPU 驱动、本地模型目录和外部 polling 服务。

这些内容在目标机部署阶段通过顶层 `.env`、证书 provision 流程、宿主机路径或外部服务配置提供。

还需要注意：

- `registry-server:9002` 的 mTLS 证书不在构建期准备，部署阶段会先部署 `9001`，再申请证书并启用 `9002`。
- `ca-server` 的正式 CA 材料不在构建包内，部署阶段可选择自动生成验证用 CA，或显式提供正式 CA 材料来源。
- `mq-auth-server`、RabbitMQ、Redis 相关证书由部署阶段的 provision 流程准备。
- `demo-partner` 和 `demo-leader` 的部署态证书也由部署阶段准备。
