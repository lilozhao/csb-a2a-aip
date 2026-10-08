/**
 * csb-a2a-aip/identity — CSB 身份层·阶段二（模块）
 * ------------------------------------------------------------------
 * 作者：明德 🎋 · 2026-10-08
 * 建在 csb-security 之上；与 A2A 服务同进程挂载，不单独起服务。
 *
 * 出口：
 *   core.js    —— 领域逻辑（agent_id 策略 / 保留字 / covenant / breach / passport）
 *   routes.js  —— HTTP 路由（框架无关：createIdentityHandler）
 */
'use strict';
module.exports = {
  core: require('./core.js'),
  routes: require('./routes.js'),
  createIdentityHandler: require('./routes.js').createIdentityHandler
};
