#!/usr/bin/env bash
# 01-create-app-databases.sh
# Docker postgres docker-entrypoint-initdb.d 脚本
# 在 postgres volume 首次创建时自动执行，为各应用创建独立用户和数据库
#
# 注意：密码不得包含单引号（'），否则 SQL 注入会导致语法错误。
set -e

echo ">>> 初始化应用数据库（首次启动）"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	-- registry-server 数据库
	CREATE USER "${REGISTRY_DB_USER}" WITH PASSWORD '${REGISTRY_DB_PASSWORD}';
	CREATE DATABASE "${REGISTRY_DB_NAME}" OWNER "${REGISTRY_DB_USER}";

	-- ca-server 数据库
	CREATE USER "${CA_DB_USER}" WITH PASSWORD '${CA_DB_PASSWORD}';
	CREATE DATABASE "${CA_DB_NAME}" OWNER "${CA_DB_USER}";

	-- discovery-server 数据库
	CREATE USER "${DISCOVERY_DB_USER}" WITH PASSWORD '${DISCOVERY_DB_PASSWORD}';
	CREATE DATABASE "${DISCOVERY_DB_NAME}" OWNER "${DISCOVERY_DB_USER}";

	\connect "${DISCOVERY_DB_NAME}"
	CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

echo ">>> 应用数据库初始化完成"
