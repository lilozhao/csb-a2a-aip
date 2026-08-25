# mq-auth-server 部署指南

本目录用于打包和部署 mq-auth-server 镜像。它依赖 `stage-infra` 提供的共享 RabbitMQ 和 Redis。

## 前置条件

1. 已完成 `acps-infra/stage-infra/` 的部署
2. `stage-rabbitmq`、`stage-redis` 容器正在运行
3. 已在宿主机准备专用证书目录，并通过 `CERTS_HOST_DIR` 指向它
4. 服务端 mTLS 证书和健康检查客户端证书均已签发并放入该目录

## 构建离线包

```bash
bash scripts/release-app/build-app-bundle.sh
```

## 首次部署

```bash
tar xzf mq-auth-server-app-{VERSION}.tar.gz
cd mq-auth-server-app-{VERSION}
cp .env.example .env
# 编辑 .env，填写 CERTS_HOST_DIR、RABBITMQ_MGMT_PASS，以及 /certs/... 形式的证书路径
bash deploy.sh
```

## 配置文件

发布包会携带 `config/` 目录，部署时由 `compose.yml` 只读挂载到容器内 `/app/config`。因此，部署态 TOML 配置应在宿主机发布目录中编辑。这里的 `bash deploy.sh` 不只是“部署新版本”，也用于在配置变更后重启应用并加载新的 TOML 配置，例如：

```bash
vi config/production.toml
# 重新执行 deploy.sh，让 mq-auth-server 重启并加载新的 TOML 配置。
bash deploy.sh
```

容器根文件系统保持只读；不要通过 `docker exec` 进入容器修改 `/app/config`。需要调整非敏感 TOML 配置时，编辑宿主机侧 `config/{APP_ENV}.toml` 后重新执行 `bash deploy.sh`，由蓝绿切换让新配置生效。

## 健康检查

- 容器健康检查通过 `python -m app.core.health_probe --url https://localhost:9007/health` 执行
- health probe 走 HTTPS + mTLS，不再使用明文 HTTP
- `APP_ENV=development` 时，若未显式配置 `HEALTHCHECK_TLS_CERT_FILE` / `HEALTHCHECK_TLS_KEY_FILE`，探针默认使用自动生成的开发 Leader 证书
- `APP_ENV=testing` / `production` 时，必须显式配置 `HEALTHCHECK_TLS_CERT_FILE` / `HEALTHCHECK_TLS_KEY_FILE`

## 证书发放与挂载约定

发布侧固定采用“宿主机目录只读挂载到容器内 `/certs`”的方式：

```text
宿主机: ${CERTS_HOST_DIR}/
	server.pem
	server.key
	acps-root-ca.pem
	client.pem
	client.key

容器内: /certs/
	server.pem
	server.key
	acps-root-ca.pem
	client.pem
	client.key
```

约定说明：

- `CERTS_HOST_DIR` 是宿主机上的真实证书目录，`compose.yml` 会将其只读挂载到容器内 `/certs`
- `TLS_CERT_FILE` / `TLS_KEY_FILE` / `TLS_CA_CERT_FILE` 必须使用容器内路径（如 `/certs/server.pem`）
- `HEALTHCHECK_TLS_CERT_FILE` / `HEALTHCHECK_TLS_KEY_FILE` / `HEALTHCHECK_TLS_CA_CERT_FILE` 也必须使用容器内路径
- `deploy.sh` 会在启动前校验证书目录和所有必需文件，缺失时直接失败
- `smoke-test.sh` 在宿主机执行时，会自动把容器内 `/certs/...` 路径映射回 `${CERTS_HOST_DIR}/...`

推荐的健康检查客户端证书发放规则：

- 用途：仅用于 `/health` / `/ready` 探针和部署后冒烟测试，不参与业务 API 调用
- 签发者：与服务端信任链一致的 ACPs CA
- Extended Key Usage：`clientAuth`
- 推荐 CN：`mq-auth-server-healthcheck`
- 权限建议：证书目录 `700`，私钥文件 `600`

## 版本更新

```bash
bash deploy.sh
```

## 回滚

```bash
bash deploy.sh --rollback
```

## 端口说明

- `9007`：Group API（群组 ACL 管理，mTLS）
- `9008`：Auth API（RabbitMQ HTTP auth backend，mTLS）
