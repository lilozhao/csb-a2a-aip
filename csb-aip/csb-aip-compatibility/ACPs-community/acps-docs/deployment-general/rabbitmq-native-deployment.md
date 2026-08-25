# RabbitMQ 4.x 原生部署指南（Ubuntu 22 / RHEL 9）

本文把 ACPs 在非 Docker 环境下对 RabbitMQ 的要求展开写清楚，重点覆盖 `mq-auth-server` 依赖的 4 个插件、TLS 配置、HTTP auth backend 和初始化资源。

本文主要服务以下场景：

- `mq-auth-server` 的原生 wheel 部署
- ACPs AIP / 群组通信运行时的 RabbitMQ 基础设施

## 1. 与 acps-infra 对齐的合同

`acps-infra/stage-infra` 当前默认的 RabbitMQ 合同来自以下文件：

- `stage-infra/rabbitmq.conf`
- `stage-infra/enabled_plugins`
- `stage-infra/init-rabbitmq.sh`

原生部署至少要对齐以下行为：

| 项目           | 默认值                                                                                                            | 说明                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| RabbitMQ 版本  | 4.2+                                                                                                              | README 写法是 4.2+；官方安装可直接装 4.3.x                |
| Broker 端口    | `5671`                                                                                                            | 仅 TLS listener，对应 `listeners.tcp = none`              |
| Management API | `15672`                                                                                                           | 默认 HTTP，仅建议内网访问                                 |
| 必需插件       | `rabbitmq_management`、`rabbitmq_auth_mechanism_ssl`、`rabbitmq_auth_backend_http`、`rabbitmq_auth_backend_cache` | 与 stage-infra 保持一致                                   |
| 认证机制       | `EXTERNAL` + `PLAIN`                                                                                              | 与 `mq-auth-server` 协同工作                              |
| 鉴权后端       | `internal` + `cache`，缓存后端指向 `http`                                                                         | `mq-auth-server` 是 HTTP 鉴权源                           |
| vhost          | `acps`                                                                                                            | `init-rabbitmq.sh` 里显式创建                             |
| exchange       | `inbox.topic`                                                                                                     | `topic` 类型，持久化                                      |
| 管理账号       | 至少 2 个                                                                                                         | 一个运维管理员，一个供 `mq-auth-server` 调 Management API |

与 Docker 版相比，原生部署最大的区别是：这些东西都要你自己安装、自己配、自己初始化，RabbitMQ 包本身不会替你完成 ACPs 所需的业务合同。

## 2. 部署前准备

开始前先准备：

- 一台用于运行 RabbitMQ 的主机。
- 一台用于运行 `mq-auth-server` 的主机，或者同机部署时的本机地址。
- 一套 RabbitMQ broker 服务端证书：`rabbitmq-server.pem`、`rabbitmq-server.key`。
- 一套 RabbitMQ 访问 `mq-auth-server` 时使用的客户端证书：`rabbitmq-client.pem`、`rabbitmq-client.key`。
- 同一信任链对应的根 CA：`acps-root-ca.pem`。
- 2 个不同的 RabbitMQ 账号：
  - 运维管理员账号，例如 `admin`
  - 给 `mq-auth-server` 调 Management API 用的账号，例如 `mq-auth-svc`

注意：这两个账号必须不同。这一点直接来自 `init-rabbitmq.sh` 的校验逻辑。

## 3. Ubuntu 22 安装步骤

RabbitMQ 官方明确建议在 Ubuntu 上使用 Team RabbitMQ 的 APT 仓库，而不是系统自带仓库。

下面这套命令按 Ubuntu 22.04 `amd64` 写；如果你部署在 `arm64`，需要按 RabbitMQ 官方文档改用 Launchpad Erlang 包方案。

```bash
sudo apt-get update -y
sudo apt-get install -y curl gnupg apt-transport-https

curl -1sLf "https://keys.openpgp.org/vks/v1/by-fingerprint/0A9AF2115F4687BD29803A206B73A36E6026DFCA" \
  | sudo gpg --dearmor \
  | sudo tee /usr/share/keyrings/com.rabbitmq.team.gpg > /dev/null

sudo tee /etc/apt/sources.list.d/rabbitmq.list <<'EOF'
## Modern Erlang/OTP releases
deb [arch=amd64 signed-by=/usr/share/keyrings/com.rabbitmq.team.gpg] https://deb1.rabbitmq.com/rabbitmq-erlang/ubuntu/jammy jammy main
deb [arch=amd64 signed-by=/usr/share/keyrings/com.rabbitmq.team.gpg] https://deb2.rabbitmq.com/rabbitmq-erlang/ubuntu/jammy jammy main

## Latest RabbitMQ releases
deb [arch=amd64 signed-by=/usr/share/keyrings/com.rabbitmq.team.gpg] https://deb1.rabbitmq.com/rabbitmq-server/ubuntu/jammy jammy main
deb [arch=amd64 signed-by=/usr/share/keyrings/com.rabbitmq.team.gpg] https://deb2.rabbitmq.com/rabbitmq-server/ubuntu/jammy jammy main
EOF

sudo apt-get update -y
sudo apt-get install -y \
  erlang-base erlang-asn1 erlang-crypto erlang-eldap erlang-ftp erlang-inets \
  erlang-mnesia erlang-os-mon erlang-parsetools erlang-public-key \
  erlang-runtime-tools erlang-snmp erlang-ssl erlang-syntax-tools \
  erlang-tftp erlang-tools erlang-xmerl
sudo apt-get install -y rabbitmq-server --fix-missing

sudo systemctl enable --now rabbitmq-server
sudo systemctl status rabbitmq-server
```

