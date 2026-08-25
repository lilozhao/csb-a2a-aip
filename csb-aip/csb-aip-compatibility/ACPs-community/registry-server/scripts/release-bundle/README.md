# 部署指南

## 发布包结构

```
registry-server-release-{VERSION}/
├── VERSION                     # 版本信息（version, sha, build_date, image）
├── images.tar.gz               # Docker 镜像（应用 + postgres + nginx）
├── checksums.txt               # 发布包文件 SHA-256 校验清单
├── .env.example                # 环境变量模板
├── compose.yml                 # Docker Compose 编排
├── deploy.sh                   # 部署脚本（入口）
├── smoke-test.sh               # 冒烟测试脚本
├── README.md                   # 本文档
├── alembic.ini                 # 数据库迁移配置
├── alembic/                    # 迁移脚本
└── nginx/
    ├── conf.d/
    │   └── registry.conf       # Nginx 主配置
    └── includes/
        └── upstream.conf       # Upstream 配置（由 deploy.sh 自动管理）
```

## 部署流程（首次部署 + 版本更新）

`deploy.sh` 自动检测部署模式：

- **首次部署**：启动 postgres → 执行数据库迁移 → 启动应用
- **版本更新**：导入新镜像 → 数据库迁移 → 蓝绿切换 → 停旧应用
- **回滚**：切换回上一个版本（仅限版本更新场景）

### 第 1 步：解压发布包

```bash
tar xzf registry-server-release-{VERSION}.tar.gz
cd registry-server-release-{VERSION}
```

解压后建议先验证发布包完整性：

```bash
sha256sum -c checksums.txt
```

### 第 2 步：准备环境变量

**首次部署 — 新建 .env：**

```bash
cp .env.example .env
chmod 600 .env
```

在标准 same-host 验证场景下，可直接执行 `bash deploy.sh`，无需再编辑 `.env`：

- `CA_SERVER_BASE_URL` 已默认对齐同机 `ca-server` release-bundle 的 `9003` 服务根地址；不要在这里额外追加 `/acps-atr-v2`
- `SECRET_KEY` 若仍为占位值，`deploy.sh` 会在首次部署时自动生成随机密钥并写回 `.env`
- `AIC_CRC_SALT` 若仍为占位值，`deploy.sh` 也会在首次部署时自动生成并写回 `.env`

如果用于正式环境，或你使用自定义域名、端口、数据库密码，再显式确认以下变量：

| 变量                     | 说明                                |
| ------------------------ | ----------------------------------- |
| `POSTGRES_INIT_PASSWORD` | PostgreSQL 密码                     |
| `DATABASE_URL`           | 数据库连接串                        |
| `SECRET_KEY`             | 应用密钥                            |
| `AIC_CRC_SALT`           | AIC CRC 计算盐                      |
| `NGINX_PORT`             | Nginx 对外端口                      |
| `CA_SERVER_BASE_URL`     | CA Server 服务根地址（不是 ATR 根） |

默认 `.env.example` 已对齐同机 `ca-server` release-bundle 的默认端口 `9003`，并且示例值固定为 CA 服务根地址。只有在你改动端口、域名或拓扑时才需要调整 `CA_SERVER_BASE_URL`。

**版本更新 — 迁移旧 .env：**

```bash
cp ../registry-server-release-{OLD_VERSION}/.env .env
diff ../registry-server-release-{OLD_VERSION}/.env.example .env.example
```

如有新增变量，补充到 `.env` 中。

### 第 3 步：执行部署

```bash
bash deploy.sh
```

脚本自动完成：

**首次部署时：**

- 导入 Docker 镜像
- 启动 postgres + nginx
- 执行数据库迁移
- 启动应用（registry-server-blue）
- 运行冒烟测试

**版本更新时：**

- 导入新版 Docker 镜像
- 执行数据库迁移（如有变化）
- 检测当前活跃应用颜色（蓝/绿）
- 启动对侧应用
- 健康检查通过后自动切换流量
- 停止旧应用
- 运行冒烟测试

默认对外入口：

- `http://localhost:${NGINX_PORT:-9001}/docs`
- `http://localhost:${NGINX_PORT:-9001}/api/...`
- `http://localhost:${NGINX_PORT:-9001}/acps-atr-v2/...`
- `http://localhost:${NGINX_PORT:-9001}/acps-dsp-v2/...`

## 回滚（版本更新场景）

```bash
bash deploy.sh --rollback
```

回滚会直接重新启用上一颜色的旧容器并切回流量，不会通过 `docker compose up` 重新创建该容器。因此请不要在确认新版本稳定前手动删除旧颜色容器。

## 日常运维

### 查看当前活跃应用

优先在 nginx 容器内查看（推荐，作为最终判据）：

```bash
docker exec registry-release-bundle-nginx-1 cat /etc/nginx/includes/upstream.conf
```

宿主机目录中的文件可作为辅助排查：

```bash
cat nginx/includes/upstream.conf
```

> 升级后若宿主机目录与容器内显示不一致，请以 deploy 日志和容器内文件为准。

蓝绿应用的 Compose 服务名和 Docker 容器名统一为：`registry-server-blue` / `registry-server-green`。

### 查看日志

```bash
docker compose logs -f registry-server-blue
docker compose logs -f registry-server-green
docker compose logs -f nginx
docker compose logs -f postgres
```

### 重启服务

```bash
docker compose restart registry-server-blue
docker compose restart nginx
```

### 手动测试

```bash
bash smoke-test.sh http://localhost
```

### 清理 Docker 环境

`release-bundle` 的设计前提是“单项目单环境”：同一台宿主机上，同一个 `registry-server` release-bundle 部署目录只应保留一套活动实例。当前默认对外端口为 `9001`。

推荐直接执行发布包自带的清理脚本。它会按 Compose 项目标签删除容器、网络、卷，并清理当前项目的应用镜像，再做残留校验。

```bash
bash cleanup-docker-resources.sh
```

如果当前机器存在跨部署模式残留（例如 `*-blue` / `*-green`、`shared-nginx`、`shared-postgres`），建议追加：

```bash
bash cleanup-docker-resources.sh --cleanup-residuals
```

如果要连同上一个测试项目一并清掉，可以追加 `--also-project`：

```bash
bash cleanup-docker-resources.sh --also-project ca-server-release-bundle
```

如果当前环境使用了自定义 Compose 项目名，可以显式传入：

```bash
bash cleanup-docker-resources.sh --project-name registry-release-bundle
```

如果需要把 Docker 恢复到近似刚安装后的干净状态，可以使用全量清理选项：

```bash
bash cleanup-docker-resources.sh --purge-all-docker-resources --confirm-purge
```

这是危险操作，会删除 Docker 中的所有容器、镜像、网络和卷，仅适用于测试机或一次性环境。

脚本执行完成后，建议再做一次目视确认：

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
docker volume ls --format 'table {{.Name}}'
docker network ls --format 'table {{.Name}}'
```

## 注意事项

- `upstream.conf` 由 `deploy.sh` 自动管理，**请勿手动编辑**
- `.env` 文件包含敏感信息，建议设置权限：`chmod 600 .env`
- 版本更新前建议备份当前 `.env` 和数据库
- 首次部署使用 blue，后续更新自动在蓝绿之间切换
- 确认新版本稳定前，不要手动删除旧颜色容器
- 应用容器内部会同时监听 `9001` public listener 与 `9002` mTLS listener；当前 `release-bundle` 仅通过 Nginx 暴露 `9001` 的 HTTP public 平面，如需对外暴露 `9002`，需要在部署层额外提供独立的 TCP/TLS 入口
