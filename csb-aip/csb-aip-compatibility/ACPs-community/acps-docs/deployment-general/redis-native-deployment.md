# Redis 7 原生部署指南（Ubuntu 22 / RHEL 9）

本文把 ACPs 在非 Docker 环境下对 Redis 的要求展开写清楚，重点覆盖 `mq-auth-server` 所依赖的密码保护、AOF 持久化、TLS-only 监听和缓存淘汰策略。

本文主要服务以下场景：

- `mq-auth-server` 的原生 wheel 部署
- 任何需要复用 `stage-infra` Redis 合同的本机或小规模部署

## 1. 与 acps-infra 对齐的合同

`acps-infra/stage-infra/compose.yml` 当前给 Redis 配的是这组关键参数：

- Redis 7
- `appendonly yes`
- `maxmemory 256mb`
- `maxmemory-policy allkeys-lru`
- `requirepass <password>`
- `tls-port 6379`
- `port 0`
- `tls-auth-clients optional`

也就是说，Docker 版默认是“只开 TLS 端口，不开明文端口”。原生部署建议默认也按这个思路来做。

## 2. 部署前准备

开始前先准备：

- 一套 Redis 服务端证书：`redis-server.pem`、`redis-server.key`
- 对应根 CA：`acps-root-ca.pem`
- 一条高强度 Redis 密码
- 规划好 Redis 监听地址，是只给本机用，还是开放给内网其它主机

如果 `mq-auth-server` 和 Redis 同机部署，最安全的方式通常是只监听本机地址；如果跨主机部署，再按实际内网地址开放。

## 3. Ubuntu 22 安装步骤

Redis 官方 Linux 安装文档给出的 Ubuntu 路径如下：

```bash
sudo apt-get install -y lsb-release curl gpg
curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
sudo chmod 644 /usr/share/keyrings/redis-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/redis.list
sudo apt-get update
sudo apt-get install -y redis
```

启动并设为开机自启：

```bash
sudo systemctl enable redis-server
sudo systemctl start redis-server
sudo systemctl status redis-server
```

## 4. RHEL 9 安装步骤

Redis 官方 Linux 安装文档给出的 Red Hat / Rocky 路径比较简单：

```bash
sudo yum install -y redis
sudo systemctl enable redis
sudo systemctl start redis
sudo systemctl status redis
```

安装后立刻确认版本：

```bash
redis-server --version
```

如果你装出来的不是 Redis 7，或者后面验证发现当前二进制不支持 TLS，请不要直接继续部署 `mq-auth-server`，而是改走本文最后的“TLS / 版本兜底”章节。

## 5. 准备证书目录

示例目录使用 `/etc/redis/certs`：

```bash
sudo mkdir -p /etc/redis/certs
sudo chown -R redis:redis /etc/redis/certs
sudo chmod 750 /etc/redis/certs
```

复制以下文件：

- `/etc/redis/certs/acps-root-ca.pem`
- `/etc/redis/certs/redis-server.pem`
- `/etc/redis/certs/redis-server.key`

再收紧权限：

```bash
sudo chown redis:redis /etc/redis/certs/*
sudo chmod 640 /etc/redis/certs/*.key
sudo chmod 644 /etc/redis/certs/*.pem
```

## 6. 写入与 stage-infra 对齐的 Redis 配置

常见配置文件路径通常是 `/etc/redis/redis.conf`。建议先备份：

```bash
sudo cp /etc/redis/redis.conf /etc/redis/redis.conf.bak.$(date +%Y%m%d%H%M%S)
```

然后至少把下面这些参数改成与你环境一致的值：

```conf
bind 127.0.0.1 10.10.0.20
protected-mode yes

port 0
tls-port 6379
tls-cert-file /etc/redis/certs/redis-server.pem
tls-key-file /etc/redis/certs/redis-server.key
tls-ca-cert-file /etc/redis/certs/acps-root-ca.pem
tls-auth-clients optional

appendonly yes
maxmemory 256mb
maxmemory-policy allkeys-lru
requirepass replace-strong-redis-password
```

说明如下：