## 4. RHEL 9 安装步骤

RabbitMQ 官方建议在 RHEL 9 上使用 Team RabbitMQ 的 RPM 仓库，而不是只用系统仓库里的旧版本。

下面这套命令按 RHEL 9 `x86_64` 写；如果你部署在 `aarch64`，RabbitMQ 官方说明 Erlang 包需要改走 GitHub 发布页的 zero-dependency RPM 路径。

```bash
sudo rpm --import https://github.com/rabbitmq/signing-keys/releases/download/3.0/rabbitmq-release-signing-key.asc
sudo rpm --import https://github.com/rabbitmq/signing-keys/releases/download/3.0/cloudsmith.rabbitmq-erlang.E495BB49CC4BBE5B.key
sudo rpm --import https://github.com/rabbitmq/signing-keys/releases/download/3.0/cloudsmith.rabbitmq-server.9F4587F226208342.key

sudo tee /etc/yum.repos.d/rabbitmq.repo <<'EOF'
[modern-erlang]
name=modern-erlang-el9
baseurl=https://yum1.rabbitmq.com/erlang/el/9/$basearch
        https://yum2.rabbitmq.com/erlang/el/9/$basearch
repo_gpgcheck=1
enabled=1
gpgkey=https://github.com/rabbitmq/signing-keys/releases/download/3.0/cloudsmith.rabbitmq-erlang.E495BB49CC4BBE5B.key
gpgcheck=1
sslverify=1
sslcacert=/etc/pki/tls/certs/ca-bundle.crt
metadata_expire=300
pkg_gpgcheck=1
autorefresh=1
type=rpm-md

[modern-erlang-noarch]
name=modern-erlang-el9-noarch
baseurl=https://yum1.rabbitmq.com/erlang/el/9/noarch
        https://yum2.rabbitmq.com/erlang/el/9/noarch
repo_gpgcheck=1
enabled=1
gpgkey=https://github.com/rabbitmq/signing-keys/releases/download/3.0/cloudsmith.rabbitmq-erlang.E495BB49CC4BBE5B.key
       https://github.com/rabbitmq/signing-keys/releases/download/3.0/rabbitmq-release-signing-key.asc
gpgcheck=1
sslverify=1
sslcacert=/etc/pki/tls/certs/ca-bundle.crt
metadata_expire=300
pkg_gpgcheck=1
autorefresh=1
type=rpm-md

[rabbitmq-el9]
name=rabbitmq-el9
baseurl=https://yum2.rabbitmq.com/rabbitmq/el/9/$basearch
        https://yum1.rabbitmq.com/rabbitmq/el/9/$basearch
repo_gpgcheck=1
enabled=1
gpgkey=https://github.com/rabbitmq/signing-keys/releases/download/3.0/cloudsmith.rabbitmq-server.9F4587F226208342.key
       https://github.com/rabbitmq/signing-keys/releases/download/3.0/rabbitmq-release-signing-key.asc
gpgcheck=1
sslverify=1
sslcacert=/etc/pki/tls/certs/ca-bundle.crt
metadata_expire=300
pkg_gpgcheck=1
autorefresh=1
type=rpm-md

[rabbitmq-el9-noarch]
name=rabbitmq-el9-noarch
baseurl=https://yum2.rabbitmq.com/rabbitmq/el/9/noarch
        https://yum1.rabbitmq.com/rabbitmq/el/9/noarch
repo_gpgcheck=1
enabled=1
gpgkey=https://github.com/rabbitmq/signing-keys/releases/download/3.0/cloudsmith.rabbitmq-server.9F4587F226208342.key
       https://github.com/rabbitmq/signing-keys/releases/download/3.0/rabbitmq-release-signing-key.asc
gpgcheck=1
sslverify=1
sslcacert=/etc/pki/tls/certs/ca-bundle.crt
metadata_expire=300
pkg_gpgcheck=1
autorefresh=1
type=rpm-md
EOF

sudo dnf update -y
sudo dnf install -y logrotate erlang rabbitmq-server

sudo systemctl enable rabbitmq-server
sudo systemctl start rabbitmq-server
sudo systemctl status rabbitmq-server
```

