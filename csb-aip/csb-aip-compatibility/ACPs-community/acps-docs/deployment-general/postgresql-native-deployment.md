# PostgreSQL 17 原生部署指南（Ubuntu 22 / RHEL 9）

本文把 ACPs 在非 Docker 环境下对 PostgreSQL 的要求展开写清楚，目标是让具备基本 Linux 操作能力的用户也能按步骤完成安装、初始化和应用侧建库。

本文主要服务以下项目：

- `registry-server`
- `ca-server`
- `discovery-server`

其中只有 `discovery-server` 需要 `pgvector` 扩展；`registry-server` 和 `ca-server` 只需要标准 PostgreSQL 17。

## 1. 与 acps-infra 对齐的合同

`acps-infra/stage-infra` 当前默认使用的是 `pg17 + pgvector` 组合，并在初始化时完成以下动作：

- 使用 PostgreSQL 17。
- 为 `registry-server`、`ca-server`、`discovery-server` 创建独立数据库和独立用户。
- 仅在 `agent_discovery` 库中执行 `CREATE EXTENSION vector`。
- Docker 版初始化时启用了 `--data-checksums`。

原生部署建议尽量对齐以下默认命名，这样最省事：

| 项目             | 数据库名          | 用户名      | 备注               |
| ---------------- | ----------------- | ----------- | ------------------ |
| registry-server  | `agent_registry`  | `registry`  | 普通 PostgreSQL 库 |
| ca-server        | `agent_ca`        | `ca`        | 普通 PostgreSQL 库 |
| discovery-server | `agent_discovery` | `discovery` | 需要 `vector` 扩展 |

## 2. 部署前准备

开始前先确认这几件事：

- 目标机已经完成时间同步，至少不要让系统时钟明显漂移。
- 你有 root 或 sudo 权限。
- 你已经决定数据库是否只监听本机，还是要允许其它主机连接。
- 你已经准备好 3 组应用数据库密码。
- 如果 `discovery-server` 会部署在这台主机对应的数据库上，准备安装 `pgvector`。

如果你只为一个应用单独部署 PostgreSQL，也仍然建议保留独立数据库和独立用户，不要让多个 ACPs 服务共用一个账号。

## 3. Ubuntu 22 安装步骤

### 3.1. 配置 PGDG 官方仓库并安装 PostgreSQL 17

PostgreSQL 官方建议在 Ubuntu 上使用 PGDG APT 仓库，而不是只依赖系统自带仓库。先执行：

```bash
sudo apt install -y postgresql-common ca-certificates
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
sudo apt update
sudo apt install -y postgresql-17 postgresql-client-17
```

如果这台主机承载 `discovery-server` 所使用的数据库，再额外安装 `pgvector` 包：

```bash
sudo apt install -y postgresql-17-pgvector
```

安装完成后，Ubuntu 通常会自动创建默认 cluster 并启动服务。仍建议显式确认一次：

```bash
sudo systemctl enable --now postgresql
sudo systemctl status postgresql
pg_lsclusters
```

### 3.2. 可选：重建 cluster 以启用 data checksums

这一步不是 ACPs 运行的硬性前提，但如果你想与 `acps-infra/stage-infra` 的 Docker 默认值保持一致，建议在正式导入数据前启用 checksums。

仅在“刚装完 PostgreSQL、尚未放入业务数据”时执行：

```bash
sudo pg_dropcluster --stop 17 main
sudo pg_createcluster 17 main -- --data-checksums
sudo systemctl restart postgresql
```

执行后可验证：

```bash
sudo -u postgres psql -d postgres -c "SHOW data_checksums;"
```

## 4. RHEL 9 安装步骤

### 4.1. 配置 PGDG 官方仓库并安装 PostgreSQL 17

PostgreSQL 官方在 RHEL 9 上同样建议使用 PGDG RPM 仓库。执行：

```bash
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-$(uname -m)/pgdg-redhat-repo-latest.noarch.rpm
sudo dnf -qy module disable postgresql
sudo dnf install -y postgresql17 postgresql17-server
```

如果这台主机承载 `discovery-server` 所使用的数据库，再安装 `pgvector` 包：

```bash
sudo dnf install -y pgvector_17
```

初始化并启动 PostgreSQL 17：

```bash
sudo /usr/pgsql-17/bin/postgresql-17-setup initdb
sudo systemctl enable --now postgresql-17
sudo systemctl status postgresql-17
```

如果你希望与 Docker 版本一样启用 data checksums，务必在首次 `initdb` 时就做，不要等业务数据已经写入以后再改。

### 4.2. RHEL 9 上的配置文件位置

PGDG 安装的 PostgreSQL 17 常见路径如下：

- 数据目录：`/var/lib/pgsql/17/data`
- 主配置：`/var/lib/pgsql/17/data/postgresql.conf`
- 访问控制：`/var/lib/pgsql/17/data/pg_hba.conf`

如果你不确定当前实例实际使用哪个配置文件，直接查询：

```bash
sudo -u postgres psql -d postgres -c "SHOW config_file;"
sudo -u postgres psql -d postgres -c "SHOW hba_file;"
```

## 5. 创建 ACPs 应用数据库和用户

