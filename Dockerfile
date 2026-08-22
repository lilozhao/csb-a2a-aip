# CSB A2A Server — 容器镜像
# 用法：在 csb-a2a-aip 代码仓库根目录构建（本文件由 csb-starter-kit 提供）
#
# 一个镜像，两种角色（用 command 区分）：
#   - A2A Server : node server_v5.js     （默认，端口 3100）
#   - 本地注册表  : node start-registry.js （端口 3099）
#
# 安全设计：镜像只打包代码，不打包身份。
# identity.json（含 LLM 密钥）通过 docker-compose 卷挂载注入，永不进镜像。
#
# CSB-Security 集成（2026-08-22）:
#   csb-a2a-aip 通过 file:../csb-security 引用安全库（optionalDependencies，缺失时降级 legacy）
#   构建时需把 csb-security 一并 COPY 进镜像（从 workspace 根目录构建）:
#     docker build -f csb-a2a-aip/Dockerfile .
#   详见 docs/UPGRADE-SECURITY-INTEGRATION.md

FROM node:20-alpine

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

# 再复制代码（含 csb-security，若在构建上下文内）
COPY . .
COPY csb-security /app/csb-security 2>/dev/null || true

ENV NODE_ENV=production

EXPOSE 3100 3099

CMD ["node", "server_v5.js"]
