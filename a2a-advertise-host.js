'use strict';
/**
 * a2a-advertise-host.js
 *
 * [2026-09-22 T-5] 「对外广告地址」单一真相源。
 *
 * 背景：
 *   - 2026-09-13：AgentCard(`/.well-known/agent.json`) 硬编码 `http://localhost:${port}`
 *     → 远程 peer 拿到 localhost，谁都连不上。当时在 server_v5.js 内联了一个 IIFE 解析。
 *   - 2026-07-27 起：`/.well-known/ai-catalog.json` 硬编码 `http://172.28.0.5:3100`
 *     （抄模板残留 → **全社区通病**：每个 v5 实例的 catalog 都广告成阿轩的地址）。
 *
 * 本模块把该解析逻辑抽出来，让 v4/v5 共用，避免「每处各自硬编码 / 各自定义」再分叉。
 *
 * 优先级：
 *   env A2A_HOST > identity.publicHost > identity.host > config.getSelf?.()?.host > 'localhost'
 *
 * 注意：新 loader.js 里 config.getSelf() 是三级优先，可能抛错 → 用 ?.() 可选链 + try 兜底。
 *
 * @param {object} identity  已解析的 identity.json 对象
 * @param {object} [config]  config/loader 实例（可缺省）
 * @returns {string} host（不含协议与端口）
 */
module.exports = function resolveAdvertiseHost(identity, config) {
  if (process.env.A2A_HOST) return process.env.A2A_HOST;
  if (identity && identity.publicHost) return identity.publicHost;
  if (identity && identity.host) return identity.host;
  try { return config?.getSelf?.()?.host || 'localhost'; } catch { return 'localhost'; }
};
