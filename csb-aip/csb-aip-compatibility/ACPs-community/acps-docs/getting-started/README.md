[首页](../README.md)

# ACPs 快速开始

本文是 ACPs 的入口说明，用来帮助你判断自己应该走哪条路径：本地开发测试、Docker 单机 standalone 打包部署，或基于 wheel 包的通用部署。各路径的详细步骤已经拆到独立文档中维护，本文只保留路线和最小命令。

## 1. 先理解三类工作

ACPs 的日常工作可以分成三类：

| 目标 | 适合对象 | 详细文档 |
| --- | --- | --- |
| 本地开发与测试 | 修改服务、SDK、CLI、demo 代码的开发者 | [开发与测试总览](../development/development-testing-overview.md) |
| Docker 单机 standalone 打包与部署 | 需要交付一套同机 Docker 离线包的构建者和部署者 | [Docker 打包指南](../deployment-docker/docker-standalone-packaging-guide.md)、[Docker 安装指南](../deployment-docker/docker-standalone-installation-guide.md) |
| wheel/native 打包与部署 | 不使用 Docker 编排、按运行包部署到普通环境的部署者 | [通用 wheel/native 打包部署总览](../deployment-general/general-packaging-deployment-guide.md) |

如果你只是想开始参与开发，优先读开发测试文档。如果你已经要交付环境，再根据目标部署形态选择 Docker standalone 或 wheel/native 文档。

## 2. 本地开发测试怎么开始

开发者通常需要在同一个工作区中放置多个 ACPs 项目，例如：

```text
acps/
  registry-server/
  ca-server/
  discovery-server/
  mq-auth-server/
  demo-partner/
  demo-leader/
  acps-cli/
  acps-sdk/
  acps-infra/
  acps-docs/
```

多数 Python 服务项目统一使用 `uv` 管理 Python 与依赖，使用 `just` 收口开发、测试、质量检查命令。第一次进入某个服务项目时，一般是：

```bash
cp .env.example .env
# 按项目需要填写数据库、LLM、RabbitMQ、证书等配置

just app bootstrap
just app
```

常用检查与测试命令：

```bash
just doctor
just test unit
just test integration
just test e2e
just qa
```

这些命令在不同项目里的细节略有差异，但整体模型一致：`infra -> prep -> doctor -> app -> test -> qa`。完整解释请看 [开发与测试总览](../development/development-testing-overview.md)。

## 3. Docker 单机 standalone 怎么做

Docker 单机部署面向“把一套完整 demo 系统打成一个离线包，并在同一台目标机上安装”的场景。最终交付物形如：

```text
acps-demo-standalone-{version}-{platform}.tar
```

构建机上进入 `acps-infra` 执行顶层打包脚本：

```bash
cd acps-infra
bash scripts/release-standalone/build.sh 2.1.0
```

目标机上解包、准备顶层 `.env`，再执行安装：

```bash
tar xf acps-demo-standalone-{version}-{platform}.tar
cd acps-demo-standalone-{version}-{platform}
cp .env.example .env
# 编辑 .env
bash install.sh
```

Linux 目标机通常需要：

```bash
sudo bash install.sh
```

Docker standalone 的重要原则是：普通部署者只操作顶层 tar 包、顶层 `.env`、`install.sh` 和 `upgrade.sh`，不进入各组件目录单独部署。打包阶段看 [Docker 打包指南](../deployment-docker/docker-standalone-packaging-guide.md)，安装和升级阶段看 [Docker 安装指南](../deployment-docker/docker-standalone-installation-guide.md)。

## 4. wheel/native 部署怎么做

wheel/native 部署面向“不依赖 Docker 编排、按 Python wheel 运行包和原生基础设施部署”的场景。它通常需要自己准备：

- Python 运行环境
- PostgreSQL
- RabbitMQ
- Redis
- 各服务的 wheel 运行包
- 证书、配置、systemd 或等价进程管理

整体顺序建议从 [通用 wheel/native 打包部署总览](../deployment-general/general-packaging-deployment-guide.md) 开始读。PostgreSQL、RabbitMQ、Redis 的原生安装细节分别在同目录的基础服务文档中维护。

这条路径更适合需要控制目标机进程、基础服务和网络策略的部署环境；如果只是快速交付一套同机 demo 系统，优先考虑 Docker standalone。

## 5. 开发智能体从哪里继续

环境准备好之后，如果你的目标是开发 Leader / Partner 智能体，请继续阅读 [AIP 开发教程](../tutorials/agent-development.md)。

新版教程只讲代码和协议理解，不再重复开发环境搭建、打包、部署步骤。环境、测试和部署问题分别回到本文上面的三类文档中查。
