# ca-server release-app

`release-app` 用于在 stage-infra 架构下只交付 `ca-server` 应用镜像，依赖外部已部署的 `stage-nginx` 与 `stage-postgres`。

## 前置条件

1. stage-infra 已部署完成
2. `stage-nginx`、`stage-postgres` 正在运行
3. 推荐采用 sibling 目录布局：`../stage-infra` 与当前应用目录同级；此时无需显式设置 `STAGE_INFRA_DIR`
4. 对外路径前缀使用 `/ca-server`

## 构建离线包

```bash
bash scripts/release-app/build-app-bundle.sh
```

## 首次部署

```bash
tar xzf ca-server-app-{VERSION}.tar.gz
cd ca-server-app-{VERSION}
cp .env.example .env
# 默认示例已对齐同机 stage-infra + registry-server/ca-server release-app，可直接部署。
# 若 AUTO_GENERATE_CA_MATERIALS=true 且 certs/ 为空，deploy.sh 会自动生成验证用根 CA。
bash deploy.sh
```

如果当前目录不是与 `stage-infra/` 同级，而是保留了解压后的版本号目录名，再显式传入：

```bash
STAGE_INFRA_DIR=/path/to/acps-stage-infra-{VERSION} bash deploy.sh
```

正式环境仍建议关闭 `AUTO_GENERATE_CA_MATERIALS`、显式提供持久化 CA 根证书，并按需替换数据库密码和正式域名。

默认对外入口：`http://localhost:9000/ca-server`

如果同机部署下的 `acps-cli cert` 访问到的 CA 服务根地址不是 `http://host.docker.internal:9000/ca-server`，通常说明运行中的 `ca-server` `.env` 已偏离默认 same-host 拓扑，或修改 `.env` 后尚未重新执行 `bash deploy.sh` 完成蓝绿切换。

## 配置文件

发布包会携带 `config/` 目录，部署时由 `compose.yml` 只读挂载到容器内 `/app/config`。因此，部署态 TOML 配置应在宿主机发布目录中编辑。这里的 `bash deploy.sh` 不只是“部署新版本”，也用于在配置变更后重启应用并加载新的 TOML 配置，例如：

```bash
vi config/production.toml
# 重新执行 deploy.sh，让 ca-server 重启并加载新的 TOML 配置。
bash deploy.sh
```

容器根文件系统保持只读；不要通过 `docker exec` 进入容器修改 `/app/config`。需要调整非敏感 TOML 配置时，编辑宿主机侧 `config/{APP_ENV}.toml` 后重新执行 `bash deploy.sh`，由蓝绿切换让新配置生效。

## 版本更新

```bash
bash deploy.sh
```

部署脚本会执行蓝绿切换，在 `ca-server-blue` 和 `ca-server-green` 之间切流。

## 回滚

```bash
bash deploy.sh --rollback
```

## 最终清理

验证结束后建议执行以下清理，确保不残留应用容器、卷和 stage 路由文件：

```bash
docker compose -f compose.yml down -v
rm -f ../stage-infra/nginx/conf.d/apps/ca-server.conf
docker exec stage-nginx nginx -s reload
```

如果当前目录不是与 `stage-infra` 同级，请将路径替换为实际的 `STAGE_INFRA_DIR`。

可选残留检查：

```bash
docker ps -a --format '{{.Names}}\t{{.Status}}' | grep -E '^ca-server-(blue|green)$|ca-server-release-app' || true
docker network ls --format '{{.Name}}' | grep -E '^ca-server-release-app' || true
docker volume ls --format '{{.Name}}' | grep -E '^ca-server' || true
```

## 路由模式

stage-nginx 会写入 `ca-server.conf` 路由片段，外部访问统一走 `/ca-server` 前缀，例如：

- `http://host/ca-server/acps-atr-v2/acme/directory`
- `http://host/ca-server/acps-atr-v2/ca/trust-bundle`
- `http://host/ca-server/docs`

其中路由暴露策略为：

- 公开协议端点：`/ca-server/acps-atr-v2/acme*`、`/ca-server/acps-atr-v2/crl*`、`/ca-server/acps-atr-v2/ocsp*`、`/ca-server/acps-atr-v2/ca/trust-bundle`
- 文档端点 `/ca-server/docs`、`/ca-server/redoc`、`/ca-server/openapi.json` 由应用配置 `DOCS_ENABLED` 决定是否返回文档
- 公开健康端点：`/ca-server/health`
- 仅限内网 + 内部服务令牌：`/ca-server/acps-atr-v2/ca/revoke-notify`、`/ca-server/acps-atr-v2/ca/retrieve/*`，请求需携带 `Authorization: Bearer ${CA_SERVER_INTERNAL_API_TOKEN}`
- 仅限内网 + 管理员令牌：`/ca-server/admin/certificates*`，请求需携带 `Authorization: Bearer ${CA_SERVER_ADMIN_API_TOKEN}`
- 其他 `/ca-server/*` 路径默认返回 `404`

应用容器内部监听端口固定为 `9003`。