## 5. 建议先调高文件句柄上限

RabbitMQ 官方建议生产场景至少准备 `65536` 的 open files 限制。可以直接加一个 systemd drop-in：

```bash
sudo mkdir -p /etc/systemd/system/rabbitmq-server.service.d
sudo tee /etc/systemd/system/rabbitmq-server.service.d/limits.conf <<'EOF'
[Service]
LimitNOFILE=65536
EOF

sudo systemctl daemon-reload
sudo systemctl restart rabbitmq-server
```

## 6. 准备证书目录

下面用 `/etc/rabbitmq/certs` 作为示例目录：

```bash
sudo mkdir -p /etc/rabbitmq/certs
sudo chown -R rabbitmq:rabbitmq /etc/rabbitmq/certs
sudo chmod 750 /etc/rabbitmq/certs
```

把这 5 个文件复制进去：

- `/etc/rabbitmq/certs/acps-root-ca.pem`
- `/etc/rabbitmq/certs/rabbitmq-server.pem`
- `/etc/rabbitmq/certs/rabbitmq-server.key`
- `/etc/rabbitmq/certs/rabbitmq-client.pem`
- `/etc/rabbitmq/certs/rabbitmq-client.key`

再收紧权限：

```bash
sudo chown rabbitmq:rabbitmq /etc/rabbitmq/certs/*
sudo chmod 640 /etc/rabbitmq/certs/*.key
sudo chmod 644 /etc/rabbitmq/certs/*.pem
```

## 7. 启用 ACPs 所需插件

最直接的办法是按 RabbitMQ 官方插件文档，用 `--offline` 在本地改 enabled plugins 文件：

```bash
sudo rabbitmq-plugins enable --offline \
  rabbitmq_management \
  rabbitmq_auth_mechanism_ssl \
  rabbitmq_auth_backend_http \
  rabbitmq_auth_backend_cache
```

然后验证：

```bash
sudo rabbitmq-plugins list -E -m
```

你应该能看到至少这 4 个插件处于启用状态。

## 8. 写入与 stage-infra 对齐的 `rabbitmq.conf`

先备份原文件：

```bash
sudo cp /etc/rabbitmq/rabbitmq.conf /etc/rabbitmq/rabbitmq.conf.bak.$(date +%Y%m%d%H%M%S) 2>/dev/null || true
```

再把配置替换为下面这个基线版本。注意把 `mq-auth-server.internal` 换成你自己的 `mq-auth-server` 地址。

```bash
sudo tee /etc/rabbitmq/rabbitmq.conf <<'EOF'
# ===== TLS listeners =====
listeners.ssl.default = 5671
listeners.tcp = none

ssl_options.cacertfile = /etc/rabbitmq/certs/acps-root-ca.pem
ssl_options.certfile = /etc/rabbitmq/certs/rabbitmq-server.pem
ssl_options.keyfile = /etc/rabbitmq/certs/rabbitmq-server.key
ssl_options.verify = verify_peer
ssl_options.fail_if_no_peer_cert = true
ssl_options.versions.1 = tlsv1.3
ssl_options.depth = 1
ssl_options.ciphers.1 = TLS_AES_256_GCM_SHA384
ssl_options.ciphers.2 = TLS_CHACHA20_POLY1305_SHA256
ssl_options.ciphers.3 = TLS_AES_128_GCM_SHA256

# ===== Management API =====
management.tcp.port = 15672

# ===== Authentication =====
auth_mechanisms.1 = EXTERNAL
auth_mechanisms.2 = PLAIN
ssl_cert_login_from = common_name

# ===== Authorization backends =====
auth_backends.1 = internal
auth_backends.2 = cache

auth_cache.cached_backend = http
auth_cache.cache_ttl = 15000

auth_http.user_path = https://mq-auth-server.internal:9008/auth/user
auth_http.vhost_path = https://mq-auth-server.internal:9008/auth/vhost
auth_http.resource_path = https://mq-auth-server.internal:9008/auth/resource
auth_http.topic_path = https://mq-auth-server.internal:9008/auth/topic
auth_http.http_method = post
auth_http.ssl_options.cacertfile = /etc/rabbitmq/certs/acps-root-ca.pem
auth_http.ssl_options.certfile = /etc/rabbitmq/certs/rabbitmq-client.pem
auth_http.ssl_options.keyfile = /etc/rabbitmq/certs/rabbitmq-client.key
auth_http.ssl_options.verify = verify_peer
EOF
```

重启服务：

```bash
sudo systemctl restart rabbitmq-server
```

## 9. 初始化 ACPs 账号、vhost 和 exchange

这一步直接对应 `stage-infra/init-rabbitmq.sh` 的行为。