下面的 SQL 直接参考了 `acps-infra/stage-infra/init-databases.sh` 的创建逻辑，只是改成了可手工执行的版本。

先把示例密码替换成你自己的强密码，然后再执行。

```bash
sudo -u postgres psql -d postgres <<'SQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'registry') THEN
        CREATE ROLE registry LOGIN PASSWORD 'replace-registry-password';
    ELSE
        ALTER ROLE registry WITH LOGIN PASSWORD 'replace-registry-password';
    END IF;
END
$$;

SELECT 'CREATE DATABASE agent_registry OWNER registry'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'agent_registry')\gexec

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ca') THEN
        CREATE ROLE ca LOGIN PASSWORD 'replace-ca-password';
    ELSE
        ALTER ROLE ca WITH LOGIN PASSWORD 'replace-ca-password';
    END IF;
END
$$;

SELECT 'CREATE DATABASE agent_ca OWNER ca'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'agent_ca')\gexec

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'discovery') THEN
        CREATE ROLE discovery LOGIN PASSWORD 'replace-discovery-password';
    ELSE
        ALTER ROLE discovery WITH LOGIN PASSWORD 'replace-discovery-password';
    END IF;
END
$$;

SELECT 'CREATE DATABASE agent_discovery OWNER discovery'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'agent_discovery')\gexec
SQL
```

如果这台主机上的 PostgreSQL 还要服务 `discovery-server`，继续执行：

```bash
sudo -u postgres psql -d agent_discovery -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

这一句必须使用具备足够权限的数据库管理员账号执行。不要假设 `discovery` 业务用户本身有创建扩展的权限。

## 6. 配置监听地址和访问控制

如果 PostgreSQL 只供本机应用使用，保持默认本地监听通常最安全；如果要让其它主机访问，再显式打开监听和 `pg_hba.conf`。

### 6.1. 调整 `listen_addresses`

把 `postgresql.conf` 中的 `listen_addresses` 改成目标地址。例如：

```conf
listen_addresses = '127.0.0.1,10.10.0.15'
```

如果你确实需要监听所有网卡，可以用 `'*'`，但更推荐只写实际需要暴露的地址。

### 6.2. 在 `pg_hba.conf` 中加入 ACPs 用户规则

示例：

```conf
host    agent_registry    registry     10.10.0.0/24    scram-sha-256
host    agent_ca          ca           10.10.0.0/24    scram-sha-256
host    agent_discovery   discovery    10.10.0.0/24    scram-sha-256
```

修改完成后重启服务：

Ubuntu 22：

```bash
sudo systemctl restart postgresql
```

RHEL 9：

```bash
sudo systemctl restart postgresql-17
```

## 7. 验证步骤

至少按下面顺序验证一次。

### 7.1. 验证服务本身

Ubuntu 22：

```bash
sudo systemctl status postgresql
```

RHEL 9：

```bash
sudo systemctl status postgresql-17
```

### 7.2. 验证数据库和角色

```bash
sudo -u postgres psql -d postgres -c "\du"
sudo -u postgres psql -d postgres -c "\l"
```

### 7.3. 验证 `vector` 扩展

如果这台主机承载 `discovery-server`：

```bash
sudo -u postgres psql -d agent_discovery -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';"
```

### 7.4. 用业务账号做一次实际连接

```bash
PGPASSWORD='replace-discovery-password' psql -h 127.0.0.1 -U discovery -d agent_discovery -c "SELECT current_database(), current_user;"
```

如果 `registry-server` 或 `ca-server` 跑在其它主机上，请把 `-h 127.0.0.1` 换成 PostgreSQL 实际监听地址，从应用主机再测一遍。

## 8. 与 ACPs 项目的对接提醒

- `registry-server` 和 `ca-server` 只要求 PostgreSQL 17，不要求 `pgvector`。
- `discovery-server` 必须在自己的目标库里启用 `vector` 扩展，不能只在 `postgres` 默认库里装一次就结束。
- 如果你把三个服务放在同一个 PostgreSQL 实例里，建议保留 3 个独立数据库，不要混表。
- 应用侧连接串建议直接使用独立用户名，不要把超级用户密码写进 `.env`。

## 9. 常见坑

- Ubuntu 22 自带仓库通常不是 PostgreSQL 17。如果你没走 PGDG 仓库，最终装出来的版本很可能不对。
- RHEL 9 如果没有先执行 `dnf -qy module disable postgresql`，依赖解析可能混到系统模块包。
- `pgvector` 安装成功不等于扩展已经在目标库里可用；包安装和 `CREATE EXTENSION vector` 是两步。
- `pg_hba.conf` 改完没重启或没 reload，是最常见的“密码明明对却连不上”的原因之一。

## 10. 官方参考

- PostgreSQL Ubuntu 安装页：`https://www.postgresql.org/download/linux/ubuntu/`
- PostgreSQL Red Hat 安装页：`https://www.postgresql.org/download/linux/redhat/`
- PGDG APT Wiki：`https://wiki.postgresql.org/wiki/Apt`
- PGDG YUM Wiki：`https://wiki.postgresql.org/wiki/YUM_Installation`
- pgvector 官方仓库：`https://github.com/pgvector/pgvector`
