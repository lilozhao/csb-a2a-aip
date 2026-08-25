# demo-leader Release Scripts

本目录为 **demo-leader** 容器化部署脚本。

## 目录结构

```
scripts/release-app/
├── build-app-bundle.sh   # 构建镜像并打包发布 bundle
├── compose.yml           # 运行时 Docker Compose（leader + web-nginx）
├── deploy.sh             # 部署/更新脚本
├── nginx/
│   └── default.conf      # Nginx 反向代理配置
├── .env.example          # 环境变量示例（复制为 .env 后填写）
└── README.md             # 本文档
```

## 快速开始

### 1. 构建发布 Bundle

```bash
# 在项目根目录执行，VERSION 可选（默认时间戳）
bash scripts/release-app/build-app-bundle.sh [VERSION]

# 输出：dist/demo-leader-<VERSION>.tar.gz
```

### 2. 部署

```bash
# 解压 bundle 到目标服务器
tar xzf demo-leader-<VERSION>.tar.gz
cd demo-leader-<VERSION>

# 复制并配置 .env
cp .env.example .env
vi .env   # 填写 LLM API key 等必填项

# 准备 leader/config.toml、leader/atr/、leader/scenario/（参见 leader/README.md）
# 发布 bundle 不包含本地开发证书、私钥或 trust bundle；部署前需把正式证书材料放到 leader/atr/ 下

# 部署
bash deploy.sh
```

### 3. 更新部署

```bash
bash deploy.sh --force-recreate
```

## 端口说明

| 端口 | 服务       | 说明               |
| ---- | ---------- | ------------------ |
| 9010 | web-nginx  | Web UI（外部访问） |
| 9011 | leader API | 仅内部网络访问     |

## 冒烟测试

```bash
bash smoke-test.sh
```
