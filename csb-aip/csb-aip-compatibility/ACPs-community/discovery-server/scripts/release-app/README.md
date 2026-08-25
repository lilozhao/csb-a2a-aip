# 部署指南（discovery-server release-app）

`release-app` 用于在 stage-infra 架构下只交付 `discovery-server` 应用镜像，依赖外部已部署的 `stage-nginx` 与 `stage-postgres`。

## 前置条件

1. stage-infra 已部署完成
2. `stage-nginx`、`stage-postgres` 正在运行
3. 推荐采用 sibling 目录布局：`../stage-infra` 与当前应用目录同级；此时无需显式设置 `STAGE_INFRA_DIR`
4. 对外路径前缀使用 `/discovery`
5. `acps-sdk` 与本项目保持 sibling 目录布局，供构建镜像时注入 `--build-context acps_sdk=../acps-sdk`

## 构建离线包

```bash
bash scripts/release-app/build-app-bundle.sh
```

如在 Apple Silicon 上构建，仍建议显式设置：

```bash
DOCKER_PLATFORM=linux/arm64 bash scripts/release-app/build-app-bundle.sh
```

脚本参数：

- 位置参数 `VERSION`：可选，显式指定发布版本号；未提供时默认使用当前时间戳
- `--dry-run`：仅做输入校验并打印将要生成的镜像名、包内容和版本信息，不执行实际构建
- `--result-file <path>`：输出一份 shell 风格的构建结果元数据，便于 CI、上层打包脚本或 standalone 组装逻辑复用
- `-h` / `--help`：打印用法

构建相关环境变量：

- `DOCKER_PLATFORM`：目标镜像平台；Apple Silicon 上建议显式设为 `linux/arm64`
- `DISCOVERY_BUILD_PROFILE`：依赖档位，支持 `cpu` 和 `gpu`，默认值为 `cpu`

其中：

- `cpu`：使用 `cpu-build-manifest` 独立依赖清单，适合 release-app / standalone 交付，镜像体积更小
- `gpu`：使用项目主依赖清单，会包含本地模型推理相关重依赖，只有确实需要时才建议使用

常见示例：

```bash
# 默认 cpu 档位 + 自动时间戳版本
DOCKER_PLATFORM=linux/arm64 bash scripts/release-app/build-app-bundle.sh

# 指定版本号
DOCKER_PLATFORM=linux/arm64 bash scripts/release-app/build-app-bundle.sh 20260509212816

# dry-run 预检查
DOCKER_PLATFORM=linux/arm64 bash scripts/release-app/build-app-bundle.sh --dry-run 20260509212816

# 生成结果元数据文件
DOCKER_PLATFORM=linux/arm64 bash scripts/release-app/build-app-bundle.sh \
	--result-file /tmp/discovery-release.env \
	20260509212816

# 明确切换到 gpu 依赖档位
DOCKER_PLATFORM=linux/arm64 DISCOVERY_BUILD_PROFILE=gpu \
	bash scripts/release-app/build-app-bundle.sh 20260509212816
```

## 首次部署

```bash
tar xzf discovery-server-app-{VERSION}.tar.gz
cd discovery-server-app-{VERSION}
cp .env.example .env
# 默认示例已对齐同机 stage-infra + registry-server release-app，可直接部署。
# 若 polling / forwarder / 模型路径不在同机，请按实际环境修改 .env。
bash deploy.sh
```

如果当前目录不是与 `stage-infra/` 同级，而是保留了解压后的版本号目录名，再显式传入：

```bash
STAGE_INFRA_DIR=/path/to/acps-stage-infra-{VERSION} bash deploy.sh
```

默认对外入口：`http://localhost:9000/discovery`

## 配置文件

发布包会携带 `config/` 目录，部署时由 `compose.yml` 只读挂载到容器内 `/app/config`。因此，部署态 TOML 配置应在宿主机发布目录中编辑。这里的 `bash deploy.sh` 不只是“部署新版本”，也用于在配置变更后重启应用并加载新的 TOML 配置，例如：

```bash
vi config/production.toml
# 重新执行 deploy.sh，让 discovery-server 重启并加载新的 TOML 配置。
bash deploy.sh
```

容器根文件系统保持只读；不要通过 `docker exec` 进入容器修改 `/app/config`。需要调整非敏感 TOML 配置时，编辑宿主机侧 `config/{APP_ENV}.toml` 后重新执行 `bash deploy.sh`，由蓝绿切换让新配置生效。

## 版本更新

```bash
bash deploy.sh
```

部署脚本会执行蓝绿切换，在 `discovery-server-blue` 和 `discovery-server-green` 之间切流；更新前会先执行 `alembic upgrade head`。

## 回滚

```bash
bash deploy.sh --rollback
```

## 最终清理

验证结束后建议执行以下清理，确保不残留应用容器、卷和 stage 路由文件：

```bash
docker compose -f compose.yml down -v
rm -f ../stage-infra/nginx/conf.d/apps/discovery.conf
docker exec stage-nginx nginx -s reload
```

如果当前目录不是与 `stage-infra` 同级，请将路径替换为实际的 `STAGE_INFRA_DIR`。

可选残留检查：

```bash
docker ps -a --format '{{.Names}}\t{{.Status}}' | grep -E '^discovery-server-(blue|green)$|discovery-release-app' || true
docker network ls --format '{{.Name}}' | grep -E '^discovery-release-app' || true
docker volume ls --format '{{.Name}}' | grep -E '^discovery' || true
```

## 路由模式

stage-nginx 会写入 `discovery.conf` 路由片段，外部访问统一走 `/discovery` 前缀，例如：

- `http://host/discovery/health`
- `http://host/discovery/docs`
- `http://host/discovery/api/v1/discovery/search`

其中路由暴露策略为：

- 公开健康端点：`/discovery/health`
- 仅限内网：`/discovery/ready`、`/discovery/metrics`
- 其他 `/discovery/*` 路径统一转发到应用容器 `9005`

开发与测试仍优先复用 `acps-infra/dev-infra/compose.yml`；本目录只服务于 stage-infra release-app 发布。