- `bind`：请写成本机实际需要监听的地址，不建议直接用 `0.0.0.0`。
- `port 0`：关闭明文端口，只保留 TLS 端口。
- `tls-auth-clients optional`：与 stage-infra 默认值一致，客户端不强制提供证书，但服务端仍然使用 TLS。
- `appendonly yes`：与 Docker 版保持一致，避免 ACL 状态只存在内存里。
- `requirepass`：`mq-auth-server` 直接依赖这条密码。

改完以后重启服务。

Ubuntu 22：

```bash
sudo systemctl restart redis-server
```

RHEL 9：

```bash
sudo systemctl restart redis
```

## 7. 验证步骤

### 7.1. 验证服务状态

Ubuntu 22：

```bash
sudo systemctl status redis-server
```

RHEL 9：

```bash
sudo systemctl status redis
```

### 7.2. 验证 TLS 连接

```bash
REDISCLI_AUTH='replace-strong-redis-password' \
redis-cli --tls --cacert /etc/redis/certs/acps-root-ca.pem ping
```

返回 `PONG` 才算通过。

### 7.3. 验证 AOF、内存策略和密码已生效

```bash
REDISCLI_AUTH='replace-strong-redis-password' \
redis-cli --tls --cacert /etc/redis/certs/acps-root-ca.pem CONFIG GET appendonly

REDISCLI_AUTH='replace-strong-redis-password' \
redis-cli --tls --cacert /etc/redis/certs/acps-root-ca.pem CONFIG GET maxmemory-policy

REDISCLI_AUTH='replace-strong-redis-password' \
redis-cli --tls --cacert /etc/redis/certs/acps-root-ca.pem INFO persistence | grep aof_enabled
```

你应该至少看到：

- `appendonly` 对应 `yes`
- `maxmemory-policy` 对应 `allkeys-lru`
- `aof_enabled:1`

## 8. 与 `mq-auth-server` 的对接提醒

Redis 准备完成后，`mq-auth-server` 侧至少要同步这些配置：

- 如果 Redis 采用本文默认的 TLS-only 方案，`.env` 中的 `REDIS_URL` 应写成 `rediss://:<password>@<host>:6379/0`
- `REDIS_TLS_CA_CERT` 指向对应 CA 文件
- 如果你改成了明文 Redis，就必须把 `REDIS_URL` 改回 `redis://...`，并把 `REDIS_TLS_CA_CERT` 置空

换句话说，Redis 的部署方式和 `mq-auth-server` 的环境变量必须成对调整，不能只改一边。

## 9. TLS / 版本兜底方案

如果你在 RHEL 9 上通过系统包安装后，发现以下任一问题：

- 版本不是 Redis 7
- 二进制不支持 TLS

可以改走 Redis 官方源码安装路径。Redis 官方文档给出的最小命令是：

```bash
wget https://download.redis.io/redis-stable.tar.gz
tar -xzvf redis-stable.tar.gz
cd redis-stable
make BUILD_TLS=yes
sudo make install
```

对应的常见依赖包：

Ubuntu 22：

```bash
sudo apt-get install -y build-essential tcl libssl-dev
```

RHEL 9：

```bash
sudo dnf groupinstall -y "Development Tools"
sudo dnf install -y openssl-devel tcl
```

源码安装更灵活，但也意味着 systemd service、日志轮转和目录权限需要你自己再补一层封装。对一般用户来说，优先选择能直接满足 Redis 7 + TLS 的发行版包方案更省心。

## 10. 常见坑

- `redis-cli ping` 能通，不代表 TLS 配置是对的。`mq-auth-server` 真正会用的是 `rediss://` 链路。
- 只开了 `tls-port 6379`，但没把 `port 0` 关掉，结果以为自己是 TLS-only，实际上明文端口还在。
- 改完 `redis.conf` 没重启服务，是最常见的“为什么还是旧配置”的原因。
- `mq-auth-server` 的 `REDIS_URL` 与 Redis 实际部署方式不匹配，会直接表现为启动失败或 readiness 失败。

## 11. 官方参考

- Redis Linux 安装页：`https://redis.io/docs/latest/operate/oss_and_stack/install/archive/install-redis/install-redis-on-linux/`
- Redis 源码安装页：`https://redis.io/docs/latest/operate/oss_and_stack/install/archive/install-redis/install-redis-from-source/`
