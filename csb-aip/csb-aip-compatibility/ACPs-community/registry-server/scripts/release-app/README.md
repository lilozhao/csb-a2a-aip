# 部署指南（registry-server release-app）

`release-app` 用于在 stage-infra 架构下只交付应用镜像，依赖外部已部署的 `stage-nginx` 与 `stage-postgres`。

## 前置条件

1. stage-infra 已部署完成
2. `stage-nginx`、`stage-postgres` 正在运行
3. 推荐采用 sibling 目录布局：`../stage-infra` 与当前应用目录同级；此时无需显式设置 `STAGE_INFRA_DIR`
4. 对外URL路径前缀使用 `/registry`
5. 准备 `REGISTRY_CERTS_HOST_DIR` 宿主机目录；若暂不启用 `9002`，可以先为空目录

## 构建离线包

```bash
bash scripts/release-app/build-app-bundle.sh
```

## 首次部署

```bash
tar xzf registry-server-app-{VERSION}.tar.gz
cd registry-server-app-{VERSION}
cp .env.example .env
# 在标准 same-host 验证场景下，.env.example 可直接使用。
# 若 SECRET_KEY 保持占位值，deploy.sh 会在首次部署时自动生成并写回 .env。
# 若 AIC_CRC_SALT 保持占位值，deploy.sh 也会在首次部署时自动生成并写回 .env。
# `.env.example` 默认保持 `REGISTRY_SERVER_ENABLE_MTLS_LISTENER=false`，先收敛 public plane。
# 按目标环境编辑 config/{APP_ENV}.toml；该目录会只读挂载到容器内 /app/config。
bash deploy.sh
```

如果当前目录不是与 `stage-infra/` 同级，而是保留了解压后的版本号目录名，再显式传入：

```bash
STAGE_INFRA_DIR=/path/to/acps-stage-infra-{VERSION} bash deploy.sh
```

正式环境仍建议显式设置 `SECRET_KEY`、`AIC_CRC_SALT`、数据库密码和自定义域名。

默认对外入口：`http://localhost:9000/registry`

## 配置文件

发布包会携带 `config/` 目录，部署时由 `compose.yml` 只读挂载到容器内 `/app/config`。因此，部署态 TOML 配置应在宿主机发布目录中编辑。这里的 `bash deploy.sh` 不只是“部署新版本”，也用于在配置变更后重启应用并加载新的 TOML 配置，例如：

```bash
vi config/production.toml
# 重新执行 deploy.sh，让 registry-server 重启并加载新的 TOML 配置。
bash deploy.sh
```

容器根文件系统保持只读；不要通过 `docker exec` 进入容器修改 `/app/config`。需要调整非敏感 TOML 配置时，编辑宿主机侧 `config/{APP_ENV}.toml` 后重新执行 `bash deploy.sh`，由蓝绿切换让新配置生效。

## 9002 mTLS listener

`9002` 不经过 `stage-nginx`，而是以独立宿主机端口直出。release-app 的约定如下：

1. `REGISTRY_CERTS_HOST_DIR` 对应的宿主机目录会整体只读挂载到容器内 `/certs`
2. `REGISTRY_SERVER_ENABLE_MTLS_LISTENER=false` 时，仅部署 public plane；此时证书目录可以为空目录
3. `REGISTRY_SERVER_ENABLE_MTLS_LISTENER=true` 时，deploy.sh 会强制校验下列文件已经存在：
   - `/certs/server.pem`
   - `/certs/server.key`
   - `/certs/trust-bundle.pem`
   - `/certs/probe-client.pem`
   - `/certs/probe-client.key`
4. `REGISTRY_SERVER_MTLS_PORT` 同时控制容器内监听端口和宿主机发布端口，默认值为 `9002`

推荐的宿主机证书布局：

```text
${REGISTRY_CERTS_HOST_DIR}/
	server.pem
	server.key
	trust-bundle.pem
	probe-client.pem
	probe-client.key
```

当启用 `9002` 后，部署脚本会为避免宿主机端口冲突而先停止当前活跃颜色，再启动新颜色。这意味着 `9002` 不具备与 `9001` 相同的零停机切换语义；这是当前发布模型的已知取舍。

## 版本更新

```bash
bash deploy.sh
```

部署脚本会执行蓝绿切换，在 `registry-server-blue` 和 `registry-server-green` 之间切流。

## 回滚

```bash
bash deploy.sh --rollback
```

## 最终清理

验证结束后建议执行以下清理，确保不残留应用容器、卷和 stage 路由文件：

```bash
docker compose -f compose.yml down -v
rm -f ../stage-infra/nginx/conf.d/apps/registry.conf
docker exec stage-nginx nginx -s reload
```

如果当前目录不是与 `stage-infra` 同级，请将路径替换为实际的 `STAGE_INFRA_DIR`。

可选残留检查：

```bash
docker ps -a --format '{{.Names}}\t{{.Status}}' | grep -E '^registry-server-(blue|green)$|registry-release-app' || true
docker network ls --format '{{.Name}}' | grep -E '^registry-release-app' || true
docker volume ls --format '{{.Name}}' | grep -E '^registry' || true
```

## 路由模式

stage-nginx 会写入 `registry.conf` 路由片段，外部访问统一走 `/registry` 前缀，例如：

- `http://host/registry/api/auth/login`
- `http://host/registry/docs`
- `http://host/registry/health`（健康检查，公开）

如后续启用 `/registry/ready`、`/registry/metrics`，仍保持仅限内网访问。

应用容器内部会同时监听 `9001` public listener 与 `9002` mTLS listener。`9001` 继续由 stage-nginx 管理，`9002` 则在启用时直接发布宿主机端口。