### 9.1. 创建管理员账号

```bash
sudo rabbitmqctl add_user admin 'replace-admin-password' 2>/dev/null || sudo rabbitmqctl change_password admin 'replace-admin-password'
sudo rabbitmqctl set_user_tags admin administrator
```

### 9.2. 创建 `acps` vhost 并授予管理员全部权限

```bash
sudo rabbitmqctl add_vhost acps 2>/dev/null || true
sudo rabbitmqctl set_permissions -p acps admin ".*" ".*" ".*"
```

### 9.3. 创建给 `mq-auth-server` 用的管理账号

```bash
sudo rabbitmqctl add_user mq-auth-svc 'replace-mq-auth-mgmt-password' 2>/dev/null || sudo rabbitmqctl change_password mq-auth-svc 'replace-mq-auth-mgmt-password'
sudo rabbitmqctl set_user_tags mq-auth-svc administrator
sudo rabbitmqctl clear_permissions -p acps mq-auth-svc 2>/dev/null || true
```

这里的设计是：

- `admin` 账号负责初始建 vhost、建 exchange 和运维管理。
- `mq-auth-svc` 账号给 `mq-auth-server` 调 Management API 用，但不直接拥有 `acps` vhost 的业务读写权限。

### 9.4. 创建 `inbox.topic` exchange

```bash
sudo rabbitmqadmin \
  --username admin \
  --password 'replace-admin-password' \
  declare exchange \
  -V acps \
  --name inbox.topic \
  --type topic \
  --durable true
```

### 9.5. 删除默认 `guest` 用户

如果你不是仅本机自测，建议删掉默认 `guest`：

```bash
sudo rabbitmqctl delete_user guest 2>/dev/null || true
```

## 10. 验证步骤

至少做完以下验证再让应用接入。

### 10.1. 基础健康检查

```bash
sudo rabbitmq-diagnostics ping
sudo rabbitmq-diagnostics status
```

### 10.2. 验证插件

```bash
sudo rabbitmq-plugins list -E -m
```

### 10.3. 验证监听端口

```bash
sudo rabbitmq-diagnostics check_port_listener 5671
sudo rabbitmq-diagnostics check_port_listener 15672
```

### 10.4. 验证账号和 vhost

```bash
sudo rabbitmqctl list_users
sudo rabbitmqctl list_vhosts
sudo rabbitmqctl list_permissions -p acps
```

### 10.5. 验证 `inbox.topic` exchange

```bash
sudo rabbitmqadmin \
  --username admin \
  --password 'replace-admin-password' \
  list exchanges \
  -V acps \
  name type durable
```

### 10.6. 验证 RabbitMQ 能否通过 mTLS 访问 `mq-auth-server`

可以先在 RabbitMQ 主机上用同一组客户端证书做一次 TLS 连通性验证：

```bash
curl --cert /etc/rabbitmq/certs/rabbitmq-client.pem \
  --key /etc/rabbitmq/certs/rabbitmq-client.key \
  --cacert /etc/rabbitmq/certs/acps-root-ca.pem \
  https://mq-auth-server.internal:9008/health
```

如果这一步都不通，RabbitMQ 的 `auth_http.*` 也不会成功。

## 11. 与 `mq-auth-server` 的对接提醒

- `mq-auth-server` README 里的 `RABBITMQ_MGMT_URL` 指向的是 Management API 地址，例如 `http://rabbitmq.internal:15672`，不是 `amqps://...:5671`。
- `mq-auth-server` 的 `[rabbitmq].mgmt_user` / `RABBITMQ_MGMT_PASS` 应与本文创建的 `mq-auth-svc` 对应。
- `15672` 建议只开放给内网运维面和 `mq-auth-server`，不要直接暴露到公网。
- 如果你决定不用 TLS broker，而改成明文 `5672`，要同步重写应用配置；这会偏离当前 stage-infra 合同。

## 12. 常见坑

- 只安装 RabbitMQ 包、不启用 4 个插件，`mq-auth-server` 无法按 ACPs 合同工作。
- 只给 broker 配服务端证书、不配 `auth_http` 的客户端证书，RabbitMQ 访问 `mq-auth-server` 会失败。
- `admin` 和 `mq-auth-svc` 账号混用，会偏离 `init-rabbitmq.sh` 的设计，也更难排查权限问题。
- `rabbitmq-plugins` 如果报 enabled plugins file 不匹配，先执行 `rabbitmq-plugins directories -s` 看实际文件路径。

## 13. 官方参考

- RabbitMQ Debian/Ubuntu 安装页：`https://www.rabbitmq.com/docs/install-debian`
- RabbitMQ RPM 安装页：`https://www.rabbitmq.com/docs/install-rpm`
- RabbitMQ 插件文档：`https://www.rabbitmq.com/docs/plugins`
