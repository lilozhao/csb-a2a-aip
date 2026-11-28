#!/usr/bin/env node
/**
 * server.js — 统一启动入口
 *
 * 背景（2026-11-28 修）：
 *   package.json 的 main/start 一直指向本文件，但仓库里**没有** server.js，
 *   新用户 `npm start` 第一条命令就 MODULE_NOT_FOUND。
 *   README 写的是 `node server_v5.js`，老用户无感，新用户必踩。
 *
 * 这里只做一件事：把入口收敛到 v5，不复制任何启动逻辑。
 * 想直接跑也可以：node server_v5.js。
 */
'use strict';

require('./server_v5.js');
