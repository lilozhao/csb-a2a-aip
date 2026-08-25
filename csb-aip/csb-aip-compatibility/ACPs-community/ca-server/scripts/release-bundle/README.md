# 部署指南

## 发布包结构

```
ca-server-release-{VERSION}/
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
├── certs/                      # 正式环境可自行准备；same-host 验证可留空由 deploy.sh 自动生成
└── nginx/
    ├── conf.d/
    │   └── ca-server.conf      # Nginx 主配置
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
tar xzf ca-server-release-{VERSION}.tar.gz
cd ca-server-release-{VERSION}
```

解压后建议先验证发布包完整性：

```bash
sha256sum -c checksums.txt
```

### 第 2 步：准备环境变量和证书

**首次部署 — 新建 .env：**

```bash
cp .env.example .env
chmod 600 .env
```

在标准 same-host 验证场景下，可直接执行 `bash deploy.sh`，无需再编辑 `.env` 或预先生成 `certs/`：

- `ACME_DIRECTORY_URL` 与 `REGISTRY_SERVER_URL` 已默认对齐同机 `registry-server` / `ca-server` release-bundle 端口
- 若 `AUTO_GENERATE_CA_MATERIALS=true` 且 `certs/ca.crt`、`certs/ca.key` 缺失，`deploy.sh` 会自动生成自签根 CA

如果用于正式环境，或你使用自定义域名、端口、数据库密码，再显式确认以下变量：

| 变量                         | 说明                        |
| ---------------------------- | --------------------------- |
| `POSTGRES_INIT_PASSWORD`     | PostgreSQL 密码             |
| `DATABASE_URL`               | 数据库连接串                |
| `NGINX_PORT`                 | Nginx 对外端口              |
| `CA_CERT_PATH`               | CA 证书路径                 |
| `CA_KEY_PATH`                | CA 私钥路径                 |
| `AUTO_GENERATE_CA_MATERIALS` | 是否允许自动生成验证用根 CA |

默认 `.env.example` 已对齐同机 `registry-server` release-bundle 的默认端口 `9001`，并将 CA 自身对外 ACME 地址设置为 `9003`。在标准 same-host 组合下无需修改协议相关地址；只有在你改动端口、域名或拓扑时才需要调整。

正式环境建议将 `AUTO_GENERATE_CA_MATERIALS=false`，并显式把 `ca.crt` 和 `ca.key` 放入 `certs/` 目录。

如果你仍希望手工生成自签根 CA，可执行：`openssl req -x509 -newkey rsa:4096 -sha256 -nodes -days 3650 -keyout certs/ca.key -out certs/ca.crt -subj "/C=CN/ST=Beijing/L=Beijing/O=Agent CA/OU=Certificate Authority/CN=Agent CA Root Certificate" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -addext "subjectKeyIdentifier=hash"`

当 `AUTO_GENERATE_CA_MATERIALS=false` 时，`deploy.sh` 会在启动前检查 `certs/` 下是否存在这两个文件；若缺失，会直接失败并给出明确提示，而不会等到冒烟测试阶段才出现 `500`。

**版本更新 — 迁移旧 .env：**

```bash
cp ../ca-server-release-{OLD_VERSION}/.env .env
diff ../ca-server-release-{OLD_VERSION}/.env.example .env.example
mkdir -p certs
```

如有新增变量，补充到 `.env` 中，并确保 `certs/` 目录下仍有可用的 CA 证书和私钥；如果保留 `AUTO_GENERATE_CA_MATERIALS=true`，也可以在删除旧验证证书后让新包自动再生成一次。

### 第 3 步：执行部署

```bash
bash deploy.sh
```

脚本自动完成：

**首次部署时：**

- 导入 Docker 镜像
- 启动 postgres + nginx
- 执行数据库迁移
- 启动应用（ca-server-blue）
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

- `http://localhost:${NGINX_PORT:-9003}/acps-atr-v2/acme/...`
- `http://localhost:${NGINX_PORT:-9003}/acps-atr-v2/crl...`
- `http://localhost:${NGINX_PORT:-9003}/acps-atr-v2/ocsp...`
- `http://localhost:${NGINX_PORT:-9003}/acps-atr-v2/ca/trust-bundle`
- `http://localhost:${NGINX_PORT:-9003}/docs`、`/redoc`、`/openapi.json`（是否可用由 `DOCS_ENABLED` 控制）

默认仅限内网访问：

- `http://localhost:${NGINX_PORT:-9003}/health`
- `http://localhost:${NGINX_PORT:-9003}/acps-atr-v2/ca/revoke-notify`、`/acps-atr-v2/ca/retrieve/...`，请求需携带 `Authorization: Bearer ${CA_SERVER_INTERNAL_API_TOKEN}`
- `http://localhost:${NGINX_PORT:-9003}/admin/certificates...`，请求需携带 `Authorization: Bearer ${CA_SERVER_ADMIN_API_TOKEN}`

其他未显式放行的路径默认返回 `404`。

## 回滚（版本更新场景）

```bash
bash deploy.sh --rollback
```

回滚会直接重新启用上一颜色的旧容器并切回流量，不会通过 `docker compose up` 重新创建该容器。因此请不要在确认新版本稳定前手动删除旧颜色容器。

## 日常运维

### 查看当前活跃应用

优先在 nginx 容器内查看（推荐，作为最终判据）：

```bash
docker exec ca-server-release-bundle-nginx-1 cat /etc/nginx/includes/upstream.conf
```

宿主机目录中的文件可作为辅助排查：

```bash
cat nginx/includes/upstream.conf
```

> 升级后若宿主机目录与容器内显示不一致，请以 deploy 日志和容器内文件为准。

蓝绿应用的 Compose 服务名和 Docker 容器名统一为：`ca-server-blue` / `ca-server-green`。

### 查看日志

```bash
docker compose logs -f ca-server-blue
docker compose logs -f ca-server-green
docker compose logs -f nginx
docker compose logs -f postgres
```

### 重启服务

```bash
docker compose restart ca-server-blue
docker compose restart nginx
```

### 手动测试

```bash
bash smoke-test.sh http://localhost
```

### 清理 Docker 环境

`release-bundle` 的设计前提是“独占环境”：同一台宿主机上，任一时刻只应保留一个对外绑定 `9003` 端口（或你自定义端口）的 ca-server release-bundle 部署。

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
bash cleanup-docker-resources.sh --also-project registry-release-bundle
```

如果当前环境使用了自定义 Compose 项目名，可以显式传入：

```bash
bash cleanup-docker-resources.sh --project-name ca-server-release-bundle
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
- 应用容器内部监听端口固定为 `9003`
- CA 证书通过 `./certs:/app/certs:ro` 挂载，不打包进镜像
