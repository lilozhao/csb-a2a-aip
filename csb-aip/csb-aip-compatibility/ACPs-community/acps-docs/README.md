# ACPS Docs

这个目录是 ACPs 项目的参考文档入口，聚合了开发测试、CLI、SDK、基础设施部署与使用指南。

## 目录结构

```text
acps-docs/
|-- getting-started/
|   `-- README.md
|-- tutorials/
|   |-- agent-development.md
|   `-- aip-sdk-tutorial.md
|-- reference/
|   `-- cli-reference.md
|-- development/
|   `-- development-testing-overview.md
|-- deployment-docker/
|   |-- docker-standalone-packaging-guide.md
|   `-- docker-standalone-installation-guide.md
`-- deployment-general/
    |-- general-packaging-deployment-guide.md
    |-- postgresql-native-deployment.md
    |-- rabbitmq-native-deployment.md
    `-- redis-native-deployment.md
```

## 快速导航

### 1 通用指南

- ACPs 快速开始: [getting-started/README.md](getting-started/README.md)
- ACPs AIP 开发教程: [tutorials/agent-development.md](tutorials/agent-development.md)

### 2 CLI 文档

- CLI 参考: [references/cli-reference.md](references/cli-reference.md)

### 3 开发测试文档

- ACPs 开发与测试总览: [development/development-testing-overview.md](development/development-testing-overview.md)

### 4 Docker 单机部署文档

- ACPs Docker 单机部署打包指南: [deployment-docker/docker-standalone-packaging-guide.md](deployment-docker/docker-standalone-packaging-guide.md)
- ACPs Docker 单机部署安装指南: [deployment-docker/docker-standalone-installation-guide.md](deployment-docker/docker-standalone-installation-guide.md)

### 5 SDK 文档

| 文档 | 链接 |
| -- | --- |
| ACPs SDK 智能体身份码 （AIC） | [SDK: AIC DOC](../acps-sdk/acps_sdk/aip/README.md) |
| ACPs SDK 智能体能力描述 （ACS） | [SDK: ACS DOC](../acps-sdk/acps_sdk/acs/README.md) |
| ACPs SDK 智能体发现协议（ADP）| [SDK: ADP DOC](../acps-sdk/acps_sdk/adp/README.md) |
| ACPs 智能体交互协议（AIP） SDK 开发指南 | [tutorials/aip-sdk-tutorial.md](tutorials/aip-sdk-tutorial.md) |

### 6 原生部署说明

## 建议阅读顺序

1. 先阅读 [getting-started/README.md](getting-started/README.md)，判断是开发测试、Docker standalone，还是 wheel/native 部署。

2. 开发 Leader / Partner 时继续阅读 [tutorials/agent-development.md](tutorials/agent-development.md)。

3. 按需查看 [references/cli-reference.md](references/cli-reference.md)

4. 参与开发或测试时参考 [development/development-testing-overview.md](development/development-testing-overview.md)

5. 构建 Docker 单机 standalone 包时参考 [deployment-docker/docker-standalone-packaging-guide.md](deployment-docker/docker-standalone-packaging-guide.md)

6. 安装 Docker 单机 standalone 包时参考 [deployment-docker/docker-standalone-installation-guide.md](deployment-docker/docker-standalone-installation-guide.md)

7. 使用 SDK 时参考
   1. [ACPs SDK 智能体身份码 （AIC）](../acps-sdk/acps_sdk/aip/README.md)  
   2. [ACPs SDK 智能体能力描述 （ACS）](../acps-sdk/acps_sdk/acs/README.md)  
   3. [ACPs SDK 智能体发现协议（ADP）](../acps-sdk/acps_sdk/adp/README.md)  
   4. [ACPs 智能体交互协议（AIP） SDK 开发指南](tutorials/aip-sdk-tutorial.md)

8. 需要原生部署基础设施时参考：
   - ACPs 原生部署说明: [deployment-general/general-packaging-deployment-guide.md](deployment-general/general-packaging-deployment-guide.md)
   - ACPs 环境中 PostgreSQL 部署与配置说明: [deployment-general/postgresql-native-deployment.md](deployment-general/postgresql-native-deployment.md)
   - ACPs 环境中 RabbitMQ 部署与配置说明: [deployment-general/rabbitmq-native-deployment.md](deployment-general/rabbitmq-native-deployment.md)
   - ACPs 环境中 Redis 部署与配置说明: [deployment-general/redis-native-deployment.md](deployment-general/redis-native-deployment.md)
