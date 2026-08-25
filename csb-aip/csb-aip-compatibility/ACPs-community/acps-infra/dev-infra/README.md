# dev-infra

`dev-infra` 是 ACPs 多项目共享的本地开发依赖集合。日常开发通过 [dev-infra.sh](./dev-infra.sh) 管理底层 [compose.yml](./compose.yml) 中的服务，而不是直接手写 `docker compose` 命令。

## 目标

- 统一 `registry-server`、`ca-server`、`discovery-server`、`acps-cli` 等项目的共享依赖入口
- 对外只暴露稳定的 service 名，不暴露 `profile` 之类的 Compose 实现细节
- 把“启动 / 状态 / 等待 / 日志 / 重建 / 诊断”收敛到一个脚本里

## 公开 service

| 公开 service | Compose service | 容器名         | 默认端口        | volume                    | 说明                       |
| ------------ | --------------- | -------------- | --------------- | ------------------------- | -------------------------- |
| `postgres`   | `dev-postgres`  | `dev-postgres` | `5432`          | `dev-infra_dev-pgdata`    | 默认依赖，含开发库与测试库 |
| `redis`      | `dev-redis`     | `dev-redis`    | `6379`          | `dev-infra_dev-redisdata` | 可选依赖                   |
| `rabbitmq`   | `dev-rabbitmq`  | `dev-rabbitmq` | `5672`, `15672` | `dev-infra_dev-mqdata`    | 可选依赖                   |
| `gateway`    | `dev-nginx`     | `dev-nginx`    | `9000`          | 无                        | 开发网关                   |

兼容旧写法：

- `dev-postgres`
- `dev-redis`
- `dev-rabbitmq`
- `dev-nginx`

脚本仍接受旧名称，但会输出弃用提示；新文档和项目级入口统一使用 `postgres`、`redis`、`rabbitmq`、`gateway`。

## 快速开始

```bash
# 检查 Docker / Compose / compose.yml / service 映射
./dev-infra.sh doctor

# 启动默认依赖（postgres）
./dev-infra.sh up

# 查看全部服务状态
./dev-infra.sh status

# 启动额外依赖
./dev-infra.sh up redis rabbitmq

# 等待就绪
./dev-infra.sh wait postgres rabbitmq

# 查看日志
./dev-infra.sh logs postgres rabbitmq --follow

# 停止整个 dev-infra
./dev-infra.sh down
```

## 命令说明

### `doctor`

检查运行前置条件：

- `docker` 是否可用
- `docker compose` 是否可用
- `compose.yml` 是否可解析
- 顶层 project name 是否与脚本常量一致
- service 和 volume 映射是否完整
- 外部网络 `acps-dev-net` 是否存在

示例：

```bash
./dev-infra.sh doctor
```

### `up [service ...]`

启动指定服务；不传 service 时默认启动 `postgres`。

示例：

```bash
./dev-infra.sh up
./dev-infra.sh up postgres
./dev-infra.sh up postgres rabbitmq
```

说明：

- 首次启动会自动创建外部网络 `acps-dev-net`
- `up` 只负责提交启动命令；需要等待健康检查时，再执行 `wait`

### `down`

停止整个 `dev-infra` compose 项目，保留 volume。

示例：

```bash
./dev-infra.sh down
```

说明：

- 这是共享依赖的整体关闭操作，会影响所有正在使用 `dev-infra` 的本地项目
- 默认不删除 volume，不会清空数据库或消息数据

### `status [service ...]`

输出静态定义和动态状态。

示例：

```bash
./dev-infra.sh status
./dev-infra.sh status postgres rabbitmq
```

输出内容包括：

- 公开 service 名
- Compose service 名
- 容器名
- 端口映射
- volume 名
- 当前状态和健康状态
- 服务说明

如果 Docker daemon 当前不可访问，`status` 会退化为静态视图，并把动态字段标成 `unavailable`。

### `wait [service ...]`

等待服务就绪。

示例：

```bash
./dev-infra.sh wait
./dev-infra.sh wait postgres
./dev-infra.sh wait postgres rabbitmq
```

说明：

- 不传 service 时，默认等待当前已创建的服务容器
- 对带 healthcheck 的服务，等待 `healthy`
- 对无 healthcheck 的服务，等待 `running`

### `logs [service ...] [--tail N] [--since DURATION] [--follow]`

查看日志，支持单服务、多服务和跟随模式。

示例：

```bash
./dev-infra.sh logs
./dev-infra.sh logs postgres
./dev-infra.sh logs postgres rabbitmq --tail 300
./dev-infra.sh logs rabbitmq --since 10m --follow
```

说明：

- 默认输出最近 `200` 行
- 默认不阻塞；只有加 `--follow` 才持续跟随
- 不传 service 时，默认只输出当前运行中的服务日志
- 如果需要查看已停止容器的日志，请显式指定 service

### `reset [service ...] [--volumes] [--yes]`

做修复性重建或显式数据清理。

示例：

```bash
./dev-infra.sh reset postgres
./dev-infra.sh reset postgres --volumes --yes
./dev-infra.sh reset --volumes --yes
```

说明：

- 不带 `--volumes`：删除容器并重建，保留数据
- 带 `--volumes`：删除对应 volume，下次 `up` 时重建数据
- 全量 `reset` 或任何带 `--volumes` 的操作，都要求显式传 `--yes`
- `gateway` 没有 volume，执行 `reset gateway --volumes --yes` 只会删除容器，不会删除数据卷

## 数据库

`postgres` 启动后会通过 [postgres/init/01-create-databases.sh](./postgres/init/01-create-databases.sh) 初始化开发库和测试库。

为避免将共享 `dev-postgres` 建立在 `pgvector/pgvector:pg17` 这类第三方预构建镜像之上，当前改为基于本地 [postgres/Dockerfile](./postgres/Dockerfile) 构建：底座镜像使用官方 `postgres:17-bookworm`，再通过 Debian 包安装 `postgresql-17-pgvector`。

| 数据库                 | 用户        | 密码        | 用途                    |
| ---------------------- | ----------- | ----------- | ----------------------- |
| `agent_registry`       | `registry`  | `registry`  | registry-server 开发库  |
| `agent_registry_test`  | `registry`  | `registry`  | registry-server 测试库  |
| `agent_ca`             | `ca`        | `ca`        | ca-server 开发库        |
| `agent_ca_test`        | `ca`        | `ca`        | ca-server 测试库        |
| `agent_discovery`      | `discovery` | `discovery` | discovery-server 开发库 |
| `agent_discovery_test` | `discovery` | `discovery` | discovery-server 测试库 |

PostgreSQL superuser 固定为：

- 用户：`postgres`
- 密码：`devpass`

## 底层实现说明

- `dev-infra.sh` 是推荐入口
- [compose.yml](./compose.yml) 是底层实现细节，仍可用于排障和理解编排结构
- 日常开发文档和项目级 `Justfile` 不再直接暴露 `profile` 或 `dev-*` service 名
